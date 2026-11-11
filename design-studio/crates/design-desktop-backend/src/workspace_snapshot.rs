//! Private SQLite encoding. References live in a versioned envelope and are
//! interpreted only at schema-known asset leaves, never in arbitrary user text.
use crate::digest_hex;
use crate::{BackendError, Result, bounded_json, document_byte_limit};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

pub fn snapshot_byte_limit() -> usize {
    document_byte_limit().saturating_add(64 * 1024)
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Font,
    Image,
}
impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Font => "font",
            Self::Image => "image",
        }
    }
}
pub struct Asset {
    pub hash: String,
    pub kind: Kind,
    pub value: String,
}
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub assets: BTreeMap<String, Asset>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    pointer: String,
    hash: String,
    kind: Kind,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    version: u32,
    document: Value,
    resources: Vec<Reference>,
}
fn corrupt(message: &str) -> BackendError {
    BackendError::new("WORKSPACE_CORRUPT", message)
}
fn db(error: sqlx::Error) -> BackendError {
    BackendError::new(
        "WORKSPACE_ERROR",
        format!("Workspace resource query failed: {error}"),
    )
}
fn segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
pub fn asset_hash(kind: Kind, value: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(kind.label().as_bytes());
    digest.update([0]);
    digest.update(value);
    digest_hex((digest.finalize()).as_slice())
}
fn base64(value: &str) -> bool {
    if value.is_empty() || !value.len().is_multiple_of(4) {
        return false;
    }
    let bytes = value.as_bytes();
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2 {
        return false;
    }
    let numeric = |byte: u8| match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    if !bytes[..bytes.len() - padding]
        .iter()
        .all(|byte| numeric(*byte).is_some())
    {
        return false;
    }
    let last = numeric(bytes[bytes.len() - padding - 1]).unwrap_or(0);
    padding == 0 || (padding == 1 && last & 3 == 0) || (padding == 2 && last & 15 == 0)
}
fn valid_resource(kind: Kind, value: &str) -> bool {
    match kind {
        Kind::Font => base64(value),
        Kind::Image => futureox_design_kernel::paint::RASTER_DATA_PREFIXES
            .into_iter()
            .any(|prefix| value.strip_prefix(prefix).is_some_and(base64)),
    }
}
fn paints(value: &Value, pointer: &str, paths: &mut BTreeMap<String, Kind>) {
    if let Some(paints) = value.as_array() {
        for (index, paint) in paints.iter().enumerate() {
            if paint.as_object().is_some_and(|p| p.contains_key("image")) {
                paths.insert(format!("{pointer}/{index}/image"), Kind::Image);
            }
        }
    }
}
fn pose(value: &Value, pointer: &str, paths: &mut BTreeMap<String, Kind>) {
    if let Some(fills) = value.get("fills") {
        paints(fills, &format!("{pointer}/fills"), paths);
    }
    if let Some(strokes) = value.get("strokes").and_then(Value::as_array) {
        for (index, stroke) in strokes.iter().enumerate() {
            if stroke
                .get("paint")
                .and_then(Value::as_object)
                .is_some_and(|p| p.contains_key("image"))
            {
                paths.insert(
                    format!("{pointer}/strokes/{index}/paint/image"),
                    Kind::Image,
                );
            }
        }
    }
}
fn resource_paths(document: &Value) -> BTreeMap<String, Kind> {
    let mut paths = BTreeMap::new();
    if let Some(fonts) = document.get("fonts").and_then(Value::as_object) {
        for (id, font) in fonts {
            if font.as_object().is_some_and(|f| f.contains_key("data")) {
                paths.insert(format!("/fonts/{}/data", segment(id)), Kind::Font);
            }
        }
    }
    if let Some(nodes) = document.get("nodes").and_then(Value::as_object) {
        for (id, node) in nodes {
            let pointer = format!("/nodes/{}", segment(id));
            pose(node, &pointer, &mut paths);
            if let Some(overrides) = node
                .pointer("/instance/overrides")
                .and_then(Value::as_object)
            {
                for (key, fields) in overrides {
                    pose(
                        fields,
                        &format!("{pointer}/instance/overrides/{}", segment(key)),
                        &mut paths,
                    );
                }
            }
        }
    }
    if let Some(clips) = document.get("animations").and_then(Value::as_array) {
        for (clip_index, clip) in clips.iter().enumerate() {
            if let Some(tracks) = clip.get("tracks").and_then(Value::as_array) {
                for (track_index, track) in tracks.iter().enumerate() {
                    if let Some(keys) = track.get("keyframes").and_then(Value::as_array) {
                        for (key_index, key) in keys.iter().enumerate() {
                            if let Some(value) = key.get("value") {
                                pose(
                                    value,
                                    &format!(
                                        "/animations/{clip_index}/tracks/{track_index}/keyframes/{key_index}/value"
                                    ),
                                    &mut paths,
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(styles) = document
        .pointer("/designSystem/styles")
        .and_then(Value::as_object)
    {
        for (id, style) in styles {
            if style.get("kind").and_then(Value::as_str) == Some("paint")
                && let Some(value) = style.get("value")
            {
                paints(
                    value,
                    &format!("/designSystem/styles/{}/value", segment(id)),
                    &mut paths,
                );
            }
        }
    }
    paths
}
pub fn encode(document: &Value) -> Result<Encoded> {
    let paths = resource_paths(document);
    let mut envelope = Envelope {
        format: "forma-workspace-snapshot".into(),
        version: 2,
        document: document.clone(),
        resources: Vec::new(),
    };
    let mut assets = BTreeMap::new();
    for (pointer, kind) in paths {
        let Some(value) = envelope.document.pointer(&pointer).and_then(Value::as_str) else {
            continue;
        };
        // Tiny values remain inline: a SHA/path reference would increase both
        // storage and work. Every extracted leaf saves more than its envelope.
        if value.len() < pointer.len() + 512 || !valid_resource(kind, value) {
            continue;
        }
        let digest = asset_hash(kind, value.as_bytes());
        assets.entry(digest.clone()).or_insert_with(|| Asset {
            hash: digest.clone(),
            kind,
            value: value.into(),
        });
        *envelope
            .document
            .pointer_mut(&pointer)
            .ok_or_else(|| corrupt("Resource path disappeared during encoding"))? = Value::Null;
        envelope.resources.push(Reference {
            pointer,
            hash: digest,
            kind,
        });
    }
    let bytes = bounded_json(&envelope, snapshot_byte_limit(), "DOCUMENT_TOO_LARGE")?;
    Ok(Encoded { bytes, assets })
}
pub async fn checked_asset(
    connection: &mut SqliteConnection,
    digest: &str,
    kind: Kind,
) -> Result<String> {
    // A corrupt length must not materialize an unbounded BLOB before checking it.
    let row = sqlx::query("SELECT kind,byte_length,CASE WHEN length(value)<=? THEN value ELSE NULL END AS value FROM assets WHERE hash=?")
        .bind(document_byte_limit() as i64).bind(digest).fetch_optional(connection).await.map_err(db)?.ok_or_else(||corrupt("Workspace resource is missing; snapshot retained"))?;
    let stored_kind: String = row.try_get("kind").map_err(db)?;
    let declared: i64 = row.try_get("byte_length").map_err(db)?;
    let bytes: Option<Vec<u8>> = row.try_get("value").map_err(db)?;
    let bytes = bytes.ok_or_else(|| BackendError::new("DOCUMENT_RESOURCE_LIMIT", "Workspace resource exceeds this session's working-memory allowance; stored bytes retained"))?;
    if stored_kind != kind.label()
        || declared != bytes.len() as i64
        || asset_hash(kind, &bytes) != digest
    {
        return Err(corrupt(
            "Workspace resource hash/metadata mismatch; stored bytes retained",
        ));
    }
    let value = String::from_utf8(bytes).map_err(|_| corrupt("Workspace resource is not UTF-8"))?;
    if !valid_resource(kind, &value) {
        return Err(corrupt("Workspace resource encoding is invalid"));
    }
    Ok(value)
}
pub async fn decode(
    connection: &mut SqliteConnection,
    bytes: &[u8],
    encoding: i64,
    id: &str,
    revision: i64,
) -> Result<Value> {
    if bytes.len() > snapshot_byte_limit() {
        return Err(corrupt("Encoded snapshot exceeds its byte budget"));
    }
    if encoding == 1 {
        if bytes.len() > document_byte_limit() {
            return Err(corrupt("Legacy snapshot exceeds its byte budget"));
        }
        return serde_json::from_slice(bytes)
            .map_err(|_| corrupt("Legacy snapshot is invalid JSON"));
    }
    if encoding != 2 {
        return Err(corrupt("Unknown workspace snapshot encoding"));
    }
    let mut envelope: Envelope = serde_json::from_slice(bytes)
        .map_err(|_| corrupt("Workspace snapshot envelope is invalid"))?;
    if envelope.format != "forma-workspace-snapshot" || envelope.version != 2 {
        return Err(corrupt("Workspace snapshot envelope version is invalid"));
    }
    let allowed = resource_paths(&envelope.document);
    let mut pointers = BTreeSet::new();
    let mut resources = BTreeMap::new();
    let mut expanded = bounded_json(
        &envelope.document,
        document_byte_limit(),
        "WORKSPACE_CORRUPT",
    )?
    .len();
    for reference in &envelope.resources {
        if allowed.get(&reference.pointer) != Some(&reference.kind)
            || !pointers.insert(&reference.pointer)
            || envelope.document.pointer(&reference.pointer) != Some(&Value::Null)
            || reference.hash.len() != 64
            || !reference.hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(corrupt(
                "Workspace reference is not a unique schema-known resource placeholder",
            ));
        }
        if !resources.contains_key(&reference.hash) {
            let value = checked_asset(connection, &reference.hash, reference.kind).await?;
            resources.insert(reference.hash.clone(), (reference.kind, value));
        }
        let (kind, value) = &resources[&reference.hash];
        if *kind != reference.kind {
            return Err(corrupt("Workspace reference kind mismatch"));
        }
        // Resource syntax is ASCII with no JSON escapes: replacing null (4 bytes)
        // with a quoted string adds exactly value.len()-2 bytes.
        expanded = expanded
            .checked_add(value.len().saturating_sub(2))
            .filter(|n| *n <= document_byte_limit())
            .ok_or_else(|| corrupt("Expanded snapshot exceeds the document budget"))?;
    }
    let references = sqlx::query_scalar::<_, String>(
        "SELECT asset_hash FROM revision_assets WHERE document_id=? AND revision=?",
    )
    .bind(id)
    .bind(revision)
    .fetch_all(&mut *connection)
    .await
    .map_err(db)?
    .into_iter()
    .collect::<BTreeSet<_>>();
    if references != resources.keys().cloned().collect::<BTreeSet<_>>() {
        return Err(corrupt("Workspace revision resource index is inconsistent"));
    }
    for reference in envelope.resources {
        *envelope
            .document
            .pointer_mut(&reference.pointer)
            .ok_or_else(|| corrupt("Workspace resource target disappeared"))? =
            Value::String(resources[&reference.hash].1.clone());
    }
    Ok(envelope.document)
}
