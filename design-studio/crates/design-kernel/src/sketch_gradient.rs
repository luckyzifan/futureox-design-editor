//! Local byte rendering for an unchanged, horizontal Sketch sRGB gradient.
//! The 16-by-16 phase table was measured from independent constant-alpha
//! gradient panels on Sketch 93 (155335). Three different alpha intervals
//! agreed on all 256 phases. A different authored gradient is not admitted
//! merely because it came from the same document.

use crate::{
    blend::{Pixel, Surface},
    math::{Rect, Transform},
    raster::Mask,
    scene::{Document, Node, Paint},
};

pub(crate) const BLEND: &str = "sketch-gradient-over";
struct PhaseTable {
    bytes: [u8; 256],
    uniforms: [f32; 86],
}

fn phase_table() -> &'static PhaseTable {
    static TABLE: std::sync::OnceLock<PhaseTable> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let entries: Vec<u8> =
            serde_json::from_str(include_str!("../shaders/sketch-gradient-noise.json"))
                .expect("bundled Sketch gradient rank table");
        let bytes: [u8; 256] = entries
            .try_into()
            .expect("one rank for each Sketch gradient phase");
        // Three byte ranks fit exactly in one binary32 uniform. The two-stop
        // shader uses the otherwise unused stop slots starting at float 60.
        let mut uniforms = [0.; 86];
        for (packed, chunk) in uniforms.iter_mut().zip(bytes.chunks(3)) {
            let word = chunk
                .iter()
                .enumerate()
                .fold(0u32, |word, (i, &byte)| word | (u32::from(byte) << (8 * i)));
            *packed = word as f32;
        }
        PhaseTable { bytes, uniforms }
    })
}

pub fn phase_uniforms() -> &'static [f32; 86] {
    &phase_table().uniforms
}

pub(crate) struct SketchGradient {
    rect: Rect,
    stops: [[f32; 4]; 2],
    phases: &'static [u8; 256],
}

/// Keep only an authored paint that still agrees with its imported
/// source record. A render-only projection may carry just this receipt.
pub(crate) fn source_paint<'a>(doc: &Document, node: &'a Node) -> Option<&'a Paint> {
    if doc.color_management.is_some()
        || doc
            .design_system
            .as_ref()?
            .sketch_containers
            .get("sketchDocumentColorSpace")?
            .as_u64()?
            != 1
        || node.kind != "vector"
        || node.opacity != 1.
        || node.blend != "normal"
        || node.passes_backdrop()
        || node.mask
        || node.clip
        || !node.children.is_empty()
        || node.effects.iter().any(|effect| effect.visible)
        || node.strokes.iter().any(|stroke| stroke.visible)
    {
        return None;
    }
    let [paint] = node.fills.as_slice() else {
        return None;
    };
    let [start, end] = paint.stops.as_slice() else {
        return None;
    };
    if !paint.visible
        || paint.kind != "linear"
        || paint.opacity != 1.
        || paint.blend != "normal"
        || paint.angle != 0.
        || paint.transform != Some(Transform([-1., 0., 0., -1., 1., 1.]))
        || start.offset != 0.
        || end.offset != 1.
    {
        return None;
    }
    let source: serde_json::Value = serde_json::from_str(crate::interop::sketch_binding(
        doc,
        node,
        "sketchSourceGradients",
    )?)
    .ok()?;
    let source_paint: Paint =
        serde_json::from_value(source.get("0")?.get("paint")?.clone()).ok()?;
    (source_paint == *paint).then_some(paint)
}

pub(crate) fn render_paint_binding(doc: &Document, node: &Node) -> Option<serde_json::Value> {
    let paint = source_paint(doc, node)?;
    Some(serde_json::json!({"0": {"paint":paint}}).to_string().into())
}

/// Keep only the source receipt needed by this rendering pass when creating
/// a non-editable canvas snapshot. All other Sketch container receipts stay
/// on the authored source, rather than duplicating raw archive metadata.
pub fn retain_render_metadata(doc: &mut Document) -> Result<(), String> {
    let mut metadata = serde_json::Map::new();
    for node in doc.nodes.values() {
        crate::render_cancellation::checkpoint()?;
        if node
            .fills
            .first()
            .is_some_and(|paint| paint.kind == "linear")
            && let Some(binding) = render_paint_binding(doc, node)
        {
            metadata.insert(
                node.id.clone(),
                serde_json::json!({
                    "bindings": {"sketchSourceGradients":binding}
                }),
            );
        }
    }
    if let Some(system) = &mut doc.design_system {
        system.sketch_containers.clear();
        if !metadata.is_empty() {
            system
                .sketch_containers
                .insert("nodeMetadata".into(), metadata.into());
            system
                .sketch_containers
                .insert("sketchDocumentColorSpace".into(), serde_json::json!(1));
        }
    }
    Ok(())
}

impl SketchGradient {
    pub(crate) fn for_node(
        doc: &Document,
        node: &Node,
        matrix: Transform,
        edges: [f64; 4],
    ) -> Option<Self> {
        let [a, b, c, d, x, y] = matrix.0;
        if [a, b, c, d] != [1., 0., 0., 1.]
            || [x, y, node.width, node.height]
                .iter()
                .any(|v| !v.is_finite() || v.fract() != 0.)
            || edges != [x, y, x + node.width, y + node.height]
            || edges.iter().any(|v| v.abs() > 1_048_576.)
        {
            return None;
        }
        let paint = source_paint(doc, node)?;
        let stops = [
            crate::color::unmanaged_straight(&paint.stops[0].color).ok()?,
            crate::color::unmanaged_straight(&paint.stops[1].color).ok()?,
        ];
        if stops.iter().all(|stop| stop[3] == 1.) || stops.iter().all(|stop| stop[3] == 0.) {
            return None;
        }
        Some(Self {
            rect: Rect::new(x as i32, y as i32, node.width as u32, node.height as u32),
            stops,
            phases: &phase_table().bytes,
        })
    }

    fn pixel(&self, x: i32, y: i32) -> Pixel {
        let local_x = x - self.rect.x;
        let local_y = y - self.rect.y;
        let t = 1. - (local_x as f32 + 0.5) / self.rect.w as f32;
        let [a, b] = self.stops;
        let color: [f32; 4] =
            std::array::from_fn(|channel| a[channel] + (b[channel] - a[channel]) * t);
        let phase = ((local_y & 15) * 16 + (local_x & 15)) as usize;
        let threshold = f32::from(self.phases[phase]) / 256.;
        Pixel(
            Pixel::rgba(color[0], color[1], color[2], color[3])
                .0
                .map(|value| (value * 255. + threshold).floor() / 255.),
        )
    }

    pub(crate) fn composite(
        &self,
        target: &mut Surface,
        output: Option<Rect>,
        clip: Option<&Mask>,
    ) -> Result<(), String> {
        let region = self
            .rect
            .intersect(output.unwrap_or(target.rect))
            .intersect(target.rect);
        for y in region.y..region.bottom() {
            crate::render_cancellation::checkpoint()?;
            for x in region.x..region.right() {
                let coverage = clip.map_or(1., |mask| mask.at(x, y));
                let source = self.pixel(x, y).opacity(coverage);
                if source.0[3] <= 0. {
                    continue;
                }
                let index = target.rect.index(x, y).expect("gradient inside target");
                let dest = &mut target.pixels[index];
                *dest = if coverage == 1. {
                    let dst = dest.rgba8_quantized();
                    let result =
                        crate::blend::over_mode(dst, source, crate::blend::BlendMode::Normal);
                    result.rgba8_quantized()
                } else {
                    crate::blend::over_mode(*dest, source, crate::blend::BlendMode::Normal)
                };
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_rank_uniforms_are_exact() {
        let table = phase_table();
        for (index, &expected) in table.bytes.iter().enumerate() {
            let word = table.uniforms[index / 3] as u32;
            assert_eq!(((word >> (8 * (index % 3))) & 255) as u8, expected);
        }
    }

    #[test]
    fn phase_is_layer_local_for_translations_and_cropped_output() {
        let stops = [[0.8, 0.2, 0.7, 0.8], [0.15, 0.95, 0.1, 0.4]];
        let turn = |x, y| SketchGradient {
            rect: Rect::new(x, y, 40, 35),
            stops,
            phases: &phase_table().bytes,
        };
        let reference = turn(0, 0);
        let translated = turn(-23, 37);
        let crop = Rect::new(3, 8, 22, 24);
        let mut full = Surface::new(reference.rect).unwrap();
        let mut partial = Surface::new(crop).unwrap();
        full.pixels.fill(Pixel([0.024, 0.07, 0.16, 1.]));
        partial.pixels.fill(Pixel([0.024, 0.07, 0.16, 1.]));
        reference.composite(&mut full, None, None).unwrap();
        reference.composite(&mut partial, Some(crop), None).unwrap();
        for y in crop.y..crop.bottom() {
            for x in crop.x..crop.right() {
                assert_eq!(reference.pixel(x, y).0, translated.pixel(x - 23, y + 37).0);
                assert_eq!(full.at(x, y).0, partial.at(x, y).0);
            }
        }
        assert_ne!(reference.pixel(3, 1).0, reference.pixel(3, 2).0);
        assert_eq!(reference.pixel(3, 1).0, reference.pixel(3, 17).0);
    }
}
