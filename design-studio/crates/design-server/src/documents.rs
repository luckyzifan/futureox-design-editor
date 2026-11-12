use crate::{ApiError, AppState, Result, validation};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::collections::{BTreeMap, HashSet};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Save {
    document: Value,
    revision: i64,
    request_id: Uuid,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    id: String,
    name: String,
    revision: i64,
    document: Value,
    updated_at: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    id: String,
    name: String,
    revision: i64,
    updated_at: String,
}

/// The editor's DocumentPatch transport, retaining the authored JSON values.
#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Patch {
    fields: BTreeMap<String, Value>,
    nodes: BTreeMap<String, Option<Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    deleted_fields: Vec<String>,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Edit {
    revision: i64,
    request_id: Uuid,
    patch: Patch,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct EditReceipt {
    revision: i64,
    /// A stale edit can commit over unrelated changes. Return the merged state
    /// only in this case, so the client can advance from its submitted draft.
    #[serde(skip_serializing_if = "Option::is_none")]
    merged: Option<Document>,
}

#[derive(Deserialize)]
pub(crate) struct Since {
    after: i64,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct Change {
    revision: i64,
    /// Null with a newer revision means the client should read a snapshot.
    patch: Option<Value>,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::UNPROCESSABLE_ENTITY, message.into())
}

fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "Document revision has changed".into())
}

fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Document not found".into())
}

fn revision_is_valid(revision: i64) -> bool {
    (0..9_007_199_254_740_991).contains(&revision)
}

fn admission(state: &AppState) -> Result<tokio::sync::OwnedSemaphorePermit> {
    state.compute.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Document processing capacity exceeded".into(),
        )
    })
}

fn document_worker_error(_: tokio::task::JoinError) -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Document processing failed".into(),
    )
}

impl Patch {
    fn validate(&self) -> Result<()> {
        if self.fields.is_empty() && self.nodes.is_empty() && self.deleted_fields.is_empty() {
            return Err(invalid("Empty document patch"));
        }
        let mut keys = HashSet::new();
        if self.fields.keys().chain(&self.deleted_fields).any(|key| {
            !keys.insert(key)
                || !matches!(
                    key.as_str(),
                    "fdCompatibility"
                        | "schemaVersion"
                        | "name"
                        | "pages"
                        | "fonts"
                        | "animations"
                        | "rasterProfile"
                        | "colorManagement"
                        | "designSystem"
                        | "prototype"
                        | "reviews"
                )
        }) {
            return Err(invalid("Invalid document patch fields"));
        }
        if self.nodes.iter().any(|(id, node)| {
            id.len() != 36
                || Uuid::parse_str(id).is_err()
                || node
                    .as_ref()
                    .is_some_and(|node| node["id"].as_str() != Some(id.as_str()))
        }) {
            return Err(invalid("Invalid node patch identity"));
        }
        Ok(())
    }

    fn apply(&self, base: Option<&Value>, mut current: Value) -> Result<Value> {
        if let Some(base) = base {
            let overlaps = self.fields.iter().any(|(key, value)| {
                base.get(key) != current.get(key) && current.get(key) != Some(value)
            }) || self
                .deleted_fields
                .iter()
                .any(|key| base.get(key) != current.get(key) && current.get(key).is_some())
                || self.nodes.iter().any(|(id, value)| {
                    base["nodes"].get(id) != current["nodes"].get(id)
                        && current["nodes"].get(id) != value.as_ref()
                });
            if overlaps {
                return Err(conflict());
            }
        }
        let root = current
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid stored document"))?;
        for key in &self.deleted_fields {
            root.remove(key);
        }
        for (key, value) in &self.fields {
            root.insert(key.clone(), value.clone());
        }
        let nodes = root
            .get_mut("nodes")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| invalid("Invalid stored nodes"))?;
        for (id, value) in &self.nodes {
            if let Some(node) = value {
                nodes.insert(id.clone(), node.clone());
            } else {
                nodes.remove(id);
            }
        }
        Ok(current)
    }
}

#[utoipa::path(get,path="/api/design/documents",responses((status=200,body=Vec<Summary>),(status=401)),security(("workspace_token"=[])))]
pub(crate) async fn list(State(state): State<AppState>) -> Result<Json<Vec<Summary>>> {
    let rows=sqlx::query("SELECT id::text,name,revision,updated_at::text FROM design_documents ORDER BY updated_at DESC LIMIT 500").fetch_all(&state.pool).await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| Summary {
                id: r.get("id"),
                name: r.get("name"),
                revision: r.get("revision"),
                updated_at: r.get("updated_at"),
            })
            .collect(),
    ))
}

fn decode(row: PgRow) -> Document {
    Document {
        id: row.get("id"),
        name: row.get("name"),
        revision: row.get("revision"),
        document: row.get("document"),
        updated_at: row.get("updated_at"),
    }
}

#[utoipa::path(get,path="/api/design/documents/{id}",params(("id"=String,Path)),responses((status=200,body=Document),(status=404)),security(("workspace_token"=[])))]
pub(crate) async fn read(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Document>> {
    let row = sqlx::query(
        "SELECT id::text,name,revision,document,updated_at::text FROM design_documents WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)?;
    Ok(Json(decode(row)))
}

#[utoipa::path(get,path="/api/design/documents/{id}/changes",params(("id"=String,Path),("after"=i64,Query)),responses((status=200,body=Change),(status=404),(status=422)),security(("workspace_token"=[])))]
pub(crate) async fn changes(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(since): Query<Since>,
) -> Result<Json<Change>> {
    if since.after == 0 || !revision_is_valid(since.after) {
        return Err(invalid("Invalid revision"));
    }
    // A recent follower receives one ordered delta. A distant follower or a
    // legacy snapshot save uses one GET of the current document instead.
    let row = sqlx::query(
        "SELECT d.revision, v.patch FROM design_documents d
         LEFT JOIN design_versions v ON v.document_id=d.id AND v.revision=$2+1 AND d.revision-$2<=8
         WHERE d.id=$1",
    )
    .bind(id)
    .bind(since.after)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)?;
    let patch: Option<Value> = row.get("patch");
    let revision = if patch.is_some() {
        since.after + 1
    } else {
        row.get("revision")
    };
    Ok(Json(Change { revision, patch }))
}

async fn lock(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<()> {
    // Serializes concurrent first writes and later rebases across service processes.
    let key = i64::from_be_bytes(id.as_bytes()[..8].try_into().unwrap());
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(key)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn existing_receipt(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    request: Uuid,
    digest: &[u8],
) -> Result<Option<i64>> {
    let row = sqlx::query(
        "SELECT digest,revision FROM design_write_receipts WHERE document_id=$1 AND request_id=$2",
    )
    .bind(id)
    .bind(request)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = row {
        if row.get::<Vec<u8>, _>("digest") != digest {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Idempotency key has different content".into(),
            ));
        }
        return Ok(Some(row.get("revision")));
    }
    Ok(None)
}

async fn version(tx: &mut Transaction<'_, Postgres>, id: Uuid, revision: i64) -> Result<Document> {
    let row=sqlx::query("SELECT document_id::text AS id,document->>'name' AS name,revision,document,created_at::text AS updated_at FROM design_versions WHERE document_id=$1 AND revision=$2")
        .bind(id).bind(revision).fetch_one(&mut **tx).await?;
    Ok(decode(row))
}

async fn store(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    revision: i64,
    name: String,
    document: Value,
    patch: Option<Value>,
    request: Uuid,
    digest: &[u8],
) -> Result<Document> {
    let updated_at: String = sqlx::query_scalar(
        "INSERT INTO design_documents(id,name,revision,document) VALUES($1,$2,$3,$4)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,revision=EXCLUDED.revision,document=EXCLUDED.document,updated_at=now()
         RETURNING updated_at::text",
    )
    .bind(id)
    .bind(&name)
    .bind(revision)
    .bind(&document)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO design_versions(document_id,revision,document,patch)
         SELECT id,revision,document,$2 FROM design_documents WHERE id=$1",
    )
    .bind(id)
    .bind(patch)
    .execute(&mut **tx)
    .await?;
    sqlx::query("INSERT INTO design_write_receipts(document_id,request_id,digest,revision) VALUES($1,$2,$3,$4)")
        .bind(id).bind(request).bind(digest).bind(revision).execute(&mut **tx).await?;
    Ok(Document {
        id: id.to_string(),
        name,
        revision,
        document,
        updated_at,
    })
}

#[utoipa::path(put,path="/api/design/documents/{id}",params(("id"=String,Path)),request_body=Save,responses((status=200,body=Document),(status=409),(status=422)),security(("workspace_token"=[])))]
pub(crate) async fn save(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<Save>,
) -> Result<Json<Document>> {
    if !revision_is_valid(input.revision) {
        return Err(invalid("Invalid revision"));
    }
    let permit = admission(&state)?;
    let (input, name, digest) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let name = validation::validate(&input.document, id).map_err(invalid)?;
        // Retain the original snapshot digest for already-persisted receipts.
        let bytes =
            serde_json::to_vec(&json!({"document":input.document,"revision":input.revision}))
                .map_err(|_| invalid("Invalid document"))?;
        Ok::<_, ApiError>((input, name, Sha256::digest(bytes).to_vec()))
    })
    .await
    .map_err(document_worker_error)??;
    let mut tx = state.pool.begin().await?;
    lock(&mut tx, id).await?;
    if let Some(revision) = existing_receipt(&mut tx, id, input.request_id, &digest).await? {
        let document = version(&mut tx, id, revision).await?;
        tx.commit().await?;
        return Ok(Json(document));
    }
    let current: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM design_documents WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if current.unwrap_or(0) != input.revision {
        return Err(conflict());
    }
    let document = store(
        &mut tx,
        id,
        input.revision + 1,
        name,
        input.document,
        None,
        input.request_id,
        &digest,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(document))
}

#[utoipa::path(patch,path="/api/design/documents/{id}",params(("id"=String,Path)),request_body=Edit,responses((status=200,body=EditReceipt),(status=404),(status=409),(status=422)),security(("workspace_token"=[])))]
pub(crate) async fn edit(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<Edit>,
) -> Result<Json<EditReceipt>> {
    if input.revision == 0 || !revision_is_valid(input.revision) {
        return Err(invalid("Invalid revision"));
    }
    input.patch.validate()?;
    let permit = admission(&state)?;
    let (input, patch, digest, permit) = tokio::task::spawn_blocking(move || {
        let patch =
            serde_json::to_value(&input.patch).map_err(|_| invalid("Invalid document patch"))?;
        let bytes = serde_json::to_vec(&json!({"patch":patch,"revision":input.revision}))
            .map_err(|_| invalid("Invalid document patch"))?;
        Ok::<_, ApiError>((input, patch, Sha256::digest(bytes).to_vec(), permit))
    })
    .await
    .map_err(document_worker_error)??;
    let mut tx = state.pool.begin().await?;
    lock(&mut tx, id).await?;
    if let Some(revision) = existing_receipt(&mut tx, id, input.request_id, &digest).await? {
        let merged = if revision != input.revision + 1 {
            Some(version(&mut tx, id, revision).await?)
        } else {
            None
        };
        tx.commit().await?;
        return Ok(Json(EditReceipt { revision, merged }));
    }
    let row = sqlx::query("SELECT revision,document FROM design_documents WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(not_found)?;
    let head: i64 = row.get("revision");
    if !revision_is_valid(head) || input.revision > head {
        return Err(conflict());
    }
    let current: Value = row.try_get("document")?;
    let stale = input.revision != head;
    let base: Option<Value> = if stale {
        Some(
            sqlx::query_scalar(
                "SELECT document FROM design_versions WHERE document_id=$1 AND revision=$2",
            )
            .bind(id)
            .bind(input.revision)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(conflict)?,
        )
    } else {
        None
    };
    let (next, name) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let next = input.patch.apply(base.as_ref(), current)?;
        let name = validation::validate(&next, id)
            .map_err(|error| if stale { conflict() } else { invalid(error) })?;
        Ok::<_, ApiError>((next, name))
    })
    .await
    .map_err(document_worker_error)??;
    let revision = head + 1;
    let document = store(
        &mut tx,
        id,
        revision,
        name,
        next,
        Some(patch),
        input.request_id,
        &digest,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(EditReceipt {
        revision,
        merged: stale.then_some(document),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = "0FD13AFE-C62F-4AC2-B111-185B535694AE";
    const SECOND: &str = "1FD13AFE-C62F-4AC2-B111-185B535694AE";

    #[test]
    fn concurrent_patches_merge_distinct_nodes_and_preserve_source_ids() {
        let base = json!({"nodes":{
            (FIRST): {"id":FIRST,"name":"a"},
            (SECOND): {"id":SECOND,"name":"b"}
        }});
        let left: Patch = serde_json::from_value(json!({
            "fields":{}, "nodes":{(FIRST):{"id":FIRST,"name":"left"}}
        }))
        .unwrap();
        let right: Patch = serde_json::from_value(json!({
            "fields":{}, "nodes":{(SECOND):{"id":SECOND,"name":"right"}}
        }))
        .unwrap();
        left.validate().unwrap();
        right.validate().unwrap();
        let first = left.apply(None, base.clone()).unwrap();
        let both = right.apply(Some(&base), first).unwrap();
        assert_eq!(both["nodes"][FIRST]["name"], "left");
        assert_eq!(both["nodes"][SECOND]["name"], "right");
        let conflicting: Patch = serde_json::from_value(json!({
            "fields":{}, "nodes":{(FIRST):{"id":FIRST,"name":"other"}}
        }))
        .unwrap();
        assert_eq!(
            conflicting.apply(Some(&base), both).unwrap_err().0,
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn explicit_null_and_field_removal_are_distinct() {
        let original = json!({"nodes":{}});
        let assign: Patch = serde_json::from_value(json!({
            "nodes":{}, "fields":{"fdCompatibility":null}
        }))
        .unwrap();
        let assigned = assign.apply(None, original.clone()).unwrap();
        assert_eq!(assigned.get("fdCompatibility"), Some(&Value::Null));
        let remove: Patch = serde_json::from_value(json!({
            "nodes":{}, "fields":{}, "deletedFields":["fdCompatibility"]
        }))
        .unwrap();
        assert_eq!(remove.apply(None, assigned).unwrap(), original);
        let identity: Patch = serde_json::from_value(json!({
            "nodes":{}, "fields":{"id":"different"}
        }))
        .unwrap();
        assert_eq!(
            identity.validate().unwrap_err().0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
