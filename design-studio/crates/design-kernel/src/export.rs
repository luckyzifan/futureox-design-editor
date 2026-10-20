//! Lossless sRGB PNG export with bounded raster working surfaces.
use crate::{Engine, RenderOptions, fidelity::RasterProfile, renderer::Stats, measurement};
use std::io::Write;

pub const MAX_SIDE: u32 = 16384;
pub const MAX_PIXELS: u64 = 64_000_000;

/// Document-space raster region. The origin is never snapped to a device grid.
/// The right/bottom extent rounds outwards to whole output pixels; this does not
/// stretch the content. DPR, editor pan/zoom and page padding are not inputs.
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct ExportBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionRequest {
    pub page_id: String,
    pub bounds: ExportBounds,
    pub scale: f64,
    /// None exports the page region. A selection isolates its top-level selected
    /// subtrees, retaining world transforms and their internal clips/effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raster_profile: Option<RasterProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_output: Option<crate::color::ColorOutput>,
}

#[derive(serde::Serialize)]
pub struct RegionPlan {
    pub width: u32,
    pub height: u32,
    pub view: crate::View,
}

pub fn region_plan(bounds: ExportBounds, scale: f64) -> Result<RegionPlan, String> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height, scale]
        .into_iter()
        .all(f64::is_finite)
        || bounds.width <= 0.
        || bounds.height <= 0.
        || !(0.001..=128.).contains(&scale)
        || bounds.x.abs().max(bounds.y.abs()) > 1e9
    {
        return Err("Invalid export region or scale (0.001–128)".into());
    }
    let pixels = |length: f64| {
        let value = length * scale;
        // Cancel only arithmetic round-off at an integer, not authored fractions.
        let integer = value.round();
        if integer >= 1. && (value - integer).abs() <= 8. * f64::EPSILON * value.abs().max(1.) {
            integer
        } else {
            value.ceil()
        }
    };
    let (width, height) = (pixels(bounds.width), pixels(bounds.height));
    if width > f64::from(MAX_SIDE) || height > f64::from(MAX_SIDE) {
        return Err("PNG export exceeds 16384 pixels per side or 64 million pixels".into());
    }
    let (width, height) = (width as u32, height as u32);
    validate_size(width, height)?;
    Ok(RegionPlan {
        width,
        height,
        view: crate::View {
            x: -bounds.x * scale,
            y: -bounds.y * scale,
            zoom: scale,
        },
    })
}

impl Engine {
    /// Standalone CPU PNG export, without editor, browser or platform state.
    /// Selection changes are temporary and restored even on a rendering error.
    pub fn render_region_png(&mut self, request: &RegionRequest) -> Result<Vec<u8>, String> {
        let plan = region_plan(request.bounds, request.scale)?;
        let mut value = serde_json::json!({
            "pageId": request.page_id, "width": plan.width, "height": plan.height,
            "view": plan.view, "transparent": true, "grid": false,
        });
        if let Some(profile) = request.raster_profile {
            value["rasterProfile"] = serde_json::to_value(profile).map_err(|e| e.to_string())?;
        }
        let options = self.parse_options(value)?;
        let managed = self.color_settings().is_some();
        if (managed || options.raster_profile.is_export())
            && (plan.width > 8192
                || plan.height > 8192
                || u64::from(plan.width) * u64::from(plan.height) > 8_388_608)
        {
            return Err("Figma/managed export exceeds 8192 per side or 8388608 pixels".into());
        }
        if options.raster_profile.is_export() && request.scale > 64. {
            return Err("Figma export scale exceeds its 64x supersampling budget".into());
        }
        self.prepare_frame(&options)?;
        self.resolve_layout()?;
        let doc = self
            .doc
            .as_ref()
            .ok_or("Load a document before exporting")?;
        let page_index = doc
            .pages
            .iter()
            .position(|p| p.id == request.page_id)
            .ok_or("Page not found")?;
        let roots = if let Some(ids) = &request.node_ids {
            use std::collections::BTreeSet;
            let selected: BTreeSet<_> = ids.iter().map(String::as_str).collect();
            if selected.is_empty() || selected.len() > 1000 {
                return Err("Export selection requires 1–1000 nodes".into());
            }
            fn visit(
                doc: &crate::scene::Document,
                id: &str,
                parent: crate::math::Transform,
                selected: &BTreeSet<&str>,
                found: &mut BTreeSet<String>,
                roots: &mut Vec<(String, crate::math::Transform)>,
                inside: bool,
            ) {
                let node = &doc.nodes[id];
                if !node.visible {
                    return;
                }
                let matrix = parent.concat(node.transform);
                let chosen = selected.contains(id);
                if chosen {
                    found.insert(id.to_owned());
                    if !inside {
                        roots.push((id.to_owned(), matrix));
                    }
                }
                for child in &node.children {
                    visit(doc, child, matrix, selected, found, roots, inside || chosen);
                }
            }
            let mut roots = Vec::new();
            let mut found = BTreeSet::new();
            for id in &doc.pages[page_index].children {
                visit(
                    doc,
                    id,
                    crate::math::Transform::default(),
                    &selected,
                    &mut found,
                    &mut roots,
                    false,
                );
            }
            if found.len() != selected.len() {
                return Err(
                    "Export selection contains hidden nodes or nodes outside this page".into(),
                );
            }
            Some(roots)
        } else {
            None
        };
        let mut restore = None;
        if let Some(roots) = roots {
            let doc = self.doc.as_mut().expect("document checked");
            let children = std::mem::replace(
                &mut doc.pages[page_index].children,
                roots.iter().map(|(id, _)| id.clone()).collect(),
            );
            let transforms: Vec<_> = roots
                .into_iter()
                .map(|(id, matrix)| {
                    let node = doc.nodes.get_mut(&id).expect("selected node checked");
                    (id, std::mem::replace(&mut node.transform, matrix))
                })
                .collect();
            restore = Some((children, transforms));
        }
        let result = if managed || request.color_output.is_some() {
            self.render_color_png(&options, request.color_output.unwrap_or_default())
        } else {
            // One page-wide resolve policy and halo-aware tile path for every
            // region, including small crops. Viewport-dependent coverage or a
            // small-image fast path can otherwise change bytes at slice seams.
            let doc = self.doc.as_ref().expect("document checked");
            let coherent = options.raster_profile != RasterProfile::Analytic
                && region_correlated_samples(doc, page_index);
            render_tiles(self, &options, 512, 128, coherent)
        };
        if let Some((children, transforms)) = restore {
            let doc = self.doc.as_mut().expect("render preserves document");
            doc.pages[page_index].children = children;
            for (id, transform) in transforms {
                doc.nodes
                    .get_mut(&id)
                    .expect("render preserves nodes")
                    .transform = transform;
            }
        }
        result
    }
}

fn region_correlated_samples(doc: &crate::scene::Document, page_index: usize) -> bool {
    fn visit(
        doc: &crate::scene::Document,
        id: &str,
        count: &mut usize,
        backdrop: &mut bool,
    ) -> bool {
        let node = &doc.nodes[id];
        if !node.visible || node.opacity <= 0. {
            return true;
        }
        *count += node
            .fills
            .iter()
            .filter(|p| p.visible && p.opacity > 0.)
            .count()
            + node
                .strokes
                .iter()
                .filter(|s| s.visible && s.width > 0.)
                .count()
            + usize::from(node.clip && !node.children.is_empty());
        *backdrop |= node.backdrop_effect().is_some();
        node.effects.iter().all(|effect| {
            !effect.visible
                || matches!(
                    effect.kind.as_str(),
                    "blur" | "shadow" | "inner-shadow" | "background-blur" | "glass"
                )
        }) && node
            .children
            .iter()
            .all(|child| visit(doc, child, count, backdrop))
    }
    let (mut count, mut backdrop) = (0, false);
    let supported = doc.pages[page_index]
        .children
        .iter()
        .all(|id| visit(doc, id, &mut count, &mut backdrop));
    supported && (count > 1 || backdrop)
}

#[derive(serde::Serialize)]
pub struct SvgPaths {
    pub fill: String,
    pub stroke: String,
}
pub fn svg_paths(
    node: &crate::scene::Node,
    fonts: &crate::font::Fonts,
) -> Result<SvgPaths, String> {
    let paths = if node.kind == "text" {
        crate::path::LocalPaths::Text(fonts.node_path_shared(node)?)
    } else {
        crate::path::LocalPaths::Owned(node.paths()?)
    };
    let (fill,stroke)=paths.pair();
    Ok(SvgPaths {
        fill: fill.svg_data(),
        stroke: stroke.svg_data(),
    })
}

/// Calculate measurements for a target node (hover distance display).
///
/// Returns measurements to the nearest parent edges and sibling nodes,
/// sorted by distance (closest first), limited to 8 measurements.
pub fn calculate_node_measurements(
    engine: &mut Engine,
    target_id: &str,
) -> Result<Vec<measurement::Measurement>, String> {
    let doc = engine
        .doc
        .as_ref()
        .ok_or("No document loaded")?;
    measurement::calculate_measurements(doc, target_id)
}

/// A single backdrop stage over local solid paints has no transitive spatial
/// dependency. Certify its actual ray/filter inputs inside the root's existing
/// halo before omitting the export-only duplicate padding. General graphs keep
/// the old padding guard, including multiple consumers, masks and sample planes.
fn single_backdrop_covered_by_root_halo(
    doc: &crate::scene::Document, page: &crate::scene::Page,
    camera: crate::math::Transform, tile: crate::math::Rect,
) -> bool {
    use crate::{math::{Rect, Transform}, scene::{Effect, Node}};
    fn visit<'a>(doc: &'a crate::scene::Document, id: &str, parent: Transform,
        consumer: &mut Option<(&'a Node, &'a Effect, Transform)>) -> bool {
        let n = &doc.nodes[id];
        if !n.visible || n.opacity <= 0. { return true; }
        let matrix = parent.concat(n.transform);
        if matrix.inverse().is_err() || n.mask || doc.mask_child(n).is_some()
            || n.fills.iter().chain(n.strokes.iter().map(|s| &s.paint))
                .any(|p| p.visible && p.kind != "solid") {
            return false;
        }
        let backdrop = n.backdrop_effect();
        if n.effects.iter().filter(|e| e.visible).any(|e| {
            !backdrop.is_some_and(|b| std::ptr::eq(e, b))
        }) { return false; }
        if let Some(effect) = backdrop {
            if consumer.is_some() || (effect.kind == "glass" &&
                (effect.glass.is_none() || crate::optics::GlassShape::from_node(n).is_none())) {
                return false;
            }
            *consumer = Some((n, effect, matrix));
        }
        n.render_children().iter().all(|child| visit(doc, child, matrix, consumer))
    }
    let mut consumer = None;
    if !page.children.iter().all(|id| visit(doc, id, camera, &mut consumer)) { return false; }
    let Some((node, effect, matrix)) = consumer else { return false; };
    let halo = crate::geometry_snapshot::effect_halo(node, matrix);
    if !(0..=2048).contains(&halo) { return false; }
    let sigma = effect.backdrop_radius() * matrix.max_scale() / 2.;
    let Ok(radii) = crate::effects::gaussian_box_radii(sigma) else { return false; };
    let source = if let Some((shape, glass)) = crate::optics::GlassShape::from_node(node).zip(effect.glass.as_ref()) {
        // Ordinary inverses were certified above, so changing this validation
        // rectangle cannot change inverse selection or coordinate phase.
        let Ok(samples) = crate::optics::input_region(tile.expand(2048), tile, shape, matrix, glass, None) else { return false; };
        samples
    } else { tile };
    let support = radii.into_iter().sum::<u32>() as i32;
    let required = source.expand(support);
    let retained: Rect = tile.expand(halo);
    required.intersect(retained) == required
}

pub(crate) fn backdrop_padding(
    engine: &Engine,
    options: &RenderOptions,
    tile: crate::math::Rect,
) -> Result<i32, String> {
    use crate::math::Transform;
    fn visit(
        doc: &crate::scene::Document,
        id: &str,
        parent: Transform,
        region: crate::math::Rect,
        total: &mut f64,
    ) -> Result<(), String> {
        let n = &doc.nodes[id];
        if !n.visible || n.opacity <= 0. {
            return Ok(());
        }
        let m = parent.concat(n.transform);
        if let Some(fx) = n.backdrop_effect() {
            let (path, _) = n.paths()?;
            if !path.control_bounds(m).intersect(region).empty() {
                *total += (fx.blur_radius() * 2. + fx.material_halo()) * m.max_scale();
            }
        }
        for child in &n.children {
            visit(doc, child, m, region, total)?;
        }
        Ok(())
    }
    let mut total = 0.;
    let density = if options.raster_profile.is_export() { 2. } else { 1. };
    if let Some(doc) = &engine.doc {
        let page = doc
            .pages
            .iter()
            .find(|p| p.id == options.page_id)
            .ok_or("Page not found")?;
        let v = options.view;
        let camera = Transform([v.zoom, 0., 0., v.zoom, v.x, v.y]);
        if options.raster_profile == crate::fidelity::RasterProfile::Analytic
            && doc.color_management.is_none()
            && single_backdrop_covered_by_root_halo(doc, page, camera, tile) {
            return Ok(0);
        }
        for id in &page.children {
            // render_surfaces_with_budget_inner admits at most 2048 SOURCE
            // pixels of combined support. Export profiles double both axes;
            // this traversal is still in OUTPUT coordinates. Expanding by
            // 2048 output pixels counted unrelated boards outside every
            // admissible source surface and could reject a small HDR crop.
            visit(doc, id, camera, tile.expand((2048. / density) as i32), &mut total)?;
        }
    }
    // Backdrop reads depend on earlier siblings' filter inputs as well as
    // ancestor filters. Reserve their source support before cropping a tile.
    if !total.is_finite() || total * density > 1024. {
        return Err("PNG backdrop dependency padding exceeds its 1024-pixel budget".into());
    }
    Ok(total.ceil() as i32)
}

pub fn validate_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("PNG export exceeds 16384 pixels per side or 64 million pixels".into());
    }
    Ok(())
}

#[cfg(test)]
mod backdrop_budget_tests {
    use super::*;
    use crate::{math::Rect, View};
    use serde_json::json;
    fn document(far: bool) -> String {
        let mut nodes = serde_json::Map::new();
        let mut children = vec!["base".to_string()];
        nodes.insert("base".into(), json!({"id":"base","kind":"rectangle","width":64,"height":64,"fills":[{"kind":"solid","color":"#4488cc"}]}));
        for i in 0..4 {
            let id = format!("blur{i}"); children.push(id.clone());
            nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":128,"height":128,
                "transform":[1,0,0,1,if far {1500} else {0},0],
                "effects":[{"kind":"background-blur","visible":true,"radius":200,"color":"#000000","opacity":1,"x":0,"y":0,"spread":0,"amount":0}]}));
        }
        json!({"schemaVersion":1,"id":"d","name":"budget","pages":[{"id":"p","name":"page","children":children,"background":"#ffffff"}],"nodes":nodes}).to_string()
    }
    fn options() -> RenderOptions {
        RenderOptions { page_id:"p".into(), width:64, height:64, view:View{x:0.,y:0.,zoom:1.},
            transparent:false, grid:false, checkerboard:false, pixel_preview:None, animation:None,
            raster_profile:RasterProfile::Figma, interactive_effects:false }
    }
    #[test]
    fn doubled_export_ignores_backdrops_outside_admissible_source_support() {
        let mut engine = Engine::new(); engine.load_document(&document(true)).unwrap();
        assert_eq!(backdrop_padding(&engine, &options(), Rect::new(0,0,64,64)).unwrap(), 0);
        let pixels = engine.render(&options()).unwrap();
        let mut plain: serde_json::Value = serde_json::from_str(&document(true)).unwrap();
        plain["pages"][0]["children"] = json!(["base"]);
        plain["nodes"].as_object_mut().unwrap().retain(|id, _| id == "base");
        engine.load_document(&plain.to_string()).unwrap();
        assert_eq!(pixels, engine.render(&options()).unwrap());
    }
    #[test]
    fn genuinely_local_over_budget_chain_remains_rejected() {
        let mut engine = Engine::new(); engine.load_document(&document(false)).unwrap();
        assert!(backdrop_padding(&engine, &options(), Rect::new(0,0,64,64)).unwrap_err().contains("1024"));
    }
}
fn encoder(output: &mut Vec<u8>, width: u32, height: u32) -> png::Encoder<'_, &mut Vec<u8>> {
    let mut encoder = png::Encoder::new(output, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    encoder.set_compression(png::Compression::Fast);
    encoder
}
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    validate_size(width, height)?;
    if rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return Err("PNG RGBA buffer length differs from dimensions".into());
    }
    let mut output = Vec::new();
    let mut writer = encoder(&mut output, width, height)
        .write_header()
        .map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(output)
}
/// Serialize a generated profile definition without machine-clock metadata.
pub fn canonical_icc(profile: &moxcms::ColorProfile) -> Result<Vec<u8>, String> {
    let mut bytes = profile.encode().map_err(|e| e.to_string())?;
    if bytes.len() < 128 || &bytes[36..40] != b"acsp" {
        return Err("Unexpected generated ICC header".into());
    }
    // moxcms 0.8.1's writer constructs a fresh header with now(), ignoring
    // profile.creation_date_time. Normalize the generated definition *after*
    // serialization; imported image profiles are never rewritten.
    for (i, value) in [2000_u16, 1, 1, 0, 0, 0].iter().enumerate() {
        bytes[24 + i * 2..26 + i * 2].copy_from_slice(&value.to_be_bytes());
    }
    // The profile ID is optional. Do not retain a digest of a pre-normalized
    // header if a future encoder starts computing it.
    bytes[84..100].fill(0);
    Ok(bytes)
}

/// Tagged 16-bit RGB PNG; CICP follows PNG 3 / H.273 and SDR also carries ICC.
pub fn encode_color_png(
    width: u32,
    height: u32,
    pixels: &[crate::blend::Pixel],
    settings: crate::color::ColorSettings,
    output: crate::color::ColorOutput,
) -> Result<Vec<u8>, String> {
    use crate::color::ColorSpace;
    validate_size(width, height)?;
    settings.validate()?;
    if pixels.len() != width as usize * height as usize
        || pixels.iter().flat_map(|p| p.0).any(|v| !v.is_finite())
    {
        return Err("Invalid floating-point export buffer".into());
    }
    let codes = match output.space {
        ColorSpace::Srgb => Some([1, 13, 0, 1]),
        ColorSpace::LinearSrgb => Some([1, 8, 0, 1]),
        ColorSpace::DisplayP3 => Some([12, 13, 0, 1]),
        ColorSpace::LinearP3 => Some([12, 8, 0, 1]),
        ColorSpace::Rec2020 => Some([9, 14, 0, 1]),
        ColorSpace::LinearRec2020 => Some([9, 8, 0, 1]),
        ColorSpace::Pq => Some([9, 16, 0, 1]),
        ColorSpace::Hlg => Some([9, 18, 0, 1]),
        ColorSpace::A98 | ColorSpace::ProPhoto => None,
        _ => return Err("PNG output requires an RGB color space".into()),
    };
    let mut bytes = Vec::with_capacity(pixels.len() * 8);
    let transform = settings.prepare_output(output);
    for pixel in pixels {
        for c in transform.apply(*pixel) {
            bytes.extend_from_slice(
                &((c.clamp(0., 1.) * 65535.).round_ties_even() as u16).to_be_bytes(),
            );
        }
    }
    let mut png = Vec::new();
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Sixteen;
    // Keep ordinary ICC-aware viewers color-correct for SDR/wide-gamut exports.
    // HDR is described by cICP; a relative SDR ICC would misstate luminance.
    let profile = match output.space {
        ColorSpace::Srgb | ColorSpace::LinearSrgb => Some(moxcms::ColorProfile::new_srgb()),
        ColorSpace::DisplayP3 | ColorSpace::LinearP3 => {
            Some(moxcms::ColorProfile::new_display_p3())
        }
        ColorSpace::Rec2020 | ColorSpace::LinearRec2020 => Some(moxcms::ColorProfile::new_bt2020()),
        ColorSpace::A98 => Some(moxcms::ColorProfile::new_adobe_rgb()),
        ColorSpace::ProPhoto => Some(moxcms::ColorProfile::new_pro_photo_rgb()),
        _ => None,
    };
    if let Some(mut profile) = profile {
        if matches!(
            output.space,
            ColorSpace::LinearSrgb | ColorSpace::LinearP3 | ColorSpace::LinearRec2020
        ) {
            let curve = Some(moxcms::ToneReprCurve::Parametric(vec![1.]));
            profile.red_trc = curve.clone();
            profile.green_trc = curve.clone();
            profile.blue_trc = curve;
            profile.cicp = None;
        }
        // A generated profile definition has a fixed timestamp, independently
        // of machine clock, replica and native/WASM constructor defaults.
        profile.creation_date_time = moxcms::ColorDateTime {
            year: 2000,
            month: 1,
            day_of_the_month: 1,
            hours: 0,
            minutes: 0,
            seconds: 0,
        };
        info.icc_profile = Some(std::borrow::Cow::Owned(canonical_icc(&profile)?));
    }
    let mut encoder = png::Encoder::with_info(&mut png, info).map_err(|e| e.to_string())?;
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    if let Some(codes) = codes {
        writer
            .write_chunk(png::chunk::ChunkType(*b"cICP"), &codes)
            .map_err(|e| e.to_string())?;
    }
    writer.write_image_data(&bytes).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(png)
}
pub(crate) fn render_png(engine: &mut Engine, options: &RenderOptions) -> Result<Vec<u8>, String> {
    validate_size(options.width, options.height)?;
    if let Some(settings) = engine.doc.as_ref().and_then(|d| d.color_management) {
        let pixels = engine.render_linear(options)?;
        return encode_color_png(
            options.width,
            options.height,
            &pixels,
            settings,
            crate::color::ColorOutput::default(),
        );
    }
    if options.pixel_preview.is_some() || (options.width <= 512 && options.height <= 512) {
        let bytes = engine.render(options)?;
        return encode_rgba(options.width, options.height, &bytes);
    }
    render_tiled(engine, options, 512, 128)
}
fn render_tiled(
    engine: &mut Engine,
    options: &RenderOptions,
    tile_width: u32,
    rows: u32,
) -> Result<Vec<u8>, String> {
    validate_size(options.width, options.height)?;
    engine.resolve_layout()?;
    // Decide sample correlation for the entire export, not independently per
    // tile. Changing it at a tile boundary can alter overlapping edge coverage.
    let coherent = options.raster_profile != RasterProfile::Analytic
        && engine
            .doc
            .as_ref()
            .is_some_and(|doc| crate::fidelity::coherent_samples(doc, options));
    render_tiles(engine, options, tile_width, rows, coherent)
}
fn render_tiles(
    engine: &mut Engine,
    options: &RenderOptions,
    tile_width: u32,
    rows: u32,
    coherent: bool,
) -> Result<Vec<u8>, String> {
    validate_size(options.width, options.height)?;
    let mut output = Vec::new();
    let mut writer = encoder(&mut output, options.width, options.height)
        .write_header()
        .map_err(|e| e.to_string())?;
    let mut stats = Stats::default();
    {
        let mut stream = writer
            .stream_writer_with_size(64 * 1024)
            .map_err(|e| e.to_string())?;
        for y in (0..options.height).step_by(rows as usize) {
            let h = rows.min(options.height - y);
            // At the maximum output width this row band occupies only 8 MiB;
            // no full-size RGBA framebuffer or full-size GPU texture is needed.
            let mut band = vec![0; options.width as usize * h as usize * 4];
            for x in (0..options.width).step_by(tile_width as usize) {
                let w = tile_width.min(options.width - x);
                let tile = engine.export_tile(options, coherent, x, y, w, h)?;
                stats.accumulate(engine.stats());
                if stats.allocated_layer_pixels > 2_000_000_000 {
                    return Err("PNG export compositing work budget exceeded".into());
                }
                for row in 0..h as usize {
                    let start = (row * options.width as usize + x as usize) * 4;
                    band[start..start + w as usize * 4]
                        .copy_from_slice(&tile[row * w as usize * 4..(row + 1) * w as usize * 4]);
                }
            }
            stream.write_all(&band).map_err(|e| e.to_string())?;
        }
        stream.finish().map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    engine.stats = stats;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn svg_keeps_arcs_and_beziers_instead_of_fixed_polygon_samples() {
        use crate::{
            math::Point,
            path::{Command, Path},
        };
        let circle = Path::ellipse(64., 48.).svg_data();
        assert_eq!(circle.matches('A').count(), 2);
        assert_eq!(circle.matches('L').count(), 0);
        let curve = Path {
            commands: vec![
                Command::Move(Point::new(0., 0.)),
                Command::Cubic(
                    Point::new(0., 40.),
                    Point::new(60., 40.),
                    Point::new(60., 0.),
                ),
                Command::Quad(Point::new(30., -20.), Point::new(0., 0.)),
                Command::Close,
            ],
        }
        .svg_data();
        assert!(curve.contains('C') && curve.contains('Q') && curve.ends_with("Z "));
    }
    #[test]
    fn png_records_srgb_and_preserves_every_byte_of_a_ramp() {
        let rgba: Vec<u8> = (0..=255_u8).flat_map(|v| [v, 255 - v, v, 255]).collect();
        let bytes = encode_rgba(256, 1, &rgba).unwrap();
        assert!(bytes.windows(4).any(|s| s == b"sRGB"));
        assert_eq!(
            image::load_from_memory(&bytes)
                .unwrap()
                .into_rgba8()
                .as_raw(),
            &rgba
        );
        assert!(encode_rgba(256, 2, &rgba).is_err());
        assert!(validate_size(16385, 1).is_err());
        assert!(validate_size(8192, 8192).is_err());
    }
    #[test]
    fn tiled_filters_and_nested_clips_match_a_single_render() {
        let doc = json!({"schemaVersion":1,"id":"d","name":"tile seam","pages":[{"id":"p","name":"p","children":["bg","g"],"background":"#ffffff"}],"nodes":{
            "bg":{"id":"bg","kind":"rectangle","width":256,"height":192,"fills":[{"kind":"linear","color":"#ffffff","stops":[{"offset":0,"color":"#114477"},{"offset":1,"color":"#eecc88"}]}]},
            "g":{"id":"g","kind":"frame","width":190,"height":140,"transform":[1,0.1,-0.1,1,20.125,16.125],"radii":[16,16,16,16],"clip":true,"blend":"pass-through","children":["a","b"]},
            "a":{"id":"a","kind":"ellipse","width":130,"height":96,"transform":[1,0,0,1,8.125,12.125],"fills":[{"kind":"solid","color":"#3366cc"}],"effects":[{"kind":"blur","radius":4,"color":"#000000"}]},
            "b":{"id":"b","kind":"rectangle","width":112,"height":98,"transform":[1,0,0,1,60.125,40.125],"fills":[{"kind":"solid","color":"#ffffff","opacity":0.12}],"effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]}
        }});
        for smooth in [false, true] {
            let mut doc = doc.clone();
            if smooth {
                for id in ["g", "a", "b"] {
                    doc["nodes"][id]["smoothing"] = json!(1.);
                    doc["nodes"][id]["radii"] = json!([20., 20., 20., 20.]);
                }
                doc["nodes"]["a"]["kind"] = json!("rectangle");
            }
            let mut engine = Engine::new();
            engine.load_document(&doc.to_string()).unwrap();
            for profile in ["analytic", "figma"] {
                let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":256,"height":192,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":profile})).unwrap();
                let expected = engine.render(&options).unwrap();
                let bytes = render_tiled(&mut engine, &options, 64, 48).unwrap();
                let actual = image::load_from_memory(&bytes)
                    .unwrap()
                    .into_rgba8()
                    .into_raw();
                let changed: Vec<_> = expected
                    .chunks_exact(4)
                    .zip(actual.chunks_exact(4))
                    .enumerate()
                    .filter(|(_, (a, b))| a != b)
                    .take(12)
                    .collect();
                let max = expected
                    .iter()
                    .zip(&actual)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap();
                assert!(
                    expected == actual,
                    "tile seam changed pixels in {profile}: max {max}, first {changed:?}"
                );
            }
        }
    }
}
