//! Inferred auto-layout: deriving stack parameters from a static frame's
//! child geometry, replicating the thresholds decoded from the reference
//! engine's layout-inference solver (`wasm-function_41951`).
//!
//! Decoded constants (WAT provenance in comments):
//! - 200.0 / 80.0  initial spacing-class thresholds (@600/@608)
//! - 400.0        narrow-container single-column cutoff (@787)
//! - 1000.0       large-container padding-cap switch (@1512)
//! - 180.0 / 80.0 padding caps for large / small containers (@1512-1515)
//! - 125.0 / 500.0 banner width / height headroom over the row minimum
//!   (@14258/@14221: child > min + headroom ⇒ banner child)
use crate::scene::{Document, Node};
use serde::{Deserialize, Serialize};

pub const LOOSE_SPACING: f64 = 200.;
pub const DENSE_SPACING: f64 = 80.;
pub const NARROW_CONTAINER: f64 = 400.;
pub const LARGE_CONTAINER: f64 = 1000.;
pub const PAD_CAP_LARGE: f64 = 180.;
pub const PAD_CAP_SMALL: f64 = 80.;
pub const BANNER_WIDTH_HEADROOM: f64 = 125.;
pub const BANNER_HEIGHT_HEADROOM: f64 = 500.;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InferredDirection {
    None,
    Vertical,
    Horizontal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredLayout {
    pub direction: InferredDirection,
    /// Uniform spacing between children; `None` when children are not
    /// uniformly spaced (no stack inferred).
    pub gap: Option<f64>,
    pub padding: [f64; 4],
    /// Children whose width exceeds the row minimum by the banner headroom;
    /// the reference engine treats these as full-bleed sections and keeps
    /// them out of the inferred flow.
    pub banner_children: Vec<String>,
    pub flow_order: Vec<String>,
}

/// Padding cap scales with container size: large containers may infer up to
/// `PAD_CAP_LARGE`, small ones up to `PAD_CAP_SMALL` (@1512 `select`).
pub fn padding_cap(container_extent: f64) -> f64 {
    if container_extent > LARGE_CONTAINER {
        PAD_CAP_LARGE
    } else {
        PAD_CAP_SMALL
    }
}

fn metrics(node: &Node) -> (f64, f64, f64, f64) {
    let [a, b, c, d, tx, ty] = node.transform.0;
    let x = tx + 0f64.min(a * node.width) + 0f64.min(c * node.height);
    let y = ty + 0f64.min(b * node.width) + 0f64.min(d * node.height);
    let w = a.abs() * node.width + c.abs() * node.height;
    let h = b.abs() * node.width + d.abs() * node.height;
    (x, y, w, h)
}

/// Infer stack parameters from a static frame.  Returns `direction: None`
/// with no gap when the children are not arranged in a stack.
pub fn infer(doc: &Document, frame_id: &str) -> InferredLayout {
    let mut out = InferredLayout {
        direction: InferredDirection::None,
        gap: None,
        padding: [0.; 4],
        banner_children: Vec::new(),
        flow_order: Vec::new(),
    };
    let Some(frame) = doc.nodes.get(frame_id) else {
        return out;
    };
    let children: Vec<&Node> = frame
        .children
        .iter()
        .filter_map(|id| doc.nodes.get(id))
        .filter(|n| n.visible && !n.sizing_value().absolute)
        .collect();
    if children.len() < 2 {
        return out;
    }

    let boxes: Vec<_> = children.iter().map(|n| metrics(n)).collect();
    // Children are measured in the parent's local basis, including after Scale.
    let (fw, fh) = (frame.width, frame.height);

    // Banner children: extent beyond the row minimum by the decoded
    // headroom (width 125 / height 500) leave the inferred flow (@14258).
    let min_w = boxes.iter().map(|b| b.2).fold(f64::INFINITY, f64::min);
    let min_h = boxes.iter().map(|b| b.3).fold(f64::INFINITY, f64::min);
    let mut flow: Vec<usize> = Vec::new();
    for (i, b) in boxes.iter().enumerate() {
        let banner = b.2 > min_w + BANNER_WIDTH_HEADROOM || b.3 > min_h + BANNER_HEIGHT_HEADROOM;
        if banner {
            out.banner_children.push(children[i].id.clone());
        } else {
            flow.push(i);
        }
    }
    if flow.len() < 2 {
        return out;
    }

    // Column/row test: compare along both axes with the spacing-class
    // thresholds (@600: 200 loose baseline; @608: 80 dense cutoff).
    // boxes are (x, y, w, h); axis helpers pick main/cross components.
    let get = |b: (f64, f64, f64, f64), axis: usize| -> f64 {
        match axis {
            0 => b.0,
            _ => b.1,
        }
    };
    let extent = |b: (f64, f64, f64, f64), axis: usize| -> f64 {
        match axis {
            0 => b.2,
            _ => b.3,
        }
    };
    let axis_gap = |axis: usize, cross: usize| -> Option<f64> {
        let mut items: Vec<_> = flow.iter().map(|&i| boxes[i]).collect();
        items.sort_by(|a, b| {
            get(*a, axis)
                .partial_cmp(&get(*b, axis))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut gaps = Vec::new();
        for w in items.windows(2) {
            let (a, b) = (w[0], w[1]);
            let gap = get(b, axis) - (get(a, axis) + extent(a, axis));
            if gap < -1e-6 {
                return None; // overlapping along this axis
            }
            if gap > LOOSE_SPACING {
                return None; // @600: too loose to infer a stack
            }
            gaps.push(gap);
        }
        // Cross axis: spans must start near the same origin (a column/row,
        // not a diagonal or 2D arrangement).
        let starts: Vec<f64> = items.iter().map(|b| get(*b, cross)).collect();
        let spread = starts.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
            - starts.iter().cloned().fold(f64::INFINITY, f64::min);
        if spread > DENSE_SPACING {
            return None;
        }
        // Uniformity: gaps within the dense threshold of each other.
        let first = gaps[0];
        if gaps.iter().any(|g| (g - first).abs() > DENSE_SPACING) {
            return None;
        }
        Some(first.max(0.))
    };

    let v = axis_gap(1, 0);
    let h = axis_gap(0, 1);
    out.direction = match (v, h) {
        (Some(_), None) => InferredDirection::Vertical,
        (None, Some(_)) => InferredDirection::Horizontal,
        // Prefer the axis whose gaps are denser (children packed tighter).
        (Some(vg), Some(hg)) => {
            if vg <= hg {
                InferredDirection::Vertical
            } else {
                InferredDirection::Horizontal
            }
        }
        (None, None) => return out,
    };
    let axis = usize::from(out.direction == InferredDirection::Vertical);
    flow.sort_by(|&a, &b| get(boxes[a], axis).total_cmp(&get(boxes[b], axis)));
    out.flow_order = flow.iter().map(|&i| children[i].id.clone()).collect();
    out.gap = match out.direction {
        InferredDirection::Vertical => v,
        InferredDirection::Horizontal => h,
        InferredDirection::None => None,
    };

    // Padding from the flow bounds, clamped through the decoded size-scaled
    // cap (@1512): padding = min(observed, cap).
    let cap = padding_cap(if out.direction == InferredDirection::Vertical {
        fw
    } else {
        fh
    });
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for &i in &flow {
        let b = boxes[i];
        x0 = x0.min(b.0);
        y0 = y0.min(b.1);
        x1 = x1.max(b.0 + b.2);
        y1 = y1.max(b.1 + b.3);
    }
    // Child bounds are parent-local; the frame's world translation/scale
    // must not be subtracted from padding in that same local basis.
    out.padding = [
        y0.clamp(0., cap),
        (fw - x1).clamp(0., cap),
        (fh - y1).clamp(0., cap),
        x0.clamp(0., cap),
    ];
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;
    use std::collections::BTreeMap;

    fn doc_with(children: &[(f64, f64, f64, f64)], frame: (f64, f64, f64, f64)) -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut f = sample_node("f", "frame");
        f.width = frame.2;
        f.height = frame.3;
        f.transform.0[4] = frame.0;
        f.transform.0[5] = frame.1;
        for (i, (x, y, w, h)) in children.iter().enumerate() {
            let mut c = sample_node(&format!("c{i}"), "rectangle");
            c.width = *w;
            c.height = *h;
            c.transform.0[4] = *x;
            c.transform.0[5] = *y;
            f.children.push(format!("c{i}"));
            doc.nodes.insert(format!("c{i}"), c);
        }
        doc.nodes.insert("f".into(), f);
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["f".into()],
            background: "#ffffff".into(),
        });
        doc
    }

    #[test]
    fn infers_vertical_stack_with_uniform_gap() {
        // Frame 300x400; children 100 wide, stacked vertically, gap 8,
        // padding 16 all around.
        // Snug frame (content 100x166 + 16 all around = 132x198).
        let doc = doc_with(
            &[
                (16., 16., 100., 50.),
                (16., 74., 100., 50.),
                (16., 132., 100., 50.),
            ],
            (0., 0., 132., 198.),
        );
        let r = infer(&doc, "f");
        assert_eq!(r.direction, InferredDirection::Vertical);
        assert!((r.gap.unwrap() - 8.).abs() < 1e-9, "gap {:?}", r.gap);
        assert!(
            r.padding.iter().all(|&p| (p - 16.).abs() < 1e-9),
            "padding {:?}",
            r.padding
        );
        assert!(r.banner_children.is_empty());
        // Loose frame: leftover space clamps to the small-container cap 80.
        let doc = doc_with(
            &[
                (16., 16., 100., 50.),
                (16., 74., 100., 50.),
                (16., 132., 100., 50.),
            ],
            (0., 0., 300., 400.),
        );
        let r = infer(&doc, "f");
        assert_eq!(r.direction, InferredDirection::Vertical);
        assert!(
            (r.padding[1] - PAD_CAP_SMALL).abs() < 1e-9,
            "right clamps to 80: {:?}",
            r.padding
        );
        assert!(
            (r.padding[2] - PAD_CAP_SMALL).abs() < 1e-9,
            "bottom clamps to 80"
        );
    }

    #[test]
    fn infers_horizontal_stack() {
        let doc = doc_with(
            &[
                (16., 16., 50., 100.),
                (74., 16., 50., 100.),
                (132., 16., 50., 100.),
            ],
            (0., 0., 400., 200.),
        );
        let r = infer(&doc, "f");
        assert_eq!(r.direction, InferredDirection::Horizontal);
        assert!((r.gap.unwrap() - 8.).abs() < 1e-9);
    }

    #[test]
    fn loose_children_do_not_infer() {
        // Gap 250 exceeds the 200 loose threshold: no stack.
        let doc = doc_with(
            &[(16., 16., 100., 50.), (16., 316., 100., 50.)],
            (0., 0., 300., 500.),
        );
        let r = infer(&doc, "f");
        assert_eq!(r.direction, InferredDirection::None);
        assert!(r.gap.is_none());
    }

    #[test]
    fn banner_child_leaves_the_flow() {
        // One child 100 wide, another min+130 wide: the wide one exceeds the
        // 125 width headroom and is treated as a banner section.
        let doc = doc_with(
            &[
                (16., 16., 100., 50.),
                (16., 74., 230., 50.),
                (16., 132., 100., 50.),
            ],
            (0., 0., 300., 400.),
        );
        let r = infer(&doc, "f");
        assert_eq!(r.banner_children, vec!["c1".to_string()]);
        // The remaining two still form a stack; with the banner out of the
        // flow the observed gap spans across where it sat (132 - 66 = 66).
        assert_eq!(r.direction, InferredDirection::Vertical);
        assert!((r.gap.unwrap() - 66.).abs() < 1e-9, "gap {:?}", r.gap);
    }

    #[test]
    fn padding_cap_scales_with_container() {
        assert_eq!(padding_cap(999.), PAD_CAP_SMALL);
        assert_eq!(padding_cap(1001.), PAD_CAP_LARGE);
        // Large frame with 400px left margin: padding clamps to 180.
        let doc = doc_with(
            &[(400., 16., 100., 50.), (400., 74., 100., 50.)],
            (0., 0., 1200., 200.),
        );
        let r = infer(&doc, "f");
        assert!(
            (r.padding[3] - PAD_CAP_LARGE).abs() < 1e-9,
            "left {:?}",
            r.padding[3]
        );
    }

    #[test]
    fn overlapping_children_do_not_infer() {
        let doc = doc_with(
            &[(16., 16., 100., 50.), (16., 40., 100., 50.)],
            (0., 0., 300., 200.),
        );
        let r = infer(&doc, "f");
        assert_eq!(r.direction, InferredDirection::None);
    }
}
