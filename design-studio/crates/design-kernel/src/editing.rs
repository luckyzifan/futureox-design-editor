use crate::math::Point;
pub fn snap_pixel(p: Point) -> Result<Point, String> {
    if !p.finite() || p.x.abs() > 1e7 || p.y.abs() > 1e7 {
        return Err("Invalid pixel snap coordinates".into());
    }
    Ok(Point::new((p.x + 0.5).floor(), (p.y + 0.5).floor()))
}

use crate::scene::{Document, Node};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A versioned, serializable atomic edit. Graph edits include all affected
/// parent lists; validation rejects partial reparent/delete operations.
#[derive(Clone, Default, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPatch {
    #[serde(default)]
    pub nodes: BTreeMap<String, Option<Node>>,
    #[serde(default)]
    pub fields: BTreeMap<String, serde_json::Value>,
}
/// A successful patch and the exact serialized size checked for that same
/// document. Fields stay private; consuming the result transfers the document
/// and its receipt together. It certifies no later mutation of the document.
pub(crate) struct AppliedDocument {
    document: Document,
    serialized_bytes: usize,
}
impl AppliedDocument {
    pub(crate) fn into_parts(self) -> (Document, usize) {
        (self.document, self.serialized_bytes)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for EditError {}
fn error(code: &'static str, message: impl Into<String>) -> EditError {
    EditError {
        code,
        message: message.into(),
    }
}
fn check_document_size(document: &Document) -> Result<(), EditError> {
    serialized_document_size(document).map(|_| ())
}
#[cfg(test)]
std::thread_local! {
    static DOCUMENT_SIZE_COUNT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(crate) fn document_size_count_calls() -> usize {
    DOCUMENT_SIZE_COUNT_CALLS.with(std::cell::Cell::get)
}
pub(crate) fn serialized_document_size(document: &Document) -> Result<usize, EditError> {
    #[cfg(test)]
    DOCUMENT_SIZE_COUNT_CALLS.with(|calls| calls.set(calls.get() + 1));
    count_json_bytes(document, crate::capacity::document_byte_limit()).map_err(|e| error("document_budget", e.to_string()))
}
/// Exact wire size without allocating a discarded JSON byte buffer.
pub(crate) fn serialized_size(value: &impl Serialize) -> Result<usize, serde_json::Error> {
    count_json_bytes(value, usize::MAX)
}
pub(crate) fn count_json_bytes(value: &impl Serialize, limit: usize) -> Result<usize, serde_json::Error> {
    struct Counter<'a>(&'a mut usize, usize);
    impl std::io::Write for Counter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            *self.0 = self.0.saturating_add(bytes.len());
            if *self.0 > self.1 {
                return Err(std::io::Error::other("DOCUMENT_RESOURCE_LIMIT: serialized document exceeds this session's resource allowance"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = 0;
    serde_json::to_writer(Counter(&mut bytes, limit), value)?;
    Ok(bytes)
}

#[cfg(test)]
mod byte_budget_tests {
    use super::*;
    #[test]
    fn counter_preserves_utf8_escaping_float_and_limit_accounting() {
        let value = serde_json::json!({"text":"中文\n\t\"\\😀", "values":[-0.0,1e-20,123456.75],"children":[]});
        let expected = serde_json::to_vec(&value).unwrap();
        assert_eq!(serialized_size(&value).unwrap(), expected.len());
        assert_eq!(count_json_bytes(&value, expected.len()).unwrap(), expected.len());
        assert!(count_json_bytes(&value, expected.len()-1).is_err());
    }
}
impl DocumentPatch {
    pub(crate) fn is_local_properties(&self, doc: &Document) -> bool {
        self.fields.is_empty()
            && !doc
                .animations
                .iter()
                .flat_map(|c| c.tracks.iter())
                .any(|t| self.nodes.contains_key(&t.node_id))
            && self.nodes.iter().all(|(id, n)| {
                let (Some(old), Some(n)) = (doc.nodes.get(id), n.as_ref()) else {
                    return false;
                };
                old.id == n.id
                    && old.kind == n.kind
                    && old.children == n.children
                    && old.component == n.component
                    && old.component_set == n.component_set
                    && old.component_key == n.component_key
                    && old.instance == n.instance
                    && old.instance_origin == n.instance_origin
                    && old.bindings == n.bindings
                    && old.variable_modes == n.variable_modes
                    && old.style_refs == n.style_refs
                    && old.boolean_operation == n.boolean_operation
                    && old.text == n.text
            })
    }
    pub fn between(before: &Document, after: &Document) -> Result<Self, EditError> {
        if before.id != after.id {
            return Err(error(
                "document_identity",
                "An edit cannot replace the document identity",
            ));
        }
        let mut nodes = BTreeMap::new();
        for (id, node) in &after.nodes {
            if before.nodes.get(id) != Some(node) {
                nodes.insert(id.clone(), Some(node.clone()));
            }
        }
        for id in before.nodes.keys() {
            if !after.nodes.contains_key(id) {
                nodes.insert(id.clone(), None);
            }
        }
        let mut fields = BTreeMap::new();
        macro_rules! field {
            ($field:ident, $key:literal) => {
                if before.$field != after.$field {
                    fields.insert(
                        $key.into(),
                        serde_json::to_value(&after.$field)
                            .map_err(|e| error("serialization", e.to_string()))?,
                    );
                }
            };
        }
        field!(fd_compatibility, "fdCompatibility");
        field!(schema_version, "schemaVersion");
        field!(name, "name");
        field!(pages, "pages");
        field!(fonts, "fonts");
        field!(animations, "animations");
        field!(raster_profile, "rasterProfile");
        field!(color_management, "colorManagement");
        field!(design_system, "designSystem");
        field!(prototype, "prototype");
        field!(reviews, "reviews");
        Ok(Self { nodes, fields })
    }
    pub(crate) fn apply(&self, before: &Document) -> Result<Document, EditError> {
        self.apply_with_size(before).map(|applied| applied.into_parts().0)
    }
    pub(crate) fn apply_with_size(&self, before: &Document) -> Result<AppliedDocument, EditError> {
        let mut result = before.clone();
        for (id, node) in &self.nodes {
            if let Some(node) = node {
                result.nodes.insert(id.clone(), node.clone());
            } else {
                result.nodes.remove(id);
            }
        }
        for (key, value) in &self.fields {
            macro_rules! set {
                ($field:ident) => {
                    result.$field = serde_json::from_value(value.clone())
                        .map_err(|e| error("invalid_field", e.to_string()))?
                };
            }
            match key.as_str() {
                "fdCompatibility" => set!(fd_compatibility),
                "schemaVersion" => set!(schema_version),
                "reviews" => {
                    if value.is_null() {
                        result.reviews.clear();
                    } else {
                        set!(reviews);
                    }
                }
                "name" => set!(name),
                "pages" => set!(pages),
                "fonts" => {
                    if value.is_null() {
                        result.fonts.clear();
                    } else {
                        set!(fonts);
                    }
                }
                "animations" => {
                    if value.is_null() {
                        result.animations.clear();
                    } else {
                        set!(animations);
                    }
                }
                "rasterProfile" => set!(raster_profile),
                "colorManagement" => set!(color_management),
                "designSystem" => set!(design_system),
                "prototype" => set!(prototype),
                _ => {
                    return Err(error(
                        "invalid_field",
                        format!("Unsupported document field {key}"),
                    ));
                }
            }
        }
        result
            .validate()
            .map_err(|e| error("invalid_document", e))?;
        let serialized_bytes = serialized_document_size(&result)?;
        if self.fields.contains_key("fonts") {
            crate::font::Fonts::new()
                .with_resources(&result.fonts)
                .map_err(|e| error("invalid_font", e))?;
        }
        Ok(AppliedDocument { document: result, serialized_bytes })
    }
    fn empty(&self) -> bool {
        self.nodes.is_empty() && self.fields.is_empty()
    }
}
struct Entry {
    forward: DocumentPatch,
    inverse: DocumentPatch,
    bytes: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub revision: u64,
    pub patch: DocumentPatch,
    pub undo_depth: usize,
    pub redo_depth: usize,
}
/// Native/WASM history owns reversible patches, bounded by count AND bytes.
/// The current document remains authoritative; no past full-document snapshot
/// is retained for each undo step. A failed edit never changes it or the history.
pub struct DocumentEditor {
    document: Document,
    revision: u64,
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    transaction: Option<Document>,
    retained_bytes: usize,
    document_bytes: usize,
}
impl DocumentEditor {
    pub fn new(document: Document) -> Result<Self, EditError> {
        document
            .validate()
            .map_err(|e| error("invalid_document", e))?;
        check_document_size(&document)?;
        crate::font::Fonts::new()
            .with_resources(&document.fonts)
            .map_err(|e| error("invalid_font", e))?;
        let document_bytes = serialized_size(&document)
            .map_err(|e| error("serialization", e.to_string()))?;
        Ok(Self {
            document_bytes,
            document,
            revision: 0,
            undo: vec![],
            redo: vec![],
            transaction: None,
            retained_bytes: 0,
        })
    }
    pub fn document(&self) -> &Document {
        &self.document
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    fn result(&self, patch: DocumentPatch) -> EditResult {
        EditResult {
            revision: self.revision,
            patch,
            undo_depth: self.undo.len(),
            redo_depth: self.redo.len(),
        }
    }
    fn check_revision(&self, revision: u64) -> Result<(), EditError> {
        if revision != self.revision {
            Err(error("stale_revision", "The document has changed"))
        } else {
            Ok(())
        }
    }
    pub fn apply(&mut self, revision: u64, patch: DocumentPatch) -> Result<EditResult, EditError> {
        self.check_revision(revision)?;
        if self.transaction.is_some() {
            return Err(error(
                "active_transaction",
                "Commit or cancel the current transaction first",
            ));
        }
        if patch.is_local_properties(&self.document) {
            return self.publish_local(patch);
        }
        let candidate = patch.apply(&self.document)?;
        self.publish(candidate)
    }
    fn publish_local(&mut self, mut forward: DocumentPatch) -> Result<EditResult, EditError> {
        forward
            .nodes
            .retain(|id, n| self.document.nodes.get(id) != n.as_ref());
        if forward.empty() {
            return Ok(self.result(forward));
        }
        let inverse = DocumentPatch {
            nodes: forward
                .nodes
                .keys()
                .map(|id| (id.clone(), self.document.nodes.get(id).cloned()))
                .collect(),
            fields: Default::default(),
        };
        let mut size = self.document_bytes;
        for (id, n) in &forward.nodes {
            let old = serialized_size(&self.document.nodes[id])
                .map_err(|e| error("serialization", e.to_string()))?;
            let new = serialized_size(n.as_ref().unwrap())
                .map_err(|e| error("serialization", e.to_string()))?;
            size = size - old + new;
        }
        crate::capacity::check_document_bytes(size).map_err(|e| error("document_budget", e))?;
        let bytes = serialized_size(&forward)
            .map_err(|e| error("serialization", e.to_string()))?
            + serialized_size(&inverse)
                .map_err(|e| error("serialization", e.to_string()))?;
        if bytes > crate::capacity::expanded_value_limit() {
            return Err(error("history_budget", "Edit exceeds undo budget"));
        }
        self.document
            .validate_nodes(
                forward
                    .nodes
                    .iter()
                    .map(|(id, n)| (id, n.as_ref().unwrap())),
            )
            .map_err(|e| error("invalid_document", e))?;
        for (id, n) in &forward.nodes {
            self.document.nodes.insert(id.clone(), n.clone().unwrap());
        }
        self.retained_bytes -= self.redo.iter().map(|e| e.bytes).sum::<usize>();
        self.redo.clear();
        while self.undo.len() >= 80 || self.retained_bytes + bytes > crate::capacity::expanded_value_limit() {
            self.retained_bytes -= self.undo.remove(0).bytes;
        }
        self.undo.push(Entry {
            forward: forward.clone(),
            inverse,
            bytes,
        });
        self.retained_bytes += bytes;
        self.document_bytes = size;
        self.revision += 1;
        Ok(self.result(forward))
    }
    fn publish(&mut self, candidate: Document) -> Result<EditResult, EditError> {
        let forward = DocumentPatch::between(&self.document, &candidate)?;
        if forward.empty() {
            return Ok(self.result(forward));
        }
        let inverse = DocumentPatch::between(&candidate, &self.document)?;
        let bytes = serialized_size(&forward)
            .map_err(|e| error("serialization", e.to_string()))?
            + serialized_size(&inverse)
                .map_err(|e| error("serialization", e.to_string()))?;
        let budget = crate::capacity::expanded_value_limit();
        if bytes > budget {
            return Err(error(
                "history_budget",
                "This edit exceeds this session's working-memory undo budget",
            ));
        }
        self.retained_bytes -= self.redo.iter().map(|e| e.bytes).sum::<usize>();
        self.redo.clear();
        while self.undo.len() >= 80 || self.retained_bytes + bytes > budget {
            self.retained_bytes -= self.undo.remove(0).bytes;
        }
        self.undo.push(Entry {
            forward: forward.clone(),
            inverse,
            bytes,
        });
        self.retained_bytes += bytes;
        self.document_bytes = serialized_size(&candidate)
            .map_err(|e| error("serialization", e.to_string()))?;
        self.document = candidate;
        self.revision += 1;
        Ok(self.result(forward))
    }
    pub fn undo(&mut self) -> Result<EditResult, EditError> {
        if self.transaction.is_some() {
            return Err(error(
                "active_transaction",
                "Cancel the preview before undo",
            ));
        }
        let Some(entry) = self.undo.last() else {
            return Ok(self.result(DocumentPatch::default()));
        };
        let next = entry.inverse.apply(&self.document)?;
        let patch = entry.inverse.clone();
        let entry = self.undo.pop().expect("checked undo entry");
        self.redo.push(entry);
        self.document_bytes = serialized_size(&next)
            .map_err(|e| error("serialization", e.to_string()))?;
        self.document = next;
        self.revision += 1;
        Ok(self.result(patch))
    }
    pub fn redo(&mut self) -> Result<EditResult, EditError> {
        if self.transaction.is_some() {
            return Err(error(
                "active_transaction",
                "Cancel the preview before redo",
            ));
        }
        let Some(entry) = self.redo.last() else {
            return Ok(self.result(DocumentPatch::default()));
        };
        let next = entry.forward.apply(&self.document)?;
        let patch = entry.forward.clone();
        let entry = self.redo.pop().expect("checked redo entry");
        self.undo.push(entry);
        self.document_bytes = serialized_size(&next)
            .map_err(|e| error("serialization", e.to_string()))?;
        self.document = next;
        self.revision += 1;
        Ok(self.result(patch))
    }
    pub fn begin(&mut self, revision: u64) -> Result<(), EditError> {
        self.check_revision(revision)?;
        if self.transaction.is_some() {
            return Err(error("active_transaction", "A transaction is already open"));
        }
        self.transaction = Some(self.document.clone());
        Ok(())
    }
    pub fn preview(&mut self, patch: DocumentPatch) -> Result<EditResult, EditError> {
        let base = self
            .transaction
            .as_ref()
            .ok_or_else(|| error("no_transaction", "Begin a transaction first"))?;
        let next = patch.apply(base)?;
        let changes = DocumentPatch::between(&self.document, &next)?;
        self.document_bytes = serialized_size(&next)
            .map_err(|e| error("serialization", e.to_string()))?;
        self.document = next;
        Ok(self.result(changes))
    }
    pub fn cancel(&mut self) -> Result<EditResult, EditError> {
        let Some(base) = self.transaction.take() else {
            return Ok(self.result(DocumentPatch::default()));
        };
        let patch = DocumentPatch::between(&self.document, &base)?;
        self.document_bytes = serialized_size(&base)
            .map_err(|e| error("serialization", e.to_string()))?;
        self.document = base;
        Ok(self.result(patch))
    }
    pub fn commit(&mut self) -> Result<EditResult, EditError> {
        let base = self
            .transaction
            .take()
            .ok_or_else(|| error("no_transaction", "Begin a transaction first"))?;
        let candidate = std::mem::replace(&mut self.document, base);
        self.publish(candidate)
    }
}


#[cfg(test)]
mod applied_document_size_tests {
    use super::*;
    use serde_json::json;

    fn source() -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 2, "id": "size-receipt", "name": "size",
            "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["n"]}],
            "nodes": {"n": {"id": "n", "kind": "rectangle", "width": 16, "height": 20}}
        })).unwrap()
    }

    fn check(before: &Document, patch: &DocumentPatch) -> Document {
        let original = serde_json::to_vec(before).unwrap();
        let (document, bytes) = patch.apply_with_size(before).unwrap().into_parts();
        assert_eq!(bytes, serde_json::to_vec(&document).unwrap().len());
        assert!(bytes > 0, "an unchanged document is not a zero-byte receipt");
        assert_eq!(patch.apply(before).unwrap(), document, "the existing wrapper stays identical");
        assert_eq!(serde_json::to_vec(before).unwrap(), original, "application does not mutate the base");
        document
    }

    #[test]
    fn checked_receipt_covers_noop_escaping_schema_and_numeric_lengths() {
        let before = source();
        assert_eq!(check(&before, &DocumentPatch::default()), before);
        let mut next = before.clone();
        next.name = "引号\"\n反斜杠\\🦀".into();
        next.schema_version = 16;
        for x in [0.0, -0.0, -123456.875, 0.000000125, 9999999.25] {
            next.nodes.get_mut("n").unwrap().transform.0[4] = x;
            // Explicitly include the node: f64 PartialEq considers +0 and -0
            // equal, so `between` alone is not evidence that -0 was applied.
            let mut patch = DocumentPatch::between(&before, &next).unwrap();
            patch.nodes.insert("n".into(), Some(next.nodes["n"].clone()));
            let actual = check(&before, &patch);
            assert_eq!(actual.nodes["n"].transform.0[4].to_bits(), x.to_bits());
            assert_eq!(serde_json::to_vec(&actual).unwrap(), serde_json::to_vec(&next).unwrap());
        }
    }

    #[test]
    fn checked_receipt_matches_actual_document_after_removal() {
        let before = source();
        let mut next = before.clone();
        next.nodes.remove("n");
        next.pages[0].children.clear();
        assert_eq!(check(&before, &DocumentPatch::between(&before, &next).unwrap()), next);
    }

    #[test]
    fn checked_receipt_errors_match_wrapper_and_leave_base_unchanged() {
        let before = source();
        let original = serde_json::to_vec(&before).unwrap();
        let mut invalid_node = before.nodes["n"].clone();
        invalid_node.transform.0[4] = f64::NAN;
        let patches = [
            DocumentPatch { nodes: [("n".into(), Some(invalid_node))].into(), fields: BTreeMap::new() },
            DocumentPatch { nodes: BTreeMap::new(), fields: [("schemaVersion".into(), json!(0))].into() },
            DocumentPatch { nodes: BTreeMap::new(), fields: [("unknownReceiptField".into(), json!(1))].into() },
            DocumentPatch { nodes: [("n".into(), None)].into(), fields: BTreeMap::new() },
        ];
        for patch in patches {
            let checked = patch.apply_with_size(&before).err().expect("must not issue a receipt");
            assert_eq!(checked, patch.apply(&before).unwrap_err());
            assert_eq!(serde_json::to_vec(&before).unwrap(), original);
        }
    }

    #[test]
    fn exact_counter_preserves_inclusive_byte_budget_boundary() {
        let document = source();
        let bytes = serde_json::to_vec(&document).unwrap().len();
        assert_eq!(count_json_bytes(&document, bytes).unwrap(), bytes);
        assert!(count_json_bytes(&document, bytes - 1).is_err());
    }

    #[test]
    fn wrapper_history_undo_redo_keeps_exact_document_accounting() {
        let before = source();
        let mut next = before.clone();
        next.name = "renamed \"文档\"".into();
        next.nodes.get_mut("n").unwrap().transform.0[4] = -1234.875;
        let mut editor = DocumentEditor::new(before.clone()).unwrap();
        editor.apply(0, DocumentPatch::between(&before, &next).unwrap()).unwrap();
        assert_eq!(editor.document(), &next);
        assert_eq!(editor.document_bytes, serde_json::to_vec(editor.document()).unwrap().len());
        editor.undo().unwrap();
        assert_eq!(editor.document(), &before);
        assert_eq!(editor.document_bytes, serde_json::to_vec(editor.document()).unwrap().len());
        editor.redo().unwrap();
        assert_eq!(editor.document(), &next);
        assert_eq!(editor.document_bytes, serde_json::to_vec(editor.document()).unwrap().len());
    }
}

#[cfg(test)]
mod receipt_failure_boundary_tests {
    use super::*;
    use serde_json::json;

    fn source() -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 2, "id": "receipt-failures", "name": "before",
            "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["n"]}],
            "nodes": {"n": {"id": "n", "kind": "rectangle", "width": 16, "height": 20}}
        })).unwrap()
    }

    #[test]
    fn invalid_font_never_issues_a_receipt_and_keeps_error_order() {
        let before = source();
        let serialized = serde_json::to_vec(&before).unwrap();
        let patch = DocumentPatch {
            nodes: Default::default(),
            fields: [("fonts".into(), json!({"bad": {"family": "Broken", "data": "!"}}))].into(),
        };
        let error = patch.apply_with_size(&before).err().unwrap();
        assert_eq!(error.code, "invalid_font");
        assert_eq!(error, patch.apply(&before).unwrap_err());
        assert_eq!(serde_json::to_vec(&before).unwrap(), serialized);
        let mut invalid = patch;
        invalid.fields.insert("schemaVersion".into(), json!(0));
        assert_eq!(invalid.apply_with_size(&before).err().unwrap().code, "invalid_document");
    }

    // This test changes the pinned process capacity. Run ALONE in a fresh
    // process with the exact filter documented in TEST-PLAN.md, never in the
    // ordinary parallel suite or alongside another ignored capacity test.
    #[test]
    #[ignore = "isolated process only: pins exact document capacity"]
    fn full_apply_receipt_preserves_exact_budget_boundary() {
        let before = source();
        let mut at_limit = before.clone();
        at_limit.name = "x".repeat(100);
        let exact = serde_json::to_vec(&at_limit).unwrap().len();
        crate::capacity::configure(exact as u64 * crate::capacity::REPRESENTATION_RESERVE).unwrap();
        assert_eq!(crate::capacity::document_byte_limit(), exact);
        let patch = DocumentPatch::between(&before, &at_limit).unwrap();
        let (actual, bytes) = patch.apply_with_size(&before).unwrap().into_parts();
        assert_eq!(bytes, exact);
        assert_eq!(actual, at_limit);
        let mut over = at_limit.clone();
        over.name.push('x');
        assert_eq!(serde_json::to_vec(&over).unwrap().len(), exact + 1);
        let rejected = DocumentPatch::between(&before, &over).unwrap();
        let error = rejected.apply_with_size(&before).err().unwrap();
        assert_eq!(error.code, "document_budget");
        assert_eq!(error, rejected.apply(&before).unwrap_err());
        assert_eq!(before.name, "before");
        let mut both = rejected;
        both.fields.insert("fonts".into(), json!({"bad": {"family": "Broken", "data": "!"}}));
        assert_eq!(both.apply_with_size(&before).err().unwrap().code, "document_budget",
            "the original byte-budget-before-font failure ordering is retained");
    }
}
