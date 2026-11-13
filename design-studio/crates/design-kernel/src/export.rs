//! Lossless sRGB PNG export with bounded raster working surfaces.
use crate::{fidelity::RasterProfile, math::Rect, measurement, renderer::Stats, Engine, RenderOptions};
use std::io::Write;
mod backdrop_demand;

#[derive(Clone, Copy)]
pub(crate) enum ExportPadding {
    Extra(i32),
    Required(Rect),
}

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
                let source_id = node.repeat_origin.as_deref().unwrap_or(id);
                let chosen = selected.contains(source_id);
                if chosen {
                    found.insert(source_id.to_owned());
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
        let result = if managed {
            self.render_color_png(&options, request.color_output.unwrap_or_default())
        } else {
            match unmanaged_byte_space(request.color_output) {
                // One page-wide resolve policy and halo-aware tile path for every
                // region, including small crops. Viewport-dependent coverage or a
                // small-image fast path can otherwise change bytes at slice seams.
                // Display P3 converts those sRGB samples and tags the file. It does
                // not switch the document to linear-light compositing.
                Ok(space) => {
                    let doc = self.doc.as_ref().expect("document checked");
                    let coherent = options.raster_profile != RasterProfile::Analytic
                        && region_correlated_samples(doc, page_index);
                    let (tile_width, rows) = if options.raster_profile == RasterProfile::Analytic {
                        // Share overlapping filter input across a wider tile
                        // while keeping the PNG row band within eight MiB.
                        (1024, 256.min(8 * 1024 * 1024 / (options.width * 4)))
                    } else if options.raster_profile == RasterProfile::Figma
                        && options.width <= 1024 && options.height <= 1024
                        && crate::renderer::clipped_opaque_frame(doc, &doc.pages[page_index].children)
                            .is_some_and(|frame| {
                                frame.children.iter().any(|id| doc.nodes[id].effects.iter()
                                    .any(|effect| effect.visible && effect.gradient_blur.is_some()))
                                && frame.children.iter().any(|id| doc.nodes[id].backdrop_effect().is_some())
                            })
                    {
                        // The root clip bounds all target planes. Render a
                        // small board once instead of filtering it per band.
                        // The byte band is at most 4 MiB; pressure still splits it.
                        (options.width, options.height)
                    } else {
                        (512, 128)
                    };
                    render_tiles(self, &options, tile_width, rows, coherent, space)
                }
                Err(error) => Err(error),
            }
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
        progressive_backdrop: &mut bool,
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
        let effect = node.backdrop_effect();
        *backdrop |= effect.is_some();
        *progressive_backdrop |= effect.is_some_and(|effect| effect.gradient_blur.is_some());
        let mut supported = node.effects.iter().all(|effect| {
            !effect.visible
                || matches!(
                    effect.kind.as_str(),
                    "blur" | "shadow" | "inner-shadow" | "background-blur" | "glass"
                )
        });
        for child in &node.children {
            supported &= visit(doc, child, count, backdrop, progressive_backdrop);
        }
        supported
    }
    let (mut count, mut backdrop, mut progressive_backdrop) = (0, false, false);
    let supported = doc.pages[page_index]
        .children
        .iter()
        .fold(true, |supported, id| {
            visit(doc, id, &mut count, &mut backdrop, &mut progressive_backdrop) && supported
        });
    // A progressive backdrop consumes the same four correlated samples as
    // the Figma canvas, including when the export contains a zoom/motion blur.
    progressive_backdrop || supported && (count > 1 || backdrop)
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
    let (fill, stroke) = paths.pair();
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
    let doc = engine.doc.as_ref().ok_or("No document loaded")?;
    measurement::calculate_measurements(doc, target_id)
}

/// A single backdrop stage over local solid paints has no transitive spatial
/// dependency. Certify its actual ray/filter inputs inside the root's existing
/// halo before omitting the export-only duplicate padding. General graphs keep
/// the old padding guard, including multiple consumers, masks and sample planes.
fn single_backdrop_covered_by_root_halo(
    doc: &crate::scene::Document,
    page: &crate::scene::Page,
    camera: crate::math::Transform,
    tile: crate::math::Rect,
) -> bool {
    use crate::{
        math::{Rect, Transform},
        scene::{Effect, Node},
    };
    fn visit<'a>(
        doc: &'a crate::scene::Document,
        id: &str,
        parent: Transform,
        consumer: &mut Option<(&'a Node, &'a Effect, Transform)>,
    ) -> bool {
        let n = &doc.nodes[id];
        if !n.visible || n.opacity <= 0. {
            return true;
        }
        let matrix = parent.concat(n.transform);
        if matrix.inverse().is_err()
            || n.mask
            || doc.mask_child(n).is_some()
            || n.fills
                .iter()
                .chain(n.strokes.iter().map(|s| &s.paint))
                .any(|p| p.visible && p.kind != "solid")
        {
            return false;
        }
        let backdrop = n.backdrop_effect();
        if n.effects
            .iter()
            .filter(|e| e.visible)
            .any(|e| !backdrop.is_some_and(|b| std::ptr::eq(e, b)))
        {
            return false;
        }
        if let Some(effect) = backdrop {
            if consumer.is_some()
                || (effect.kind == "glass"
                    && (effect.glass.is_none()
                        || crate::optics::GlassShape::from_node(n).is_none()))
            {
                return false;
            }
            *consumer = Some((n, effect, matrix));
        }
        n.render_children()
            .iter()
            .all(|child| visit(doc, child, matrix, consumer))
    }
    let mut consumer = None;
    if !page
        .children
        .iter()
        .all(|id| visit(doc, id, camera, &mut consumer))
    {
        return false;
    }
    let Some((node, effect, matrix)) = consumer else {
        return false;
    };
    let halo = crate::geometry_snapshot::effect_halo(node, matrix);
    if !(0..=2048).contains(&halo) {
        return false;
    }
    let sigma = effect.backdrop_radius() * matrix.max_scale() / 2.;
    let Ok(radii) = crate::effects::gaussian_box_radii(sigma) else {
        return false;
    };
    let source = if let Some((shape, glass)) =
        crate::optics::GlassShape::from_node(node).zip(effect.glass.as_ref())
    {
        // Ordinary inverses were certified above, so changing this validation
        // rectangle cannot change inverse selection or coordinate phase.
        let Ok(samples) =
            crate::optics::input_region(tile.expand(2048), tile, shape, matrix, glass, None)
        else {
            return false;
        };
        samples
    } else {
        tile
    };
    let support = radii.into_iter().sum::<u32>() as i32;
    let required = source.expand(support);
    let retained: Rect = tile.expand(halo);
    required.intersect(retained) == required
}

/// Enumerate in painter order. Both the one-tile path and the frame index use
/// the same transformed bounds and unrounded support contribution.
pub(crate) fn visit_backdrops(
    doc: &crate::scene::Document,
    roots: &[String],
    camera: crate::math::Transform,
    mut emit: impl FnMut(crate::math::Rect, f64),
) -> Result<(), String> {
    fn visit(
        doc: &crate::scene::Document, id: &str, parent: crate::math::Transform,
        emit: &mut impl FnMut(crate::math::Rect, f64),
    ) -> Result<(), String> {
        let n = &doc.nodes[id];
        if !n.visible || n.opacity <= 0. { return Ok(()); }
        let matrix = parent.concat(n.transform);
        if let Some(fx) = n.backdrop_effect() {
            let (path, _) = n.paths()?;
            emit(path.control_bounds(matrix), (fx.blur_radius() * 2. + fx.material_halo()) * matrix.max_scale());
        }
        for child in &n.children { visit(doc, child, matrix, emit)?; }
        Ok(())
    }
    for (i,id) in roots.iter().enumerate() {
        if i % 64 == 0 { crate::render_cancellation::checkpoint()?; }
        visit(doc, id, camera, &mut emit)?;
    }
    Ok(())
}

pub(crate) fn backdrop_padding(
    engine: &Engine,
    options: &RenderOptions,
    tile: crate::math::Rect,
) -> Result<i32, String> {
    use crate::math::Transform;
    let mut total = 0.;
    let density = if options.raster_profile.is_export() {
        2.
    } else {
        1.
    };
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
            && single_backdrop_covered_by_root_halo(doc, page, camera, tile)
        {
            return Ok(0);
        }
        // The 2048-pixel support limit is in source coordinates.
        let region = tile.expand((2048. / density) as i32);
        visit_backdrops(doc, &page.children, camera, |bounds, support| {
            if !bounds.intersect(region).empty() { total += support; }
        })?;
    }
    checked_backdrop_padding(total, density)
}

pub(crate) fn checked_backdrop_padding(total: f64, density: f64) -> Result<i32, String> {
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
            let id = format!("blur{i}");
            children.push(id.clone());
            nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":128,"height":128,
                "transform":[1,0,0,1,if far {1500} else {0},0],
                "effects":[{"kind":"background-blur","visible":true,"radius":200,"color":"#000000","opacity":1,"x":0,"y":0,"spread":0,"amount":0}]}));
        }
        json!({"schemaVersion":1,"id":"d","name":"budget","pages":[{"id":"p","name":"page","children":children,"background":"#ffffff"}],"nodes":nodes}).to_string()
    }
    fn options() -> RenderOptions {
        RenderOptions {
            page_id: "p".into(),
            width: 64,
            height: 64,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: false,
            grid: false,
            checkerboard: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::Figma,
            interactive_effects: false,
        }
    }
    #[test]
    fn doubled_export_ignores_backdrops_outside_admissible_source_support() {
        let mut engine = Engine::new();
        engine.load_document(&document(true)).unwrap();
        assert_eq!(
            backdrop_padding(&engine, &options(), Rect::new(0, 0, 64, 64)).unwrap(),
            0
        );
        let pixels = engine.render(&options()).unwrap();
        let mut plain: serde_json::Value = serde_json::from_str(&document(true)).unwrap();
        plain["pages"][0]["children"] = json!(["base"]);
        plain["nodes"]
            .as_object_mut()
            .unwrap()
            .retain(|id, _| id == "base");
        engine.load_document(&plain.to_string()).unwrap();
        assert_eq!(pixels, engine.render(&options()).unwrap());
    }
    #[test]
    fn genuinely_local_over_budget_chain_remains_rejected() {
        let mut engine = Engine::new();
        engine.load_document(&document(false)).unwrap();
        assert!(
            backdrop_padding(&engine, &options(), Rect::new(0, 0, 64, 64))
                .unwrap_err()
                .contains("1024")
        );
    }

    #[test]
    fn analytic_png_uses_actual_backdrop_dependencies_across_output_bands() {
        let mut nodes = serde_json::Map::new();
        let mut roots = Vec::new();
        for i in 0..28 {
            let group = format!("group{i}");
            let ink = format!("ink{i}");
            let first = format!("first{i}");
            let last = format!("last{i}");
            roots.push(group.clone());
            nodes.insert(group.clone(), json!({"id":group,"kind":"frame","width":56,"height":54,
                "transform":[1,0,0,1,(i%4)*64,(i/4)*61],"clip":true,"children":[ink,first,last],
                "fills":[{"kind":"solid","color":"#d1dfeb"}]}));
            nodes.insert(ink.clone(), json!({"id":ink,"kind":"rectangle","width":25,"height":28,
                "transform":[1,0,0,1,4,4],"fills":[{"kind":"solid","color":"#1256aa"}],
                "effects":[{"kind":"shadow","radius":4,"x":3,"y":2,"color":"#573731"}]}));
            for (name, x, y) in [(first, 8, 9), (last, 13, 19)] {
                nodes.insert(name.clone(), json!({"id":name,"kind":"ellipse","width":35,"height":33,
                    "transform":[1,0,0,1,x,y],"opacity":0.8,
                    "effects":[{"kind":"background-blur","radius":12,"color":"#000000"}]}));
            }
        }
        nodes.insert("board".into(), json!({"id":"board","kind":"frame","width":256,"height":428,
            "clip":true,"children":roots}));
        let doc = json!({"schemaVersion":20,"id":"isolated","name":"Isolated backdrops",
            "pages":[{"id":"p","name":"page","children":["board"],"background":"#ffffff"}],"nodes":nodes});
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let options = RenderOptions { width: 256, height: 428, transparent: true,
            raster_profile: RasterProfile::Analytic, ..options() };
        let tile = Rect::new(0, 0, 256, 256);
        assert!(backdrop_padding(&engine, &options, tile).unwrap_err().contains("1024"));
        let whole = engine.render(&options).unwrap();
        let request = RegionRequest { page_id: options.page_id.clone(),
            bounds: ExportBounds { x: 0., y: 0., width: 256., height: 428. }, scale: 1.,
            raster_profile: Some(RasterProfile::Analytic), node_ids: None, color_output: None };
        let png = engine.render_region_png(&request).unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().into_rgba8().as_raw(), &whole);
    }

    #[test]
    fn analytic_png_still_rejects_a_chain_that_reads_past_the_budget() {
        let mut nodes = serde_json::Map::new();
        let mut roots = Vec::new();
        for i in 0..5 {
            let id = format!("blur{i}");
            roots.push(id.clone());
            nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":5000,"height":5000,
                "effects":[{"kind":"background-blur","radius":250,"color":"#000000"}]}));
        }
        let mut engine = Engine::new();
        engine.load_document(&json!({"schemaVersion":20,"id":"chain","name":"Chain",
            "pages":[{"id":"p","name":"page","children":roots,"background":"#ffffff"}],"nodes":nodes}).to_string()).unwrap();
        let request = RegionRequest { page_id: "p".into(),
            bounds: ExportBounds { x: 2000., y: 2000., width: 64., height: 64. }, scale: 1.,
            raster_profile: Some(RasterProfile::Analytic), node_ids: None, color_output: None };
        assert!(engine.render_region_png(&request).unwrap_err().contains("1024"));
    }
}
fn begin_tagged_png<'a>(
    output: &'a mut Vec<u8>,
    width: u32,
    height: u32,
    space: crate::color::ColorSpace,
) -> Result<png::Writer<&'a mut Vec<u8>>, String> {
    use crate::color::ColorSpace;
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Eight;
    // The png encoder drops an ICC profile when `info.srgb` is set. Write the
    // sRGB chunk after the header so the profile is kept as well. Display P3
    // omits that chunk; cICP plus the P3 profile are the tag.
    let (cicp, srgb_chunk) = match space {
        ColorSpace::Srgb => {
            info.icc_profile = Some(std::borrow::Cow::Owned(srgb_icc_profile()?));
            (None, true)
        }
        ColorSpace::DisplayP3 => {
            info.icc_profile = Some(std::borrow::Cow::Owned(display_p3_icc_profile()?));
            (Some([12_u8, 13, 0, 1]), false)
        }
        _ => return Err("8-bit export tags sRGB or Display P3".into()),
    };
    let mut encoder = png::Encoder::with_info(output, info).map_err(|e| e.to_string())?;
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    if srgb_chunk {
        writer
            .write_chunk(png::chunk::ChunkType(*b"sRGB"), &[0])
            .map_err(|e| e.to_string())?;
    }
    if let Some(codes) = cicp {
        writer
            .write_chunk(png::chunk::ChunkType(*b"cICP"), &codes)
            .map_err(|e| e.to_string())?;
    }
    Ok(writer)
}
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    encode_tagged_rgba(width, height, rgba, crate::color::ColorSpace::Srgb)
}
pub fn encode_tagged_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
    space: crate::color::ColorSpace,
) -> Result<Vec<u8>, String> {
    use crate::color::ColorSpace;
    validate_size(width, height)?;
    if rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return Err("PNG RGBA buffer length differs from dimensions".into());
    }
    let mut samples = rgba.to_vec();
    if space == ColorSpace::DisplayP3 {
        convert_srgb_straight_to_display_p3(&mut samples);
    }
    let mut output = Vec::new();
    let mut writer = begin_tagged_png(&mut output, width, height, space)?;
    writer
        .write_image_data(&samples)
        .map_err(|e| e.to_string())?;
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

/// Canonical sRGB IEC 61966-2-1 profile. The timestamp and profile id are
/// fixed so exports do not depend on the machine clock.
pub fn srgb_icc_profile() -> Result<Vec<u8>, String> {
    canonical_icc(&moxcms::ColorProfile::new_srgb())
}

/// Canonical Display P3 profile. Same fixed timestamp as the sRGB profile.
pub fn display_p3_icc_profile() -> Result<Vec<u8>, String> {
    canonical_icc(&moxcms::ColorProfile::new_display_p3())
}

/// 8-bit unmanaged export. Anything else still needs a managed document.
pub(crate) fn unmanaged_byte_space(
    output: Option<crate::color::ColorOutput>,
) -> Result<crate::color::ColorSpace, String> {
    use crate::color::{ColorSpace, ToneMap};
    match output {
        None => Ok(ColorSpace::Srgb),
        Some(output)
            if output.space == ColorSpace::Srgb && output.tone_map == ToneMap::Clip =>
        {
            Ok(ColorSpace::Srgb)
        }
        Some(output)
            if output.space == ColorSpace::DisplayP3 && output.tone_map == ToneMap::Clip =>
        {
            Ok(ColorSpace::DisplayP3)
        }
        Some(_) => Err(
            "Unmanaged export tags sRGB or Display P3. Other color outputs need document color management."
                .into(),
        ),
    }
}

fn convert_srgb_straight_to_display_p3(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let encoded = crate::color::encoded_srgb_to_display_p3(
            [pixel[0], pixel[1], pixel[2]].map(|c| f64::from(c) / 255.),
        );
        for (channel, value) in encoded.into_iter().enumerate() {
            pixel[channel] = (value.clamp(0., 1.) * 255.).round_ties_even() as u8;
        }
    }
}

/// PDF object body for an RGB ICCBased color space. Callers choose the
/// object number; `/N 3` matches the RGB samples this exporter writes.
pub fn pdf_icc_based_object(profile: &[u8]) -> Result<Vec<u8>, String> {
    if profile.len() < 128 || &profile[36..40] != b"acsp" || profile.len() > 4 * 1024 * 1024 {
        return Err("PDF ICC profile is missing, not RGB-capable, or too large".into());
    }
    if &profile[16..20] != b"RGB " {
        return Err("PDF ICC profile is not an RGB color space".into());
    }
    let data = miniz_oxide::deflate::compress_to_vec_zlib(profile, 6);
    let mut object = format!(
        "<< /N 3 /Alternate /DeviceRGB /Filter /FlateDecode /Length {} >>\nstream\n",
        data.len()
    )
    .into_bytes();
    object.extend(data);
    object.extend_from_slice(b"\nendstream");
    Ok(object)
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
    // The one-byte sRGB chunk is only true for encoded sRGB. Linear sRGB and
    // wide-gamut outputs keep cICP plus a matching ICC profile instead.
    if output.space == ColorSpace::Srgb {
        info.srgb = Some(png::SrgbRenderingIntent::Perceptual);
    }
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
        let bytes = engine.render_exact(options)?;
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
    render_tiles(
        engine,
        options,
        tile_width,
        rows,
        coherent,
        crate::color::ColorSpace::Srgb,
    )
}
fn render_tiles(
    engine: &mut Engine,
    options: &RenderOptions,
    tile_width: u32,
    rows: u32,
    coherent: bool,
    space: crate::color::ColorSpace,
) -> Result<Vec<u8>, String> {
    validate_size(options.width, options.height)?;
    let mut padding = backdrop_demand::BackdropDemand::new(engine, options)?;
    // The dependency plan bounds each tile independently. A wider large-page
    // strip avoids re-rasterizing the same layer halos at each horizontal edge.
    let tile_width = if padding.is_some() && options.width > 4096 { 2048 } else { tile_width };
    let mut output = Vec::new();
    let mut writer = begin_tagged_png(&mut output, options.width, options.height, space)?;
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
                write_export_tile(engine, options, coherent, Rect::new(x as i32, y as i32, w, h),
                    y, &mut band, &mut stats, &mut padding)?;
            }
            if space == crate::color::ColorSpace::DisplayP3 {
                convert_srgb_straight_to_display_p3(&mut band);
            }
            stream.write_all(&band).map_err(|e| e.to_string())?;
        }
        stream.finish().map_err(|e| e.to_string())?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    engine.stats = stats;
    Ok(output)
}

fn write_export_tile(
    engine: &mut Engine, options: &RenderOptions, coherent: bool, tile: Rect,
    band_y: u32, band: &mut [u8], stats: &mut Stats,
    padding: &mut Option<backdrop_demand::BackdropDemand>,
) -> Result<(), String> {
    crate::render_cancellation::checkpoint()?;
    let result = match padding.as_mut() {
        Some(plan) => plan.padding(engine, options, tile)
            .and_then(|halo| engine.export_tile_with_padding(options, coherent, tile, halo)),
        None => engine.export_tile(options, coherent, tile.x as u32, tile.y as u32, tile.w, tile.h),
    };
    stats.accumulate(engine.stats());
    if stats.allocated_layer_pixels > 2_000_000_000 {
        return Err("PNG export compositing work budget exceeded".into());
    }
    match result {
        Ok(pixels) => {
            for (row, source) in pixels.chunks_exact(tile.w as usize * 4).enumerate() {
                let offset = ((tile.y as usize - band_y as usize + row) * options.width as usize + tile.x as usize) * 4;
                band[offset..offset + source.len()].copy_from_slice(source);
            }
        }
        Err(error) if error == "Compositing memory budget exceeded" && tile.w.max(tile.h) > 32 => {
            // Retry only the failed output rectangle. The global sample phase,
            // filter support, and per-attempt compositor budget still apply.
            let [a, b] = if tile.w >= tile.h {
                let w = tile.w / 2;
                [Rect::new(tile.x, tile.y, w, tile.h), Rect::new(tile.x + w as i32, tile.y, tile.w - w, tile.h)]
            } else {
                let h = tile.h / 2;
                [Rect::new(tile.x, tile.y, tile.w, h), Rect::new(tile.x, tile.y + h as i32, tile.w, tile.h - h)]
            };
            write_export_tile(engine, options, coherent, a, band_y, band, stats, padding)?;
            write_export_tile(engine, options, coherent, b, band_y, band, stats, padding)?;
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn progressive_backdrop_filters_background_before_paint_and_preserves_fd() {
        let scene = json!({
            "schemaVersion":19,"id":"d","name":"Progressive backdrop","rasterProfile":"figma",
            "pages":[{"id":"p","name":"Page","children":["left","stripe","lens","foreground"],"background":"#ffffff"}],
            "nodes":{
                "left":{"id":"left","kind":"rectangle","width":96,"height":64,"fills":[{"kind":"solid","color":"#db286c"}]},
                "stripe":{"id":"stripe","kind":"rectangle","width":44,"height":64,"transform":[1,0,0,1,52,0],
                    "fills":[{"kind":"solid","color":"#236ac4"}]},
                "lens":{"id":"lens","kind":"rectangle","width":72,"height":48,"transform":[1,0,0,1,12,8],
                    "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
                    "effects":[{"kind":"background-blur","radius":4,"color":"#000000",
                        "gradientBlur":{"start":[24,24],"end":[40,24],"startCount":0,"endCount":4,"smooth":true}}]},
                "foreground":{"id":"foreground","kind":"rectangle","width":6,"height":8,"transform":[1,0,0,1,62,28],
                    "fills":[{"kind":"solid","color":"#22bb44"}]}
            }
        });
        let request = RegionRequest {
            page_id: "p".into(),
            bounds: ExportBounds { x: 0., y: 0., width: 96., height: 64. },
            scale: 1.,
            node_ids: None,
            raster_profile: None,
            color_output: None,
        };
        let bytes = crate::binfmt::encode_value(&scene).unwrap();
        assert_eq!(crate::binfmt::decode_value(&bytes).unwrap(), scene);
        let render = |document: &serde_json::Value| {
            let mut engine = Engine::new();
            engine.load_document(&document.to_string()).unwrap();
            image::load_from_memory(&engine.render_region_png(&request).unwrap()).unwrap().into_rgba8()
        };
        let actual = render(&scene);
        let mut plain = scene.clone();
        plain["nodes"]["lens"]["effects"] = json!([]);
        let sharp = render(&plain);
        assert_eq!(actual.get_pixel(24, 32), sharp.get_pixel(24, 32));
        assert_ne!(actual.get_pixel(54, 32), sharp.get_pixel(54, 32));
        assert_eq!(actual.get_pixel(64, 32), sharp.get_pixel(64, 32));
        let mut mixed = scene.clone();
        mixed["nodes"]["foreground"]["effects"] = json!([{
            "kind":"zoom-blur","radius":0,"color":"#000000","zoomBlur":{"amount":4,"center":[0.5,0.5]}
        }]);
        let actual_mixed = render(&mixed);
        let mut engine = Engine::new();
        engine.load_document(&mixed.to_string()).unwrap();
        let options = engine.parse_options(json!({"pageId":"p","width":96,"height":64,
            "view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
        let reference = render_tiles(&mut engine, &options, 96, 64, true, crate::color::ColorSpace::Srgb).unwrap();
        assert_eq!(actual_mixed, image::load_from_memory(&reference).unwrap().into_rgba8());
        let mut desaturated = scene;
        desaturated["nodes"]["lens"]["effects"][0]["colorControls"] = json!({
            "space":"srgb","brightness":0,"contrast":1,"saturation":0,"hue":0
        });
        assert_ne!(render(&desaturated).get_pixel(54, 32), actual.get_pixel(54, 32));
    }

    #[test]
    fn progressive_background_blur_matches_its_png_and_stays_inside_shape_and_clip() {
        let mut nodes = serde_json::Map::new();
        let mut stripe_ids = Vec::new();
        for index in 0..10 {
            let id = format!("stripe{index}");
            stripe_ids.push(id.clone());
            let color = if index % 2 == 0 { "#111111" } else { "#eeeeee" };
            nodes.insert(id.clone(), json!({
                "id": id, "kind": "rectangle", "width": 8, "height": 48, "transform": [1,0,0,1,index * 8,0],
                "fills": [{"kind":"solid","color":color}]
            }));
        }
        stripe_ids.push("lens".into());
        nodes.insert("frame".into(), json!({
            "id":"frame","kind":"frame","width":80,"height":48,"clip":true,"transform":[1,0,0,1,8,8],
            "children": stripe_ids
        }));
        let children = vec!["frame".to_string(), "ink".to_string()];
        nodes.insert("lens".into(), json!({
            "id":"lens","kind":"rectangle","width":64,"height":32,"transform":[1,0,0,1,0,8],
            "radii":[8,8,8,8],
            "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
            "effects":[{"kind":"background-blur","radius":1,"color":"#000000",
                "gradientBlur":{"start":[0,16],"end":[64,16],"startCount":0,"endCount":8,"smooth":true}}]
        }));
        nodes.insert("ink".into(), json!({
            "id":"ink","kind":"rectangle","width":6,"height":8,"transform":[1,0,0,1,70,36],
            "fills":[{"kind":"solid","color":"#00aa00"}]
        }));
        let scene = json!({
            "schemaVersion":19,"id":"d","name":"Progressive backdrop edges","rasterProfile":"figma",
            "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],
            "nodes": nodes
        });
        let request = RegionRequest {
            page_id: "p".into(),
            bounds: ExportBounds { x: 0., y: 0., width: 96., height: 64. },
            scale: 1.,
            node_ids: None,
            raster_profile: None,
            color_output: None,
        };
        let mut engine = Engine::new();
        engine.load_document(&scene.to_string()).unwrap();
        let png = image::load_from_memory(&engine.render_region_png(&request).unwrap()).unwrap().into_rgba8();
        let options = engine.parse_options(json!({"pageId":"p","width":96,"height":64,
            "view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
        let tiled = image::load_from_memory(&render_tiles(&mut engine, &options, 96, 64, true, crate::color::ColorSpace::Srgb).unwrap()).unwrap().into_rgba8();
        assert_eq!(png, tiled);
        let again = image::load_from_memory(&engine.render_region_png(&request).unwrap()).unwrap().into_rgba8();
        assert_eq!(png, again);
        let contrast = |x: u32| (png.get_pixel(x, 32)[0] as i16 - png.get_pixel(x + 4, 32)[0] as i16).abs();
        assert!(contrast(20) > contrast(60), "start {} end {}", contrast(20), contrast(60));
        assert_eq!(png.get_pixel(72, 40)[1], 170);
        let mut sharp = scene.clone();
        sharp["nodes"]["lens"]["effects"] = json!([]);
        let mut sharp_engine = Engine::new();
        sharp_engine.load_document(&sharp.to_string()).unwrap();
        let sharp = image::load_from_memory(&sharp_engine.render_region_png(&request).unwrap()).unwrap().into_rgba8();
        assert_eq!(png.get_pixel(72, 40), sharp.get_pixel(72, 40), "opaque foreground stacks above the blur");
        assert_eq!(png.get_pixel(4, 32), sharp.get_pixel(4, 32), "clipped progressive blur does not paint outside the frame");
        assert_ne!(png.get_pixel(24, 32), sharp.get_pixel(24, 32));

        let angle = 40_f64.to_radians();
        let (cos, sin) = (angle.cos(), angle.sin());
        let (w, h) = (40_f64, 24_f64);
        let (tx, ty) = (32. - cos * w / 2. + sin * h / 2., 32. - sin * w / 2. - cos * h / 2.);
        let mut turned = json!({
            "schemaVersion":19,"id":"d","name":"Rotated progressive lens","rasterProfile":"figma",
            "pages":[{"id":"p","name":"Page","children":["stripe","lens"],"background":"#ffffff"}],
            "nodes":{
                "stripe":{"id":"stripe","kind":"rectangle","width":64,"height":64,"fills":[{"kind":"solid","color":"#2244aa"}]},
                "lens":{"id":"lens","kind":"rectangle","width":40,"height":24,"radii":[6,6,6,6],
                    "transform":[cos, sin, -sin, cos, tx, ty],
                    "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
                    "effects":[{"kind":"background-blur","radius":1,"color":"#000000",
                        "gradientBlur":{"start":[0,12],"end":[40,12],"startCount":0,"endCount":6,"smooth":true}}]}
            }
        });
        let mut mask = turned.clone();
        mask["nodes"]["lens"]["effects"] = json!([]);
        mask["nodes"]["lens"]["fills"] = json!([{"kind":"solid","color":"#ffffff","opacity":1}]);
        let small = RegionRequest {
            page_id: "p".into(),
            bounds: ExportBounds { x: 0., y: 0., width: 64., height: 64. },
            scale: 1., node_ids: None, raster_profile: None, color_output: None,
        };
        let decode = |document: &serde_json::Value| {
            let mut engine = Engine::new();
            engine.load_document(&document.to_string()).unwrap();
            image::load_from_memory(&engine.render_region_png(&small).unwrap()).unwrap().into_rgba8()
        };
        let blurred = decode(&turned);
        let covered = decode(&mask);
        turned["nodes"]["lens"]["effects"] = json!([]);
        turned["nodes"]["lens"]["fills"] = json!([]);
        let bare = decode(&turned);
        let mut saw_outside = false;
        let mut leaked = false;
        let mut inside = false;
        for y in 0..64u32 {
            for x in 0..64u32 {
                if covered.get_pixel(x, y) == bare.get_pixel(x, y) {
                    saw_outside = true;
                    leaked |= blurred.get_pixel(x, y) != bare.get_pixel(x, y);
                } else {
                    inside |= blurred.get_pixel(x, y) != bare.get_pixel(x, y);
                }
            }
        }
        assert!(saw_outside && inside, "the rotated rounded lens has pixels both inside and outside its shape");
        assert!(!leaked, "the rotated lens does not filter pixels outside its rounded shape");
    }

    #[test]
    fn overlapping_blur_support_exports_with_bounded_surfaces() {
        let lens = |id, y, radius| json!({
            "id": id, "kind": "rectangle", "width": 192, "height": 104,
            "transform": [1,0,0,1,257,y], "radii": [16,16,16,16],
            "fills": [{"kind":"solid", "color":"#ffffff", "opacity":0.1}],
            "effects": [{"kind":"glass", "radius":radius, "color":"#172033", "opacity":0.5, "amount":14,
                "glass":{"depth":8, "refraction":0.5, "dispersion":0.3, "lightAngle":45, "lightIntensity":0.5}}]
        });
        let document = json!({
            "schemaVersion":19, "id":"d", "name":"Effect overlap", "rasterProfile":"figma",
            "pages":[{"id":"p","name":"Page","children":["frame"],"background":"#ffffff"}],
            "nodes":{
                "frame":{"id":"frame","kind":"frame","width":480,"height":320,"clip":true,
                    "children":["glass1","blur","glass2"],"fills":[{"kind":"solid","color":"#151f32"}]},
                "glass1":lens("glass1",34,8),
                "blur":{"id":"blur","kind":"rectangle","width":192,"height":104,"transform":[1,0,0,1,32,182],
                    "radii":[16,16,16,16],"fills":[{"kind":"solid","color":"#f7faff"}],
                    "effects":[{"kind":"blur","radius":8,"color":"#172033","gradientBlur":{"start":[0,0],"end":[192,0],
                        "startCount":0,"endCount":12,"smooth":true}}]},
                "glass2":lens("glass2",182,12)
            }
        });
        let mut engine = Engine::new();
        engine.load_document(&document.to_string()).unwrap();
        let request = RegionRequest {
            page_id: "p".into(),
            bounds: ExportBounds { x: 0., y: 0., width: 480., height: 320. },
            scale: 1.,
            node_ids: Some(vec!["frame".into()]),
            raster_profile: None,
            color_output: None,
        };
        let png = engine.render_region_png(&request).unwrap();
        assert!(engine.compositing_ledger().scene_peak_bytes <= crate::memory::COMPOSITING_BYTES);
        let options = engine.parse_options(json!({"pageId":"p","width":480,"height":320,
            "view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
        let reference = render_tiles(&mut engine, &options, 120, 80, true, crate::color::ColorSpace::Srgb).unwrap();
        let decode = |bytes: &[u8]| image::load_from_memory(bytes).unwrap().into_rgba8();
        let actual = decode(&png);
        assert_eq!(actual.dimensions(), (480, 320));
        assert_eq!(actual, decode(&reference));
    }
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
            ..Path::default()
        }
        .svg_data();
        assert!(curve.contains('C') && curve.contains('Q') && curve.ends_with("Z "));
    }
    #[test]
    fn png_records_srgb_and_preserves_every_byte_of_a_ramp() {
        let rgba: Vec<u8> = (0..=255_u8).flat_map(|v| [v, 255 - v, v, 255]).collect();
        let bytes = encode_rgba(256, 1, &rgba).unwrap();
        assert!(bytes.windows(4).any(|s| s == b"sRGB"));
        assert!(bytes.windows(4).any(|s| s == b"iCCP"));
        assert!(bytes
            .windows(8)
            .any(|s| s == [0, 0, 0, 1, b's', b'R', b'G', b'B']));
        assert_eq!(
            image::load_from_memory(&bytes)
                .unwrap()
                .into_rgba8()
                .as_raw(),
            &rgba
        );
        assert!(encode_rgba(256, 2, &rgba).is_err());
        let managed = encode_color_png(
            1,
            1,
            &[crate::blend::Pixel::rgba(0.5, 0.25, 0.125, 1.)],
            crate::color::ColorSettings::default(),
            crate::color::ColorOutput::default(),
        )
        .unwrap();
        assert!(managed.windows(4).any(|s| s == b"cICP"));
        assert!(managed
            .windows(8)
            .any(|s| s == [0, 0, 0, 1, b's', b'R', b'G', b'B']));
        let wide = encode_color_png(
            1,
            1,
            &[crate::blend::Pixel::rgba(0.5, 0.25, 0.125, 1.)],
            crate::color::ColorSettings::default(),
            crate::color::ColorOutput {
                space: crate::color::ColorSpace::DisplayP3,
                tone_map: crate::color::ToneMap::Clip,
            },
        )
        .unwrap();
        assert!(wide.windows(4).any(|s| s == b"cICP"));
        assert!(!wide
            .windows(8)
            .any(|s| s == [0, 0, 0, 1, b's', b'R', b'G', b'B']));
        assert!(validate_size(16385, 1).is_err());
        assert!(validate_size(8192, 8192).is_err());
    }
    fn rgba_at(bytes: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
    }

    #[test]
    fn layer_fill_color_and_shadow_opacity_multiply() {
        let doc = json!({"schemaVersion":1,"id":"d","name":"opacity","pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],"nodes":{
            "n":{"id":"n","kind":"rectangle","width":8,"height":8,"opacity":0.5,
                "fills":[{"kind":"solid","color":"color(srgb 1 0 0 / 0.5)","opacity":0.5}],
                "effects":[{"kind":"shadow","visible":true,"radius":0,"x":12,"y":0,"spread":0,"color":"color(srgb 0 0 0 / 0.5)","opacity":0.5,"amount":0}]}
        }});
        for profile in ["analytic", "figma"] {
            let mut engine = Engine::new();
            engine.load_document(&doc.to_string()).unwrap();
            let options = engine
                .parse_options(json!({
                    "pageId":"p","width":24,"height":8,
                    "view":{"x":0.0,"y":0.0,"zoom":1.0},
                    "transparent":true,"grid":false,"checkerboard":false,
                    "rasterProfile": profile
                }))
                .unwrap();
            let bytes = engine.render(&options).unwrap();
            let fill = rgba_at(&bytes, 24, 4, 4);
            let shadow = rgba_at(&bytes, 24, 16, 4);
            assert!(
                (30..=34).contains(&fill[3]) && fill[0] == 255 && fill[1] == 0 && fill[2] == 0,
                "{profile} fill {fill:?}"
            );
            assert!(
                (6..=12).contains(&shadow[3]) && shadow[0] <= 2 && shadow[1] <= 2 && shadow[2] <= 2,
                "{profile} shadow {shadow:?}"
            );
        }
    }

    #[test]
    fn unmanaged_display_p3_export_converts_and_tags() {
        let doc = json!({"schemaVersion":1,"id":"d","name":"p3","pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],"nodes":{
            "n":{"id":"n","kind":"rectangle","width":2,"height":2,"fills":[{"kind":"solid","color":"#ff0000"}]}
        }});
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let bounds = ExportBounds { x: 0., y: 0., width: 2., height: 2. };
        let srgb = engine
            .render_region_png(&RegionRequest {
                page_id: "p".into(),
                bounds,
                scale: 1.,
                node_ids: None,
                raster_profile: Some(RasterProfile::Analytic),
                color_output: None,
            })
            .unwrap();
        let p3 = engine
            .render_region_png(&RegionRequest {
                page_id: "p".into(),
                bounds,
                scale: 1.,
                node_ids: None,
                raster_profile: Some(RasterProfile::Analytic),
                color_output: Some(crate::color::ColorOutput {
                    space: crate::color::ColorSpace::DisplayP3,
                    tone_map: crate::color::ToneMap::Clip,
                }),
            })
            .unwrap();
        assert!(srgb.windows(4).any(|window| window == b"sRGB"));
        assert!(srgb.windows(4).any(|window| window == b"iCCP"));
        assert!(p3.windows(4).any(|window| window == b"cICP"));
        assert!(p3.windows(4).any(|window| window == b"iCCP"));
        assert!(!p3.windows(8).any(|window| window == [0, 0, 0, 1, b's', b'R', b'G', b'B']));
        let decode = |png: &[u8]| {
            let decoder = png::Decoder::new(std::io::Cursor::new(png));
            let mut reader = decoder.read_info().unwrap();
            let mut buffer = vec![0; reader.output_buffer_size().expect("png size")];
            let frame = reader.next_frame(&mut buffer).unwrap();
            buffer.truncate(frame.buffer_size());
            buffer
        };
        let srgb_px = decode(&srgb);
        let p3_px = decode(&p3);
        assert_eq!(&srgb_px[0..4], &[255, 0, 0, 255]);
        assert_ne!(&p3_px[0..3], &[255, 0, 0]);
        assert_eq!(p3_px[3], 255);
        assert!(p3_px[0] < 255 && p3_px[1] > 0 && p3_px[2] > 0, "{p3_px:?}");
        let jpeg = crate::export_formats::transcode(&p3, "jpeg", 1.).unwrap();
        let profile = display_p3_icc_profile().unwrap();
        assert!(jpeg.windows(profile.len()).any(|window| window == profile.as_slice()));
        let srgb_jpeg = crate::export_formats::transcode(&srgb, "jpeg", 1.).unwrap();
        let srgb_profile = srgb_icc_profile().unwrap();
        assert!(srgb_jpeg.windows(srgb_profile.len()).any(|window| window == srgb_profile.as_slice()));
        assert!(engine
            .render_region_png(&RegionRequest {
                page_id: "p".into(),
                bounds,
                scale: 1.,
                node_ids: None,
                raster_profile: Some(RasterProfile::Analytic),
                color_output: Some(crate::color::ColorOutput {
                    space: crate::color::ColorSpace::Rec2020,
                    tone_map: crate::color::ToneMap::Clip,
                }),
            })
            .unwrap_err()
            .contains("Display P3"));
        let neutral = crate::color::encoded_srgb_to_display_p3([0., 0., 0.]);
        assert!(neutral.iter().all(|v| v.abs() < 1e-9));
        let white = crate::color::encoded_srgb_to_display_p3([1., 1., 1.]);
        assert!(white.iter().all(|v| (v - 1.).abs() < 1e-9));
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

    #[test]
    fn clipped_blurred_rectangle_tiff_matches_the_cpu_png_at_two_scales() {
        let doc = json!({
            "schemaVersion": 1,
            "id": "d",
            "name": "tiff-scene",
            "pages": [{"id": "p", "name": "p", "children": ["frame"], "background": "#ffffff"}],
            "nodes": {
                "frame": {"id": "frame", "kind": "frame", "width": 60, "height": 40, "transform": [1, 0, 0, 1, 30, 20], "clip": true, "children": ["ink", "spill"]},
                "ink": {"id": "ink", "kind": "rectangle", "width": 36, "height": 24, "transform": [1, 0, 0, 1, 8, 8],
                    "fills": [{"kind": "solid", "color": "color(srgb 0.15 0.45 0.9 / 0.45)"}],
                    "effects": [{"kind": "blur", "radius": 3, "color": "#000000"}]},
                "spill": {"id": "spill", "kind": "rectangle", "width": 40, "height": 30, "transform": [1, 0, 0, 1, -20, -10],
                    "fills": [{"kind": "solid", "color": "#cc2200"}],
                    "effects": [{"kind": "blur", "radius": 4, "color": "#000000"}]}
            }
        });
        let saved = doc.to_string();
        let mut unclipped = doc.clone();
        unclipped["nodes"]["frame"]["clip"] = json!(false);
        let mut clipped = Engine::new();
        let mut open = Engine::new();
        clipped.load_document(&saved).unwrap();
        open.load_document(&unclipped.to_string()).unwrap();
        let decode = |png: &[u8]| {
            let decoder = png::Decoder::new(std::io::Cursor::new(png));
            let mut reader = decoder.read_info().unwrap();
            let mut buffer = vec![0; reader.output_buffer_size().expect("png size")];
            let frame = reader.next_frame(&mut buffer).unwrap();
            buffer.truncate(frame.buffer_size());
            buffer
        };
        for scale in [1., 2.] {
            let request = RegionRequest {
                page_id: "p".into(),
                bounds: ExportBounds { x: 0., y: 0., width: 120., height: 90. },
                scale,
                node_ids: Some(vec!["frame".into()]),
                raster_profile: Some(RasterProfile::Analytic),
                color_output: None,
            };
            let png = clipped.render_region_png(&request).unwrap();
            let without_clip = open.render_region_png(&request).unwrap();
            assert!(png.windows(4).any(|window| window == b"sRGB"));
            assert!(png.windows(4).any(|window| window == b"iCCP"));
            let png_pixels = decode(&png);
            assert_ne!(png_pixels, decode(&without_clip), "clip changes the CPU export");
            assert!(png_pixels.chunks_exact(4).any(|pixel| (1..255).contains(&pixel[3])));
            let tiff = crate::export_formats::transcode(&png, "tiff", scale).unwrap();
            assert_eq!(&tiff[..4], b"MM\x00\x2A");
            assert!(!tiff.starts_with(b"\x89PNG"));
            let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&tiff)).unwrap();
            let (width, height) = decoder.dimensions().unwrap();
            assert_eq!(
                (width, height),
                ((120. * scale) as u32, (90. * scale) as u32)
            );
            let samples = match decoder.read_image().unwrap() {
                tiff::decoder::DecodingResult::U8(samples) => samples,
                _ => panic!("expected 8-bit TIFF samples"),
            };
            assert_eq!(samples, png_pixels);
            let profile = srgb_icc_profile().unwrap();
            assert!(tiff.windows(profile.len()).any(|window| window == profile.as_slice()));
        }
        assert_eq!(doc.to_string(), saved);
    }
}
