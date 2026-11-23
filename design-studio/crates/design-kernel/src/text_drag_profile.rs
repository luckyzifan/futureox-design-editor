//! Stage timings for dragging one text layer on the native CPU.
//!
//! Interactive frames compile a GPU scene after `apply_interaction_transforms`.
//! Shaping and glyph outlines are timed separately from that compile and from
//! the packet bytes. This is not a canvas, WebGPU, Metal, or desktop measurement.
use crate::fidelity::RasterProfile;
use crate::font::Fonts;
use crate::math::{Rect, Transform};
use crate::path::Path;
use crate::renderer::{Engine, RenderOptions, View};
use crate::scene::Node;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Instant;

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}

fn percentile(samples: &mut [f64], p: f64) -> f64 {
    assert!(!samples.is_empty());
    samples.sort_by(f64::total_cmp);
    let index = ((samples.len() - 1) as f64 * p).round() as usize;
    samples[index]
}

fn node(text: &str, width: f64, height: f64, wrap: bool, sketch: bool) -> Node {
    let mut style = json!({"wrap": wrap, "fontId": "default"});
    if sketch {
        style["lineBoxBaseline"] = json!("nearest-point");
    }
    serde_json::from_value(json!({
        "id": "t", "kind": "text", "text": text, "fontSize": 18.0,
        "width": width, "height": height,
        "transform": [1, 0, 0, 1, 16, 20],
        "fills": [{"kind": "solid", "color": "#111111"}],
        "textStyle": style
    }))
    .expect("text node")
}

fn document(text_node: &Node) -> String {
    json!({
        "schemaVersion": 1, "id": "text-drag", "name": "text drag",
        "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["t"]}],
        "nodes": {"t": text_node}
    })
    .to_string()
}

fn cache_key(node: &Node, fonts: &Fonts) -> Vec<u8> {
    serde_json::to_vec(&(
        &node.text,
        node.font_size.to_bits(),
        node.width.to_bits(),
        node.height.to_bits(),
        &node.text_style,
        &node.text_runs,
        &node.text_path,
        fonts.glyph_origin_quantization(),
    ))
    .expect("text path key")
}

fn flatten_at(path: &Path, tolerance: f64, x: f64) -> Result<Vec<crate::path::Contour>, String> {
    path.flatten_for_fill(
        Transform([1., 0., 0., 1., x, 20.]),
        tolerance,
        Rect::new(-64, -64, 1024, 768),
        tolerance < 0.001,
    )
}

fn point_delta(
    left: &[crate::path::Contour],
    right: &[crate::path::Contour],
    dx: f64,
) -> Option<f64> {
    if left.len() != right.len() {
        return None;
    }
    let mut max = 0_f64;
    for (a, b) in left.iter().zip(right) {
        if a.points.len() != b.points.len() || a.closed != b.closed {
            return None;
        }
        for (p, q) in a.points.iter().zip(&b.points) {
            max = max.max((p.x + dx - q.x).abs()).max((p.y - q.y).abs());
        }
    }
    Some(max)
}

fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn options(profile: &str) -> (RenderOptions, String) {
    let options = RenderOptions {
        animation: None,
        page_id: "p".into(),
        width: 320,
        height: 200,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: false,
        grid: false,
        pixel_preview: None,
        raster_profile: if profile == "figmaSubpixel" {
            RasterProfile::FigmaSubpixel
        } else {
            RasterProfile::Analytic
        },
        interactive_effects: false,
        checkerboard: false,
    };
    let request = json!({
        "pageId": "p", "width": 320, "height": 200,
        "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "transparent": false, "grid": false,
        "rasterProfile": profile
    })
    .to_string();
    (options, request)
}

fn load(font: &[u8], document: &str) -> Result<Engine, String> {
    let mut engine = Engine::new();
    engine.load_font(font)?;
    engine.load_document(document)?;
    Ok(engine)
}

fn pose(dx: f64) -> BTreeMap<String, Transform> {
    BTreeMap::from([("t".into(), Transform([1., 0., 0., 1., 16. + dx, 20.]))])
}

/// Which text-layer drag stages to time. `stages` includes shaping, glyph
/// outlines, flatten and the Sketch mask. The drag compile always runs.
pub struct TextDragMeasure {
    pub repeats: usize,
    pub case_id: Option<String>,
    pub stages: bool,
}

/// Time glyph outline/shaping caches, flatten, Sketch mask stamps, and the
/// native scene compile used by a fractional text-layer drag.
pub fn measure(font: &[u8], options: &TextDragMeasure) -> Result<Value, String> {
    let repeats = options.repeats;
    if font.is_empty() || repeats == 0 || repeats > 64 {
        return Err("Invalid text drag profile".into());
    }
    let single = "Hello 文字";
    let multi = "设计文字拖动 Text layer 0123 ".repeat(4);
    let mut cases = Vec::new();
    let selected = options.case_id.as_deref();
    let want = |id: &str| selected.is_none_or(|chosen| chosen == id);
    if want("single-analytic") {
        cases.push(case(
            font,
            "single-analytic",
            single,
            220.,
            36.,
            false,
            false,
            "analytic",
            repeats,
            0.5,
            options.stages,
        )?);
    }
    if want("multi-analytic") {
        cases.push(case(
            font,
            "multi-analytic",
            &multi,
            260.,
            150.,
            true,
            false,
            "analytic",
            repeats,
            0.5,
            options.stages,
        )?);
    }
    if want("single-figmaSubpixel") {
        cases.push(case(
            font,
            "single-figmaSubpixel",
            single,
            220.,
            36.,
            false,
            false,
            "figmaSubpixel",
            repeats,
            0.5,
            options.stages,
        )?);
    }
    if want("multi-figmaSubpixel") {
        cases.push(case(
            font,
            "multi-figmaSubpixel",
            &multi,
            260.,
            150.,
            true,
            false,
            "figmaSubpixel",
            repeats,
            0.5,
            options.stages,
        )?);
    }
    if want("multi-figmaSubpixel-integer") {
        cases.push(case(
            font,
            "multi-figmaSubpixel-integer",
            &multi,
            260.,
            150.,
            true,
            false,
            "figmaSubpixel",
            repeats,
            1.0,
            options.stages,
        )?);
    }
    if want("multi-sketch-analytic") {
        cases.push(case(
            font,
            "multi-sketch-analytic",
            &multi,
            260.,
            150.,
            true,
            true,
            "analytic",
            repeats,
            0.5,
            options.stages,
        )?);
    }
    if cases.is_empty() {
        return Err("TEXT_DRAG_CASE did not match a text drag".into());
    }
    let (pixels, programs) = if !options.stages {
        (Value::Null, Value::Null)
    } else {
        (
            pixel_drag(font, &document(&node(&multi, 260., 150., true, false)))?,
            program_shift(font, &document(&node(&multi, 260., 150., true, false)))?,
        )
    };
    Ok(json!({
        "target": "native-cpu",
        "hardwareWebgpu": "NOT_RUN",
        "macosMetalElectronDesktop": "NOT_RUN",
        "swiftShaderIsNotMetal": true,
        "repeats": repeats,
        "stages": options.stages,
        "viewport": [320, 200],
        "cases": cases,
        "analyticPixelDrag": pixels,
        "programShift": programs
    }))
}

fn program_shift(font: &[u8], document: &str) -> Result<Value, String> {
    let mut engine = load(font, document)?;
    let (options, _) = options("figmaSubpixel");
    let base = engine.compile_gpu(&options)?;
    if !engine.apply_interaction_transforms(&pose(4.))? {
        return Err("Integer program probe was not retained".into());
    }
    let integer = engine.compile_gpu(&options)?;
    if !engine.apply_interaction_transforms(&pose(4.5))? {
        return Err("Fractional program probe was not retained".into());
    }
    let fractional = engine.compile_gpu(&options)?;
    let mut mismatches = 0_u32;
    let mut max_abs = 0_f32;
    for (a, b) in base.curves.iter().zip(&integer.curves) {
        if a.to_bits() != b.to_bits() {
            mismatches += 1;
            max_abs = max_abs.max((a - b).abs());
        }
    }
    let mismatch = base
        .curves
        .iter()
        .zip(&integer.curves)
        .position(|(a, b)| a.to_bits() != b.to_bits());
    let rect = |scene: &crate::gpu::GpuScene| scene.nodes["t"].fill.rect;
    Ok(json!({
        "baseCurves": base.curves.len(),
        "integerCurvesEqual": base.curves == integer.curves,
        "fractionalCurvesEqual": base.curves == fractional.curves,
        "integerMismatchFloats": mismatches,
        "integerMaxAbs": max_abs,
        "integerFirstMismatch": mismatch,
        "baseFillRect": [rect(&base).x, rect(&base).y, rect(&base).w, rect(&base).h],
        "integerFillRect": [rect(&integer).x, rect(&integer).y, rect(&integer).w, rect(&integer).h],
        "fractionalFillRect": [rect(&fractional).x, rect(&fractional).y, rect(&fractional).w, rect(&fractional).h]
    }))
}

fn case(
    font: &[u8],
    text_id: &str,
    text: &str,
    width: f64,
    height: f64,
    wrap: bool,
    sketch: bool,
    profile: &str,
    repeats: usize,
    step: f64,
    stages: bool,
) -> Result<Value, String> {
    if !stages {
        let drag = drag(
            font,
            &document(&node(text, width, height, wrap, sketch)),
            profile,
            repeats,
            step,
        )?;
        return Ok(json!({"id": text_id, "profile": profile, "stages": false, "drag": drag}));
    }
    let mut fonts = Fonts::new();
    fonts.load(font)?;
    let node = node(text, width, height, wrap, sketch);
    let cold_at = Instant::now();
    let path = fonts.node_path(&node)?;
    let cold_ms = ms(cold_at);
    let shaping_after_cold = fonts.shaping_cache_stats();
    let glyphs_after_cold = fonts.glyph_cache_stats();
    let mut hot = Vec::with_capacity(24);
    for _ in 0..24 {
        let at = Instant::now();
        let again = fonts.node_path_shared(&node)?;
        hot.push(ms(at));
        if !std::sync::Arc::ptr_eq(&again, &fonts.node_path_shared(&node)?) {
            return Err(format!("{text_id} text path cache returned a new outline"));
        }
    }
    let shaping_after_hot = fonts.shaping_cache_stats();
    if u64_field(&shaping_after_hot["runs"], "builds")
        != u64_field(&shaping_after_cold["runs"], "builds")
    {
        return Err(format!("{text_id} reshaped a cached text layer"));
    }
    if u64_field(&glyphs_after_cold, "builds") == 0 {
        return Err(format!("{text_id} did not build glyph outlines"));
    }
    let key = cache_key(&node, &fonts);
    let mut key_samples = Vec::with_capacity(24);
    for _ in 0..24 {
        let at = Instant::now();
        std::hint::black_box(cache_key(&node, &fonts));
        key_samples.push(ms(at));
    }
    let layout = fonts.node_layout(&node, Some(width))?;
    let mut analytic_flatten = Vec::new();
    let mut figma_flatten = Vec::new();
    let mut points = 0;
    for i in 0..8 {
        let x = 16. + i as f64 * step;
        let at = Instant::now();
        let contours = flatten_at(&path, 0.015625, x)?;
        analytic_flatten.push(ms(at));
        if i == 0 {
            points = contours.iter().map(|c| c.points.len()).sum();
        }
        let at = Instant::now();
        let fine = flatten_at(&path, 0.0001220703125, x)?;
        figma_flatten.push(ms(at));
        if i == 0 && profile == "figmaSubpixel" {
            points = fine.iter().map(|c| c.points.len()).sum();
        }
    }
    let base = flatten_at(&path, 0.0001220703125, 16.)?;
    let mut equivariant = true;
    let mut max_error = 0_f64;
    for dx in [0.5_f64, 1., 3., 8.] {
        let moved = flatten_at(&path, 0.0001220703125, 16. + dx)?;
        match point_delta(&base, &moved, dx) {
            Some(error) => max_error = max_error.max(error),
            None => equivariant = false,
        }
    }
    let (splash_ms, splash_rects) = if sketch {
        let matrix = Transform([1., 0., 0., 1., 16.5, 20.]);
        let mut samples = Vec::new();
        let mut rects = None;
        for _ in 0..4 {
            let at = Instant::now();
            let mask = crate::font_splash::sketch_device_mask(&node, &fonts, matrix);
            samples.push(ms(at));
            rects = Some(mask.map_or(0, |mask| mask.len()));
        }
        (Some(percentile(&mut samples, 0.5)), rects)
    } else {
        (None, None)
    };
    let doc = document(&node);
    let drag = drag(font, &doc, profile, repeats, step)?;
    Ok(json!({
        "id": text_id,
        "profile": profile,
        "sketchLineBox": sketch,
        "glyphs": layout.glyphs.len(),
        "lines": layout.lines.len(),
        "pathCommands": path.commands.len(),
        "coldShapeMs": cold_ms,
        "hotLookupP50Ms": percentile(&mut hot, 0.5),
        "keyBytes": key.len(),
        "keySerdeP50Ms": percentile(&mut key_samples, 0.5),
        "flattenAnalyticP50Ms": percentile(&mut analytic_flatten, 0.5),
        "flattenFigmaP50Ms": percentile(&mut figma_flatten, 0.5),
        "flattenPoints": points,
        "translationEquivariant": equivariant,
        "translationMaxAbsError": max_error,
        "splashP50Ms": splash_ms,
        "splashRects": splash_rects,
        "shapingBuilds": u64_field(&shaping_after_cold["runs"], "builds"),
        "glyphBuilds": u64_field(&glyphs_after_cold, "builds"),
        "drag": drag
    }))
}

fn drag(
    font: &[u8],
    document: &str,
    profile: &str,
    repeats: usize,
    step: f64,
) -> Result<Value, String> {
    let (
        scene_samples,
        curves,
        vertices,
        shaping_delta,
        glyph_delta,
        hits_delta,
        fragment_delta,
        program_delta,
    ) = {
        let mut engine = load(font, document)?;
        let (options, _) = options(profile);
        engine.compile_gpu(&options)?;
        let before = engine.gpu_compile_cache_stats();
        let shaping_before = engine.fonts.shaping_cache_stats();
        let glyph_before = engine.fonts.glyph_cache_stats();
        let mut samples = Vec::with_capacity(repeats);
        let mut curves = 0;
        let mut vertices = 0;
        for i in 1..=repeats {
            if !engine.apply_interaction_transforms(&pose(step * i as f64))? {
                return Err(format!("{profile} text drag was not retained"));
            }
            let at = Instant::now();
            let scene = engine.compile_gpu(&options)?;
            samples.push(ms(at));
            curves = scene.curves.len();
            vertices = scene.vertices.len();
        }
        let after = engine.gpu_compile_cache_stats();
        let shaping_after = engine.fonts.shaping_cache_stats();
        let glyph_after = engine.fonts.glyph_cache_stats();
        (
            samples,
            curves,
            vertices,
            u64_field(&shaping_after["runs"], "builds")
                .saturating_sub(u64_field(&shaping_before["runs"], "builds")),
            u64_field(&glyph_after, "builds").saturating_sub(u64_field(&glyph_before, "builds")),
            u64_field(&after["textPaths"], "hits")
                .saturating_sub(u64_field(&before["textPaths"], "hits")),
            u64_field(&after, "fragmentBuilds")
                .saturating_sub(u64_field(&before, "fragmentBuilds")),
            u64_field(&after, "builds").saturating_sub(u64_field(&before, "builds")),
        )
    };
    let (packet_samples, packet_bytes, same_pose) = {
        let mut engine = load(font, document)?;
        let (_, request) = options(profile);
        let first = engine.compile_gpu_packet_request(&request)?;
        let second = engine.compile_gpu_packet_request(&request)?;
        if first != second {
            return Err(format!("{profile} repeated pose changed the GPU packet"));
        }
        let mut samples = Vec::with_capacity(repeats);
        let mut bytes = first.len();
        for i in 1..=repeats {
            if !engine.apply_interaction_transforms(&pose(step * i as f64))? {
                return Err(format!("{profile} text drag was not retained"));
            }
            let at = Instant::now();
            let packet = engine.compile_gpu_packet_request(&request)?;
            samples.push(ms(at));
            bytes = packet.len();
            if packet == first {
                return Err(format!("{profile} drag left the GPU packet unchanged"));
            }
        }
        (samples, bytes, true)
    };
    let mut scene_samples = scene_samples;
    let mut packet_samples = packet_samples;
    Ok(json!({
        "steps": repeats,
        "stepDocumentPx": step,
        "sceneP50Ms": percentile(&mut scene_samples, 0.5),
        "sceneP95Ms": percentile(&mut scene_samples, 0.95),
        "packetP50Ms": percentile(&mut packet_samples, 0.5),
        "packetP95Ms": percentile(&mut packet_samples, 0.95),
        "packetBytes": packet_bytes,
        "curves": curves,
        "vertices": vertices,
        "shapingBuildsDelta": shaping_delta,
        "glyphBuildsDelta": glyph_delta,
        "textPathHitsDelta": hits_delta,
        "fragmentBuildsDelta": fragment_delta,
        "programBuildsDelta": program_delta,
        "samePosePacketStable": same_pose
    }))
}

fn pixel_drag(font: &[u8], document: &str) -> Result<Value, String> {
    let mut engine = load(font, document)?;
    let (options, _) = options("analytic");
    let settled = engine.render(&options)?;
    let again = engine.render(&options)?;
    if settled != again {
        return Err("Repeated analytic text frame changed pixels".into());
    }
    if !engine.apply_interaction_transforms(&pose(3.5))? {
        return Err("Analytic text drag was not retained".into());
    }
    let moved = engine.render(&options)?;
    let different = settled
        .chunks_exact(4)
        .zip(moved.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    if different == 0 {
        return Err("Dragging analytic text did not change pixels".into());
    }
    Ok(json!({
        "bytes": settled.len(),
        "differentPixels": different,
        "maxChannel": settled.iter().zip(&moved).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap()
    }

    #[test]
    fn cached_text_drag_key_does_not_reshape_or_rebuild_glyphs() {
        let mut fonts = Fonts::new();
        fonts.load(&font()).unwrap();
        let node = node("Hello 文字", 220., 36., false, false);
        let first = fonts.node_path_shared(&node).unwrap();
        let shaped = u64_field(&fonts.shaping_cache_stats()["runs"], "builds");
        let outlined = u64_field(&fonts.glyph_cache_stats(), "builds");
        assert!(shaped > 0 && outlined > 0);
        let second = fonts.node_path_shared(&node).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &second));
        assert_eq!(
            u64_field(&fonts.shaping_cache_stats()["runs"], "builds"),
            shaped
        );
        assert_eq!(u64_field(&fonts.glyph_cache_stats(), "builds"), outlined);
        assert!(!cache_key(&node, &fonts).is_empty());
    }
}
