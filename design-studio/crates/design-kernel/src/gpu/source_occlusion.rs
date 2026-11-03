//! Front-to-back visibility certificate for immutable SDR source tiles. An
//! independent normal overwrite must cover the whole downstream demand.
use super::*;
use crate::geometry_snapshot::Prepared;
use base64::Engine as _;

fn standard_png(uri: &str) -> bool {
    let Some(data) = uri.strip_prefix("data:image/png;base64,") else {
        return false;
    };
    let size = data.len().min(4096) & !3;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&data[..size]) else {
        return false;
    };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.get(12..16) != Some(b"IHDR") {
        return false;
    }
    let mut pos = 8;
    while pos + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        match &bytes[pos + 4..pos + 8] {
            b"IDAT" => return true,
            b"iCCP" | b"cICP" | b"acTL" => return false,
            _ => {}
        }
        let Some(end) = pos.checked_add(12).and_then(|n| n.checked_add(size)) else {
            return false;
        };
        pos = end;
    }
    false
}
fn colour(s: &str) -> Option<f64> {
    let (space, rgb, alpha) = crate::color::parse(s, crate::color::ColorSpace::Srgb).ok()?;
    (matches!(
        space,
        crate::color::ColorSpace::Srgb | crate::color::ColorSpace::LinearSrgb
    ) && rgb.iter().all(|v| (0. ..=1.).contains(v))
        && (0. ..=1.).contains(&alpha))
    .then_some(alpha)
}
fn bounded_paint(p: &Paint) -> bool {
    !p.visible
        || p.blend == "normal"
            && (0. ..=1.).contains(&p.opacity)
            && match p.kind.as_str() {
                "solid" => colour(&p.color).is_some(),
                "linear" | "radial" | "angular" | "diamond" => p
                    .stops
                    .iter()
                    .all(|s| s.offset.is_finite() && colour(&s.color).is_some()),
                "image" => p.adjust.is_none() && p.image.as_deref().is_some_and(standard_png),
                _ => false,
            }
}
fn opaque_paint(p: &Paint) -> bool {
    p.visible
        && p.opacity == 1.
        && p.blend == "normal"
        && match p.kind.as_str() {
            "solid" => colour(&p.color) == Some(1.),
            "linear" | "radial" | "angular" | "diamond" => {
                !p.stops.is_empty() && p.stops.iter().all(|s| colour(&s.color) == Some(1.))
            }
            _ => false,
        }
}
struct Check<'a> {
    doc: &'a Document,
    prepared: &'a HashMap<String, Prepared>,
    region: Rect,
    work: usize,
}
impl Check<'_> {
    fn bounded(&mut self, id: &str) -> bool {
        let Some(p) = self.prepared.get(id) else {
            return true;
        };
        let n = &self.doc.nodes[id];
        if !n.visible || n.opacity == 0. || p.bounds.intersect(self.region).empty() {
            return true;
        }
        self.work += 1;
        if self.work > 4096 {
            return false;
        }
        matches!(n.blend.as_str(), "normal" | "pass-through")
            && (0. ..=1.).contains(&n.opacity)
            && n.fills.iter().all(bounded_paint)
            && n.strokes
                .iter()
                .all(|s| !s.visible || bounded_paint(&s.paint))
            && n.effects.iter().filter(|e| e.visible).all(|e| {
                matches!(
                    e.kind.as_str(),
                    "blur" | "gaussian-blur" | "shadow" | "inner-shadow"
                ) && e.radius.is_finite()
                    && e.gradient_blur.is_none()
                    && e.spread == 0.
                    && colour(&e.color).is_some()
            })
            && n.render_children().iter().all(|id| self.bounded(id))
    }
    fn opaque(&mut self, id: &str) -> bool {
        let Some(p) = self.prepared.get(id) else {
            return false;
        };
        let n = &self.doc.nodes[id];
        if !n.visible
            || n.opacity != 1.
            || n.mask
            || n.composite_blend() != "normal"
            || p.bounds.intersect(self.region).empty()
        {
            return false;
        }
        self.work += 1;
        if self.work > 4096 {
            return false;
        }
        if n.effects
            .iter()
            .any(|e| e.visible && !matches!(e.kind.as_str(), "inner-shadow" | "shadow"))
        {
            return false;
        }
        if n.clip && constant_fill_coverage(n, p, self.region) != Some(true) {
            return false;
        }
        if let Some(mask) = self.doc.mask_child(n) {
            if mask.mask_type.as_deref() != Some("shape")
                || !mask.visible
                || !self
                    .prepared
                    .get(&mask.id)
                    .is_some_and(|mp| constant_fill_coverage(mask, mp, self.region) == Some(true))
            {
                return false;
            }
        }
        if n.fills.iter().any(opaque_paint)
            && constant_fill_coverage(n, p, self.region) == Some(true)
        {
            return true;
        }
        n.render_children()
            .iter()
            .rev()
            .any(|child| self.opaque(child))
    }
}
/// An outer shadow is drawn behind its source. A fully opaque foreground
/// hides it even when that foreground is assembled from nested siblings.
pub(super) fn covers_own_shadow(
    doc: &Document,
    prepared: &HashMap<String, Prepared>,
    node: &Node,
    region: Rect,
) -> bool {
    if node.render_children().is_empty()
        || region.empty()
        || region.w > 1024
        || region.h > 1024
        || !node.effects.iter().any(|e| e.visible)
        || !node
            .effects
            .iter()
            .filter(|e| e.visible)
            .all(|e| e.kind == "shadow")
    {
        return false;
    }
    let mut check = Check {
        doc,
        prepared,
        region,
        work: 0,
    };
    check.opaque(&node.id) && check.bounded(&node.id)
}
pub(super) fn start(
    doc: &Document,
    prepared: &HashMap<String, Prepared>,
    children: &[String],
    region: Rect,
) -> usize {
    if children.len() < 2 || region.empty() || region.w > 2048 || region.h > 2048 {
        return 0;
    }
    let mut check = Check {
        doc,
        prepared,
        region,
        work: 0,
    };
    // Preserve initially required mask objects; masks constrain the entire
    // sibling content even when their position precedes an opaque child.
    for i in (1..children.len()).rev() {
        if check.opaque(&children[i]) {
            return if children.iter().all(|id| check.bounded(id)) {
                i
            } else {
                0
            };
        }
    }
    0
}
