use crate::sketch::{Error, Result, archive, raw_json};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayerKind {
    Page,
    Group,
    ShapeGroup,
    ShapePath,
    Rectangle,
    Oval,
    Text,
    Bitmap,
    SymbolMaster,
    SymbolInstance,
    Artboard,
    CanvasFrame,
    Frame,
    Other(String),
}
impl LayerKind {
    fn parse(value: &str) -> Self {
        match value {
            "page" => Self::Page,
            "group" => Self::Group,
            "shapeGroup" => Self::ShapeGroup,
            "shapePath" => Self::ShapePath,
            "rectangle" => Self::Rectangle,
            "oval" => Self::Oval,
            "text" => Self::Text,
            "bitmap" => Self::Bitmap,
            "symbolMaster" => Self::SymbolMaster,
            "symbolInstance" => Self::SymbolInstance,
            "artboard" => Self::Artboard,
            "canvasFrame" => Self::CanvasFrame,
            "frame" => Self::Frame,
            other => Self::Other(other.to_owned()),
        }
    }
}

/// Native layer fields remain authoritative, including unknown fields. A page
/// is a real Sketch layer-tree root, never an extra node in a foreign document.
#[derive(Debug, Clone, PartialEq)]
pub struct Layer {
    fields: Map<String, Value>,
    // Exact original field fragments, excluding children (which retain their
    // own fragments). General scene JSON keeps the ordinary numeric contract.
    source_fields: BTreeMap<String, String>,
    children: Option<Vec<Layer>>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinConstraints {
    /// Raw low three bits (horizontal) and high three bits (vertical).
    /// Set bits denote flexible leading margin (4), size (2), trailing margin (1).
    /// `frame_for_parent_resize` solves a bounded legacy subset.
    pub horizontal: u8,
    pub vertical: u8,
}
impl Layer {
    fn parse(
        value: Value,
        source: &str,
        depth: usize,
        count: &mut usize,
        ids: &mut HashSet<String>,
    ) -> Result<Self> {
        if depth > 64 {
            return Err(Error::Limit("layer depth"));
        }
        *count += 1;
        if *count > 20_000 {
            return Err(Error::Limit("layer count"));
        }
        let Value::Object(mut fields) = value else {
            return Err(Error::Invalid("layer must be an object".into()));
        };
        let id = fields
            .get("do_objectID")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Missing("layer do_objectID".into()))?;
        if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) || id.contains('/') {
            return Err(Error::Invalid("layer identity".into()));
        }
        if !ids.insert(id.to_owned()) {
            return Err(Error::Ambiguous(format!("duplicate layer identity {id}")));
        }
        if fields.get("_class").and_then(Value::as_str).is_none() {
            return Err(Error::Missing("layer _class".into()));
        }
        let mut source_fields = raw_json::fields(source)?;
        let source_children: Vec<Box<serde_json::value::RawValue>> =
            match source_fields.remove("layers") {
                Some(raw) => {
                    serde_json::from_str(raw.get()).map_err(|e| Error::Invalid(e.to_string()))?
                }
                None => Vec::new(),
            };
        let children = match fields.remove("layers") {
            None => None,
            Some(Value::Array(children)) => Some(
                children
                    .into_iter()
                    .enumerate()
                    .map(|(index, v)| {
                        Self::parse(v, source_children[index].get(), depth + 1, count, ids)
                    })
                    .collect::<Result<_>>()?,
            ),
            Some(_) => return Err(Error::Invalid("layers must be an array".into())),
        };
        let source_fields = source_fields
            .into_iter()
            .map(|(key, raw)| (key, raw.get().to_owned()))
            .collect();
        Ok(Self {
            fields,
            source_fields,
            children,
        })
    }
    pub fn id(&self) -> &str {
        self.fields["do_objectID"]
            .as_str()
            .expect("validated layer id")
    }
    pub fn kind(&self) -> LayerKind {
        LayerKind::parse(
            self.fields["_class"]
                .as_str()
                .expect("validated layer class"),
        )
    }
    pub fn fields(&self) -> &Map<String, Value> {
        &self.fields
    }
    /// Exact source JSON for an unchanged field, including numbers outside
    /// f64/u64 precision. `fields()` remains a semantic JSON projection.
    pub fn native_field_json(&self, name: &str) -> Result<Option<String>> {
        self.fields
            .get(name)
            .map(|value| {
                raw_json::merge(value, self.source_fields.get(name).map(String::as_str))
                    .map(|raw| raw.get().to_owned())
            })
            .transpose()
    }

    fn to_native_json(&self) -> Result<Box<serde_json::value::RawValue>> {
        let mut fields = self
            .fields
            .iter()
            .map(|(key, value)| {
                Ok((
                    key.clone(),
                    raw_json::merge(value, self.source_fields.get(key).map(String::as_str))?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        if let Some(children) = &self.children {
            let children = children
                .iter()
                .map(Self::to_native_json)
                .collect::<Result<Vec<_>>>()?;
            fields.insert("layers".into(), raw_json::raw(&children)?);
        }
        raw_json::raw(&fields)
    }
    pub fn children(&self) -> &[Layer] {
        self.children.as_deref().unwrap_or_default()
    }
    pub fn to_native_value(&self) -> Value {
        let mut fields = self.fields.clone();
        if let Some(children) = &self.children {
            fields.insert(
                "layers".into(),
                Value::Array(children.iter().map(Self::to_native_value).collect()),
            );
        }
        Value::Object(fields)
    }
    pub fn resizing_constraints(&self) -> Result<Option<PinConstraints>> {
        let Some(value) = self.fields.get("resizingConstraint") else {
            return Ok(None);
        };
        let bits = value
            .as_u64()
            .filter(|v| *v <= 63)
            .ok_or_else(|| Error::Invalid("resizingConstraint is not a six-bit mask".into()))?;
        Ok(Some(PinConstraints {
            horizontal: (bits & 7) as u8,
            vertical: ((bits >> 3) & 7) as u8,
        }))
    }
    fn find(&self, id: &str) -> Option<&Layer> {
        if self.id() == id {
            Some(self)
        } else {
            self.children().iter().find_map(|n| n.find(id))
        }
    }
    fn ancestry<'a>(&'a self, id: &str, out: &mut Vec<&'a Layer>) -> bool {
        out.push(self);
        if self.id() == id {
            return true;
        }
        for child in self.children() {
            if child.ancestry(id, out) {
                return true;
            }
        }
        out.pop();
        false
    }
    fn find_mut(&mut self, id: &str) -> Option<&mut Layer> {
        if self.id() == id {
            return Some(self);
        }
        self.children
            .as_mut()?
            .iter_mut()
            .find_map(|n| n.find_mut(id))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativePage {
    archive_path: String,
    root: Layer,
}
impl NativePage {
    pub fn root(&self) -> &Layer {
        &self.root
    }
    pub fn archive_path(&self) -> &str {
        &self.archive_path
    }
}

#[derive(Debug, Clone)]
pub struct Document {
    files: BTreeMap<String, Vec<u8>>,
    native_document: Value,
    pages: Vec<NativePage>,
}
impl Document {
    pub fn from_sketch(bytes: &[u8]) -> Result<Self> {
        let files = archive::read(bytes)?;
        let parse = |name: &str| -> Result<Value> {
            let bytes = files.get(name).ok_or_else(|| Error::Missing(name.into()))?;
            serde_json::from_slice(bytes).map_err(|e| Error::Invalid(format!("{name}: {e}")))
        };
        let _meta = parse("meta.json")?;
        let native_document = parse("document.json")?;
        if native_document.get("_class").and_then(Value::as_str) != Some("document") {
            return Err(Error::Invalid("native document class".into()));
        }
        let refs = native_document
            .get("pages")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::Missing("native page references".into()))?;
        if refs.is_empty() || refs.len() > 100 {
            return Err(Error::Limit("page count"));
        }
        let mut pages = Vec::new();
        let mut paths = HashSet::new();
        let mut ids = HashSet::new();
        let mut count = 0;
        for reference in refs {
            let path = reference
                .get("_ref")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::Missing("page _ref".into()))?;
            if !path.starts_with("pages/") || !archive::safe_path(path) {
                return Err(Error::Invalid("native page reference path".into()));
            }
            let path = if path.ends_with(".json") {
                path.to_owned()
            } else {
                format!("{path}.json")
            };
            if !paths.insert(path.clone()) {
                return Err(Error::Ambiguous("repeated page reference".into()));
            }
            let source = std::str::from_utf8(
                files
                    .get(&path)
                    .ok_or_else(|| Error::Missing(path.clone()))?,
            )
            .map_err(|e| Error::Invalid(e.to_string()))?;
            let root = Layer::parse(parse(&path)?, source, 0, &mut count, &mut ids)?;
            if root.kind() != LayerKind::Page {
                return Err(Error::Invalid(
                    "page reference points to a non-page layer".into(),
                ));
            }
            pages.push(NativePage {
                archive_path: path,
                root,
            });
        }
        Ok(Self {
            files,
            native_document,
            pages,
        })
    }
    pub fn pages(&self) -> &[NativePage] {
        &self.pages
    }
    pub fn native_document(&self) -> &Value {
        &self.native_document
    }
    /// Opaque archive resources only. Page/document state is available through
    /// the authoritative typed tree, never stale pre-edit archive JSON.
    pub fn resource(&self, path: &str) -> Option<&[u8]> {
        if path == "document.json" || self.pages.iter().any(|page| page.archive_path == path) {
            return None;
        }
        self.files.get(path).map(Vec::as_slice)
    }
    pub fn layer(&self, id: &str) -> Option<&Layer> {
        self.pages.iter().find_map(|p| p.root.find(id))
    }
    fn layer_mut(&mut self, id: &str) -> Option<&mut Layer> {
        self.pages.iter_mut().find_map(|p| p.root.find_mut(id))
    }
    pub fn to_sketch(&self) -> Result<Vec<u8>> {
        let mut files = self.files.clone();
        for page in &self.pages {
            let value = page.root.to_native_value();
            // Preserve exact bytes for unedited JSON parts, including whitespace.
            let original: Value = serde_json::from_slice(&files[&page.archive_path])
                .map_err(|e| Error::Invalid(e.to_string()))?;
            if value != original {
                files.insert(
                    page.archive_path.clone(),
                    page.root.to_native_json()?.get().as_bytes().to_vec(),
                );
            }
        }
        archive::write(&files)
    }
    /// Manual local frame edit for plain native shape/bitmap leaves. Constraint
    /// metadata is retained, not interpreted as a second parent-resize command.
    /// Negative local positions are legal; sizes follow the existing frame bounds.
    /// Read-only capability query sharing exactly the frame-edit target checks.
    /// Returns the current native parent-local frame; creates no history or clone.
    pub fn editable_leaf_frame(&self, id: &str) -> Result<crate::sketch::Frame> {
        self.editable_leaf_target(id)?.legacy_frame()
    }
    fn editable_leaf_target(&self, id: &str) -> Result<&Layer> {
        let mut ancestry = Vec::new();
        if !self
            .pages
            .iter()
            .any(|page| page.root.ancestry(id, &mut ancestry))
        {
            return Err(Error::Missing(format!("layer {id}")));
        }
        let target = *ancestry.last().expect("found target");
        if !target.children().is_empty()
            || !matches!(
                target.kind(),
                LayerKind::Rectangle | LayerKind::Oval | LayerKind::ShapePath | LayerKind::Bitmap
            )
        {
            return Err(Error::Unsupported(
                "manual frame edit supports shape/bitmap leaves only".into(),
            ));
        }
        Self::require_geometry_edit_ancestry(&ancestry, "manual frame edit")?;
        target.legacy_frame()?;
        if let Some(pins) = target.resizing_constraints()?
            && (pins.horizontal == 0 || pins.vertical == 0)
        {
            return Err(Error::Unsupported("overconstrained legacy frame".into()));
        }
        if target.kind() == LayerKind::ShapePath {
            crate::sketch::CurveContour::from_layer(target)?;
        }
        Ok(target)
    }
    // Both manual leaf edits and legacy container resize stay inside the same
    // conservative native geometry-edit context. This is admission only; it
    // does not implement ancestor transforms, Symbol layout or auto-layout.
    fn require_geometry_edit_ancestry(ancestry: &[&Layer], operation: &str) -> Result<()> {
        for (index, node) in ancestry.iter().enumerate() {
            if index + 1 < ancestry.len()
                && !matches!(
                    node.kind(),
                    LayerKind::Page | LayerKind::Group | LayerKind::Artboard
                )
            {
                return Err(Error::Unsupported(format!(
                    "{operation} cannot traverse symbols or unsupported containers"
                )));
            }
            node.require_legacy_layout()?;
            for key in ["isLocked", "isFlippedHorizontal", "isFlippedVertical"] {
                if node
                    .fields
                    .get(key)
                    .is_some_and(|v| v.as_bool() != Some(false))
                {
                    return Err(Error::Unsupported(format!("{operation} rejects {key}")));
                }
            }
            if node.fields.get("groupLayout").is_some_and(|v| {
                v.get("_class").and_then(Value::as_str) != Some("MSImmutableFreeformGroupLayout")
            }) {
                return Err(Error::Unsupported(format!(
                    "{operation} requires freeform ancestry"
                )));
            }
        }
        Ok(())
    }
    pub fn set_leaf_frame(&mut self, id: &str, frame: crate::sketch::Frame) -> Result<()> {
        frame.validate()?;
        let target = self.editable_leaf_target(id)?;
        let mut replacement = target.clone();
        let native = replacement
            .fields
            .get_mut("frame")
            .expect("validated frame");
        native["x"] = Value::from(frame.x);
        native["y"] = Value::from(frame.y);
        native["width"] = Value::from(frame.width);
        native["height"] = Value::from(frame.height);
        // Native points/handles remain normalized. Validate the resulting pixel
        // projection using the existing geometry boundary, never rewrite points.
        if replacement.kind() == LayerKind::ShapePath {
            crate::sketch::CurveContour::from_layer(&replacement)?;
        }
        *self.layer_mut(id).expect("validated target") = replacement;
        Ok(())
    }
    /// Explicit legacy freeform edit. Every proposal and serialized frame is
    /// prepared before the sole replacement; failures leave all native data intact.
    pub fn resize_legacy_container(&mut self, id: &str, width: f64, height: f64) -> Result<()> {
        let mut ancestry = Vec::new();
        if !self
            .pages
            .iter()
            .any(|page| page.root.ancestry(id, &mut ancestry))
        {
            return Err(Error::Missing(format!("layer {id}")));
        }
        let parent = *ancestry.last().expect("found resize container");
        if !matches!(parent.kind(), LayerKind::Group | LayerKind::Artboard) {
            return Err(Error::Unsupported("legacy group/artboard required".into()));
        }
        Self::require_geometry_edit_ancestry(&ancestry, "legacy container resize")?;
        if parent.fields.get("groupLayout").is_some_and(|v| {
            v.get("_class").and_then(Value::as_str) != Some("MSImmutableFreeformGroupLayout")
        }) || parent
            .fields
            .get("resizesContent")
            .is_some_and(|v| v.as_bool() != Some(true))
        {
            return Err(Error::Unsupported(
                "container does not use freeform content resizing".into(),
            ));
        }
        let frame = parent.legacy_frame()?;
        if [width, height]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.5 || *v > 1e9)
        {
            return Err(Error::Invalid("invalid requested container size".into()));
        }
        let old = crate::sketch::Size {
            width: frame.width,
            height: frame.height,
        };
        let new = crate::sketch::Size { width, height };
        let mut frames = Vec::with_capacity(parent.children().len());
        for child in parent.children() {
            if !child.children().is_empty()
                || !matches!(
                    child.kind(),
                    LayerKind::Rectangle
                        | LayerKind::Oval
                        | LayerKind::ShapePath
                        | LayerKind::Bitmap
                )
            {
                return Err(Error::Unsupported(
                    "resize supports direct shape/bitmap leaves only".into(),
                ));
            }
            let f = child.frame_for_parent_resize(old, new)?;
            let mut native = child.fields["frame"].clone();
            native["x"] = Value::from(f.x);
            native["y"] = Value::from(f.y);
            native["width"] = Value::from(f.width);
            native["height"] = Value::from(f.height);
            frames.push(native);
        }
        let mut replacement = parent.clone();
        replacement.fields.get_mut("frame").unwrap()["width"] = Value::from(width);
        replacement.fields.get_mut("frame").unwrap()["height"] = Value::from(height);
        if let Some(children) = replacement.children.as_mut() {
            for (child, frame) in children.iter_mut().zip(frames) {
                child.fields.insert("frame".into(), frame);
                // Match leaf-frame edits: normalized handles may exceed the
                // supported local-coordinate bounds after an otherwise valid
                // resize. Validate the replacement before any live-tree write.
                if child.kind() == LayerKind::ShapePath {
                    crate::sketch::CurveContour::from_layer(child)?;
                }
            }
        }
        // No fallible operation after this point. Identity was validated above.
        *self
            .layer_mut(id)
            .expect("validated parent remains present") = replacement;
        Ok(())
    }
    pub fn rename_layer(&mut self, id: &str, name: &str) -> Result<()> {
        if name.encode_utf16().count() > 200 || name.chars().any(char::is_control) {
            return Err(Error::Invalid("layer name".into()));
        }
        let layer = self
            .layer_mut(id)
            .ok_or_else(|| Error::Missing(format!("layer {id}")))?;
        layer
            .fields
            .insert("name".into(), Value::String(name.into()));
        Ok(())
    }
    // Native sample: 22-sketch-json-dictionary.md section 5; converter_instance
    // convert_override maps each guid to do_objectID and joins with '/'. Symbol
    // swaps are separate *_symbolID records. Until their inheritance/precedence
    // is implemented, reject them instead of resolving text against a stale master.
    fn require_unswapped_instance(instance: &Layer) -> Result<()> {
        if !instance.children().is_empty() {
            return Err(Error::Unsupported(
                "symbol instance with embedded children".into(),
            ));
        }
        if let Some(value) = instance.fields.get("overrideValues") {
            let values = value
                .as_array()
                .ok_or_else(|| Error::Invalid("overrideValues must be an array".into()))?;
            if values.len() > 4096 {
                return Err(Error::Limit("symbol overrides"));
            }
            for record in values {
                let name = record
                    .get("overrideName")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::Invalid("missing native override name".into()))?;
                if name.ends_with("_symbolID") {
                    return Err(Error::Unsupported(
                        "nested symbol swap resolution is unsupported".into(),
                    ));
                }
            }
        }
        Ok(())
    }
    /// Bounded native ID discovery. This is not Symbol layout or rendered inheritance.
    pub fn text_override_targets(&self, instance_id: &str) -> Result<Vec<TextOverrideTarget>> {
        let resolver = SymbolResolver::new(self);
        let instance = resolver.instance(instance_id)?;
        Self::require_unswapped_instance(instance)?;
        let symbol = SymbolResolver::symbol(instance)?;
        let root = resolver.master(symbol)?;
        let mut walk = TargetWalk {
            resolver: &resolver,
            visited: HashSet::from([symbol]),
            visits: 0,
            bytes: 0,
            targets: Vec::new(),
        };
        for child in root.children() {
            walk.visit(child, "", 1)?;
        }
        Ok(walk.targets)
    }
    /// Reports this instance's explicit record and the master source separately.
    /// Neither absence nor master text claims the final inherited/rendered value.
    pub fn text_override_value(
        &self,
        instance_id: &str,
        target_path: &str,
    ) -> Result<TextOverrideValue> {
        let resolver = SymbolResolver::new(self);
        let (instance, target) = resolver.text_target(instance_id, target_path)?;
        Self::require_unswapped_instance(instance)?;
        let key = format!("{target_path}_stringValue");
        let explicit_text = match instance.fields.get("overrideValues") {
            None => None,
            Some(Value::Array(values)) => {
                if values.len() > 4096 {
                    return Err(Error::Limit("symbol overrides"));
                }
                let mut matches = values
                    .iter()
                    .filter(|v| v.get("overrideName").and_then(Value::as_str) == Some(&key));
                let found = matches.next();
                if matches.next().is_some() {
                    return Err(Error::Ambiguous("duplicate native override record".into()));
                }
                match found {
                    None => None,
                    Some(record) => {
                        Some(bounded_text(record.get("value").ok_or_else(|| {
                            Error::Invalid("missing override value".into())
                        })?)?)
                    }
                }
            }
            Some(_) => return Err(Error::Invalid("overrideValues must be an array".into())),
        };
        let master_text = match target.fields.get("attributedString") {
            None => None,
            Some(Value::Object(value)) => value.get("string").map(bounded_text).transpose()?,
            Some(_) => return Err(Error::Invalid("invalid master attributedString".into())),
        };
        Ok(TextOverrideValue {
            explicit_text,
            master_text,
        })
    }
    /// Set the instance's native override record, without editing its master or
    /// flattening its inherited subtree. Unswapped local nested instances are
    /// resolved one boundary at a time; external, swapped and cyclic paths refuse.
    pub fn set_text_override(
        &mut self,
        instance_id: &str,
        target_path: &str,
        text: &str,
    ) -> Result<()> {
        if text.encode_utf16().count() > 100_000 {
            return Err(Error::Limit("override text"));
        }
        let resolver = SymbolResolver::new(self);
        let (instance, _) = resolver.text_target(instance_id, target_path)?;
        let key = format!("{target_path}_stringValue");
        let mut overrides = match instance.fields.get("overrideValues") {
            None => Vec::new(),
            Some(Value::Array(values)) => values.clone(),
            Some(_) => return Err(Error::Invalid("overrideValues must be an array".into())),
        };
        if overrides.len() > 4096 {
            return Err(Error::Limit("symbol overrides"));
        }
        let matches: Vec<_> = overrides
            .iter()
            .enumerate()
            .filter(|(_, v)| v.get("overrideName").and_then(Value::as_str) == Some(&key))
            .map(|(i, _)| i)
            .collect();
        if matches.len() > 1 {
            return Err(Error::Ambiguous("duplicate native override record".into()));
        }
        if let Some(index) = matches.first() {
            overrides[*index]
                .as_object_mut()
                .ok_or_else(|| Error::Invalid("override record".into()))?
                .insert("value".into(), Value::String(text.into()));
        } else {
            if overrides.len() == 4096 {
                return Err(Error::Limit("symbol overrides"));
            }
            overrides.push(
                serde_json::json!({"_class":"overrideValue","overrideName":key,"value":text}),
            );
        }
        // All lookup/validation completes before the single authoritative change.
        self.layer_mut(instance_id)
            .expect("validated instance")
            .fields
            .insert("overrideValues".into(), Value::Array(overrides));
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOverrideTarget {
    pub target_path: String,
    pub layer_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOverrideValue {
    pub explicit_text: Option<String>,
    pub master_text: Option<String>,
}
fn bounded_text(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::Unsupported("non-string native text value".into()))?;
    if text.encode_utf16().count() > 100_000 {
        return Err(Error::Limit("override text"));
    }
    Ok(text.to_owned())
}
/// One index per operation avoids repeated full-document scans during discovery.
struct SymbolResolver<'a> {
    document: &'a Document,
    masters: BTreeMap<&'a str, Vec<&'a Layer>>,
}
impl<'a> SymbolResolver<'a> {
    fn new(document: &'a Document) -> Self {
        fn collect<'a>(layer: &'a Layer, index: &mut BTreeMap<&'a str, Vec<&'a Layer>>) {
            if layer.kind() == LayerKind::SymbolMaster
                && let Some(symbol) = layer.fields.get("symbolID").and_then(Value::as_str)
            {
                index.entry(symbol).or_default().push(layer);
            }
            for child in layer.children() {
                collect(child, index);
            }
        }
        let mut masters = BTreeMap::new();
        for page in &document.pages {
            collect(&page.root, &mut masters);
        }
        Self { document, masters }
    }
    fn master(&self, symbol: &str) -> Result<&'a Layer> {
        match self
            .masters
            .get(symbol)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            [master] => Ok(master),
            [] => Err(Error::Unsupported(format!(
                "symbol {symbol} has no local master; external resolution is unsupported"
            ))),
            masters => Err(Error::Ambiguous(format!(
                "symbol {symbol} resolves to {} masters",
                masters.len()
            ))),
        }
    }
    fn instance(&self, id: &str) -> Result<&'a Layer> {
        let instance = self
            .document
            .layer(id)
            .ok_or_else(|| Error::Missing("symbol instance".into()))?;
        if instance.kind() != LayerKind::SymbolInstance {
            return Err(Error::Unsupported(
                "override target is not a symbol instance".into(),
            ));
        }
        Ok(instance)
    }
    fn symbol(instance: &'a Layer) -> Result<&'a str> {
        instance
            .fields
            .get("symbolID")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Missing("instance symbolID".into()))
    }
    fn text_target(&self, instance_id: &str, target_path: &str) -> Result<(&'a Layer, &'a Layer)> {
        let path: Vec<&str> = target_path.split('/').collect();
        if path.is_empty() || path.len() > 64 || path.iter().any(|p| p.is_empty()) {
            return Err(Error::Invalid("override path".into()));
        }
        let instance = self.instance(instance_id)?;
        let symbol = Self::symbol(instance)?;
        let mut target = self.master(symbol)?;
        let mut visited = HashSet::from([symbol]);
        for id in path {
            if target.kind() == LayerKind::SymbolInstance {
                Document::require_unswapped_instance(instance)?;
                Document::require_unswapped_instance(target)?;
                let nested = Self::symbol(target)?;
                if !visited.insert(nested) {
                    return Err(Error::Unsupported("cyclic nested symbol reference".into()));
                }
                target = self.master(nested)?;
            }
            let matches: Vec<_> = target.children().iter().filter(|n| n.id() == id).collect();
            if matches.len() != 1 {
                return Err(Error::Ambiguous(format!(
                    "override path component {id} resolves to {} direct children",
                    matches.len()
                )));
            }
            target = matches[0];
        }
        if target.kind() != LayerKind::Text {
            return Err(Error::Unsupported(
                "stringValue override requires a text layer".into(),
            ));
        }
        Ok((instance, target))
    }
}
struct TargetWalk<'a, 'b> {
    resolver: &'b SymbolResolver<'a>,
    visited: HashSet<&'a str>,
    visits: usize,
    bytes: usize,
    targets: Vec<TextOverrideTarget>,
}
impl<'a> TargetWalk<'a, '_> {
    fn visit(&mut self, layer: &'a Layer, prefix: &str, depth: usize) -> Result<()> {
        self.visits += 1;
        if self.visits > 4096 || depth > 64 {
            return Err(Error::Limit("text target traversal"));
        }
        let path = if prefix.is_empty() {
            layer.id().to_owned()
        } else {
            format!("{prefix}/{}", layer.id())
        };
        if layer.kind() == LayerKind::Text {
            // Conservative JSON escaping upper bound; never return a silently partial list.
            self.bytes += 6 * (path.len() + layer.id().len()) + 64;
            if self.targets.len() >= 256 || self.bytes > 128 * 1024 {
                return Err(Error::Limit("text target response"));
            }
            self.targets.push(TextOverrideTarget {
                target_path: path.clone(),
                layer_id: layer.id().into(),
            });
        }
        if layer.kind() == LayerKind::SymbolInstance {
            Document::require_unswapped_instance(layer)?;
            let symbol = SymbolResolver::symbol(layer)?;
            if !self.visited.insert(symbol) {
                return Err(Error::Unsupported("cyclic nested symbol reference".into()));
            }
            let master = self.resolver.master(symbol)?;
            for child in master.children() {
                self.visit(child, &path, depth + 1)?;
            }
            self.visited.remove(symbol);
        } else {
            for child in layer.children() {
                self.visit(child, &path, depth + 1)?;
            }
        }
        Ok(())
    }
}
