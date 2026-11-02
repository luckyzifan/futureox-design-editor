//! Facet composition over the existing scene node model.
//!
//! Nodes are addressed as bundles of orthogonal facets (transform, clip,
//! stack layout, constraints, …) instead of one flat property surface.  The
//! facet payloads bridge onto the authored `Node` fields so the renderer and
//! persistence keep working unchanged; `kind` gates which facets a node
//! exposes, mirroring capability composition rather than inheritance.
use crate::layout::{Anchor, Flow};
use crate::math::Transform;
use crate::scene::Node;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum FacetKind {
    Document,
    Canvas,
    Frame,
    Transform,
    Clip,
    Mask,
    Stack,
    Constraints,
    Vector,
    Text,
    Shape,
    Instance,
    Componentish,
    Variable,
    Effects,
    Export,
    Blend,
    Prototype,
    Annotation,
    Keyframe,
}

const ALL_FACETS: [FacetKind; 20] = {
    use FacetKind::*;
    [
        Document,
        Canvas,
        Frame,
        Transform,
        Clip,
        Mask,
        Stack,
        Constraints,
        Vector,
        Text,
        Shape,
        Instance,
        Componentish,
        Variable,
        Effects,
        Export,
        Blend,
        Prototype,
        Annotation,
        Keyframe,
    ]
};

impl FacetKind {
    pub const ALL: [FacetKind; 20] = ALL_FACETS;
    pub fn as_str(self) -> &'static str {
        match self {
            FacetKind::Document => "document",
            FacetKind::Canvas => "canvas",
            FacetKind::Frame => "frame",
            FacetKind::Transform => "transform",
            FacetKind::Clip => "clip",
            FacetKind::Mask => "mask",
            FacetKind::Stack => "stack",
            FacetKind::Constraints => "constraints",
            FacetKind::Vector => "vector",
            FacetKind::Text => "text",
            FacetKind::Shape => "shape",
            FacetKind::Instance => "instance",
            FacetKind::Componentish => "componentish",
            FacetKind::Variable => "variable",
            FacetKind::Effects => "effects",
            FacetKind::Export => "export",
            FacetKind::Blend => "blend",
            FacetKind::Prototype => "prototype",
            FacetKind::Annotation => "annotation",
            FacetKind::Keyframe => "keyframe",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        FacetKind::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
    }
}

/// Facet payloads stay small projections; richer authored data remains on
/// `Node` and is reached through the owning facet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Facet {
    Document {
        name: String,
    },
    Canvas {
        background: String,
    },
    Frame {
        width: f64,
        height: f64,
        #[serde(alias = "corner_radius")]
        corner_radius: f64,
    },
    Transform {
        matrix: [f64; 6],
    },
    Clip {
        on: bool,
    },
    Mask {
        on: bool,
        #[serde(alias = "mask_type")]
        mask_type: Option<String>,
    },
    Stack {
        horizontal: bool,
        grid: bool,
        gap: f64,
        padding: [f64; 4],
    },
    Constraints {
        horizontal: ConstraintAxis,
        vertical: ConstraintAxis,
    },
    Vector {
        #[serde(alias = "point_count")]
        point_count: usize,
    },
    Text {
        characters: usize,
    },
    Shape {
        points: usize,
    },
    Instance {
        #[serde(alias = "component_id")]
        component_id: String,
    },
    Componentish {
        #[serde(alias = "component_key")]
        component_key: Option<String>,
    },
    Variable {
        modes: BTreeMap<String, String>,
    },
    Effects {
        count: usize,
    },
    Export {
        settings: usize,
    },
    Blend {
        mode: String,
        opacity: f64,
    },
    Prototype {
        interactions: usize,
    },
    Annotation {
        visible: bool,
    },
    Keyframe {
        animations: usize,
    },
}

impl Facet {
    /// The payload tag is part of the mutation contract, including for read-only views.
    pub fn kind(&self) -> FacetKind {
        match self {
            Self::Document { .. } => FacetKind::Document,
            Self::Canvas { .. } => FacetKind::Canvas,
            Self::Frame { .. } => FacetKind::Frame,
            Self::Transform { .. } => FacetKind::Transform,
            Self::Clip { .. } => FacetKind::Clip,
            Self::Mask { .. } => FacetKind::Mask,
            Self::Stack { .. } => FacetKind::Stack,
            Self::Constraints { .. } => FacetKind::Constraints,
            Self::Vector { .. } => FacetKind::Vector,
            Self::Text { .. } => FacetKind::Text,
            Self::Shape { .. } => FacetKind::Shape,
            Self::Instance { .. } => FacetKind::Instance,
            Self::Componentish { .. } => FacetKind::Componentish,
            Self::Variable { .. } => FacetKind::Variable,
            Self::Effects { .. } => FacetKind::Effects,
            Self::Export { .. } => FacetKind::Export,
            Self::Blend { .. } => FacetKind::Blend,
            Self::Prototype { .. } => FacetKind::Prototype,
            Self::Annotation { .. } => FacetKind::Annotation,
            Self::Keyframe { .. } => FacetKind::Keyframe,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FacetAccess {
    ReadOnly,
    ReadWrite,
}

/// Summary payloads cannot describe a mutation. Use the owning text, vector,
/// effect, export or prototype editing command for those authored values.
pub fn facet_access(kind: FacetKind) -> FacetAccess {
    match kind {
        FacetKind::Vector
        | FacetKind::Text
        | FacetKind::Effects
        | FacetKind::Export
        | FacetKind::Prototype
        | FacetKind::Keyframe => FacetAccess::ReadOnly,
        _ => FacetAccess::ReadWrite,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCapability {
    pub kind: FacetKind,
    pub access: FacetAccess,
    pub present: bool,
}

/// Includes optional writable facets even before their authored value exists.
pub fn facet_capabilities(node: &Node) -> Vec<FacetCapability> {
    facets_for_kind(&node.kind)
        .into_iter()
        .map(|kind| FacetCapability {
            kind,
            access: facet_access(kind),
            present: facet_view(node, kind).is_some(),
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintAxis {
    Start,
    Center,
    End,
    Stretch,
    Scale,
}

/// Facets a node kind exposes.  Authored kinds map onto a fixed capability
/// set; unknown kinds fall back to the transform + blend baseline.
pub fn facets_for_kind(kind: &str) -> Vec<FacetKind> {
    use FacetKind::*;
    match kind {
        "page" => vec![Document, Canvas],
        "frame" | "section" | "group" => vec![
            Frame,
            Transform,
            Clip,
            Stack,
            Constraints,
            Variable,
            Effects,
            Export,
            Blend,
            Prototype,
            Annotation,
        ],
        "text" => vec![
            Transform, Text, Clip, Variable, Effects, Export, Blend, Annotation,
        ],
        "rectangle" | "rect" | "ellipse" | "polygon" | "star" | "line" | "path" | "vector" => {
            vec![
                Transform, Shape, Vector, Clip, Mask, Variable, Effects, Export, Blend, Annotation,
            ]
        }
        "instance" => vec![
            Transform,
            Instance,
            Componentish,
            Clip,
            Variable,
            Effects,
            Export,
            Blend,
            Prototype,
        ],
        "boolean" => vec![Transform, Vector, Clip, Effects, Export, Blend],
        _ => vec![Transform, Blend],
    }
}

fn matrix_of(transform: &Transform) -> [f64; 6] {
    transform.0
}

/// Facets present on a node: the kind's capability set intersected with
/// non-default field state, so facet queries reflect authored data.
pub fn facet_set(node: &Node) -> Vec<(FacetKind, Facet)> {
    facets_for_kind(&node.kind)
        .into_iter()
        .filter_map(|kind| facet_view(node, kind).map(|facet| (kind, facet)))
        .collect()
}

/// Read one facet projection of a node.
pub fn facet_view(node: &Node, kind: FacetKind) -> Option<Facet> {
    if !facets_for_kind(&node.kind).contains(&kind) {
        return None;
    }
    let matrix = matrix_of(&node.transform);
    Some(match kind {
        FacetKind::Document => Facet::Document {
            name: node.name.clone(),
        },
        FacetKind::Canvas => Facet::Canvas {
            background: node
                .fills
                .first()
                .map(|fill| fill.color.clone())
                .unwrap_or_default(),
        },
        FacetKind::Frame => Facet::Frame {
            width: node.width,
            height: node.height,
            corner_radius: node.corner_radius,
        },
        FacetKind::Transform => Facet::Transform { matrix },
        FacetKind::Clip => (node.clip).then_some(Facet::Clip { on: true })?,
        FacetKind::Mask => (node.mask).then(|| Facet::Mask {
            on: true,
            mask_type: node.mask_type.clone(),
        })?,
        FacetKind::Stack => {
            let layout = node.layout.as_ref()?;
            Facet::Stack {
                horizontal: matches!(layout.mode, Flow::Horizontal),
                grid: matches!(layout.mode, Flow::Grid),
                gap: layout.gap,
                padding: layout.padding,
            }
        }
        FacetKind::Constraints => {
            let constraints = node.constraints.as_ref()?;
            Facet::Constraints {
                horizontal: axis_of(constraints.horizontal),
                vertical: axis_of(constraints.vertical),
            }
        }
        FacetKind::Vector => Facet::Vector {
            point_count: node.points,
        },
        FacetKind::Text => (node.kind == "text").then(|| Facet::Text {
            characters: node.text.chars().count(),
        })?,
        FacetKind::Shape => Facet::Shape {
            points: node.points,
        },
        FacetKind::Instance => node.instance.as_ref().map(|instance| Facet::Instance {
            component_id: instance.component_id.clone(),
        })?,
        FacetKind::Componentish => Facet::Componentish {
            component_key: node.component_key.clone(),
        },
        FacetKind::Variable => (!node.variable_modes.is_empty()).then(|| Facet::Variable {
            modes: node.variable_modes.clone(),
        })?,
        FacetKind::Effects => (!node.effects.is_empty()).then_some(Facet::Effects {
            count: node.effects.len(),
        })?,
        FacetKind::Export => (!node.export_settings.is_empty()).then_some(Facet::Export {
            settings: node.export_settings.len(),
        })?,
        FacetKind::Blend => Facet::Blend {
            mode: node.blend.clone(),
            opacity: node.opacity,
        },
        FacetKind::Prototype | FacetKind::Keyframe => return None,
        FacetKind::Annotation => Facet::Annotation {
            visible: node.visible,
        },
    })
}

fn axis_of(anchor: Anchor) -> ConstraintAxis {
    match anchor {
        Anchor::Start => ConstraintAxis::Start,
        Anchor::Center => ConstraintAxis::Center,
        Anchor::End => ConstraintAxis::End,
        Anchor::Stretch => ConstraintAxis::Stretch,
        Anchor::Scale => ConstraintAxis::Scale,
    }
}

fn anchor_of(axis: ConstraintAxis) -> Anchor {
    match axis {
        ConstraintAxis::Start => Anchor::Start,
        ConstraintAxis::Center => Anchor::Center,
        ConstraintAxis::End => Anchor::End,
        ConstraintAxis::Stretch => Anchor::Stretch,
        ConstraintAxis::Scale => Anchor::Scale,
    }
}

/// Write a facet projection back onto an authored node.
pub fn apply_facet(node: &mut Node, kind: FacetKind, facet: &Facet) -> Result<(), String> {
    let allowed = facets_for_kind(&node.kind);
    if !allowed.contains(&kind) {
        return Err(format!(
            "facet {} is not exposed by kind `{}`",
            kind.as_str(),
            node.kind
        ));
    }
    if facet.kind() != kind {
        return Err(format!(
            "facet payload does not match kind {}",
            kind.as_str()
        ));
    }
    if facet_access(kind) == FacetAccess::ReadOnly {
        return Err(format!("facet {} is a read-only summary", kind.as_str()));
    }
    // Validate the complete payload before touching the node. In particular an
    // invalid resize must not partially alter the network or history state.
    match facet {
        Facet::Frame {
            width,
            height,
            corner_radius,
        } if [*width, *height, *corner_radius]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.) =>
        {
            return Err("facet frame requires finite nonnegative dimensions".into());
        }
        Facet::Frame { .. }
            if node.network.is_some() && (node.width <= 0. || node.height <= 0.) =>
        {
            return Err("facet frame cannot scale a zero-sized vector network".into());
        }
        Facet::Transform { matrix } if matrix.iter().any(|v| !v.is_finite()) => {
            return Err("facet transform requires finite coordinates".into());
        }
        Facet::Stack {
            horizontal: true,
            grid: true,
            ..
        } => {
            return Err("facet stack cannot be both horizontal and grid".into());
        }
        Facet::Stack { gap, padding, .. }
            if !gap.is_finite() || padding.iter().any(|v| !v.is_finite() || *v < 0.) =>
        {
            return Err("facet stack requires a finite gap and nonnegative padding".into());
        }
        Facet::Blend { opacity, .. } if !opacity.is_finite() || !(0. ..=1.).contains(opacity) => {
            return Err("facet blend opacity must be between zero and one".into());
        }
        _ => {}
    }
    match (kind, facet) {
        (FacetKind::Document, Facet::Document { name }) => node.name = name.clone(),
        (FacetKind::Canvas, Facet::Canvas { background }) => match node.fills.first_mut() {
            Some(fill) => fill.color = background.clone(),
            None => node.fills.push(crate::scene::Paint {
                kind: "solid".into(),
                color: background.clone(),
                ..solid_default()
            }),
        },
        (
            FacetKind::Frame,
            Facet::Frame {
                width,
                height,
                corner_radius,
            },
        ) => {
            crate::mutation::resize(node, *width, *height);
            node.corner_radius = *corner_radius;
        }
        (FacetKind::Transform, Facet::Transform { matrix }) => {
            node.transform = Transform(*matrix);
        }
        (FacetKind::Clip, Facet::Clip { on }) => node.clip = *on,
        (FacetKind::Mask, Facet::Mask { on, mask_type }) => {
            node.mask = *on;
            node.mask_type = mask_type.clone();
        }
        (
            FacetKind::Stack,
            Facet::Stack {
                horizontal,
                grid,
                gap,
                padding,
            },
        ) => {
            let layout = node.layout.get_or_insert_with(Default::default);
            layout.mode = if *grid {
                Flow::Grid
            } else if *horizontal {
                Flow::Horizontal
            } else {
                Flow::Vertical
            };
            layout.gap = *gap;
            layout.padding = *padding;
        }
        (
            FacetKind::Constraints,
            Facet::Constraints {
                horizontal,
                vertical,
            },
        ) => {
            let constraints = node.constraints.get_or_insert_with(Default::default);
            constraints.horizontal = anchor_of(*horizontal);
            constraints.vertical = anchor_of(*vertical);
        }
        (FacetKind::Shape, Facet::Shape { points }) => node.points = *points,
        (FacetKind::Instance, Facet::Instance { component_id }) => {
            node.instance
                .get_or_insert_with(|| Box::new(crate::components::Instance {
                        slot_contents: Default::default(),
                    component_id: String::new(),
                    overrides: Default::default(),
                    property_values: Default::default(),
                }))
                .component_id = component_id.clone();
        }
        (FacetKind::Componentish, Facet::Componentish { component_key }) => {
            node.component_key = component_key.clone();
        }
        (FacetKind::Variable, Facet::Variable { modes }) => node.variable_modes = modes.clone(),
        (FacetKind::Blend, Facet::Blend { mode, opacity }) => {
            node.blend = mode.clone();
            node.opacity = *opacity;
        }
        (FacetKind::Annotation, Facet::Annotation { visible }) => node.visible = *visible,
        _ => {
            return Err(format!(
                "facet payload does not match kind {}",
                kind.as_str()
            ));
        }
    }
    Ok(())
}

fn solid_default() -> crate::scene::Paint {
    crate::scene::Paint {
        transform: None,
        id: String::new(),
        kind: "solid".into(),
        color: "#000000".into(),
        opacity: 1.,
        visible: true,
        angle: 0.,
        stops: Vec::new(),
        image: None,
        fit: "cover".into(),
        blend: "normal".into(),
        adjust: None,
        tile: None,
    }
}

/// Test and tooling helper: a fully defaulted node of the given kind.
pub fn sample_node(id: &str, kind: &str) -> Node {
    Node {
        repeat: None,
        repeat_origin: None,
        guides: Default::default(),
        board: None,
        layout_grid: None,
        connector: None,
        path_offset: 0.,
        text_path: None,
        vector_brush: None,
        export_settings: Default::default(),
        arc: None,
        corner_radius: 0.,
        constrain_proportions: false,
        boolean_operation: None,
        bindings: BTreeMap::new(),
        variable_modes: BTreeMap::new(),
        style_refs: BTreeMap::new(),
        mask_type: None,
        id: id.into(),
        kind: kind.into(),
        name: String::new(),
        transform: Transform::default(),
        width: 100.,
        height: 60.,
        children: Vec::new(),
        visible: true,
        locked: false,
        opacity: 1.,
        blend: "normal".into(),
        fills: Vec::new(),
        strokes: Vec::new(),
        effects: Vec::new(),
        radii: [0.; 4],
        smoothing: 0.,
        clip: false,
        mask: false,
        points: 0,
        inner_radius: 0.,
        network: None,
        vector_geometry: None,
        text: String::new(),
        font_size: 28.,
        text_style: None,
        text_runs: Default::default(),
        layout: None,
        sizing: None,
        constraints: None,
        component: None,
        component_set: false,
        component_key: None,
        instance: None,
        instance_origin: None,
        plugin_data: BTreeMap::new(),
        derived_path: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_gates_facet_set() {
        let text = sample_node("n1", "text");
        let kinds: Vec<_> = facet_set(&text).iter().map(|(k, _)| *k).collect();
        assert!(kinds.contains(&FacetKind::Text));
        assert!(!kinds.contains(&FacetKind::Frame));

        let frame = sample_node("n2", "frame");
        let kinds: Vec<_> = facet_set(&frame).iter().map(|(k, _)| *k).collect();
        assert!(kinds.contains(&FacetKind::Frame));
        assert!(kinds.contains(&FacetKind::Transform));
        assert!(kinds.contains(&FacetKind::Blend));
    }

    #[test]
    fn transform_facet_round_trips() {
        let mut n = sample_node("n1", "frame");
        let matrix = [2., 0., 0., 2., 10., -4.];
        apply_facet(&mut n, FacetKind::Transform, &Facet::Transform { matrix }).unwrap();
        assert_eq!(
            facet_view(&n, FacetKind::Transform),
            Some(Facet::Transform { matrix })
        );
    }

    #[test]
    fn stack_facet_writes_layout() {
        let mut n = sample_node("n1", "frame");
        let facet = Facet::Stack {
            horizontal: true,
            grid: false,
            gap: 8.,
            padding: [4.; 4],
        };
        apply_facet(&mut n, FacetKind::Stack, &facet).unwrap();
        let layout = n.layout.as_ref().unwrap();
        assert!(matches!(layout.mode, Flow::Horizontal));
        assert_eq!(layout.gap, 8.);
        assert_eq!(facet_view(&n, FacetKind::Stack), Some(facet));
    }

    #[test]
    fn constraints_facet_round_trips() {
        let mut n = sample_node("n1", "frame");
        let facet = Facet::Constraints {
            horizontal: ConstraintAxis::Scale,
            vertical: ConstraintAxis::Center,
        };
        apply_facet(&mut n, FacetKind::Constraints, &facet).unwrap();
        assert_eq!(facet_view(&n, FacetKind::Constraints), Some(facet));
    }

    #[test]
    fn frame_facet_resize_keeps_extent() {
        let mut n = sample_node("n1", "frame");
        apply_facet(
            &mut n,
            FacetKind::Frame,
            &Facet::Frame {
                width: 200.,
                height: 120.,
                corner_radius: 8.,
            },
        )
        .unwrap();
        assert_eq!((n.width, n.height, n.corner_radius), (200., 120., 8.));
    }

    #[test]
    fn reject_foreign_facet() {
        let mut n = sample_node("n1", "text");
        assert!(
            apply_facet(
                &mut n,
                FacetKind::Frame,
                &Facet::Frame {
                    width: 1.,
                    height: 1.,
                    corner_radius: 0.
                }
            )
            .is_err()
        );
    }

    #[test]
    fn direct_reads_respect_the_same_kind_gate_as_discovery() {
        let node = sample_node("n1", "text");
        assert_eq!(facet_view(&node, FacetKind::Frame), None);
        let capabilities = facet_capabilities(&node);
        assert!(
            capabilities.iter().any(|c| c.kind == FacetKind::Text
                && c.access == FacetAccess::ReadOnly
                && c.present)
        );
        assert!(capabilities.iter().any(|c| c.kind == FacetKind::Clip
            && c.access == FacetAccess::ReadWrite
            && !c.present));
        assert!(!capabilities.iter().any(|c| c.kind == FacetKind::Frame));
    }

    #[test]
    fn json_contract_uses_frontend_camel_case_fields() {
        for payload in [
            serde_json::json!({"kind":"frame","width":10.,"height":20.,"cornerRadius":3.}),
            serde_json::json!({"kind":"mask","on":true,"maskType":"alpha"}),
            serde_json::json!({"kind":"vector","pointCount":4}),
            serde_json::json!({"kind":"instance","componentId":"c1"}),
            serde_json::json!({"kind":"componentish","componentKey":"key"}),
        ] {
            let facet: Facet = serde_json::from_value(payload.clone()).unwrap();
            assert_eq!(serde_json::to_value(facet).unwrap(), payload);
        }
        let legacy: Facet =
            serde_json::from_str(r#"{"kind":"instance","component_id":"c1"}"#).unwrap();
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::json!({"kind":"instance","componentId":"c1"})
        );
    }

    #[test]
    fn summary_writes_and_mismatched_payloads_fail_without_mutation() {
        for (node_kind, kind, payload) in [
            ("text", FacetKind::Text, Facet::Text { characters: 5 }),
            ("frame", FacetKind::Effects, Facet::Effects { count: 5 }),
            ("frame", FacetKind::Export, Facet::Export { settings: 5 }),
            ("path", FacetKind::Vector, Facet::Vector { point_count: 5 }),
        ] {
            let mut node = sample_node("n1", node_kind);
            let before = serde_json::to_value(&node).unwrap();
            assert!(
                apply_facet(&mut node, kind, &payload)
                    .unwrap_err()
                    .contains("read-only")
            );
            assert_eq!(serde_json::to_value(&node).unwrap(), before);
            let mismatch = Facet::Annotation { visible: false };
            assert!(
                apply_facet(&mut node, kind, &mismatch)
                    .unwrap_err()
                    .contains("does not match")
            );
            assert_eq!(serde_json::to_value(&node).unwrap(), before);
        }
    }

    #[test]
    fn invalid_payload_fails_before_dependent_fields_change() {
        let mut node = sample_node("n1", "frame");
        let before = serde_json::to_value(&node).unwrap();
        for payload in [
            Facet::Frame {
                width: 200.,
                height: -1.,
                corner_radius: 4.,
            },
            Facet::Frame {
                width: f64::NAN,
                height: 60.,
                corner_radius: 4.,
            },
            Facet::Transform {
                matrix: [1., 0., 0., 1., f64::INFINITY, 0.],
            },
            Facet::Blend {
                mode: "normal".into(),
                opacity: 2.,
            },
            Facet::Stack {
                horizontal: true,
                grid: true,
                gap: 0.,
                padding: [0.; 4],
            },
        ] {
            assert!(apply_facet(&mut node, payload.kind(), &payload).is_err());
            assert_eq!(serde_json::to_value(&node).unwrap(), before);
        }
    }

    #[test]
    fn instance_facet_creates_component_link() {
        let mut n = sample_node("n1", "instance");
        apply_facet(
            &mut n,
            FacetKind::Instance,
            &Facet::Instance {
                component_id: "c9".into(),
            },
        )
        .unwrap();
        assert_eq!(n.instance.as_ref().unwrap().component_id, "c9");
    }
}
