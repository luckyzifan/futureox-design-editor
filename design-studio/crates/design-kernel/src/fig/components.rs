//! Resolve native component GUIDs only after the complete template tree exists.
use super::{bool_of, f64_of, guid_string, str_of, Error, FigImporter};
use crate::components::{Component, Instance, Property, PropertyKind};
use crate::math::Transform;
use crate::scene::{Document, Node, Stroke};
use crate::stroke::Marker;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn property_value(kind: &PropertyKind, value: &Value) -> Option<Value> {
    match kind {
        PropertyKind::Boolean => value.get("boolValue").filter(|v| v.is_boolean()).cloned(),
        PropertyKind::Text => value
            .pointer("/textValue/characters")
            .filter(|v| v.is_string())
            .cloned(),
        PropertyKind::InstanceSwap => value
            .get("guidValue")
            .map(|v| Value::String(guid_string(v))),
    }
}
fn descendants(doc: &Document, root: &str) -> Result<Vec<String>, Error> {
    let mut pending = doc.nodes[root].children.clone();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) {
            return Err(Error::Malformed("cyclic component template".into()));
        }
        if let Some(n) = doc.nodes.get(&id) {
            if n.instance.is_none() {
                pending.extend(n.children.clone());
            }
            out.push(id);
        }
    }
    Ok(out)
}

const IGNORED: &[&str] = &[
    "guid",
    "guidPath",
    "overrideKey",
    "parentIndex",
    "phase",
    "styleID",
    "type",
];
const STROKE_INPUTS: &[&str] = &[
    "strokeWeight",
    "strokeAlign",
    "strokeCap",
    "strokeJoin",
    "dashPattern",
    "borderStrokeWeightsIndependent",
    "borderTopWeight",
    "borderRightWeight",
    "borderBottomWeight",
    "borderLeftWeight",
];
const LAYOUT_KEYS: &[&str] = &[
    "stackMode",
    "stackSpacing",
    "stackCounterSpacing",
    "stackHorizontalPadding",
    "stackVerticalPadding",
    "stackPaddingRight",
    "stackPaddingBottom",
    "stackPadding",
    "stackWrap",
    "stackPrimaryAlignItems",
    "stackCounterAlignItems",
    "stackPrimarySizing",
    "stackCounterSizing",
    "stackPositioning",
    "stackChildPrimaryGrow",
    "stackChildAlignSelf",
    "stackCounterAlign",
    "stackJustify",
    "stackAlign",
    "stackWidth",
    "stackHeight",
    "stackCounterAlignContent",
    "minSize",
    "maxSize",
    "horizontalConstraint",
    "verticalConstraint",
];
const TEXT_KEYS: &[&str] = &[
    "textAlignHorizontal",
    "textAlignVertical",
    "textAutoResize",
    "lineHeight",
    "letterSpacing",
    "paragraphSpacing",
    "paragraphIndent",
    "textCase",
    "fontName",
    "textDecoration",
];
const CORNER_KEYS: &[(&str, usize)] = &[
    ("rectangleTopLeftCornerRadius", 0),
    ("rectangleTopRightCornerRadius", 1),
    ("rectangleBottomRightCornerRadius", 2),
    ("rectangleBottomLeftCornerRadius", 3),
];
const DERIVED_TEXT_KEYS: &[&str] = &[
    "baselines",
    "blockquotes",
    "decorations",
    "derivedLines",
    "fallbackFonts",
    "fontMetaData",
    "glyphs",
    "hyperlinkBoxes",
    "layoutSize",
    "layoutVersion",
    "lines",
    "logicalIndexToCharacterOffsetMap",
    "mentionBoxes",
    "minContentHeight",
    "truncatedHeight",
    "truncationStartIndex",
];

struct Variables {
    id_by_key: BTreeMap<String, String>,
    kind_by_id: BTreeMap<String, String>,
    collection_by_set: BTreeMap<String, String>,
    collection_modes: BTreeMap<String, Vec<String>>,
    mode_name: BTreeMap<String, String>,
}

fn finite_in(value: &Value, lo: f64, hi: f64) -> Option<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && (lo..=hi).contains(v))
}

fn binding_path(field: &str) -> Option<&'static str> {
    Some(match field {
        "WIDTH" => "width",
        "HEIGHT" => "height",
        "OPACITY" => "opacity",
        "VISIBLE" => "visible",
        "TEXT_DATA" => "text",
        "FONT_SIZE" => "fontSize",
        "STACK_SPACING" => "layout.gap",
        "STACK_COUNTER_SPACING" => "layout.lineGap",
        "LETTER_SPACING" => "textStyle.letterSpacing",
        "LINE_HEIGHT" => "textStyle.lineHeight",
        _ => return None,
    })
}

fn binding_kind(path: &str) -> &'static str {
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

fn variables_from(records: &BTreeMap<String, Value>) -> Variables {
    let mut out = Variables {
        id_by_key: BTreeMap::new(),
        kind_by_id: BTreeMap::new(),
        collection_by_set: BTreeMap::new(),
        collection_modes: BTreeMap::new(),
        mode_name: BTreeMap::new(),
    };
    for (id, record) in records {
        if str_of(record, "type") != Some("VARIABLE_SET") {
            continue;
        }
        let collection = str_of(record, "key").unwrap_or(id).to_string();
        let mut modes = Vec::new();
        if let Some(list) = record.get("variableSetModes").and_then(Value::as_array) {
            for mode in list {
                let name = str_of(mode, "name")
                    .filter(|name| !name.is_empty())
                    .unwrap_or("Mode");
                if let Some(mode_id) = mode.get("id") {
                    out.mode_name.insert(guid_string(mode_id), name.to_string());
                }
                if !modes.iter().any(|existing: &String| existing == name) {
                    modes.push(name.to_string());
                }
            }
        }
        if modes.is_empty() {
            modes.push("Default".into());
        }
        if modes.len() > 32 {
            continue;
        }
        out.collection_by_set.insert(id.clone(), collection.clone());
        if let Some(key) = str_of(record, "key").filter(|key| !key.is_empty()) {
            out.collection_by_set
                .insert(key.to_string(), collection.clone());
        }
        out.collection_modes.insert(collection, modes);
    }
    for (id, record) in records {
        if str_of(record, "type") != Some("VARIABLE") {
            continue;
        }
        let kind = match str_of(record, "variableResolvedType").unwrap_or("") {
            "COLOR" => "color",
            "FLOAT" | "NUMBER" => "number",
            "BOOLEAN" => "boolean",
            "STRING" => "string",
            _ => "string",
        };
        out.kind_by_id.insert(id.clone(), kind.into());
        out.id_by_key.insert(id.clone(), id.clone());
        if let Some(key) = str_of(record, "key").filter(|key| !key.is_empty()) {
            out.id_by_key.insert(key.to_string(), id.clone());
        }
    }
    out
}

fn reference_guid(value: &Value) -> String {
    if value.get("guid").is_some() {
        guid_string(&value["guid"])
    } else {
        guid_string(value)
    }
}

fn alias_target(value: &Value, vars: &Variables) -> Option<String> {
    let alias = value.get("alias").or_else(|| value.get("variableAlias"))?;
    if let Some(key) = alias
        .get("assetRef")
        .and_then(|reference| str_of(reference, "key"))
        .filter(|key| !key.is_empty())
    {
        if let Some(id) = vars.id_by_key.get(key) {
            return Some(id.clone());
        }
    }
    let id = reference_guid(alias);
    (id != "fig-0-0" && vars.kind_by_id.contains_key(&id)).then_some(id)
}

fn detached_style(id: &str) -> bool {
    matches!(
        id,
        "fig-0-0" | "0:0" | "fig-4294967295-4294967295" | "4294967295:4294967295"
    )
}

fn style_field(key: &str) -> Option<&'static str> {
    Some(match key {
        "styleIdForFill" => "fills",
        "styleIdForStrokeFill" => "strokes",
        "styleIdForEffect" => "effects",
        "styleIdForText" => "textStyle",
        _ => return None,
    })
}

fn style_matches(doc: &Document, id: &str, field: &str) -> bool {
    let Some(style) = doc
        .design_system
        .as_ref()
        .and_then(|system| system.styles.get(id))
    else {
        return false;
    };
    match field {
        "fills" => style.kind == "paint" && style.strokes.is_empty(),
        "strokes" => style.kind == "paint" && !style.strokes.is_empty(),
        "effects" => style.kind == "effect",
        "textStyle" => style.kind == "text",
        _ => false,
    }
}

fn target_id(path: &str, component_id: &str) -> String {
    if path == "$root" {
        component_id.to_string()
    } else {
        path.rsplit('/').next().unwrap_or(path).to_string()
    }
}

fn positive_axis(value: &Value) -> Option<f64> {
    finite_in(value, f64::MIN_POSITIVE, 1e7).filter(|v| *v > 0.)
}

fn dash_pattern(value: &Value) -> Option<String> {
    let items = value.as_array()?;
    let mut parts = Vec::new();
    for item in items {
        let number = item
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0. && *v <= 1e7)?;
        parts.push(format!("{number}"));
    }
    Some(parts.join(" "))
}

fn stroke_align(value: Option<&str>) -> Option<&'static str> {
    Some(match value.unwrap_or("CENTER") {
        "INSIDE" => "inside",
        "OUTSIDE" => "outside",
        "CENTER" => "center",
        _ => return None,
    })
}

fn stroke_join(value: Option<&str>) -> Option<&'static str> {
    Some(match value.unwrap_or("MITER") {
        "ROUND" => "round",
        "BEVEL" => "bevel",
        "MITER" => "miter",
        _ => return None,
    })
}

fn uniform_border(ov: &Value, base: f64, unsupported: &mut BTreeSet<String>) -> f64 {
    if bool_of(ov, "borderStrokeWeightsIndependent") != Some(true) {
        return base;
    }
    let borders = [
        "borderTopWeight",
        "borderRightWeight",
        "borderBottomWeight",
        "borderLeftWeight",
    ]
    .map(|key| ov.get(key).and_then(|value| finite_in(value, 0., 10000.)));
    if let Some(first) = borders[0] {
        if borders
            .iter()
            .all(|value| value.is_some_and(|item| (item - first).abs() < 1e-9))
        {
            return first;
        }
    }
    unsupported.insert("borderStrokeWeightsIndependent".into());
    base
}

fn apply_stroke_attrs(stroke: &mut Stroke, ov: &Value, unsupported: &mut BTreeSet<String>) {
    if let Some(weight) = ov.get("strokeWeight") {
        match finite_in(weight, 0., 10000.) {
            Some(weight) => stroke.width = uniform_border(ov, weight, unsupported),
            None => {
                unsupported.insert("strokeWeight".into());
            }
        }
    } else if ov.get("borderStrokeWeightsIndependent").is_some() {
        stroke.width = uniform_border(ov, stroke.width, unsupported);
    }
    if ov.get("strokeAlign").is_some() {
        match stroke_align(str_of(ov, "strokeAlign")) {
            Some(align) => stroke.align = align.into(),
            None => {
                unsupported.insert("strokeAlign".into());
            }
        }
    }
    if ov.get("strokeJoin").is_some() {
        match stroke_join(str_of(ov, "strokeJoin")) {
            Some(join) => stroke.join = join.into(),
            None => {
                unsupported.insert("strokeJoin".into());
            }
        }
    }
    if ov.get("strokeCap").is_some() {
        let cap = FigImporter::stroke_cap(str_of(ov, "strokeCap"));
        if let Some(name) = cap.2 {
            unsupported.insert(format!("strokeCap={name}"));
        } else {
            stroke.cap = cap.0.into();
            stroke.end_marker = cap.1;
        }
    }
    if let Some(pattern) = ov.get("dashPattern") {
        match dash_pattern(pattern) {
            Some(dash) => stroke.dash = dash,
            None => {
                unsupported.insert("dashPattern".into());
            }
        }
    }
}

fn strokes_from_paints(
    importer: &FigImporter,
    ov: &Value,
    unsupported: &mut BTreeSet<String>,
) -> Vec<Stroke> {
    let weight = ov
        .get("strokeWeight")
        .and_then(|value| finite_in(value, 0., 10000.))
        .unwrap_or(1.);
    if ov.get("strokeWeight").is_some() && finite_in(&ov["strokeWeight"], 0., 10000.).is_none() {
        unsupported.insert("strokeWeight".into());
    }
    let weight = uniform_border(ov, weight, unsupported);
    let align = match stroke_align(str_of(ov, "strokeAlign")) {
        Some(align) => align,
        None => {
            unsupported.insert("strokeAlign".into());
            "center"
        }
    };
    let join = match stroke_join(str_of(ov, "strokeJoin")) {
        Some(join) => join,
        None => {
            unsupported.insert("strokeJoin".into());
            "miter"
        }
    };
    let cap = FigImporter::stroke_cap(str_of(ov, "strokeCap"));
    if let Some(name) = &cap.2 {
        unsupported.insert(format!("strokeCap={name}"));
    }
    let dash = ov
        .get("dashPattern")
        .and_then(dash_pattern)
        .unwrap_or_default();
    if ov.get("dashPattern").is_some() && dash_pattern(&ov["dashPattern"]).is_none() {
        unsupported.insert("dashPattern".into());
    }
    let mut notes = Vec::new();
    let mut strokes = Vec::new();
    for paint in ov
        .get("strokePaints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(paint) = importer.paint(paint, &mut notes) {
            strokes.push(Stroke {
                start_marker: Marker::None,
                end_marker: cap.1,
                id: String::new(),
                paint,
                width: weight,
                align: align.into(),
                cap: cap.0.into(),
                join: join.into(),
                dash: dash.clone(),
                dash_offset: 0.,
                visible: true,
                width_profile: Vec::new(),
            });
        }
    }
    for note in notes {
        unsupported.insert(format!("strokePaints:{note}"));
    }
    strokes
}

fn store_strokes(
    fields: &mut BTreeMap<String, Value>,
    strokes: Vec<Stroke>,
    unsupported: &mut BTreeSet<String>,
) {
    if strokes
        .iter()
        .any(|stroke| crate::stroke::validate(stroke).is_err())
    {
        unsupported.insert("strokes".into());
        return;
    }
    if let Ok(value) = serde_json::to_value(strokes) {
        fields.insert("strokes".into(), value);
    }
}

fn apply_corners(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    template: Option<&Node>,
    unsupported: &mut BTreeSet<String>,
) {
    let kind = template.map(|node| node.kind.as_str()).unwrap_or("");
    let polygon = matches!(kind, "polygon" | "star");
    if let Some(radius) = ov.get("cornerRadius") {
        match finite_in(radius, 0., 1e7) {
            Some(radius) if polygon => {
                fields.insert("cornerRadius".into(), json!(radius));
            }
            Some(_) if !polygon => {}
            _ => {
                unsupported.insert("cornerRadius".into());
            }
        }
    }
    if let Some(smoothing) = ov.get("cornerSmoothing") {
        match finite_in(smoothing, 0., 1.) {
            Some(smoothing) => {
                fields.insert("smoothing".into(), json!(smoothing));
            }
            None => {
                unsupported.insert("cornerSmoothing".into());
            }
        }
    }
    if polygon {
        if CORNER_KEYS.iter().any(|(key, _)| ov.get(*key).is_some()) {
            unsupported.insert("rectangleCornerRadii".into());
        }
        return;
    }
    let mut radii = template.map(|node| node.radii).unwrap_or([0.; 4]);
    let mut touched = false;
    if let Some(radius) = ov
        .get("cornerRadius")
        .and_then(|value| finite_in(value, 0., 1e7))
    {
        radii = [radius; 4];
        touched = true;
    }
    for (key, index) in CORNER_KEYS {
        if let Some(value) = ov.get(*key) {
            match finite_in(value, 0., 1e7) {
                Some(radius) => {
                    radii[*index] = radius;
                    touched = true;
                }
                None => {
                    unsupported.insert((*key).into());
                }
            }
        }
    }
    if touched {
        fields.insert("radii".into(), json!(radii));
    }
}

fn apply_size(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    unsupported: &mut BTreeSet<String>,
) {
    let Some(size) = ov.get("size") else { return };
    let mut axis = |key: &str| {
        if size.get(key).is_none() {
            return;
        }
        match size.get(key).and_then(positive_axis) {
            Some(value) => {
                fields.insert(key_name(key), json!(value));
            }
            None => {
                unsupported.insert(format!("size.{key}"));
            }
        }
    };
    axis("x");
    axis("y");
}

fn key_name(axis: &str) -> String {
    if axis == "x" { "width" } else { "height" }.into()
}

fn apply_layout(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    template: Option<&Node>,
    record: Option<&Value>,
    records: &BTreeMap<String, Value>,
    importer: &FigImporter,
    unsupported: &mut BTreeSet<String>,
) {
    let present: Vec<&str> = LAYOUT_KEYS
        .iter()
        .copied()
        .filter(|key| ov.get(*key).is_some())
        .collect();
    if present.is_empty() && ov.get("stackReverseZIndex").is_none() {
        return;
    }
    if bool_of(ov, "stackReverseZIndex") == Some(true) {
        unsupported.insert("stackReverseZIndex".into());
    }
    let (Some(template), Some(source)) = (template, record) else {
        for key in present {
            unsupported.insert(key.into());
        }
        return;
    };
    let mut merged = source.clone();
    if let Some(object) = merged.as_object_mut() {
        for key in &present {
            if let Some(value) = ov.get(*key) {
                object.insert((*key).to_string(), value.clone());
            }
        }
    }
    let parent = merged
        .get("parentIndex")
        .and_then(|parent| parent.get("guid"))
        .map(guid_string)
        .and_then(|id| records.get(&id));
    let mut scratch = template.clone();
    let mut notes = Vec::new();
    if importer
        .import_layout(&mut scratch, &merged, parent, &mut notes)
        .is_err()
    {
        for key in present {
            unsupported.insert(key.into());
        }
        return;
    }
    if scratch.layout != template.layout {
        if let Ok(value) = serde_json::to_value(scratch.layout) {
            fields.insert("layout".into(), value);
        }
    }
    if scratch.sizing != template.sizing {
        if let Ok(value) = serde_json::to_value(scratch.sizing) {
            fields.insert("sizing".into(), value);
        }
    }
    if scratch.constraints != template.constraints {
        if let Ok(value) = serde_json::to_value(scratch.constraints) {
            fields.insert("constraints".into(), value);
        }
    }
}

fn apply_text(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    template: Option<&Node>,
    importer: &FigImporter,
    unsupported: &mut BTreeSet<String>,
) {
    let touches =
        TEXT_KEYS.iter().any(|key| ov.get(*key).is_some()) || ov.get("textData").is_some();
    if !touches {
        return;
    }
    let font_size = fields
        .get("fontSize")
        .and_then(Value::as_f64)
        .or_else(|| template.map(|node| node.font_size))
        .unwrap_or(16.)
        .max(1.);
    if let Some(text_data) = ov.get("textData") {
        if let Some(characters) = text_data.get("characters").and_then(Value::as_str) {
            fields.insert("text".into(), Value::String(characters.to_string()));
        } else if text_data.get("characters").is_some() {
            unsupported.insert("textData.characters".into());
        }
        if let Some(object) = text_data.as_object() {
            for key in DERIVED_TEXT_KEYS {
                if object.contains_key(*key) {
                    unsupported.insert(format!("textData.{key}"));
                }
            }
        }
        if text_data.get("characterStyleIDs").is_some()
            || text_data.get("styleOverrideTable").is_some()
        {
            let characters = fields
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_else(|| template.map(|node| node.text.as_str()).unwrap_or(""));
            let mut notes = Vec::new();
            let runs = super::styled_text_runs(
                text_data,
                characters,
                importer.display_p3,
                font_size,
                &mut notes,
            );
            for note in notes {
                unsupported.insert(note);
            }
            if !runs.is_empty() {
                if let Ok(value) = serde_json::to_value(&runs) {
                    fields.insert("textRuns".into(), value);
                }
            }
        }
    }
    let mut style = template
        .and_then(|node| node.text_style.clone())
        .map(|style| *style)
        .unwrap_or_default();
    let mut changed = false;
    if ov.get("textAlignHorizontal").is_some() {
        match str_of(ov, "textAlignHorizontal") {
            Some("CENTER") => {
                style.align = "center".into();
                changed = true;
            }
            Some("RIGHT") => {
                style.align = "end".into();
                changed = true;
            }
            Some("JUSTIFIED") => {
                style.align = "justify".into();
                changed = true;
            }
            Some("LEFT") | None => {
                style.align = "start".into();
                changed = true;
            }
            Some(other) => {
                unsupported.insert(format!("textAlignHorizontal={other}"));
            }
        }
    }
    if ov.get("textAlignVertical").is_some() {
        match str_of(ov, "textAlignVertical") {
            None | Some("TOP") => {
                style.vertical_align = "top".into();
                changed = true;
            }
            Some("CENTER") => {
                style.vertical_align = "center".into();
                changed = true;
            }
            Some("BOTTOM") => {
                style.vertical_align = "bottom".into();
                changed = true;
            }
            Some(other) => {
                unsupported.insert(format!("textAlignVertical={other}"));
            }
        }
    }
    if ov.get("textAutoResize").is_some() {
        match str_of(ov, "textAutoResize") {
            Some("WIDTH_AND_HEIGHT") => {
                style.wrap = false;
                changed = true;
            }
            Some("HEIGHT" | "NONE" | "TRUNCATE") => {
                style.wrap = true;
                changed = true;
            }
            Some(other) => {
                unsupported.insert(format!("textAutoResize={other}"));
            }
            None => {
                unsupported.insert("textAutoResize".into());
            }
        }
    }
    if let Some(value) = ov.get("lineHeight") {
        match super::line_height_multiplier(value, font_size).filter(|v| (0.1..=10.).contains(v)) {
            Some(multiplier) => {
                style.line_height = multiplier;
                changed = true;
            }
            None => {
                unsupported.insert("lineHeight".into());
            }
        }
    }
    if let Some(value) = ov.get("letterSpacing") {
        match super::letter_spacing_px(value, font_size)
            .filter(|v| v.is_finite() && v.abs() <= 1000.)
        {
            Some(pixels) => {
                style.letter_spacing = pixels;
                changed = true;
            }
            None => {
                unsupported.insert("letterSpacing".into());
            }
        }
    }
    if let Some(value) = ov.get("paragraphSpacing").and_then(Value::as_f64) {
        if value.is_finite() && (0. ..=10000.).contains(&value) {
            style.paragraph_spacing = value;
            changed = true;
        } else {
            unsupported.insert("paragraphSpacing".into());
        }
    }
    if let Some(value) = ov.get("paragraphIndent").and_then(Value::as_f64) {
        if value.is_finite() && value.abs() <= 10000. {
            style.paragraph_indent = value;
            changed = true;
        } else {
            unsupported.insert("paragraphIndent".into());
        }
    }
    if ov.get("textCase").is_some() {
        match super::text_case_of(str_of(ov, "textCase")) {
            Some(case) => {
                style.text_case = case;
                changed = true;
            }
            None => {
                unsupported.insert(format!(
                    "textCase={}",
                    str_of(ov, "textCase").unwrap_or_default()
                ));
            }
        }
    }
    if let Some(font) = ov.get("fontName") {
        match str_of(font, "style").and_then(super::style_weight) {
            Some(weight) => {
                style.weight = weight;
                changed = true;
            }
            None if str_of(font, "style").is_some() => {
                unsupported.insert("fontName.style".into());
            }
            None => {}
        }
        if let Some(family) = str_of(font, "family").filter(|family| !family.is_empty()) {
            unsupported.insert(format!("fontName.family={family}"));
        }
    }
    if ov.get("textDecoration").is_some() {
        let decoration = str_of(ov, "textDecoration").unwrap_or("");
        if matches!(decoration, "UNDERLINE" | "STRIKETHROUGH") && !fields.contains_key("textRuns") {
            let characters = fields
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| template.map(|node| node.text.clone()))
                .unwrap_or_default();
            if !characters.is_empty() {
                let underline = decoration == "UNDERLINE";
                let run = crate::font::TextRun {
                    paragraph: None,
                    text_case: None,
                    color: None,
                    underline,
                    strikethrough: !underline,
                    link: None,
                    start: 0,
                    end: characters.encode_utf16().count(),
                    font_id: None,
                    font_size: None,
                    weight: None,
                    letter_spacing: None,
                    line_height: None,
                };
                if let Ok(value) = serde_json::to_value(vec![run]) {
                    fields.insert("textRuns".into(), value);
                }
            }
        } else if !decoration.is_empty() && decoration != "NONE" {
            unsupported.insert(format!("textDecoration={decoration}"));
        }
    }
    if changed {
        if style.validate().is_ok() {
            if let Ok(value) = serde_json::to_value(style) {
                fields.insert("textStyle".into(), value);
            }
        } else {
            unsupported.insert("textStyle".into());
        }
    }
}

fn apply_effects(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    importer: &FigImporter,
    unsupported: &mut BTreeSet<String>,
) {
    let Some(effects) = ov.get("effects") else {
        return;
    };
    let record = json!({
        "type": "RECTANGLE",
        "guid": {"sessionID": 0, "localID": 0},
        "effects": effects,
    });
    let mut notes = Vec::new();
    match importer.node(&record, &mut notes) {
        Ok(node) => {
            if let Ok(value) = serde_json::to_value(node.effects) {
                fields.insert("effects".into(), value);
            }
        }
        Err(_) => {
            unsupported.insert("effects".into());
        }
    }
    for note in notes {
        unsupported.insert(format!("effects:{note}"));
    }
}

fn apply_consumption(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    vars: &Variables,
    template: Option<&Node>,
    unsupported: &mut BTreeSet<String>,
) -> Map<String, Value> {
    let mut retained = Map::new();
    if let Some(map) = ov.get("variableConsumptionMap") {
        let entries = map.get("entries").and_then(Value::as_array);
        if entries.is_some_and(|entries| !entries.is_empty()) {
            retained.insert("variableConsumptionMap".into(), map.clone());
            let mut bindings = BTreeMap::new();
            let mut seen = BTreeSet::new();
            for entry in entries.into_iter().flatten() {
                let field = str_of(entry, "variableField").unwrap_or("");
                let Some(path) = binding_path(field) else {
                    if !field.is_empty() && field != "MISSING" {
                        unsupported.insert(format!("variableConsumptionMap.{field}"));
                    } else if let Some(node_field) = entry.get("nodeField") {
                        unsupported
                            .insert(format!("variableConsumptionMap.nodeField.{node_field}"));
                    }
                    continue;
                };
                if !seen.insert(path) {
                    continue;
                }
                let Some(target) = entry
                    .get("variableData")
                    .and_then(|data| data.get("value"))
                    .and_then(|value| alias_target(value, vars))
                else {
                    unsupported.insert(format!("variableConsumptionMap.{field}"));
                    continue;
                };
                if vars.kind_by_id.get(&target).map(String::as_str) != Some(binding_kind(path)) {
                    unsupported.insert(format!("variableConsumptionMap.{field}"));
                    continue;
                }
                bindings.insert(path.to_string(), target);
            }
            if !bindings.is_empty() {
                if let Ok(value) = serde_json::to_value(bindings) {
                    fields.insert("bindings".into(), value);
                }
            }
        }
    }
    if let Some(map) = ov.get("parameterConsumptionMap") {
        if map
            .get("entries")
            .and_then(Value::as_array)
            .is_some_and(|entries| !entries.is_empty())
        {
            retained.insert("parameterConsumptionMap".into(), map.clone());
            unsupported.insert("parameterConsumptionMap".into());
        }
    }
    if let Some(map) = ov.get("variableModeBySetMap") {
        let entries = map.get("entries").and_then(Value::as_array);
        if entries.is_some_and(|entries| !entries.is_empty()) {
            let mut modes = template
                .map(|node| node.variable_modes.clone())
                .unwrap_or_default();
            let mut failed = false;
            for entry in entries.into_iter().flatten() {
                let set = entry.get("variableSetID").unwrap_or(&Value::Null);
                let collection = set
                    .get("assetRef")
                    .and_then(|reference| str_of(reference, "key"))
                    .and_then(|key| vars.collection_by_set.get(key))
                    .or_else(|| vars.collection_by_set.get(&reference_guid(set)));
                let name = entry
                    .get("variableModeID")
                    .map(guid_string)
                    .and_then(|id| vars.mode_name.get(&id));
                match (collection, name) {
                    (Some(collection), Some(name))
                        if vars
                            .collection_modes
                            .get(collection)
                            .is_some_and(|modes| modes.iter().any(|mode| mode == name)) =>
                    {
                        modes.insert(collection.clone(), name.clone());
                    }
                    _ => failed = true,
                }
            }
            if failed {
                retained.insert("variableModeBySetMap".into(), map.clone());
                unsupported.insert("variableModeBySetMap".into());
            }
            let same = template.is_some_and(|node| node.variable_modes == modes);
            if !modes.is_empty() && !same {
                if let Ok(value) = serde_json::to_value(modes) {
                    fields.insert("variableModes".into(), value);
                }
            }
        }
    }
    retained
}

fn apply_styles(
    fields: &mut BTreeMap<String, Value>,
    ov: &Value,
    doc: &Document,
    template: Option<&Node>,
    unsupported: &mut BTreeSet<String>,
) {
    let mut refs = template
        .map(|node| node.style_refs.clone())
        .unwrap_or_default();
    let mut touched = false;
    for key in [
        "styleIdForFill",
        "styleIdForStrokeFill",
        "styleIdForEffect",
        "styleIdForText",
        "styleIdForGrid",
    ] {
        let Some(value) = ov.get(key) else { continue };
        if key == "styleIdForGrid" {
            unsupported.insert(key.into());
            continue;
        }
        let Some(field) = style_field(key) else {
            continue;
        };
        let id = guid_string(value.get("guid").unwrap_or(value));
        if detached_style(&id) {
            refs.remove(field);
            touched = true;
            continue;
        }
        if style_matches(doc, &id, field) {
            refs.insert(field.into(), id);
            touched = true;
        } else {
            unsupported.insert(format!("{key} unresolved"));
        }
    }
    if touched {
        fields.insert(
            "styleRefs".into(),
            serde_json::to_value(refs).unwrap_or(json!({})),
        );
    }
}

fn trim_override_fields(fields: &mut BTreeMap<String, Value>, unsupported: &mut BTreeSet<String>) {
    const KEEP: &[&str] = &[
        "width",
        "height",
        "radii",
        "cornerRadius",
        "strokes",
        "fills",
        "effects",
        "opacity",
        "visible",
        "text",
        "fontSize",
        "textStyle",
        "textRuns",
        "layout",
        "sizing",
        "constraints",
        "styleRefs",
        "bindings",
        "variableModes",
        "name",
        "transform",
        "smoothing",
        "mask",
        "maskType",
        "clip",
        "booleanOperation",
        "swapComponent",
        "locked",
        "points",
        "innerRadius",
        "arc",
    ];
    while fields.len() > 32 {
        let Some(drop) = KEEP.iter().rev().find(|key| fields.contains_key(**key)) else {
            break;
        };
        fields.remove(*drop);
        unsupported.insert(format!("override field budget:{drop}"));
    }
}

pub(super) fn schema_floor(doc: &Document) -> u32 {
    let mut version = 1u32;
    for node in doc.nodes.values() {
        let Some(instance) = &node.instance else {
            continue;
        };
        for fields in instance.overrides.values() {
            if fields
                .get("cornerRadius")
                .and_then(Value::as_f64)
                .is_some_and(|value| value != 0.)
                || fields.get("arc").is_some()
            {
                version = version.max(7);
            }
            if let Some(style) = fields.get("textStyle") {
                if style
                    .get("verticalAlign")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value != "top")
                {
                    version = version.max(20);
                }
                if style
                    .get("textCase")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value != "original")
                {
                    version = version.max(15);
                }
            }
            if fields
                .get("textRuns")
                .and_then(Value::as_array)
                .is_some_and(|runs| {
                    runs.iter().any(|run| {
                        run.get("letterSpacing").is_some() || run.get("lineHeight").is_some()
                    })
                })
            {
                version = version.max(21);
            }
            if fields
                .get("effects")
                .and_then(Value::as_array)
                .is_some_and(|effects| {
                    effects.iter().any(|effect| {
                        effect.get("glass").is_some() || effect.get("texture").is_some()
                    })
                })
            {
                version = version.max(13);
            }
        }
    }
    version
}

pub(super) fn import(
    doc: &mut Document,
    records: &BTreeMap<String, Value>,
    importer: &FigImporter,
    notes: &mut Vec<String>,
) -> Result<(), Error> {
    // Keys are definition GUIDs throughout. Human-facing names are labels only.
    for (id, record) in records
        .iter()
        .filter(|(_, r)| str_of(r, "type") == Some("SYMBOL"))
    {
        if !doc.nodes.contains_key(id) {
            continue;
        }
        let descendants = descendants(doc, id)?;
        let mut properties = BTreeMap::new();
        for def in record
            .get("componentPropDefs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if bool_of(def, "isDeleted").unwrap_or(false) {
                continue;
            }
            let kind = match str_of(def, "type") {
                Some("BOOL") => PropertyKind::Boolean,
                Some("TEXT") => PropertyKind::Text,
                Some("INSTANCE_SWAP") => PropertyKind::InstanceSwap,
                // Variant axes belong to the component set, not a layer binding.
                Some("VARIANT") => continue,
                other => {
                    return Err(Error::Unsupported(format!(
                        "component property type {other:?}"
                    )))
                }
            };
            let key = def
                .get("id")
                .map(guid_string)
                .ok_or_else(|| Error::Malformed("component property id missing".into()))?;
            let field = match kind {
                PropertyKind::Boolean => "VISIBLE",
                PropertyKind::Text => "TEXT_DATA",
                PropertyKind::InstanceSwap => "OVERRIDDEN_SYMBOL_ID",
            };
            let mut targets: Vec<_> = descendants
                .iter()
                .filter(|target| {
                    records.get(*target).is_some_and(|r| {
                        r.get("componentPropRefs")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .any(|reference| {
                                !bool_of(reference, "isDeleted").unwrap_or(false)
                                    && reference.get("defID").map(guid_string).as_ref()
                                        == Some(&key)
                                    && str_of(reference, "componentPropNodeField") == Some(field)
                            })
                    })
                })
                .cloned()
                .collect();
            let default_value = property_value(&kind, &def["initialValue"]).ok_or_else(|| {
                Error::Unsupported(format!("component property {key} has no literal default"))
            })?;
            if targets.is_empty() {
                properties.insert(
                    key.clone(),
                    Property {
                        name: str_of(def, "name").unwrap_or(&key).into(),
                        kind,
                        target_key: String::new(),
                        also_targets: Vec::new(),
                        unbound: true,
                        default_value,
                    },
                );
                continue;
            }
            let mut parent_of = BTreeMap::<&str, &str>::new();
            for node in doc.nodes.values() {
                for child in &node.children {
                    parent_of.insert(child.as_str(), node.id.as_str());
                }
            }
            let depth = |id: &str| {
                let mut at = id;
                let mut n = 0usize;
                while let Some(parent) = parent_of.get(at) {
                    at = parent;
                    n += 1;
                    if n > 64 {
                        break;
                    }
                }
                n
            };
            targets.sort_by_key(|id| depth(id.as_str()));
            let primary = &doc.nodes[&targets[0]];
            let primary_key = primary
                .component_key
                .as_ref()
                .unwrap_or(&primary.id)
                .clone();
            let also_targets = targets[1..]
                .iter()
                .map(|id| {
                    let node = &doc.nodes[id];
                    node.component_key.as_ref().unwrap_or(&node.id).clone()
                })
                .collect();
            properties.insert(
                key.clone(),
                Property {
                    name: str_of(def, "name").unwrap_or(&key).into(),
                    kind,
                    target_key: primary_key,
                    also_targets,
                    unbound: false,
                    default_value,
                },
            );
        }
        doc.nodes.get_mut(id).unwrap().component = Some(
            (Component {
                properties,
                ..Default::default()
            })
            .into(),
        );
    }
    let variables = variables_from(records);
    let mut unsupported = BTreeSet::new();
    for (id, record) in records
        .iter()
        .filter(|(_, r)| str_of(r, "type") == Some("INSTANCE"))
    {
        if !doc.nodes.contains_key(id) {
            continue;
        }
        let Some(sd) = record.get("symbolData") else {
            continue;
        };
        let component_id = sd
            .get("symbolID")
            .map(guid_string)
            .ok_or_else(|| Error::Malformed("instance symbolID missing".into()))?;
        let properties = doc
            .nodes
            .get(&component_id)
            .and_then(|n| n.component.as_ref())
            .ok_or_else(|| {
                Error::Unsupported(format!(
                    "instance {id} has no embedded main component {component_id}"
                ))
            })?
            .properties
            .clone();
        let mut property_values = BTreeMap::new();
        for assignment in record
            .get("componentPropAssignments")
            .or_else(|| sd.get("componentPropAssignments"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(key) = assignment.get("defID").map(guid_string) else {
                return Err(Error::Malformed("property assignment defID missing".into()));
            };
            let Some(property) = properties.get(&key) else {
                unsupported.insert(format!("property assignment {key}"));
                continue;
            };
            let Some(value) = property_value(&property.kind, &assignment["value"]) else {
                unsupported.insert(format!("property assignment {key}"));
                continue;
            };
            property_values.insert(key, value);
        }
        let mut overrides = BTreeMap::new();
        let mut retained = Vec::new();
        for ov in sd
            .get("symbolOverrides")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let mut path = ov
                .get("guidPath")
                .and_then(|v| v.get("guids"))
                .and_then(Value::as_array)
                .map(|gs| gs.iter().map(guid_string).collect::<Vec<_>>().join("/"))
                .or_else(|| ov.get("overrideKey").map(guid_string))
                .unwrap_or_else(|| "$root".into());
            if path.is_empty() {
                path = "$root".into();
            }
            let target_id = target_id(&path, &component_id);
            let template = doc.nodes.get(&target_id);
            let source = records.get(&target_id);
            let mut fields = BTreeMap::new();
            let has_stroke_paints = ov.get("strokePaints").and_then(Value::as_array).is_some();
            for (key, value) in ov.as_object().into_iter().flatten() {
                if has_stroke_paints && STROKE_INPUTS.contains(&key.as_str()) {
                    continue;
                }
                if IGNORED.contains(&key.as_str())
                    || key == "cornerRadius"
                    || key == "cornerSmoothing"
                    || CORNER_KEYS.iter().any(|(name, _)| *name == key)
                    || LAYOUT_KEYS.contains(&key.as_str())
                    || TEXT_KEYS.contains(&key.as_str())
                    || STROKE_INPUTS.contains(&key.as_str())
                    || matches!(
                        key.as_str(),
                        "size"
                            | "textData"
                            | "effects"
                            | "variableConsumptionMap"
                            | "parameterConsumptionMap"
                            | "variableModeBySetMap"
                            | "stackReverseZIndex"
                            | "derivedTextData"
                            | "pluginData"
                    )
                    || style_field(key).is_some()
                    || key == "styleIdForGrid"
                {
                    continue;
                }
                match key.as_str() {
                    "name" if value.is_string() => {
                        fields.insert(key.clone(), value.clone());
                    }
                    "visible" | "locked" | "mask" if value.is_boolean() => {
                        fields.insert(key.clone(), value.clone());
                    }
                    "opacity" => match finite_in(value, 0., 1.) {
                        Some(opacity) => {
                            fields.insert("opacity".into(), json!(opacity));
                        }
                        None => {
                            unsupported.insert("opacity".into());
                        }
                    },
                    "fontSize" => match positive_axis(value) {
                        Some(size) => {
                            fields.insert("fontSize".into(), json!(size.max(1.)));
                        }
                        None => {
                            unsupported.insert("fontSize".into());
                        }
                    },
                    "fillPaints" => {
                        let mut paint_notes = Vec::new();
                        let fills: Vec<_> = value
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|paint| importer.paint(paint, &mut paint_notes))
                            .collect();
                        for note in paint_notes {
                            unsupported.insert(format!("fillPaints:{note}"));
                        }
                        fields.insert("fills".into(), serde_json::to_value(fills).unwrap());
                    }
                    "strokePaints" => {}
                    "symbolID" => {
                        let id = guid_string(value);
                        if doc
                            .nodes
                            .get(&id)
                            .is_some_and(|node| node.component.is_some())
                        {
                            fields.insert("swapComponent".into(), Value::String(id));
                        } else {
                            unsupported.insert("symbolID".into());
                        }
                    }
                    "booleanOperation" => match value.as_str() {
                        Some("UNION") => {
                            fields.insert("booleanOperation".into(), json!("union"));
                        }
                        Some("INTERSECT") => {
                            fields.insert("booleanOperation".into(), json!("intersect"));
                        }
                        Some("SUBTRACT") => {
                            fields.insert("booleanOperation".into(), json!("subtract"));
                        }
                        Some("XOR") => {
                            fields.insert("booleanOperation".into(), json!("exclude"));
                        }
                        _ => {
                            unsupported.insert("booleanOperation".into());
                        }
                    },
                    "maskType" => match value.as_str() {
                        Some("ALPHA") => {
                            fields.insert("maskType".into(), json!("alpha"));
                        }
                        Some("OUTLINE") => {
                            fields.insert("maskType".into(), json!("outline"));
                        }
                        Some("LUMINANCE") => {
                            fields.insert("maskType".into(), json!("luminance"));
                        }
                        _ => {
                            unsupported.insert("maskType".into());
                        }
                    },
                    "frameMaskDisabled" => match value.as_bool() {
                        Some(disabled)
                            if template.is_some_and(|node| {
                                matches!(node.kind.as_str(), "frame" | "section")
                            }) =>
                        {
                            fields.insert("clip".into(), json!(!disabled));
                        }
                        _ => {
                            unsupported.insert("frameMaskDisabled".into());
                        }
                    },
                    "transform" => {
                        let transform = Transform([
                            f64_of(Some(value), "m00"),
                            f64_of(Some(value), "m10"),
                            f64_of(Some(value), "m01"),
                            f64_of(Some(value), "m11"),
                            f64_of(Some(value), "m02"),
                            f64_of(Some(value), "m12"),
                        ]);
                        if transform.0.iter().all(|v| v.is_finite() && v.abs() <= 1e7)
                            && transform.inverse().is_ok()
                        {
                            fields.insert(
                                "transform".into(),
                                serde_json::to_value(transform).unwrap(),
                            );
                        } else {
                            unsupported.insert("transform".into());
                        }
                    }
                    "count" => match value.as_u64() {
                        Some(count)
                            if (3..=128).contains(&count)
                                && template.is_some_and(|node| {
                                    matches!(node.kind.as_str(), "polygon" | "star")
                                }) =>
                        {
                            fields.insert("points".into(), json!(count));
                        }
                        _ => {
                            unsupported.insert("count".into());
                        }
                    },
                    "starInnerScale" => match finite_in(value, 0., 1.) {
                        Some(radius) if template.is_some_and(|node| node.kind == "star") => {
                            fields.insert("innerRadius".into(), json!(radius));
                        }
                        _ => {
                            unsupported.insert("starInnerScale".into());
                        }
                    },
                    "arcData" => {
                        let start = f64_of(Some(value), "startingAngle");
                        let mut sweep = f64_of(Some(value), "endingAngle") - start;
                        if sweep.abs() == (std::f64::consts::TAU as f32) as f64 {
                            sweep = std::f64::consts::TAU.copysign(sweep);
                        }
                        let inner = f64_of(Some(value), "innerRadius");
                        let arc = crate::scene::EllipseArc {
                            start_angle: start,
                            sweep_angle: sweep,
                            inner_radius: inner,
                        };
                        if template.is_some_and(|node| node.kind == "ellipse")
                            && crate::authoring_shapes::validate("ellipse", Some(arc), 0., false)
                                .is_ok()
                        {
                            fields.insert("arc".into(), serde_json::to_value(arc).unwrap());
                        } else {
                            unsupported.insert("arcData".into());
                        }
                    }
                    "name" | "visible" | "locked" | "mask" => {
                        unsupported.insert(key.clone());
                    }
                    "pluginData" | "derivedTextData" => {
                        unsupported.insert(key.clone());
                    }
                    other => {
                        unsupported.insert(other.to_string());
                    }
                }
            }
            if ov.get("pluginData").is_some() {
                unsupported.insert("pluginData".into());
            }
            if ov.get("derivedTextData").is_some() {
                unsupported.insert("derivedTextData".into());
            }
            apply_size(&mut fields, ov, &mut unsupported);
            apply_corners(&mut fields, ov, template, &mut unsupported);
            apply_text(&mut fields, ov, template, importer, &mut unsupported);
            apply_effects(&mut fields, ov, importer, &mut unsupported);
            apply_layout(
                &mut fields,
                ov,
                template,
                source,
                records,
                importer,
                &mut unsupported,
            );
            apply_styles(&mut fields, ov, doc, template, &mut unsupported);
            if has_stroke_paints {
                let strokes = strokes_from_paints(importer, ov, &mut unsupported);
                store_strokes(&mut fields, strokes, &mut unsupported);
            } else if STROKE_INPUTS.iter().any(|key| ov.get(*key).is_some()) {
                if let Some(template) = template {
                    if template.strokes.is_empty() {
                        for key in STROKE_INPUTS {
                            if ov.get(*key).is_some() {
                                unsupported.insert((*key).into());
                            }
                        }
                    } else {
                        let mut strokes = template.strokes.clone();
                        for stroke in &mut strokes {
                            apply_stroke_attrs(stroke, ov, &mut unsupported);
                        }
                        store_strokes(&mut fields, strokes, &mut unsupported);
                    }
                } else {
                    for key in STROKE_INPUTS {
                        if ov.get(*key).is_some() {
                            unsupported.insert((*key).into());
                        }
                    }
                }
            }
            let mut kept =
                apply_consumption(&mut fields, ov, &variables, template, &mut unsupported);
            trim_override_fields(&mut fields, &mut unsupported);
            if !kept.is_empty() {
                kept.insert("path".into(), Value::String(path.clone()));
                retained.push(Value::Object(kept));
            }
            overrides.insert(path, fields);
        }
        let node = doc.nodes.get_mut(id).unwrap();
        node.instance = Some(
            (Instance {
                component_id,
                overrides,
                property_values,
                slot_contents: Default::default(),
            })
            .into(),
        );
        if !retained.is_empty() {
            node.bindings.insert(
                "figOverrideVariableConsumption".into(),
                serde_json::to_string(&retained).unwrap_or_else(|_| "[]".into()),
            );
        }
    }
    if !unsupported.is_empty() {
        let mut names: Vec<_> = unsupported.into_iter().collect();
        names.sort();
        let extra = names.len().saturating_sub(24);
        let shown = names.into_iter().take(24).collect::<Vec<_>>().join(", ");
        let suffix = if extra > 0 {
            format!(" and {extra} more")
        } else {
            String::new()
        };
        notes.push(format!(
            "FIG component overrides without an executable field were left unchanged: {shown}{suffix}"
        ));
    }
    Ok(())
}
