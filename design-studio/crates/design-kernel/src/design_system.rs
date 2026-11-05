//! Authored variables/styles. Resolution is deterministic and never evaluates code.
use crate::scene::{Document, Node};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignSystem {
    /// Imported font identities awaiting a real document font resource. These
    /// are provenance, never executable font references or variable bindings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub font_sources: BTreeMap<String, FontSource>,
    pub collections: BTreeMap<String, Collection>,
    pub variables: BTreeMap<String, Variable>,
    pub active_modes: BTreeMap<String, String>,
    pub styles: BTreeMap<String, SharedStyle>,
    pub libraries: BTreeMap<String, LibraryVersion>,
    /// Raw Sketch document-level payloads without a kernel-native home
    /// (sharedSwatches, foreign style/swatch lists, library metadata,
    /// per-shared-style color fidelity). Keyed by the document.json
    /// container name and re-emitted verbatim on `.sketch` export.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sketch_containers: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FontSource {
    pub style: Option<String>,
    pub runs: BTreeMap<String, String>,
    /// Source names the user explicitly replaced. Provenance stays in `style`
    /// and `runs`; a built-in substitute keeps font id `default`, so this set
    /// is what stops that layer from looking missing forever.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub resolved: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collection {
    pub name: String,
    pub modes: Vec<String>,
    pub default_mode: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Variable {
    pub name: String,
    pub collection: String,
    pub kind: String,
    pub values: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedStyle {
    pub name: String,
    pub kind: String,
    pub value: Value,
    /// Paint styles may carry the borders/shadows of a full Sketch layer
    /// style (22 号字典 §6: layerStyles objects hold fills + borders +
    /// shadows together). Applied to `strokes` alongside `fills`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub strokes: Vec<crate::scene::Stroke>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<crate::scene::Effect>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryVersion {
    #[serde(default)]
    pub page_id: Option<String>,
    pub name: String,
    pub version: u32,
    pub digest: String,
    pub component_ids: Vec<String>,
    #[serde(default)]
    pub node_map: BTreeMap<String, String>,
}

/// Persistent scopes keep inherited selections shared. In particular, long
/// collection/mode names in a small design system must not be copied once per
/// scene node (which would turn a valid small document into gigabytes of state).
#[derive(Clone, Default)]
pub(crate) struct Modes(Option<std::sync::Arc<ModeScope>>);
struct ModeScope {
    parent: Modes,
    selections: std::sync::Arc<BTreeMap<String, String>>,
}
impl Modes {
    fn with_shared(&self, selections: std::sync::Arc<BTreeMap<String, String>>) -> Self {
        if selections.is_empty() {
            return self.clone();
        }
        Self(Some(std::sync::Arc::new(ModeScope {
            parent: self.clone(),
            selections,
        })))
    }
    pub(crate) fn with(&self, selections: &BTreeMap<String, String>) -> Self {
        if selections.is_empty() {
            return self.clone();
        }
        self.with_shared(std::sync::Arc::new(selections.clone()))
    }
}
trait ModeSelection {
    fn mode(&self, collection: &str) -> Option<&str>;
}
impl ModeSelection for BTreeMap<String, String> {
    fn mode(&self, collection: &str) -> Option<&str> {
        self.get(collection).map(String::as_str)
    }
}
impl ModeSelection for Modes {
    fn mode(&self, collection: &str) -> Option<&str> {
        let mut scope = self.0.as_deref();
        while let Some(current) = scope {
            if let Some(mode) = current.selections.get(collection) {
                return Some(mode);
            }
            scope = current.parent.0.as_deref();
        }
        None
    }
}
pub fn value(
    system: &DesignSystem,
    id: &str,
    modes: &BTreeMap<String, String>,
) -> Result<Value, String> {
    value_in(system, id, modes)
}
fn value_in(system: &DesignSystem, id: &str, modes: &impl ModeSelection) -> Result<Value, String> {
    fn walk(
        s: &DesignSystem,
        id: &str,
        modes: &impl ModeSelection,
        seen: &mut BTreeSet<String>,
    ) -> Result<Value, String> {
        if seen.len() >= 64 || !seen.insert(id.into()) {
            return Err("Variable alias cycle or depth exceeded".into());
        }
        let v = s.variables.get(id).ok_or("Missing variable")?;
        let c = s
            .collections
            .get(&v.collection)
            .ok_or("Missing variable collection")?;
        let mode = modes.mode(&v.collection).unwrap_or(&c.default_mode);
        let x = v.values.get(mode).ok_or("Missing variable mode value")?;
        if let Some(alias) = x.get("alias").and_then(Value::as_str) {
            let target = s.variables.get(alias).ok_or("Missing variable alias")?;
            if target.kind != v.kind {
                return Err("Variable alias type mismatch".into());
            }
            walk(s, alias, modes, seen)
        } else {
            Ok(x.clone())
        }
    }
    walk(system, id, modes, &mut BTreeSet::new())
}
pub fn valid_property(path: &str) -> bool {
    matches!(path,"width"|"height"|"opacity"|"visible"|"text"|"fontSize"|"layout.gap"|"layout.lineGap"|"textStyle.weight"|"textStyle.lineHeight"|"textStyle.letterSpacing") ||
    path.strip_prefix("fills.").is_some_and(|v| { let mut p=v.split('.'); matches!((p.next(),p.next(),p.next()),(Some(i),Some("color"|"opacity"),None) if i.parse::<usize>().is_ok_and(|i|i<16)) })
}
fn expected(path: &str) -> &str {
    if path.ends_with("color") {
        "color"
    } else if path == "text" {
        "string"
    } else if path == "visible" {
        "boolean"
    } else {
        "number"
    }
}
pub fn set_path(root: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let parts: Vec<_> = path.split('.').collect();
    let mut target = root;
    for part in &parts[..parts.len() - 1] {
        target = if let Ok(i) = part.parse::<usize>() {
            target.get_mut(i)
        } else {
            target.get_mut(*part)
        }
        .ok_or("Binding property does not exist")?;
    }
    let key = parts.last().unwrap();
    let field = target
        .get_mut(*key)
        .ok_or("Binding property does not exist")?;
    *field = value;
    Ok(())
}
/// Node-side stroke/effect rules applied to a paint style's carried
/// borders/shadows (mirrors scene.rs `validate_nodes` checks so a style can
/// never inject parameters a node could not author).
fn validate_style_parts(doc: &Document, style: &SharedStyle) -> Result<(), String> {
    for paint in style.strokes.iter().map(|s| &s.paint) {
        if !paint.opacity.is_finite()
            || !(0. ..=1.).contains(&paint.opacity)
            || !paint.angle.is_finite()
            || paint.angle.abs() > 1e7
            || !matches!(
                paint.kind.as_str(),
                "solid" | "linear" | "radial" | "angular" | "diamond" | "image"
            )
            || paint.transform.is_some_and(|t| {
                t.0.iter().any(|v| !v.is_finite() || v.abs() > 1e7) || t.inverse().is_err()
            })
            || !matches!(paint.fit.as_str(), "cover" | "contain" | "stretch")
            || paint.stops.len() > crate::scene::MAX_GRADIENT_STOPS
            || !crate::blend::valid_mode(&paint.blend)
        {
            return Err("Invalid shared style stroke paint".into());
        }
        crate::color::pixel(doc.color_management, &paint.color, 1.)?;
        for stop in &paint.stops {
            if !stop.offset.is_finite() || !(0. ..=1.).contains(&stop.offset) {
                return Err("Invalid shared style gradient stop".into());
            }
            crate::color::pixel(doc.color_management, &stop.color, 1.)?;
        }
    }
    if style.strokes.len() > 16 {
        return Err("Invalid shared style stroke budget".into());
    }
    for s in &style.strokes {
        crate::stroke::validate(s)?;
    }
    if style.effects.len() > 16 {
        return Err("Invalid shared style effect budget".into());
    }
    for e in &style.effects {
        e.validate_material()?;
        crate::color::pixel(doc.color_management, &e.color, 1.)?;
        if [e.radius, e.spread, e.x, e.y, e.amount, e.opacity]
            .iter()
            .any(|v| !v.is_finite())
            || e.radius < 0.
            || e.radius > 1000.
            || !(0. ..=1.).contains(&e.opacity)
            || !matches!(
                e.kind.as_str(),
                "shadow"
                    | "inner-shadow"
                    | "blur"
                    | "background-blur"
                    | "glass"
                    | "noise"
                    | "texture"
                    | "color-controls"
                    | "gaussian-blur"
                    | "motion-blur" | "zoom-blur"
            )
        {
            return Err("Invalid shared style effect parameters".into());
        }
    }
    Ok(())
}
pub fn validate(doc: &Document) -> Result<(), String> {
    let Some(s) = &doc.design_system else {
        if doc.nodes.values().any(|n| {
            !n.bindings.is_empty()
                || !n.style_refs.is_empty()
                || !n.variable_modes.is_empty()
                || n.instance.as_ref().is_some_and(|i| {
                    i.overrides
                        .values()
                        .any(|f| f.contains_key("variableModes"))
                })
        }) {
            return Err("Bindings require a design system".into());
        }
        return Ok(());
    };
    if s.variables.len() > 4096
        || s.styles.len() > 4096
        || s.collections.len() > 128
        || s.libraries.len() > 128
    {
        return Err("Design system budget exceeded".into());
    }
    if s.font_sources.len() > 20_000 || s.font_sources.iter().any(|(id, source)| {
        id.len() > 256 || source.runs.len() > 4096
            || source.style.iter().chain(source.runs.values()).any(|s| s.is_empty() || s.len() > 512)
            || source.runs.keys().any(|index| index.parse::<usize>().is_err())
            || source.resolved.len() > 4097
            || source.resolved.iter().any(|name| {
                name.is_empty()
                    || name.len() > 512
                    || (source.style.as_ref() != Some(name) && !source.runs.values().any(|value| value == name))
            })
    }) {
        return Err("Invalid imported font identities".into());
    }
    for (id, c) in &s.collections {
        if id.is_empty()
            || c.name.len() > 512
            || c.modes.is_empty()
            || c.modes.len() > 32
            || !c.modes.contains(&c.default_mode)
            || c.modes.iter().collect::<BTreeSet<_>>().len() != c.modes.len()
        {
            return Err("Invalid collection modes".into());
        }
    }
    for (id, mode) in &s.active_modes {
        if !s
            .collections
            .get(id)
            .is_some_and(|c| c.modes.contains(mode))
        {
            return Err("Unknown active variable mode".into());
        }
    }
    for (id, v) in &s.variables {
        let c = s
            .collections
            .get(&v.collection)
            .ok_or("Missing variable collection")?;
        if id.is_empty()
            || v.name.len() > 512
            || v.values.len() != c.modes.len()
            || !matches!(v.kind.as_str(), "color" | "number" | "boolean" | "string")
        {
            return Err("Invalid variable".into());
        }
        for mode in &c.modes {
            let mut modes = s.active_modes.clone();
            modes.insert(v.collection.clone(), mode.clone());
            let x = value(s, id, &modes)?;
            let valid = match v.kind.as_str() {
                "color" => x
                    .as_str()
                    .is_some_and(|c| crate::color::pixel(doc.color_management, c, 1.).is_ok()),
                "number" => x.as_f64().is_some_and(|v| v.is_finite() && v.abs() <= 1e7),
                "boolean" => x.is_boolean(),
                _ => x.as_str().is_some_and(|s| s.len() <= 100000),
            };
            if !valid {
                return Err("Invalid typed variable value".into());
            }
        }
    }
    for style in s.styles.values() {
        match style.kind.as_str() {
            "paint" => {
                let _: Vec<crate::scene::Paint> =
                    serde_json::from_value(style.value.clone()).map_err(|e| e.to_string())?;
                if !style.strokes.is_empty() || !style.effects.is_empty() {
                    if doc.schema_version < 12 {
                        return Err("Shared style strokes/effects require schema 12".into());
                    }
                    validate_style_parts(doc, style)?;
                }
            }
            "text" => {
                let s: crate::font::TextStyle =
                    serde_json::from_value(style.value.clone()).map_err(|e| e.to_string())?;
                s.validate()?;
                if !style.strokes.is_empty() || !style.effects.is_empty() {
                    return Err("Only paint styles carry strokes/effects".into());
                }
            }
            "effect" => {
                let _: Vec<crate::scene::Effect> =
                    serde_json::from_value(style.value.clone()).map_err(|e| e.to_string())?;
                if !style.strokes.is_empty() || !style.effects.is_empty() {
                    return Err("Only paint styles carry strokes/effects".into());
                }
            }
            _ => return Err("Unknown shared style kind".into()),
        }
    }
    for n in doc.nodes.values() {
        validate_node(s, n)?;
        if let Some(instance) = &n.instance {
            for fields in instance.overrides.values() {
                if let Some(modes) = fields.get("variableModes") {
                    let modes: BTreeMap<String, String> = serde_json::from_value(modes.clone())
                        .map_err(|_| "Invalid node variable modes")?;
                    validate_modes(s, &modes)?;
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn validate_modes(
    s: &DesignSystem,
    modes: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (id, mode) in modes {
        if !s
            .collections
            .get(id)
            .is_some_and(|c| c.modes.contains(mode))
        {
            return Err("Unknown node variable mode".into());
        }
    }
    Ok(())
}
fn validate_node(s: &DesignSystem, n: &Node) -> Result<(), String> {
    validate_modes(s, &n.variable_modes)?;
    for (path, id) in &n.bindings {
        let v = s.variables.get(id).ok_or("Missing bound variable")?;
        if !valid_property(path) || v.kind != expected(path) {
            return Err("Variable/property type mismatch".into());
        }
    }
    for (field, id) in &n.style_refs {
        let style = s.styles.get(id).ok_or("Missing shared style")?;
        if !matches!(
            (field.as_str(), style.kind.as_str()),
            ("fills", "paint") | ("textStyle", "text") | ("effects", "effect")
        ) {
            return Err("Shared style/property mismatch".into());
        }
    }
    Ok(())
}
fn style_with_defaults(style: &SharedStyle) -> Result<Value, String> {
    fn normalize<T: DeserializeOwned + Serialize>(value: &Value) -> Result<Value, String> {
        let typed: T = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        serde_json::to_value(typed).map_err(|e| e.to_string())
    }
    // Shared styles store authored JSON, which may omit optional fields. Fill
    // those defaults before bindings address paths such as fills.0.opacity.
    match style.kind.as_str() {
        "paint" => normalize::<Vec<crate::scene::Paint>>(&style.value),
        "text" => normalize::<crate::font::TextStyle>(&style.value),
        "effect" => normalize::<Vec<crate::scene::Effect>>(&style.value),
        _ => Err("Unknown shared style kind".into()),
    }
}
/// Resolve effective references after component overrides have been merged.
/// Explicit top-level fields (including compound fields such as fills/layout)
/// win over bindings, which in turn win over shared styles.
pub(crate) fn resolve_node(
    system: Option<&DesignSystem>,
    n: &mut Node,
    modes: &Modes,
    overridden: impl Fn(&str) -> bool,
) -> Result<(), String> {
    if n.bindings.is_empty() && n.style_refs.is_empty() && n.variable_modes.is_empty() {
        return Ok(());
    }
    let s = system.ok_or("Bindings require a design system")?;
    // Overrides may introduce references that were absent during document
    // validation. Check them even when an explicit value masks their result.
    validate_node(s, n)?;
    let mut json = serde_json::to_value(&*n).map_err(|e| e.to_string())?;
    for (field, id) in &n.style_refs {
        if !overridden(field) {
            json[field] = style_with_defaults(&s.styles[id])?;
            // A paint style carrying borders/shadows (full Sketch layer
            // style) resolves them together with the fills it replaces.
            let shared = &s.styles[id];
            if field == "fills" && shared.kind == "paint" {
                if !shared.strokes.is_empty() && !overridden("strokes") {
                    json["strokes"] =
                        serde_json::to_value(&shared.strokes).map_err(|e| e.to_string())?;
                }
                if !shared.effects.is_empty() && !overridden("effects") {
                    json["effects"] =
                        serde_json::to_value(&shared.effects).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    for (field, id) in &n.bindings {
        if !overridden(field.split('.').next().unwrap()) {
            set_path(&mut json, field, value_in(s, id, modes)?)?;
        }
    }
    let mut next = serde_json::from_value(json).map_err(|e| e.to_string())?;
    crate::mutation::reconcile(n, &mut next, false, false);
    *n = next;
    Ok(())
}
pub(crate) struct NodeModeContext {
    pub inherited: Modes,
    pub effective: Modes,
}
/// Effective contexts in the authored/materialized tree. Definition ancestors
/// outside a placement's ancestry never contribute modes. Each source selection
/// map is retained only once, even when a large template has many placements.
pub(crate) fn node_mode_contexts(
    doc: &Document,
) -> Result<BTreeMap<String, NodeModeContext>, String> {
    use std::sync::Arc;
    let selections: BTreeMap<_, _> = doc
        .nodes
        .iter()
        .filter(|(_, n)| !n.variable_modes.is_empty())
        .map(|(id, n)| (id.as_str(), Arc::new(n.variable_modes.clone())))
        .collect();
    fn walk(
        doc: &Document,
        id: &str,
        inherited: &Modes,
        selections: &BTreeMap<&str, Arc<BTreeMap<String, String>>>,
        result: &mut BTreeMap<String, NodeModeContext>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 || result.contains_key(id) {
            return Err("Cyclic or repeated node mode ancestry".into());
        }
        let n = doc.nodes.get(id).ok_or("Missing mode ancestor")?;
        let mut modes = inherited.clone();
        if let Some(root) = n
            .instance
            .as_ref()
            .and_then(|i| i.overrides.get("$root"))
            .and_then(|f| f.get("variableModes"))
        {
            // An explicit map replaces template + placement selections, including {}.
            let local =
                serde_json::from_value(root.clone()).map_err(|_| "Invalid node variable modes")?;
            modes = modes.with_shared(Arc::new(local));
        } else {
            if let Some(template) = n
                .instance
                .as_ref()
                .and_then(|i| selections.get(i.component_id.as_str()))
            {
                modes = modes.with_shared(template.clone());
            }
            if let Some(local) = selections.get(id) {
                modes = modes.with_shared(local.clone());
            }
        }
        result.insert(
            id.into(),
            NodeModeContext {
                inherited: inherited.clone(),
                effective: modes.clone(),
            },
        );
        for child in &n.children {
            walk(doc, child, &modes, selections, result, depth + 1)?;
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    let modes = doc
        .design_system
        .as_ref()
        .map(|s| Modes::default().with(&s.active_modes))
        .unwrap_or_default();
    for page in &doc.pages {
        for id in &page.children {
            walk(doc, id, &modes, &selections, &mut result, 0)?;
        }
    }
    Ok(result)
}

pub fn resolve(doc: &mut Document) -> Result<(), String> {
    resolve_authored(doc)?;
    crate::components::resolve(doc)
}

/// Prepare authored component sources before rebuilding their materializations.
/// Generated layers may contain a binding masked by an explicit compound-field
/// override (e.g. fills: []); resolving those stale paths before expansion would
/// reject a valid document on its next edit or reload.
pub(crate) fn resolve_authored(doc: &mut Document) -> Result<(), String> {
    validate(doc)?;
    let contexts = node_mode_contexts(doc)?;
    let mut boolean_resizes = Vec::new();
    for n in doc
        .nodes
        .values_mut()
        .filter(|n| n.instance_origin.is_none())
    {
        let old_size = (n.width, n.height);
        let modes = &contexts[&n.id].effective;
        let placement = n.instance.is_some();
        // Builder takes geometry/paint/text from the main component, not its
        // placement's cached values. Of the placement fields Builder preserves,
        // visible is the only property that can have a variable binding.
        resolve_node(doc.design_system.as_ref(), n, modes, |field| {
            placement && field != "visible"
        })?;
        if n.boolean_operation.is_some() {
            boolean_resizes.push((
                n.children.clone(),
                n.width / old_size.0,
                n.height / old_size.1,
            ));
        }
    }
    for (children, sx, sy) in boolean_resizes {
        crate::mutation::resize_boolean_children(&mut doc.nodes, &children, sx, sy);
    }
    Ok(())
}

#[cfg(test)]
mod mode_scope_tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn resolved_font_names_round_trip_only_when_they_name_a_real_source() {
        let mut doc: Document = serde_json::from_value(json!({
            "schemaVersion":4,"id":"d","name":"Fonts",
            "pages":[{"id":"p","name":"Page","background":"#ffffff","children":[]}],
            "nodes":{},
            "designSystem":{"fontSources":{"text":{"style":"PingFang SC","runs":{"0":"PingFang SC Bold"},"resolved":["PingFang SC"]}}}
        }))
        .unwrap();
        validate(&doc).unwrap();
        let again = serde_json::to_value(&doc.design_system).unwrap();
        assert_eq!(again["fontSources"]["text"]["resolved"], json!(["PingFang SC"]));
        doc.design_system.as_mut().unwrap().font_sources.get_mut("text").unwrap().resolved.insert("Unknown".into());
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn long_mode_names_share_ancestor_and_template_storage() {
        let mut doc: Document = serde_json::from_value(json!({
            "schemaVersion":6,"id":"d","name":"Shared mode scopes",
            "pages":[{"id":"p","name":"Page","background":"#ffffff","children":[]}],
            "nodes":{},"designSystem":{}
        }))
        .unwrap();
        for i in 0..64 {
            let id = format!("collection{i}{}", "c".repeat(1024));
            let mode = "m".repeat(1024);
            let system = doc.design_system.as_mut().unwrap();
            system.collections.insert(
                id.clone(),
                Collection {
                    name: "Collection".into(),
                    modes: vec![mode.clone()],
                    default_mode: mode.clone(),
                },
            );
            system.active_modes.insert(id, mode);
        }
        let mut main: Node = serde_json::from_value(json!({
            "id":"main","kind":"frame","width":1,"height":1,"component":{}
        }))
        .unwrap();
        main.variable_modes = doc.design_system.as_ref().unwrap().active_modes.clone();
        doc.nodes.insert("main".into(), main);
        doc.pages[0].children.push("main".into());
        for i in 0..512 {
            let id = format!("node{i}");
            let n: Node = serde_json::from_value(json!({
                "id":id,"kind":"frame","width":1,"height":1,
                "instance":{"componentId":"main"}
            }))
            .unwrap();
            doc.pages[0].children.push(id.clone());
            doc.nodes.insert(id, n);
        }
        doc.validate().unwrap();
        let contexts = node_mode_contexts(&doc).unwrap();
        let ancestor = contexts["main"].inherited.0.as_ref().unwrap();
        let template = &contexts["main"].effective.0.as_ref().unwrap().selections;
        for i in 0..512 {
            let context = &contexts[&format!("node{i}")];
            assert!(Arc::ptr_eq(context.inherited.0.as_ref().unwrap(), ancestor));
            assert!(Arc::ptr_eq(
                &context.effective.0.as_ref().unwrap().selections,
                template
            ));
        }
        // Removing the template's selections makes every effective scope share
        // the one document scope too, including binding-free legacy scenes.
        doc.nodes.get_mut("main").unwrap().variable_modes.clear();
        let contexts = node_mode_contexts(&doc).unwrap();
        let ancestor = contexts["main"].inherited.0.as_ref().unwrap();
        for context in contexts.values() {
            assert!(Arc::ptr_eq(context.effective.0.as_ref().unwrap(), ancestor));
        }
    }
}
