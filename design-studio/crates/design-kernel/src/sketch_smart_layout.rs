//! Sketch Smart Layout (`MSImmutableInferredGroupLayout`) reflow.
//!
//! Sketch stores only the axis, the layout anchor and optional min/max sizes;
//! the spacing and main-axis padding are inferred from the authored frames.
//! The saved frames stay untouched until a direct child is hidden, shown,
//! moved or resized. A content change then keeps the leading/trailing gaps,
//! preserves the spacing between visible children and hugs the group along
//! the axis. The anchor decides which group edge stays put: start, center or
//! end. The cross axis is never touched, matching Sketch's one-axis Smart
//! Layout. Rotation, symbol instances and explicit stacks keep their own
//! solver and are skipped.

use crate::scene::{Document, Node};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Kernel-only model derived at import. `sketchInferredGroupLayout` keeps the
/// native archive payload for export; this receipt drives the local reflow.
pub(crate) const MODEL_BINDING: &str = "sketchSmartLayout";

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SmartLayoutModel {
    /// 0 = horizontal, 1 = vertical.
    pub axis: u8,
    /// 0 = start/min, 1 = middle/center, 2 = end/max.
    pub anchor: u8,
    #[serde(default)]
    pub min_size: f64,
    #[serde(default)]
    pub max_size: f64,
    pub gap: f64,
    pub leading: f64,
    pub trailing: f64,
    /// Authored main-axis extent of the group.
    pub group_size: f64,
    /// Authored direct children in layer order.
    pub baseline: Vec<ArchivedChild>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchivedChild {
    pub visible: bool,
    pub main: f64,
    pub size: f64,
    /// Authored text for a text layer. Font shaping may legitimately change
    /// the measured box without a user edit, so only the string is compared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|value| value.is_finite())
}

/// `import_sketch_report` moves `sketch*` bindings into document metadata;
/// a plain `.fd` save keeps them on the node. Read both locations.
fn raw_model<'a>(doc: &'a Document, id: &str) -> Option<&'a str> {
    let node = doc.nodes.get(id)?;
    node.bindings
        .get(MODEL_BINDING)
        .map(String::as_str)
        .or_else(|| {
            doc.design_system
                .as_ref()?
                .sketch_containers
                .get("nodeMetadata")?
                .get(id)?
                .get("bindings")?
                .get(MODEL_BINDING)?
                .as_str()
        })
}

fn model(doc: &Document, id: &str) -> Option<SmartLayoutModel> {
    serde_json::from_str(raw_model(doc, id)?).ok()
}

/// True only when `reflow` can actually own this node. Callers use it to keep
/// legacy child resize masks from fighting the one-axis reflow; a rotated,
/// instance, Graphic or explicitly stacked group keeps its normal solver.
pub(crate) fn has_model(doc: &Document, node: &Node) -> bool {
    if node.graphic
        || node.instance_origin.is_some()
        || node
            .layout
            .as_ref()
            .is_some_and(|layout| layout.mode != crate::layout::Flow::None)
        || !identity_rows(node)
    {
        return false;
    }
    model(doc, &node.id)
        .is_some_and(|model| model.axis <= 1 && model.anchor <= 2 && model.gap.is_finite())
}

/// Derive the reflow model from the archived layer JSON. Returns `None` for a
/// malformed layout or a group without a finite frame.
pub(crate) fn model_from_layer(layer: &Value) -> Option<String> {
    let layout = layer.get("groupLayout")?;
    let class = layout.get("_class").and_then(Value::as_str)?;
    if !matches!(class, "MSImmutableInferredGroupLayout" | "MSInferredGroupLayout") {
        return None;
    }
    let axis = match layout.get("axis")?.as_u64()? {
        0 => 0,
        1 => 1,
        _ => return None,
    };
    let anchor = match layout.get("layoutAnchor").and_then(Value::as_u64).unwrap_or(0) {
        0 => 0,
        1 => 1,
        2 => 2,
        _ => return None,
    };
    let frame = layer.get("frame")?;
    let main_extent = number(frame.get(if axis == 0 { "width" } else { "height" }))?;
    let mut baseline = Vec::new();
    for child in layer.get("layers").and_then(Value::as_array).into_iter().flatten() {
        let Some(child_frame) = child.get("frame") else { continue };
        let main = number(child_frame.get(if axis == 0 { "x" } else { "y" })).unwrap_or(0.);
        let size = number(child_frame.get(if axis == 0 { "width" } else { "height" })).unwrap_or(0.);
        let text = (child.get("_class").and_then(Value::as_str) == Some("text")).then(|| {
            child
                .pointer("/attributedString/string")
                .or_else(|| child.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        });
        baseline.push(ArchivedChild {
            visible: child.get("isVisible").and_then(Value::as_bool).unwrap_or(true),
            main,
            size,
            text,
        });
    }
    let mut visible: Vec<&ArchivedChild> = baseline.iter().filter(|child| child.visible).collect();
    visible.sort_by(|a, b| a.main.total_cmp(&b.main));
    let gap = visible
        .windows(2)
        .map(|pair| pair[1].main - (pair[0].main + pair[0].size))
        .next()
        .unwrap_or(0.);
    let leading = visible.first().map_or(0., |child| child.main);
    let trailing = visible
        .last()
        .map_or(main_extent, |child| main_extent - (child.main + child.size));
    serde_json::to_string(&SmartLayoutModel {
        axis,
        anchor,
        min_size: number(layout.get("minSize")).unwrap_or(0.),
        max_size: number(layout.get("maxSize")).unwrap_or(0.),
        gap,
        leading,
        trailing,
        group_size: main_extent,
        baseline,
    })
    .ok()
}

fn identity_rows(node: &Node) -> bool {
    let [a, b, c, d, ..] = node.transform.0;
    (a - 1.).abs() <= 1e-9 && b.abs() <= 1e-9 && c.abs() <= 1e-9 && (d - 1.).abs() <= 1e-9
}

fn main_position(node: &Node, axis: usize) -> f64 {
    node.transform.0[4 + axis]
}

fn main_size(node: &Node, axis: usize) -> f64 {
    if axis == 0 { node.width } else { node.height }
}

/// Reflow a group when its direct content no longer matches the archived
/// frames. A pristine import is a fixed point and is left byte-for-byte
/// untouched, including groups whose authored spacing is not uniform.
pub(crate) fn reflow(doc: &mut Document, id: &str) {
    let Some(node) = doc.nodes.get(id) else { return };
    if node.graphic || node.instance_origin.is_some() {
        return;
    }
    if node.layout.as_ref().is_some_and(|layout| layout.mode != crate::layout::Flow::None) {
        return;
    }
    let Some(model) = model(doc, id) else {
        return;
    };
    if model.axis > 1 || model.anchor > 2 || !model.gap.is_finite() {
        return;
    }
    let axis = model.axis as usize;
    if !identity_rows(node) {
        return;
    }
    let extent = main_size(node, axis);
    let origin = main_position(node, axis);
    let changed = node.children.len() != model.baseline.len()
        || node
            .children
            .iter()
            .zip(&model.baseline)
            .any(|(child, archived)| {
                doc.nodes.get(child).is_none_or(|child| {
                    if child.visible != archived.visible {
                        return true;
                    }
                    if let Some(text) = &archived.text {
                        // Hug text is re-measured during every solve; a box
                        // change without a string change is not an edit.
                        let sizing = child.sizing_value();
                        let auto = sizing.width == crate::layout::SizeMode::Hug
                            || sizing.height == crate::layout::SizeMode::Hug;
                        return child.text != *text
                            || (!auto
                                && ((main_position(child, axis) - archived.main).abs() > 1e-6
                                    || (main_size(child, axis) - archived.size).abs() > 1e-6));
                    }
                    (main_position(child, axis) - archived.main).abs() > 1e-6
                        || (main_size(child, axis) - archived.size).abs() > 1e-6
                })
            })
        || (extent - model.group_size).abs() > 1e-6;
    if !changed {
        return;
    }
    let mut items: Vec<(usize, String, f64)> = node
        .children
        .iter()
        .enumerate()
        .filter_map(|(index, id)| {
            let child = doc.nodes.get(id)?;
            (child.visible && identity_rows(child))
                .then(|| (index, id.clone(), main_size(child, axis)))
        })
        .collect();
    items.sort_by(|a, b| main_position(&doc.nodes[&a.1], axis).total_cmp(&main_position(&doc.nodes[&b.1], axis)).then(a.0.cmp(&b.0)));
    let content = items.iter().map(|(_, _, size)| *size).sum::<f64>()
        + model.gap * items.len().saturating_sub(1) as f64;
    let mut target = (model.leading + content + model.trailing).max(0.01);
    if model.min_size > 0. {
        target = target.max(model.min_size);
    }
    if model.max_size > 0. {
        target = target.min(model.max_size);
    }
    let target_origin = match model.anchor {
        1 => origin + (extent - target) / 2.,
        2 => origin + extent - target,
        _ => origin,
    };
    let group = doc.nodes.get_mut(id).expect("group node");
    if axis == 0 {
        crate::mutation::resize(group, target, group.height);
    } else {
        crate::mutation::resize(group, group.width, target);
    }
    group.transform.0[4 + axis] = target_origin;
    // Children are stored in the group's local space; only the group frame
    // moves by the anchor. The main-axis gaps are the authored local gaps.
    let mut cursor = model.leading;
    for (_, child, size) in items {
        if let Some(child) = doc.nodes.get_mut(&child) {
            child.transform.0[4 + axis] = cursor;
        }
        cursor += size + model.gap;
    }
}