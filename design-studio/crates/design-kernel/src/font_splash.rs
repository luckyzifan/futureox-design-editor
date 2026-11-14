//! Device-pixel text masks for Sketch line boxes.
//!
//! Poppler 24.02 rasterizes the Quartz text-preview PDF with FreeType's
//! grayscale rasterizer (`FT_LOAD_NO_HINTING`), snaps each glyph's horizontal
//! device origin to a quarter pixel by truncation, and drops the vertical
//! fraction. The analytic area program then covers those masks, so CPU and
//! WebGPU stay on the same coverage formula. Layout positions are unchanged.
use crate::math::{Point, Transform};
use crate::path::Contour;
use crate::scene::Node;
use std::sync::Arc;

const MAX_MASK_PIXELS: usize = 2_000_000;

struct Stamp {
    left: i32,
    top: i32,
    width: i32,
    rows: i32,
    coverage: Vec<u8>,
}

fn rasterize_glyph(
    bytes: &Arc<Vec<u8>>,
    digest: [u8; 32],
    index: u32,
    glyph: u32,
    size_px: f64,
    x_frac: i32,
) -> Option<Stamp> {
    let bitmap = splash_glyph::rasterize(bytes, digest, index, glyph, size_px, x_frac)?;
    Some(Stamp {
        left: bitmap.left,
        top: bitmap.top,
        width: bitmap.width,
        rows: bitmap.rows,
        coverage: bitmap.coverage,
    })
}

fn axis_scale(matrix: Transform) -> Option<f64> {
    let [a, b, c, d, _, _] = matrix.0;
    if b.abs() > 1e-9 || c.abs() > 1e-9 || a <= 1e-4 || d <= 1e-4 {
        return None;
    }
    if (a - d).abs() > 1e-4 * a.max(d) || a > 128. {
        return None;
    }
    Some(a)
}

fn sketch_line_box(node: &Node) -> bool {
    let Some(style) = node.text_style.as_ref() else {
        return false;
    };
    node.kind == "text"
        && node.text_path.is_none()
        && style.writing_mode != "vertical"
        && (matches!(style.line_box_baseline.as_str(), "nearest-point" | "sketch-font-leading")
            || (style.line_height_auto && (style.line_height - 1.35).abs() <= 1e-9))
}

fn coverage_rects(
    mask: &[u8],
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> Vec<Contour> {
    let mut rects = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let coverage = mask[(y * width + x) as usize];
            if coverage == 0 {
                continue;
            }
            let x0 = f64::from(origin_x + x);
            let y0 = f64::from(origin_y + y);
            let y1 = y0 + f64::from(coverage) / 255.0;
            rects.push(Contour {
                closed: true,
                points: vec![
                    Point::new(x0, y0),
                    Point::new(x0 + 1.0, y0),
                    Point::new(x0 + 1.0, y1),
                    Point::new(x0, y1),
                ],
            });
        }
    }
    rects
}

/// Replace a Sketch text fill with device rectangles whose area equals the
/// FreeType grayscale mask. `None` keeps the authored outlines.
pub(crate) fn sketch_device_mask(
    node: &Node,
    fonts: &crate::font::Fonts,
    matrix: Transform,
) -> Option<Vec<Contour>> {
    if !sketch_line_box(node) {
        return None;
    }
    let scale = axis_scale(matrix)?;
    if node.text_runs.iter().any(|run| run.color.is_some()) {
        return None;
    }
    let layout = fonts.node_measure(node, Some(node.width)).ok()?;
    if layout.glyphs.is_empty()
        || layout
            .glyphs
            .iter()
            .any(|glyph| glyph.path_transform.is_some() || glyph.has_variations())
    {
        return None;
    }
    let align = node
        .text_style
        .as_ref()
        .map(|style| style.vertical_align.as_str())
        .unwrap_or("top");
    let offset = (node.height - layout.height).max(0.)
        * match align {
            "center" => 0.5,
            "bottom" => 1.0,
            _ => 0.0,
        };
    let mut stamps = Vec::with_capacity(layout.glyphs.len());
    let mut stamp_pixels = 0usize;
    for glyph in &layout.glyphs {
        let device = matrix.point(Point::new(glyph.x, glyph.y + offset));
        if !device.finite() {
            return None;
        }
        let x0 = device.x.floor();
        let y0 = device.y.floor();
        let frac = ((device.x - x0) * 4.0).floor();
        if !(0.0..4.0).contains(&frac) {
            return None;
        }
        let (bytes, index, digest) = fonts.owned_face_bytes(&glyph.font_id)?;
        let stamp = rasterize_glyph(
            &bytes,
            digest,
            index,
            u32::from(glyph.id),
            glyph.size * scale,
            frac as i32,
        )?;
        stamp_pixels = stamp_pixels.checked_add(stamp.coverage.len())?;
        if stamp_pixels > MAX_MASK_PIXELS {
            return None;
        }
        let left = (x0 as i32).saturating_add(stamp.left);
        let top = (y0 as i32).saturating_sub(stamp.top);
        stamps.push(Stamp { left, top, ..stamp });
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for stamp in &stamps {
        if stamp.width == 0 || stamp.rows == 0 {
            continue;
        }
        min_x = min_x.min(stamp.left);
        min_y = min_y.min(stamp.top);
        max_x = max_x.max(stamp.left.saturating_add(stamp.width));
        max_y = max_y.max(stamp.top.saturating_add(stamp.rows));
    }
    if min_x >= max_x || min_y >= max_y {
        return Some(Vec::new());
    }
    let width = max_x.saturating_sub(min_x);
    let height = max_y.saturating_sub(min_y);
    if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > MAX_MASK_PIXELS as i64 {
        return None;
    }
    let mut mask = vec![0u8; (width as usize) * (height as usize)];
    for stamp in &stamps {
        for row in 0..stamp.rows {
            for col in 0..stamp.width {
                let src = stamp.coverage[(row * stamp.width + col) as usize];
                if src == 0 {
                    continue;
                }
                let x = stamp.left + col - min_x;
                let y = stamp.top + row - min_y;
                if x < 0 || y < 0 || x >= width || y >= height {
                    continue;
                }
                let i = (y * width + x) as usize;
                let dst = u32::from(mask[i]);
                let add = (u32::from(src) * (255 - dst) + 127) / 255;
                mask[i] = dst.saturating_add(add).min(255) as u8;
            }
        }
    }
    if mask.iter().filter(|&&coverage| coverage != 0).count() > 65_536 {
        return None;
    }
    Some(coverage_rects(&mask, min_x, min_y, width, height))
}
