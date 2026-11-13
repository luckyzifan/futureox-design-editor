#![forbid(unsafe_code)]
pub mod repeat;
pub mod analytic;
pub mod animation;
pub mod animation_bake;
pub mod animation_plan;
pub mod area_program;
pub mod authoring_shapes;
pub mod vector_brush;
pub mod binfmt;
pub mod blend;
pub mod boolean;
#[cfg(test)]
mod boolean_properties;
pub mod bounds;
pub mod capture_plan;
mod certified_filter;
pub mod code_blocks;
pub mod color;
pub mod color_controls;
pub mod components;
pub mod component_updates;
pub mod constraint_projection;
pub mod connectors;
pub mod coverage;
pub mod curve_boolean;
pub mod shape_builder;
mod curve_boolean_cache;
pub mod design_system;
pub mod dirty_region;
pub mod editing;
pub mod effects;
pub mod spatial_blur;
pub mod zoom_blur;
pub mod zoom_refine_schedule;
mod zoom_support;
pub mod noise_fill;
pub mod export;
pub mod export_formats;
pub mod heic_export;
#[cfg(not(target_arch = "wasm32"))]
pub mod ffmpeg_encode;
pub mod facet;
pub mod fidelity;
pub mod fig;
pub mod figma_gradient;
pub mod figma_sampling;
pub mod figma_rotation;
pub mod rotation_preview;
pub mod figma_snap;
pub mod ruler_units;
pub mod svg_export;
pub mod fixed_gradient;
pub mod font;
pub mod abeezee_font;
mod font_glyph_cache;
mod text_path_cache;
mod read_cache;
pub mod freehand;
mod geometry_snapshot;
mod cpu_frame_plan;
mod geometry_support;
mod world_support;
mod margin_index;
mod render_index;
mod sketch_masks;
mod resident_strokes;
mod derived_invalidation;
mod text_case;
pub mod glass_capture;
pub mod gpu;
pub mod gradient_blur;
pub mod graph_api;
pub mod handles;
mod image_color;
pub mod raster_import;
pub mod image_rows;
#[cfg(not(target_arch="wasm32"))]
pub mod source_bitmap_pixels;
pub mod image_adjust;
pub mod image_mipmap;
pub mod inferred_layout;
pub mod interop;
mod interop_resources;
pub mod sketch;
pub mod layout;
pub mod layout_grid;
pub mod measurement;
pub mod material;
pub mod math;
/// CPU/GPU memory accounting. Public for the native wgpu compositor
/// (`futureox-design-gpu`), which feeds the four-bucket GPU memory ledger at
/// its resource construction/destruction points.
pub mod memory;
pub mod capacity;
pub mod large_json;
pub mod vector_geometry;
pub mod fig_geometry;
mod mutation;
pub mod ops;
pub mod optics;
pub mod paint;
pub mod path;
pub mod pattern_fill;
pub mod pdf_export;
pub mod pdf_import;
pub mod preview;
pub mod preparation;
#[cfg(not(target_arch="wasm32"))]
pub mod navigation_image;
pub mod render_cancellation;
pub mod prototype;
pub mod prototype_logic;
pub mod protocol;
pub mod raster;
pub mod raster_surface;
pub mod rational_filter;
pub mod render_instruction;
pub mod render_telemetry;
pub mod renderer;
pub mod reviews;
mod rounded;
pub mod sampling;
pub mod scene;
#[cfg(not(target_arch = "wasm32"))]
pub mod scene_store;
#[cfg(not(target_arch = "wasm32"))]
pub mod scene_demand;
#[cfg(not(target_arch = "wasm32"))]
mod source_compile;
pub mod fd_extensions;
pub mod shortcuts;
pub mod smart_guides;
pub mod snapshot;
pub mod software_raster;
pub mod stroke;
pub mod text_path;
pub mod texture_capture;
pub mod texture_capture_plan;
pub mod texture_noise;
pub mod texture_replay;
pub mod tile_level;
pub mod tile_stack;
pub mod tiled_renderer;
pub mod vector_tools;
pub mod zoom_in_preview;
pub use renderer::{Engine, RenderOptions, View};

/// Stateless authored-document admission. No renderer, font or history state is created.
pub fn validate_document_json(json: &str) -> Result<(), String> {
    capacity::check_document_bytes(json.len())?;
    let document: scene::Document = serde_json::from_str(json).map_err(|e| e.to_string())?;
    document.validate()
}

const HIT_DEVICE_ERROR: f64 = 0.015625;

fn validate_hit_device(point: math::Point, matrix: math::Transform) -> Result<f64, String> {
    if !point.finite() || matrix.0.iter().any(|v| !v.is_finite() || v.abs() > 1e12) {
        return Err("Invalid device hit-test point or transform".into());
    }
    let scale = matrix.max_scale();
    if !scale.is_finite() || scale <= 0. {
        return Err("Invalid device hit-test scale".into());
    }
    Ok(scale)
}

fn near_contours(point: math::Point, contours: &[path::Contour], distance: f64) -> bool {
    contours.iter().any(|c| {
        let count = if c.closed {
            c.points.len()
        } else {
            c.points.len().saturating_sub(1)
        };
        (0..count).any(|i| {
            let a = c.points[i];
            let b = c.points[(i + 1) % c.points.len()];
            let d = b - a;
            let length = d.dot(d);
            let t = if length > 0. {
                ((point - a).dot(d) / length).clamp(0., 1.)
            } else {
                0.
            };
            (point - a.lerp(b, t)).length() <= distance
        })
    })
}

/// Geometric fill containment for ancestor clip/shape-mask constraints. Unlike
/// object selection this respects rounded frame paths, ignores paint visibility,
/// and never adds the pointer halo. This is not composited mask-alpha sampling.
pub fn hit_test_fill_device(
    node: &scene::Node,
    point: math::Point,
    matrix: math::Transform,
) -> Result<bool, String> {
    validate_hit_device(point, matrix)?;
    let (fill, _) = node.paths()?;
    // Offscreen masks still constrain children, but need not exhaust curve
    // subdivision merely to reject a distant pointer. Keep bounds in f64:
    // render control rectangles clamp to an integer viewport range.
    let Some(bounds) = bounds::path_bounds(&fill, matrix) else {
        return Ok(false);
    };
    let right = bounds.x + bounds.width;
    let bottom = bounds.y + bounds.height;
    let magnitude = bounds
        .x
        .abs()
        .max(bounds.y.abs())
        .max(right.abs())
        .max(bottom.abs());
    let margin = HIT_DEVICE_ERROR + magnitude * f64::EPSILON * 16.;
    if point.x < bounds.x - margin
        || point.x > right + margin
        || point.y < bounds.y - margin
        || point.y > bottom + margin
    {
        return Ok(false);
    }
    let contours = fill.flatten_for_point(matrix, HIT_DEVICE_ERROR, point)?;
    let winding = path::winding(point, &contours);
    let inside = if node.fill_even_odd()
    {
        winding.abs() % 2 != 0
    } else {
        winding != 0
    };
    // Keep inclusive exact edges (not a pointer halo), including a rectangular
    // clip's bottom/right edges formerly tested by <= in the frontend.
    Ok(inside || near_contours(point, &contours, 1e-9))
}

pub fn hit_test(node: &scene::Node, point: math::Point, tolerance: f64) -> Result<bool, String> {
    if !point.finite() || !tolerance.is_finite() || !(0. ..=1000.).contains(&tolerance) {
        return Err("Invalid hit-test point".into());
    }
    if ["slice", "frame", "section", "text"].contains(&node.kind.as_str()) {
        return Ok(point.x >= 0.
            && point.y >= 0.
            && point.x <= node.width
            && point.y <= node.height);
    }
    node.validate_strokes()?;
    let (fill, stroke) = node.paths()?;
    let fill = fill.flatten(math::Transform::default(), 0.02)?;
    let winding = path::winding(point, &fill);
    let inside = if node.fill_even_odd()
    {
        winding.abs() % 2 != 0
    } else {
        winding != 0
    };
    if inside && node.fills.iter().any(|p| p.visible) {
        return Ok(true);
    }
    let lines = stroke.flatten(math::Transform::default(), 0.02)?;
    for s in node.strokes.iter().filter(|s| s.visible && s.width > 0.) {
        let outline = stroke::expand(&lines, s, 0.02, tolerance)?;
        if path::winding(point, &outline) != 0
            && (s.align == "center" || if s.align == "inside" { inside } else { !inside })
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Hit testing in CSS/device space keeps curve error and the pointer halo
/// independent of zoom, nonuniform scale, reflection and shear. The caller may
/// rebase the transform around the pointer to avoid large camera cancellation.
pub fn hit_test_device(
    node: &scene::Node,
    point: math::Point,
    matrix: math::Transform,
    tolerance: f64,
) -> Result<bool, String> {
    if !tolerance.is_finite() || !(0. ..=1000.).contains(&tolerance) {
        return Err("Invalid device hit-test point or transform".into());
    }
    let scale = validate_hit_device(point, matrix)?;
    const ERROR: f64 = HIT_DEVICE_ERROR;
    if ["slice", "frame", "section", "text"].contains(&node.kind.as_str()) {
        let box_path = path::Path::rectangle(node.width, node.height, [0.; 4], 0.);
        let contours = box_path.flatten(matrix, ERROR)?;
        return Ok(path::winding(point, &contours) != 0 || near_contours(point, &contours, 1e-9));
    }
    node.validate_strokes()?;
    let (fill_path, stroke_path) = node.paths()?;
    let fill = fill_path.flatten_for_point(matrix, ERROR, point)?;
    let winding = path::winding(point, &fill);
    let inside = if node.fill_even_odd()
    {
        winding.abs() % 2 != 0
    } else {
        winding != 0
    };
    if inside && node.fills.iter().any(|p| p.visible) {
        return Ok(true);
    }
    if !node.strokes.iter().any(|s| s.visible && s.width > 0.) {
        return Ok(false);
    }
    let local_error = (ERROR / scale).min(1.);
    let lines = stroke_path.flatten(math::Transform::default(), local_error)?;
    for stroke in node.strokes.iter().filter(|s| s.visible && s.width > 0.) {
        if stroke.align != "center"
            && (if stroke.align == "inside" {
                !inside
            } else {
                inside
            })
        {
            continue;
        }
        let mut outline = stroke::expand(&lines, stroke, local_error, 0.)?;
        for contour in &mut outline {
            for p in &mut contour.points {
                *p = matrix.point(*p);
            }
        }
        if path::winding(point, &outline) != 0
            || (tolerance > 0. && near_contours(point, &outline, tolerance))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn geometry(json: &str) -> Result<String, String> {
    if serde_json::from_str::<serde_json::Value>(json).ok().and_then(|v| v.get("operation").and_then(|x| x.as_str()).map(str::to_owned)).as_deref() == Some("shape-builder") {
        return shape_builder::json(json);
    }
    use math::{Point, Transform};
    use path::Contour;
    #[derive(serde::Deserialize)]
    struct Request {
        operation: String,
        nodes: Vec<scene::Node>,
    }
    let request: Request = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if request.nodes.is_empty() || request.nodes.len() > 64 {
        return Err("Select 1–64 nodes".into());
    }
    let mut inputs = Vec::new();
    for n in &request.nodes {
        n.validate_strokes()?;
        let (fill, _) = n.paths()?;
        let contours = fill.flatten(n.transform, 0.01)?;
        inputs.push(
            if !n.fill_even_odd() {
                boolean::boolean_with_rules(&[contours], boolean::Operation::Union, &[false])?
            } else {
                contours
            },
        );
    }
    let results: Vec<Vec<Contour>> = if request.operation == "outline" {
        let mut results = Vec::new();
        for n in &request.nodes {
            let (fill, stroke) = n.paths()?;
            let fill = fill.flatten(Transform::default(), 0.01)?;
            let paths = stroke.flatten(Transform::default(), 0.01)?;
            for s in n.strokes.iter().filter(|s| s.visible && s.width > 0.) {
                let outlines = stroke::expand(&paths, s, 0.01, 0.)?;
                // Each primitive has positive winding: normalize their union before classifying holes.
                let mut result = boolean::boolean(
                    &outlines.iter().map(|c| vec![c.clone()]).collect::<Vec<_>>(),
                    boolean::Operation::Union,
                )?;
                if !fill.is_empty() && s.align != "center" {
                    result = boolean::boolean_with_rules(
                        &[result, fill.clone()],
                        if s.align == "inside" {
                            boolean::Operation::Intersect
                        } else {
                            boolean::Operation::Subtract
                        },
                        &[
                            false,
                            n.fill_even_odd(),
                        ],
                    )?;
                }
                for c in &mut result {
                    for p in &mut c.points {
                        *p = n.transform.point(*p);
                    }
                }
                results.push(result);
            }
        }
        results
    } else if request.operation == "divide" {
        if inputs.len() > 16 {
            return Err("Shape builder supports up to 16 inputs per operation".into());
        }
        let mut regions: Vec<Vec<Contour>> = Vec::new();
        let mut previous = Vec::new();
        for input in inputs {
            let mut next = Vec::new();
            for region in regions {
                for op in [boolean::Operation::Intersect, boolean::Operation::Subtract] {
                    let result = boolean::boolean(&[region.clone(), input.clone()], op)?;
                    if !result.is_empty() {
                        next.push(result);
                    }
                }
            }
            let extra = if previous.is_empty() {
                input.clone()
            } else {
                let mut args = vec![input.clone()];
                args.extend(previous.iter().cloned());
                boolean::boolean(&args, boolean::Operation::Subtract)?
            };
            if !extra.is_empty() {
                next.push(extra);
            }
            previous.push(input);
            regions = next;
        }
        regions
    } else {
        let op: boolean::Operation =
            serde_json::from_value(serde_json::Value::String(request.operation))
                .map_err(|_| "Unknown geometry operation")?;
        vec![boolean::boolean(&inputs, op)?]
    };
    let output: Vec<Vec<Vec<Point>>> = results
        .into_iter()
        .map(|cs| cs.into_iter().map(|c| c.points).collect())
        .collect();
    serde_json::to_string(&output).map_err(|e| e.to_string())
}

pub fn stroke_geometry(json: &str) -> Result<String, String> {
    let n: scene::Node = serde_json::from_str(json).map_err(|e| e.to_string())?;
    n.validate_strokes()?;
    let (_, path) = n.paths()?;
    let cs = path.flatten(math::Transform::default(), 0.01)?;
    let result = n
        .strokes
        .iter()
        .map(|s| {
            stroke::expand(&cs, s, 0.01, 0.)
                .map(|cs| cs.into_iter().map(|c| c.points).collect::<Vec<_>>())
        })
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use js_sys::{Array, Uint8Array};
    use wasm_bindgen::prelude::*;
    use wasm_bindgen::JsCast;
    /// Trusted bootstrap only. No document field or operation argument routes here.
    #[wasm_bindgen]
    pub fn color_fully_opaque(color: &str, opacity: f64) -> bool {
        rotation_preview::color_fully_opaque(color, opacity)
    }
    #[wasm_bindgen]
    pub fn screenshot_rotation_supplies(
        source_x: f64, source_y: f64, source_w: f64, source_h: f64,
        crop_x: f64, crop_y: f64, crop_w: f64, crop_h: f64,
        center_x: f64, center_y: f64, degrees: f64,
        view_x: f64, view_y: f64, view_w: f64, view_h: f64,
    ) -> bool {
        rotation_preview::screenshot_rotation_supplies(
            (source_x, source_y, source_w, source_h),
            (crop_x, crop_y, crop_w, crop_h),
            (center_x, center_y),
            degrees,
            (view_x, view_y, view_w, view_h),
        )
    }
    #[wasm_bindgen]
    pub fn rotation_screenshot_admitted(
        color: &str, opacity: f64,
        source_x: f64, source_y: f64, source_w: f64, source_h: f64,
        crop_x: f64, crop_y: f64, crop_w: f64, crop_h: f64,
        center_x: f64, center_y: f64, degrees: f64,
        view_x: f64, view_y: f64, view_w: f64, view_h: f64,
    ) -> bool {
        rotation_preview::rotation_screenshot_admitted(
            color, opacity,
            (source_x, source_y, source_w, source_h),
            (crop_x, crop_y, crop_w, crop_h),
            (center_x, center_y),
            degrees,
            (view_x, view_y, view_w, view_h),
        )
    }
    #[wasm_bindgen]
    pub fn rotation_source_preview_allowed(
        color: &str, opacity: f64, image: bool, backdrop: bool, effects: bool, strokes: bool,
        source_x: f64, source_y: f64, source_w: f64, source_h: f64,
        center_x: f64, center_y: f64, degrees: f64, others: &[f64],
    ) -> bool {
        if others.len() % 4 != 0 {
            return false;
        }
        let rects: Vec<(f64, f64, f64, f64)> = others.chunks(4).map(|c| (c[0], c[1], c[2], c[3])).collect();
        rotation_preview::rotation_source_preview_allowed(
            color, opacity, image, backdrop, effects, strokes,
            (source_x, source_y, source_w, source_h),
            (center_x, center_y),
            degrees,
            &rects,
        )
    }
    #[wasm_bindgen]
    pub fn configure_document_capacity(memory_bytes: f64) -> Result<(), JsValue> {
        if !memory_bytes.is_finite() || memory_bytes.fract() != 0. || memory_bytes < 16. || memory_bytes > capacity::WASM_ADDRESS_BYTES as f64 {
            return Err(JsValue::from_str("Invalid trusted document memory budget"));
        }
        capacity::configure(memory_bytes as u64).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn document_capacity_bytes() -> f64 { capacity::document_byte_limit() as f64 }
    #[wasm_bindgen]
    pub fn decode_fig_network_json(bytes:&[u8],sx:f64,sy:f64)->Result<String,JsValue>{
        let decoded=fig_geometry::decode_network(bytes,sx,sy).map_err(|e|JsValue::from_str(&e))?;
        serde_json::to_string(&decoded).map_err(|e|JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn fig_stroke_caps_json() -> String {
        serde_json::to_string(fig::STROKE_CAPS).expect("static FIG stroke caps serialize")
    }
    #[wasm_bindgen]
    pub fn fig_mask_suffixes(flags:&[u8])->Result<Vec<u32>,JsValue>{
        fig_geometry::mask_suffixes(flags).map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn decode_fig_rounded_network_json(bytes:&[u8],sx:f64,sy:f64,radius:f64,smoothing:f64,styles:&str)->Result<String,JsValue>{
        let error=|e:String|JsValue::from_str(&e);
        let mut decoded=fig_geometry::decode_network(bytes,sx,sy).map_err(error)?;
        let styles:serde_json::Value=serde_json::from_str(styles).map_err(|e|error(e.to_string()))?;
        let applied=fig_geometry::round_network(&mut decoded,radius,smoothing,&styles).map_err(error)?;
        let mut result=serde_json::to_value(&decoded).map_err(|e|error(e.to_string()))?;
        result["cornersApplied"]=serde_json::Value::Bool(applied);
        serde_json::to_string(&result).map_err(|e|error(e.to_string()))
    }
    #[wasm_bindgen]
    pub fn decode_fig_commands_json(bytes:&[u8])->Result<String,JsValue>{
        let path=fig_geometry::decode_commands(bytes).map_err(|e|JsValue::from_str(&e))?;
        let commands=vector_geometry::encode(&path).map_err(|e|JsValue::from_str(&e))?;
        serde_json::to_string(&commands).map_err(|e|JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn decode_fig_fill_commands_json(bytes:&[u8])->Result<String,JsValue>{
        let path=fig_geometry::decode_fill_commands(bytes).map_err(|e|JsValue::from_str(&e))?;
        let commands=vector_geometry::encode(&path).map_err(|e|JsValue::from_str(&e))?;
        serde_json::to_string(&commands).map_err(|e|JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn network_geometry_json(json:&str)->Result<String,JsValue>{
        capacity::check_document_bytes(json.len()).map_err(|e|JsValue::from_str(&e))?;
        let network:scene::Network=serde_json::from_str(json).map_err(|e|JsValue::from_str(&e.to_string()))?;
        if network.vertices.len()>10000||network.edges.len()>20000{return Err(JsValue::from_str("Editable network exceeds its working allowance"));}
        let (fill,stroke)=network.paths().map_err(|e|JsValue::from_str(&e))?;
        let geometry=vector_geometry::VectorGeometry::from_paths(&fill,&stroke,&network.fill_rule).map_err(|e|JsValue::from_str(&e))?;
        serde_json::to_string(&geometry).map_err(|e|JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn vector_geometry_network_json(json: &str) -> Result<String,JsValue> {
        capacity::check_document_bytes(json.len()).map_err(|e|JsValue::from_str(&e))?;
        let geometry:vector_geometry::VectorGeometry=serde_json::from_str(json).map_err(|e|JsValue::from_str(&e.to_string()))?;
        let network=geometry.network(10000).map_err(|e|JsValue::from_str(&e))?;
        serde_json::to_string(&network).map_err(|e|JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn vector_geometry_scale_json(json: &str, sx:f64, sy:f64) -> Result<String,JsValue> {
        capacity::check_document_bytes(json.len()).map_err(|e|JsValue::from_str(&e))?;
        if !sx.is_finite()||!sy.is_finite()||sx<=0.||sy<=0. {return Err(JsValue::from_str("Invalid geometry scale"));}
        let mut geometry:vector_geometry::VectorGeometry=serde_json::from_str(json).map_err(|e|JsValue::from_str(&e.to_string()))?;
        geometry.validate().map_err(|e|JsValue::from_str(&e))?;geometry.scale(sx,sy);geometry.validate().map_err(|e|JsValue::from_str(&e))?;
        serde_json::to_string(&geometry).map_err(|e|JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn validate_document_json(json: &str) -> Result<(), JsValue> {
        super::validate_document_json(json).map_err(|e| JsValue::from_str(&e))
    }
    /// SVG consumes the same ordered draw plan as the raster backends. The
    /// input contains topology only, with no image, font, path or paint bytes.
    #[wasm_bindgen]
    pub fn sketch_mask_draw_plan(json: &str) -> Result<String, JsValue> {
        crate::capacity::check_document_bytes(json.len()).map_err(|e| JsValue::from_str(&e))?;
        let mut doc: scene::Document = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        // This entry point is callable with untrusted topology. Bound the tree
        // and reject cycles, repeated IDs and missing children before walking.
        doc.validate().map_err(|e| JsValue::from_str(&e))?;
        let mut ops = Vec::new();
        crate::sketch_masks::resolve_with(&mut doc, &mut |op| ops.push(serde_json::json!(op)))
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&ops).map_err(|e| JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn snap_pixel_json(json: &str) -> Result<String, JsValue> {
        let point = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let result = editing::snap_pixel(point).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    #[wasm_bindgen]
    pub fn geometry_bounds_json(node: &str, matrix: &str) -> Result<String, JsValue> {
        let n: scene::Node =
            serde_json::from_str(node).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let m: math::Transform =
            serde_json::from_str(matrix).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if m.0.iter().any(|v| !v.is_finite() || v.abs() > 1e7) {
            return Err(JsValue::from_str("Invalid bounds transform"));
        }
        let (fill, stroke) = n.paths().map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&bounds::paths_bounds(&fill, &stroke, m))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
    #[wasm_bindgen]
    pub fn vector_translate_json(
        network: &str,
        ids: &str,
        x: f64,
        y: f64,
    ) -> Result<String, JsValue> {
        let network =
            serde_json::from_str(network).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let ids: Vec<String> =
            serde_json::from_str(ids).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let result = vector_tools::translate_vertices(network, &ids, math::Point::new(x, y))
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    #[wasm_bindgen]
    pub fn vector_fill_region_json(
        network: &str,
        x: f64,
        y: f64,
        filled: bool,
    ) -> Result<String, JsValue> {
        let network =
            serde_json::from_str(network).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let result = vector_tools::fill_region(network, math::Point::new(x, y), filled)
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    #[wasm_bindgen]
    pub fn vector_tool_json(json: &str) -> Result<String, JsValue> {
        let request = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let result = vector_tools::apply(request).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    #[wasm_bindgen]
    pub fn freehand_json(json: &str) -> Result<String, JsValue> {
        freehand::fit_json(json).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn stroke_geometry_json(json: &str) -> Result<String, JsValue> {
        stroke_geometry(json).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn stroke_handles_json(json: &str, index: usize) -> Result<String, JsValue> {
        let n = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let result = stroke::handles(&n, index).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    #[wasm_bindgen]
    pub fn figma_unpremultiply_rgba8(bytes: &mut [u8]) -> Result<(), JsValue> {
        if !bytes.len().is_multiple_of(4) {
            return Err(JsValue::from_str("Invalid RGBA8 buffer"));
        }
        for pixel in bytes.chunks_exact_mut(4) {
            let value = crate::figma_sampling::unpremultiply_rgba8([
                pixel[0], pixel[1], pixel[2], pixel[3],
            ]);
            pixel.copy_from_slice(&value);
        }
        Ok(())
    }
    #[wasm_bindgen]
    pub fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, JsValue> {
        crate::export::encode_rgba(width, height, rgba).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn encode_float_rgba8(values: &[f32]) -> Result<Vec<u8>, JsValue> {
        if values.len() > 8_388_608 * 4
            || !values.len().is_multiple_of(4)
            || values.iter().any(|v| !v.is_finite())
        {
            return Err(JsValue::from_str("Invalid floating sRGB buffer"));
        }
        Ok(values
            .chunks_exact(4)
            .flat_map(|p| blend::Pixel([p[0], p[1], p[2], p[3]]).straight_rgba8())
            .collect())
    }
    #[wasm_bindgen]
    pub fn export_region_plan_json(bounds: &str, scale: f64) -> Result<String, JsValue> {
        let bounds =
            serde_json::from_str(bounds).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let plan = export::region_plan(bounds, scale).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&plan).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    #[wasm_bindgen]
    pub fn quantized_tent_kernel_rgba(radius: f64) -> Result<Vec<u8>, JsValue> {
        let weights = effects::quantized_tent_kernel(radius).map_err(|e| JsValue::from_str(&e))?;
        Ok(weights.into_iter().flat_map(u32::to_le_bytes).collect())
    }
    #[wasm_bindgen]
    pub fn rational_tent_kernel_rgba(radius: f64) -> Result<Vec<u8>, JsValue> {
        crate::rational_filter::RationalKernel::tent(radius)
            .map(|kernel| kernel.encoded())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn rational_large_tent_kernel_rgba(radius: f64) -> Result<Vec<u8>, JsValue> {
        let bytes = crate::rational_filter::RationalKernel::large_tent(radius)
            .map(|kernel| kernel.encoded()).map_err(|e| JsValue::from_str(&e))?;
        if bytes.len() > 65536 { return Err(JsValue::from_str("Large exact filter packet exceeds 64 KiB")); }
        Ok(bytes)
    }
    #[wasm_bindgen]
    pub fn certified_tent_kernel_rgba(radius: f64) -> Result<Vec<u8>, JsValue> {
        crate::rational_filter::RationalKernel::tent(radius)
            .map(|kernel| kernel.certified_encoded())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn certified_tent_prefix_plan(radius:f64,bytes:&[u8])->Result<Vec<u32>,JsValue>{
        if !radius.is_finite()||!(8. ..=512.).contains(&radius){return Ok(Vec::new());}
        let kernel=crate::rational_filter::RationalKernel::tent(radius).map_err(|e|JsValue::from_str(&e))?;
        let interior=radius.floor()as usize-1;
        Ok(kernel.certified_prefix_plan(interior,bytes).map(|bits|vec![bits,interior as u32,kernel.reach()as u32]).unwrap_or_default())
    }
    #[wasm_bindgen]
    pub fn certified_box_kernel_rgba(radius: u32) -> Result<Vec<u8>, JsValue> {
        crate::rational_filter::RationalKernel::uniform_box(radius)
            .map(|kernel| kernel.certified_encoded())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn color_controls_uniforms(value: &str, managed: bool) -> Result<Vec<f32>, JsValue> {
        let controls: crate::color_controls::ColorControls = serde_json::from_str(value).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if !controls.validate() { return Err(JsValue::from_str("Invalid color controls")); }
        Ok(controls.uniforms(managed).to_vec())
    }
    #[wasm_bindgen]
    pub fn color_controls_matrix(value: &str) -> Result<Vec<f32>, JsValue> {
        let controls: crate::color_controls::ColorControls = serde_json::from_str(value).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if !controls.validate() { return Err(JsValue::from_str("Invalid color controls")); }
        Ok(controls.matrix().to_vec())
    }
    #[wasm_bindgen]
    pub fn motion_blur_kernel(radius:f64, angle:f64, matrix:Vec<f64>) -> Result<Vec<f32>, JsValue> {
        let matrix:[f64;6]=matrix.try_into().map_err(|_|JsValue::from_str("Motion blur requires an affine transform"))?;
        crate::spatial_blur::MotionKernel::new(radius,angle,crate::math::Transform(matrix))
            .map(|k|k.encoded()).map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn noise_fill_preset_json()->Result<String,JsValue> {
        crate::noise_fill::preset().and_then(|p|serde_json::to_string(&p).map_err(|e|e.to_string())).map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn zoom_blur_coordinates(value:&str,matrix:Vec<f64>,size:Vec<f64>,rect:&str)->Result<Vec<f32>,JsValue> {
        let p=serde_json::from_str(value).map_err(|e|JsValue::from_str(&format!("Invalid zoom parameters: {e}")))?;
        let matrix:[f64;6]=matrix.try_into().map_err(|_|JsValue::from_str("Invalid zoom transform"))?;
        let size:[f64;2]=size.try_into().map_err(|_|JsValue::from_str("Invalid zoom size"))?;
        let rect=serde_json::from_str(rect).map_err(|e|JsValue::from_str(&format!("Invalid zoom extent: {e}")))?;
        crate::zoom_blur::coordinates(p,crate::math::Transform(matrix),size,rect).map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn gaussian_box_radii(sigma: f64) -> Result<Vec<u32>, JsValue> {
        effects::gaussian_box_radii(sigma)
            .map(|r| r.to_vec())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn gaussian_region_box_radii(sigma: f64) -> Result<Vec<u32>, JsValue> {
        effects::gaussian_box_radii_region(sigma)
            .map(|r| r.to_vec())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn rational_region_box_kernel_rgba(radius:u32)->Result<Vec<u8>,JsValue>{
        crate::rational_filter::RationalKernel::regional_box(radius).map(|kernel|kernel.encoded()).map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn rational_box_kernel_rgba(radius: u32) -> Result<Vec<u8>, JsValue> {
        crate::rational_filter::RationalKernel::uniform_box(radius)
            .map(|k| k.encoded())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn gradient_sampling_grid(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        paint: &str,
        sample: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid gradient transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid gradient node dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid gradient sample index"));
        }
        crate::paint::gradient_sampling_grid(
            rect,
            math::Transform(matrix),
            size,
            &paint,
            (sample < 4).then_some(sample as usize),
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn gradient_sampling_axes(rect:&str,matrix:&[f64],size:&[f64],paint:&str,sample:u32)->Result<Vec<f32>,JsValue>{
        let compute=||->Result<Vec<f32>,String>{
            if sample>4{return Err("Invalid gradient sample index".into());}
            crate::paint::gradient_sampling_axes(serde_json::from_str(rect).map_err(|e|format!("{e}"))?,
                math::Transform(matrix.try_into().map_err(|_|"Invalid gradient transform")?),
                size.try_into().map_err(|_|"Invalid gradient dimensions")?,
                &serde_json::from_str(paint).map_err(|e|format!("{e}"))?,(sample<4).then_some(sample as usize))
        };compute().map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn source_linear_parameters(rect:&str,matrix:&[f64],size:&[f64],paint:&str,sample:u32)->Result<Vec<f32>,JsValue>{
        let compute=||->Result<Vec<f32>,String>{crate::paint::source_linear_parameters(
            serde_json::from_str(rect).map_err(|e|format!("{e}"))?,
            crate::math::Transform(matrix.try_into().map_err(|_|"Invalid gradient transform")?),
            size.try_into().map_err(|_|"Invalid gradient dimensions")?,
            &serde_json::from_str(paint).map_err(|e|format!("{e}"))?,sample as usize)};
        compute().map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn source_linear_phase_parameters(rect: &str, matrix: &[f64], size: &[f64], paint: &str) -> Result<Vec<f32>, JsValue> {
        let compute = || -> Result<Vec<f32>, String> {
            crate::paint::source_linear_phase_parameters(
                serde_json::from_str(rect).map_err(|e| format!("{e}"))?,
                math::Transform(matrix.try_into().map_err(|_| "Invalid gradient transform")?),
                size.try_into().map_err(|_| "Invalid gradient dimensions")?,
                &serde_json::from_str(paint).map_err(|e| format!("{e}"))?,
            )
        };
        compute().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub struct GradientPhaseFieldBuilder { inner:crate::paint::phase_field::Builder }
    #[wasm_bindgen]
    impl GradientPhaseFieldBuilder {
        #[wasm_bindgen(constructor)]
        pub fn new(rect:&str,matrix:&[f64],size:&[f64],paint:&str)->Result<Self,JsValue>{
            let build=||->Result<Self,String>{Ok(Self{inner:crate::paint::phase_field::Builder::new(
                serde_json::from_str(rect).map_err(|e|format!("{e}"))?,
                math::Transform(matrix.try_into().map_err(|_|"Invalid gradient transform")?),
                size.try_into().map_err(|_|"Invalid gradient dimensions")?,
                &serde_json::from_str(paint).map_err(|e|format!("{e}"))?)?})};
            build().map_err(|e|JsValue::from_str(&e))
        }
        pub fn advance(&mut self)->Result<bool,JsValue>{self.inner.advance().map_err(|e|JsValue::from_str(&e))}
        pub fn finish(&mut self)->Result<Vec<u32>,JsValue>{self.inner.finish().map_err(|e|JsValue::from_str(&e))}
    }
    #[wasm_bindgen]
    pub fn gradient_sampling_grid_region(original:&str, region:&str, matrix:&[f64], size:&[f64], paint:&str, sample:u32) -> Result<Vec<f32>,JsValue> {
        let parse=||->Result<Vec<f32>,String>{
            if sample>4{return Err("Invalid gradient sample index".into());}
            crate::paint::gradient_sampling_grid_region(
                serde_json::from_str(original).map_err(|e|format!("{e}"))?,
                serde_json::from_str(region).map_err(|e|format!("{e}"))?,
                math::Transform(matrix.try_into().map_err(|_|"Invalid gradient transform")?),
                size.try_into().map_err(|_|"Invalid gradient node dimensions")?,
                &serde_json::from_str(paint).map_err(|e|format!("{e}"))?, (sample<4).then_some(sample as usize))
        };parse().map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_sampling_grid(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_sampling_grid(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_byte_sampling_grid(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_byte_sampling_grid(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_byte_sampling_field(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_byte_sampling_field(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_mip_level(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
    ) -> Result<u32, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        crate::paint::image_mip_level(rect, math::Transform(matrix), size, image, &paint)
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_sampling_grid_at_level(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
        level: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_sampling_grid_at_level(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
            level,
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_sampling_grid_placed(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
        level: u32,
        origin: &[i32],
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let origin: [i32; 2] = origin
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image atlas origin"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_sampling_grid_placed(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
            level,
            origin,
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_sampling_axes_placed(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
        level: u32,
        origin: &[i32],
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let origin: [i32; 2] = origin
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image atlas origin"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_sampling_axes_placed(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
            level,
            origin,
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_byte_sampling_grid_at_level(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
        level: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_byte_sampling_grid_at_level(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
            level,
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_byte_sampling_field_at_level(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
        level: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_byte_sampling_field_at_level(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
            level,
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn image_byte_sampling_field_placed(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        image: &[u32],
        paint: &str,
        sample: u32,
        level: u32,
        origin: &[i32],
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image transform"))?;
        let size: [f64; 2] = size
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image node dimensions"))?;
        let image: [u32; 2] = image
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image dimensions"))?;
        let origin: [i32; 2] = origin
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid image atlas origin"))?;
        let paint = serde_json::from_str(paint).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        if sample > 4 {
            return Err(JsValue::from_str("Invalid image sample index"));
        }
        crate::paint::image_byte_sampling_field_placed(
            rect,
            math::Transform(matrix),
            size,
            image,
            &paint,
            (sample < 4).then_some(sample as usize),
            level,
            origin,
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn texture_sampling_grid(
        rect: &str,
        matrix: &[f64],
        amount: f64,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Texture matrix requires six values"))?;
        effects::texture_sampling_grid(rect, amount, math::Transform(matrix))
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn glass_material_uniforms(effect: &str, scale: f64) -> Result<Vec<f32>, JsValue> {
        let fx: scene::Effect =
            serde_json::from_str(effect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        fx.validate_material().map_err(|e| JsValue::from_str(&e))?;
        if !scale.is_finite() || scale <= 0. {
            return Err(JsValue::from_str("Invalid glass scale"));
        }
        Ok(crate::material::GlassMaterial::new(&fx, scale)
            .uniforms()
            .to_vec())
    }
    #[wasm_bindgen]
    pub fn figma_gradient_lookup(paint: &str) -> Result<Vec<u8>, JsValue> {
        let paint: scene::Paint =
            serde_json::from_str(paint).map_err(|e| JsValue::from_str(&e.to_string()))?;
        crate::figma_gradient::from_paint(&paint)
            .map(|g| g.lookup_bytes().to_vec())
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn figma_gradient_field(
        rect: &str,
        matrix: &[f64],
        size: &[f64],
        paint: &str,
        sample: usize,
        software: Option<bool>,
    ) -> Result<Vec<f32>, JsValue> {
        let parse = || -> Result<Vec<f32>, String> {
            let rect = serde_json::from_str(rect).map_err(|e| format!("{e}"))?;
            let paint = serde_json::from_str(paint).map_err(|e| format!("{e}"))?;
            let matrix = matrix
                .try_into()
                .map_err(|_| "Gradient matrix requires six values")?;
            let size = size
                .try_into()
                .map_err(|_| "Gradient size requires two values")?;
            crate::figma_gradient::field_with_raster(
                rect,
                math::Transform(matrix),
                size,
                &paint,
                sample,
                software.unwrap_or(false),
            )
        };
        parse().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn glass_capture_tiles(replay: &str, rect: &str, sample: usize) -> Result<String, JsValue> {
        let parse = || -> Result<String, String> {
            let replay: crate::glass_capture::Replay =
                serde_json::from_str(replay).map_err(|e| e.to_string())?;
            let rect: math::Rect = serde_json::from_str(rect).map_err(|e| e.to_string())?;
            replay.validate()?;
            if sample >= 4
                || rect.w > 8192 + 2 * 2048
                || rect.h > 8192 + 2 * 2048
                || u64::from(rect.w) * u64::from(rect.h) > 16_777_216
                || rect.x.abs_diff(0) > 16_777_216
                || rect.y.abs_diff(0) > 16_777_216
            {
                return Err("Invalid capture tile request".into());
            }
            let mut tiles = Vec::new();
            for (origin, region) in replay.tiles(rect) {
                let plan = replay.tile(origin, sample)?;
                let filter = plan.filter_plan()?;
                tiles.push(serde_json::json!({ "region": region, "plan": plan, "filter": filter }));
            }
            serde_json::to_string(&tiles).map_err(|e| e.to_string())
        };
        parse().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn texture_replay_tiles(
        replay: &str,
        viewport: &str,
        sample: usize,
    ) -> Result<String, JsValue> {
        let parse = || -> Result<String, String> {
            let (replay, viewport) = parse_texture_replay(replay, viewport, sample)?;
            let mut tiles = Vec::new();
            for (origin, region) in replay.tiles(viewport)? {
                use crate::texture_replay::TileOutcome;
                let outcome = match replay.tile(origin, sample, viewport)? {
                    TileOutcome::Empty => serde_json::json!({"kind": "empty"}),
                    TileOutcome::Passthrough => serde_json::json!({"kind": "passthrough"}),
                    TileOutcome::Unsupported => serde_json::json!({"kind": "unsupported"}),
                    TileOutcome::Capture(plan) => {
                        serde_json::json!({"kind": "capture", "plan": plan})
                    }
                };
                tiles.push(
                    serde_json::json!({"origin": origin, "region": region, "outcome": outcome}),
                );
            }
            serde_json::to_string(&tiles).map_err(|e| e.to_string())
        };
        parse().map_err(|e| JsValue::from_str(&e))
    }
    fn parse_texture_replay(
        replay: &str,
        viewport: &str,
        sample: usize,
    ) -> Result<(crate::texture_replay::Replay, math::Rect), String> {
        let replay: crate::texture_replay::Replay =
            serde_json::from_str(replay).map_err(|e| e.to_string())?;
        let viewport: math::Rect = serde_json::from_str(viewport).map_err(|e| e.to_string())?;
        replay.validate()?;
        // Match compile_gpu_scene's existing viewport + effect-halo admission.
        // This helper allocates only per-tile fields; it must not reject a
        // legal narrow scene merely because its full parent is wider than 4096.
        if sample >= 4
            || viewport.w > 8192 + 2 * 2048
            || viewport.h > 8192 + 2 * 2048
            || u64::from(viewport.w) * u64::from(viewport.h) > 16_777_216
            || viewport.x.abs_diff(0) > 16_777_216
            || viewport.y.abs_diff(0) > 16_777_216
        {
            return Err("Invalid texture replay request".into());
        }
        Ok((replay, viewport))
    }
    #[wasm_bindgen]
    pub fn texture_replay_field(
        replay: &str,
        viewport: &str,
        origin: &[i32],
        sample: usize,
        kind: u32,
    ) -> Result<Vec<f32>, JsValue> {
        let parse = || -> Result<Vec<f32>, String> {
            let (replay, viewport) = parse_texture_replay(replay, viewport, sample)?;
            let origin = origin
                .try_into()
                .map_err(|_| "Texture origin requires two values")?;
            let crate::texture_replay::TileOutcome::Capture(plan) =
                replay.tile(origin, sample, viewport)?
            else {
                return Err("Texture field requires a capture tile".into());
            };
            let template = crate::texture_replay::parameter_template()?;
            let grid = match kind {
                0 => plan.expanded.sampling_grid(&template)?,
                1 => plan
                    .original
                    .as_ref()
                    .ok_or("Missing original texture source")?
                    .sampling_grid(&template)?,
                2 => plan.effect_sampling_grid(&template)?,
                3 => plan.copyback_sampling_grid(&template)?,
                _ => return Err("Invalid texture field kind".into()),
            };
            Ok(grid.values)
        };
        parse().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn texture_clip_math_atlas() -> Result<Vec<u8>, JsValue> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(1024 * 1024 * 4)
            .map_err(|_| JsValue::from_str("Could not allocate texture clip atlas"))?;
        bytes.extend_from_slice(crate::texture_noise::clip_weight::baseline_root_bytes());
        bytes.extend_from_slice(crate::texture_noise::clip_weight::residual_bytes());
        bytes.resize(1024 * 1024 * 4, 0);
        Ok(bytes)
    }
    #[wasm_bindgen]
    pub fn glass_geometry_field(
        rect: &str,
        matrix: &[f64],
        shape: &str,
        effect: &str,
        sample: i32,
        software: Option<bool>,
        basis: Option<String>,
    ) -> Result<Vec<f32>, JsValue> {
        let parse = || -> Result<Vec<f32>, String> {
            let rect = serde_json::from_str(rect).map_err(|e| format!("{e}"))?;
            let shape = serde_json::from_str(shape).map_err(|e| format!("{e}"))?;
            let matrix: [f64; 6] = matrix
                .try_into()
                .map_err(|_| "Glass matrix requires six values")?;
            let effect: scene::Effect = serde_json::from_str(effect).map_err(|e| format!("{e}"))?;
            effect.validate_material()?;
            let glass = effect.glass.as_ref().ok_or("Missing glass parameters")?;
            if !(-1..=3).contains(&sample) {
                return Err("Invalid glass sample index".into());
            }
            let basis = basis.as_deref().map(serde_json::from_str).transpose().map_err(|e| format!("{e}"))?.unwrap_or(rect);
            crate::optics::field_region_with_raster(
                basis, rect,
                shape,
                math::Transform(matrix),
                glass,
                (sample >= 0).then_some(sample as usize),
                software.unwrap_or(false),
            )
        };
        parse().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub struct GlassFieldProgram(crate::optics::GlassFieldProgram);

    #[wasm_bindgen]
    impl GlassFieldProgram {
        pub fn layout(&self) -> Vec<u32> { self.0.layout() }
        pub fn field(&self) -> Result<Vec<f32>, JsValue> { self.0.field().map_err(|e| JsValue::from_str(&e)) }
    }

    #[wasm_bindgen]
    pub fn glass_field_program(basis: &str, region: &str, matrix: &[f64], shape: &str, effect: &str, sample: i32)
        -> Result<Option<GlassFieldProgram>, JsValue> {
        let parse = || -> Result<Option<GlassFieldProgram>, String> {
            let effect: scene::Effect = serde_json::from_str(effect).map_err(|e| e.to_string())?;
            effect.validate_material()?;
            if !(-1..=3).contains(&sample) { return Err("Invalid glass sample index".into()); }
            Ok(crate::optics::GlassFieldProgram::new(
                serde_json::from_str(basis).map_err(|e| e.to_string())?,
                serde_json::from_str(region).map_err(|e| e.to_string())?,
                serde_json::from_str(shape).map_err(|e| e.to_string())?,
                math::Transform(matrix.try_into().map_err(|_| "Glass matrix requires six values")?),
                effect.glass.ok_or("Missing glass parameters")?, (sample >= 0).then_some(sample as usize),
            )?.map(GlassFieldProgram))
        };
        parse().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn glass_geometry_interior(basis: &str, region: &str, matrix: &[f64], shape: &str, effect: &str, sample: i32) -> Result<String, JsValue> {
        let parse=||->Result<String,String>{
            let basis=serde_json::from_str(basis).map_err(|e|format!("{e}"))?;
            let region=serde_json::from_str(region).map_err(|e|format!("{e}"))?;
            let shape=serde_json::from_str(shape).map_err(|e|format!("{e}"))?;
            let matrix:[f64;6]=matrix.try_into().map_err(|_|"Glass matrix requires six values")?;
            let effect:scene::Effect=serde_json::from_str(effect).map_err(|e|format!("{e}"))?;effect.validate_material()?;
            let glass=effect.glass.as_ref().ok_or("Missing glass parameters")?;
            if !(-1..=3).contains(&sample){return Err("Invalid glass sample index".into());}
            let plan=crate::optics::field_interior(basis,region,shape,math::Transform(matrix),glass,(sample>=0).then_some(sample as usize),false)?;
            serde_json::to_string(&plan).map_err(|e|e.to_string())
        };parse().map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn texture_material_field(
        rect: &str,
        matrix: &[f64],
        effect: &str,
        center_x: f64,
        center_y: f64,
    ) -> Result<Vec<f32>, JsValue> {
        let rect = serde_json::from_str(rect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Texture matrix requires six values"))?;
        let effect: scene::Effect =
            serde_json::from_str(effect).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        effect
            .validate_material()
            .map_err(|e| JsValue::from_str(&e))?;
        let params = effect
            .texture
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Missing texture parameters"))?;
        if !center_x.is_finite() || !center_y.is_finite() {
            return Err(JsValue::from_str("Invalid texture node center"));
        }
        crate::material::texture_field_at(
            rect,
            effect.texture_amount(),
            params,
            math::Transform(matrix),
            [center_x, center_y],
        )
        .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn float16_encode(values: &[f32]) -> Vec<u16> {
        values
            .iter()
            .map(|v| half::f16::from_f32(*v).to_bits())
            .collect()
    }
    #[wasm_bindgen]
    pub fn float16_decode(values: &[u16]) -> Vec<f32> {
        values
            .iter()
            .map(|v| half::f16::from_bits(*v).to_f32())
            .collect()
    }
    fn linear_pixels(values: &[f32]) -> Result<Vec<blend::Pixel>, JsValue> {
        if values.len() > 8_388_608 * 4
            || !values.len().is_multiple_of(4)
            || values.iter().any(|v| !v.is_finite())
        {
            return Err(JsValue::from_str("Invalid float color buffer"));
        }
        Ok(values
            .chunks_exact(4)
            .map(|p| blend::Pixel([p[0], p[1], p[2], p[3]]))
            .collect())
    }
    #[wasm_bindgen]
    pub fn color_encode_rgba8(values: &[f32], settings: &str) -> Result<Vec<u8>, JsValue> {
        let settings: color::ColorSettings =
            serde_json::from_str(settings).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        settings.validate().map_err(|e| JsValue::from_str(&e))?;
        let transform = settings.prepare_output(Default::default());
        Ok(linear_pixels(values)?
            .into_iter()
            .flat_map(|p| {
                transform.apply(p)
                    .map(|v| (v.clamp(0., 1.) * 255.).round_ties_even() as u8)
            })
            .collect())
    }
    #[wasm_bindgen]
    pub fn color_encode_display(
        values: &[f32],
        settings: &str,
        space: &str,
    ) -> Result<Vec<f32>, JsValue> {
        let settings: color::ColorSettings =
            serde_json::from_str(settings).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let space: color::ColorSpace =
            serde_json::from_value(serde_json::Value::String(space.into()))
                .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        settings.validate().map_err(|e| JsValue::from_str(&e))?;
        let output = color::ColorOutput {
            space,
            tone_map: color::ToneMap::None,
        };
        let transform = settings.prepare_output(output);
        Ok(linear_pixels(values)?
            .into_iter()
            .flat_map(|p| {
                let c = transform.apply(p);
                [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
            })
            .collect())
    }
    #[wasm_bindgen]
    pub fn color_encode_png(
        width: u32,
        height: u32,
        values: &[f32],
        settings: &str,
        output: &str,
    ) -> Result<Vec<u8>, JsValue> {
        let settings =
            serde_json::from_str(settings).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let output =
            serde_json::from_str(output).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        export::encode_color_png(width, height, &linear_pixels(values)?, settings, output)
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub struct VectorEngine {
        inner: Engine,
        /// Staged tile bytes from the last `update_tiled_frame` call; the
        /// meta JSON carries offsets into this buffer, and `take_tiled_bytes`
        /// transfers it once per frame.
        staged_tiled_bytes: Vec<u8>,
        component_updates: crate::component_updates::State,
    }
    #[wasm_bindgen]
    pub struct ImageRowDecoder { inner: crate::image_rows::Decoder }
    #[wasm_bindgen]
    impl ImageRowDecoder {
        #[wasm_bindgen(constructor)]
        pub fn new(uri: &str, settings: &str) -> Result<ImageRowDecoder, JsValue> {
            Ok(Self { inner: crate::image_rows::Decoder::from_settings_json(uri, settings).map_err(|e| JsValue::from_str(&e))? })
        }
        pub fn width(&self) -> u32 { self.inner.width() }
        pub fn height(&self) -> u32 { self.inner.height() }
        pub fn next_rows(&mut self) -> Result<Vec<f32>, JsValue> { self.inner.next_rows().map_err(|e| JsValue::from_str(&e)) }
        pub fn window(&mut self,x:u32,y:u32,w:u32,h:u32)->Result<Vec<f32>,JsValue>{self.inner.window(x,y,w,h).map_err(|e|JsValue::from_str(&e))}
        pub fn straight_srgb8(&mut self)->Result<Vec<u8>,JsValue>{self.inner.straight_srgb8().map_err(|e|JsValue::from_str(&e))}
    }
    #[wasm_bindgen]
    pub fn source_jpeg_srgb8(uri:&str)->Result<Vec<u8>,JsValue>{crate::image_rows::source_jpeg_srgb8(uri).map_err(|e|JsValue::from_str(&e))}
    #[wasm_bindgen]
    pub fn straight_srgb8_table()->Result<Vec<u8>,JsValue>{crate::image_rows::straight_srgb8_table().map_err(|e|JsValue::from_str(&e))}
    #[wasm_bindgen]
    pub struct DocumentHistory {
        inner: crate::editing::DocumentEditor,
    }
    #[wasm_bindgen]
    impl DocumentHistory {
        #[wasm_bindgen(constructor)]
        pub fn new(document: &str) -> Result<DocumentHistory, JsValue> {
            let doc =
                serde_json::from_str(document).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let inner = crate::editing::DocumentEditor::new(doc)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            Ok(Self { inner })
        }
        pub fn apply(&mut self, revision: f64, patch: &str) -> Result<String, JsValue> {
            if !revision.is_finite()
                || revision < 0.
                || revision.fract() != 0.
                || revision > 9_007_199_254_740_991.
            {
                return Err(JsValue::from_str("Invalid revision"));
            }
            let patch =
                serde_json::from_str(patch).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let result = self
                .inner
                .apply(revision as u64, patch)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
        }
        pub fn undo(&mut self) -> Result<String, JsValue> {
            let result = self
                .inner
                .undo()
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
        }
        pub fn redo(&mut self) -> Result<String, JsValue> {
            let result = self
                .inner
                .redo()
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            serde_json::to_string(&result).map_err(|e| JsValue::from_str(&format!("{e}")))
        }
    }
    #[wasm_bindgen]
    impl VectorEngine {
        pub fn load_document_fonts(&mut self, resources: &str) -> Result<(), JsValue> {
            let resources =
                serde_json::from_str(resources).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            self.inner.fonts = self
                .inner
                .fonts
                .with_resources(&resources)
                .map_err(|e| JsValue::from_str(&e))?;
            self.component_updates.clear();
            Ok(())
        }
        pub fn text_geometry(
            &self,
            node: &str,
            matrix: &str,
            x: f64,
            y: f64,
            tolerance: f64,
        ) -> Result<String, JsValue> {
            let node: scene::Node =
                serde_json::from_str(node).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let matrix: math::Transform =
                serde_json::from_str(matrix).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let point = math::Point::new(x, y);
            validate_hit_device(point, matrix).map_err(|e| JsValue::from_str(&e))?;
            if !tolerance.is_finite() || !(0. ..=1000.).contains(&tolerance) {
                return Err(JsValue::from_str("Invalid text hit tolerance"));
            }
            let path = self
                .inner
                .fonts
                .node_path_shared(&node)
                .map_err(|e| JsValue::from_str(&e))?;
            let bounds = bounds::path_bounds(&path, matrix);
            let cs = path
                .flatten_for_point(matrix, HIT_DEVICE_ERROR, point)
                .map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&serde_json::json!({"bounds":bounds,"hit":path::winding(point,&cs)!=0||near_contours(point,&cs,tolerance)})).map_err(|e|JsValue::from_str(&format!("{e}")))
        }
        pub fn text_layout(&self, node: &str) -> Result<String, JsValue> {
            let node: scene::Node =
                serde_json::from_str(node).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let layout = self
                .inner
                .fonts
                .node_layout(&node, Some(node.width))
                .map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&layout).map_err(|e| JsValue::from_str(&format!("{e}")))
        }
        /// Caret geometry (node-local space) for one UTF-16 offset; compose
        /// with the node transform for page coordinates.
        pub fn caret_at(&self, node: &str, utf16_offset: usize) -> Result<String, JsValue> {
            let node: scene::Node =
                serde_json::from_str(node).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let caret = self
                .inner
                .fonts
                .caret_at(&node, utf16_offset)
                .map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&caret).map_err(|e| JsValue::from_str(&format!("{e}")))
        }
        /// UTF-16 offset whose caret is nearest to a node-local point.
        pub fn hit_caret(&self, node: &str, x: f64, y: f64) -> Result<usize, JsValue> {
            let node: scene::Node =
                serde_json::from_str(node).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            self.inner
                .fonts
                .hit_caret(&node, x, y)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn svg_paths(&self, node: &str) -> Result<String, JsValue> {
            let node =
                serde_json::from_str(node).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let paths = crate::export::svg_paths(&node, &self.inner.fonts)
                .map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&paths).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: Engine::new(),
                staged_tiled_bytes: Vec::new(),
                component_updates:Default::default(),
            }
        }
        /// Sketch-parity tiled frame update (`updateWithInstruction:`): the
        /// worker derives the render instruction from the frame options plus
        /// optional patch damage, rasterises only missing/dirty tiles and
        /// returns JSON metadata. Tile bytes are staged and transferred once
        /// via `take_tiled_bytes` (offsets in the JSON index it). An
        /// unchanged instruction returns zero tiles — nothing rasterised.
        pub fn update_tiled_frame(
            &mut self,
            options: &str,
            damage: Option<String>,
        ) -> Result<String, JsValue> {
            let parse = || -> Result<String, String> {
                let options = self.inner.parse_options(
                    serde_json::from_str(options).map_err(|e| e.to_string())?,
                )?;
                let damage = damage
                    .map(|json| serde_json::from_str::<Option<Vec<[f64; 4]>>>(&json))
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .flatten();
                let mut frame = self
                    .inner
                    .update_tiled_frame(&options, damage.as_deref())?;
                let meta = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
                self.staged_tiled_bytes = std::mem::take(&mut frame.bytes);
                Ok(meta)
            };
            parse().map_err(|e| JsValue::from_str(&e))
        }
        /// Transfer the staged tile bytes of the last `update_tiled_frame`.
        pub fn take_tiled_bytes(&mut self) -> Vec<u8> {
            std::mem::take(&mut self.staged_tiled_bytes)
        }
        /// Full residency of the composited level — the upload set for a
        /// canvas rebuild after resize or worker revival.
        pub fn tiled_visible_tiles(&mut self, options: &str) -> Result<String, JsValue> {
            let mut parse = || -> Result<String, String> {
                let options = self.inner.parse_options(
                    serde_json::from_str(options).map_err(|e| e.to_string())?,
                )?;
                let mut frame = self.inner.tiled_visible_tiles(&options)?;
                let meta = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
                self.staged_tiled_bytes = std::mem::take(&mut frame.bytes);
                Ok(meta)
            };
            parse().map_err(|e| JsValue::from_str(&e))
        }
        /// One canvas frame assembled inside the engine: the Sketch-parity
        /// update runs (equal instructions rasterise nothing, damage bounds
        /// the dirty tiles) and the visible residency composites straight
        /// into the device viewport. Bucket-snapped zooms assemble with the
        /// byte-exact blit; off-bucket zooms resample the bucket content in
        /// premultiplied space (the drawTiles tier). Pixel previews are
        /// rejected — hosts present those through the ordinary render.
        pub fn assemble_tiled_rgba(
            &mut self,
            options: &str,
            damage: Option<String>,
        ) -> Result<Vec<u8>, JsValue> {
            let parse = || -> Result<Vec<u8>, String> {
                let options = self.inner.parse_options(
                    serde_json::from_str(options).map_err(|e| e.to_string())?,
                )?;
                let damage = damage
                    .map(|json| serde_json::from_str::<Option<Vec<[f64; 4]>>>(&json))
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .flatten();
                Ok(self
                    .inner
                    .render_tiled_frame(&options, damage.as_deref())?
                    .rgba)
            };
            parse().map_err(|e| JsValue::from_str(&e))
        }
        /// The Figma-shape compositing ledger: scene-compositing peak +
        /// tile residency summed,
        /// `>> 20` for MB, f32 tile ratio, OOM-style pressure events from
        /// budget rejections. Diagnostic only — admission stays the
        /// reserve/Drop contract.
        pub fn compositing_ledger(&self) -> String {
            serde_json::to_string(&self.inner.compositing_ledger())
                .unwrap_or_else(|_| "{}".into())
        }
        pub fn gpu_memory_breakdown(&self) -> String {
            serde_json::to_string(&self.inner.gpu_memory_breakdown())
                .unwrap_or_else(|_| "{}".into())
        }
        /// Toggle rendering-side glyph-origin quantisation (the
        /// `allowFontSubpixelQuantization` counterpart): painted glyph
        /// outlines snap to whole local units — device pixels at zoom 1 —
        /// while layout, wrapping and caret geometry stay on the shaped
        /// fractional grid. Default off.
        pub fn set_text_quantization(&mut self, on: bool) {
            self.inner.set_text_quantization(on);
        }
        pub fn load_font(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
            self.inner.load_font(bytes).map_err(|e| JsValue::from_str(&e))?;
            self.component_updates.clear();Ok(())
        }
        pub fn load_document(&mut self, json: &str) -> Result<(), JsValue> {
            self.inner
                .load_document(json)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn apply_document_patch(&mut self, json: &str) -> Result<(), JsValue> {
            capacity::check_document_bytes(json.len()).map_err(|e| JsValue::from_str(&e))?;
            let patch =
                serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            self.inner
                .apply_document_patch(&patch)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn apply_document_patch_with_damage(&mut self, json: &str) -> Result<String, JsValue> {
            capacity::check_document_bytes(json.len()).map_err(|e| JsValue::from_str(&e))?;
            let patch =
                serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let damage = self
                .inner
                .apply_document_patch_with_damage(&patch)
                .map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&damage).map_err(|e| JsValue::from_str(&format!("{e}")))
        }
        pub fn interaction_pose_damage(&self, json: &str) -> Result<String, JsValue> {
            if json.len() > 65536 { return Err(JsValue::from_str("Interaction transforms exceed budget")); }
            let transforms = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("Invalid transforms: {e}")))?;
            let damage = self.inner.interaction_pose_damage(&transforms).map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&damage).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        pub fn apply_interaction_transforms(&mut self, json: &str) -> Result<bool, JsValue> {
            if json.len() > 65536 { return Err(JsValue::from_str("Interaction transforms exceed budget")); }
            let transforms = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("Invalid transforms: {e}")))?;
            self.inner.apply_interaction_transforms(&transforms).map_err(|e| JsValue::from_str(&e))
        }
        pub fn validate_animations(&self, json: &str) -> Result<(), JsValue> {
            let doc: scene::Document =
                serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            animation::validate(&doc).map_err(|e| JsValue::from_str(&e))
        }
        pub fn animation_document(&self, document: &str, request: &str) -> Result<String, JsValue> {
            let doc: scene::Document =
                serde_json::from_str(document).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let request: animation::Sample =
                serde_json::from_str(request).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let (sampled, _) =
                animation::sample(&doc, &request).map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&sampled).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        pub fn render_rgba(&mut self, options: &str) -> Result<Vec<u8>, JsValue> {
            let value =
                serde_json::from_str(options).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let options = self
                .inner
                .parse_options(value)
                .map_err(|e| JsValue::from_str(&e))?;
            self.inner
                .render_exact(&options)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn color_settings(&self) -> String {
            serde_json::to_string(&self.inner.color_settings()).expect("validated color settings")
        }
        pub fn glyph_cache_stats(&self) -> String {
            self.inner.fonts.glyph_cache_stats().to_string()
        }
        pub fn image_info(&mut self, uri: &str) -> Result<String, JsValue> {
            let image = self
                .inner
                .image_data(uri)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(format!("[{},{}]", image.rect.w, image.rect.h))
        }
        pub fn image_linear(&mut self, uri: &str) -> Result<Vec<f32>, JsValue> {
            let image = self
                .inner
                .image_data(uri)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(image.pixels.iter().flat_map(|p| p.0).collect())
        }
        /// Premultiplied source-asset bytes, after the same Rust orientation and
        /// colour decoding used by CPU rendering. This does not render a scene.
        pub fn image_rgba8(&mut self, uri: &str) -> Result<Vec<u8>, JsValue> {
            if self.inner.color_settings().is_some() {
                return Err(JsValue::from_str(
                    "Managed image assets require image_linear",
                ));
            }
            let image = self
                .inner
                .image_data(uri)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(image
                .pixels
                .iter()
                .flat_map(|p| {
                    p.rgba8_quantized()
                        .0
                        .map(|c| (c * 255.).round_ties_even() as u8)
                })
                .collect())
        }
        /// Toggle mip-chain materialization for this engine's asset cache and
        /// the CPU reference sampler inside `render*`.
        pub fn set_image_mips(&mut self, mips: bool) {
            self.inner.set_image_mips(mips);
        }
        pub fn image_mips(&self) -> bool {
            self.inner.image_mips()
        }
        /// Level dimensions of a resident asset without materializing the chain.
        pub fn image_info_at_level(&mut self, uri: &str, level: u32) -> Result<String, JsValue> {
            let base = self
                .inner
                .image_data(uri)
                .map_err(|e| JsValue::from_str(&e))?;
            let level = level.min(crate::image_mipmap::mip_levels([base.rect.w, base.rect.h]) - 1);
            let dims = crate::image_mipmap::level_dimensions([base.rect.w, base.rect.h], level);
            Ok(format!("[{},{}]", dims[0], dims[1]))
        }
        pub fn image_linear_at_level(
            &mut self,
            uri: &str,
            level: u32,
        ) -> Result<Vec<f32>, JsValue> {
            let image = self
                .inner
                .image_at_level(uri, level)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(image.pixels.iter().flat_map(|p| p.0).collect())
        }
        pub fn image_rgba8_at_level(&mut self, uri: &str, level: u32) -> Result<Vec<u8>, JsValue> {
            if self.inner.color_settings().is_some() {
                return Err(JsValue::from_str(
                    "Managed image assets require image_linear",
                ));
            }
            let image = self
                .inner
                .image_at_level(uri, level)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(image
                .pixels
                .iter()
                .flat_map(|p| {
                    p.rgba8_quantized()
                        .0
                        .map(|c| (c * 255.).round_ties_even() as u8)
                })
                .collect())
        }
        pub fn render_linear(&mut self, options: &str) -> Result<Vec<f32>, JsValue> {
            let value =
                serde_json::from_str(options).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let opts = self
                .inner
                .parse_options(value)
                .map_err(|e| JsValue::from_str(&e))?;
            Ok(self
                .inner
                .render_linear(&opts)
                .map_err(|e| JsValue::from_str(&e))?
                .into_iter()
                .flat_map(|p| p.0)
                .collect())
        }
        pub fn render_color_png(
            &mut self,
            options: &str,
            output: &str,
        ) -> Result<Vec<u8>, JsValue> {
            let value =
                serde_json::from_str(options).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let opts = self
                .inner
                .parse_options(value)
                .map_err(|e| JsValue::from_str(&e))?;
            let out =
                serde_json::from_str(output).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            self.inner
                .render_color_png(&opts, out)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn render_png(&mut self, options: &str) -> Result<Vec<u8>, JsValue> {
            let value =
                serde_json::from_str(options).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let options = self
                .inner
                .parse_options(value)
                .map_err(|e| JsValue::from_str(&e))?;
            self.inner
                .render_png(&options)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn render_region_png(&mut self, request: &str) -> Result<Vec<u8>, JsValue> {
            let request =
                serde_json::from_str(request).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            self.inner
                .render_region_png(&request)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn export_pdf_vector(&mut self, options: &str) -> Result<Vec<u8>, JsValue> {
            let value =
                serde_json::from_str(options).map_err(|e| JsValue::from_str(&format!("{e}")))?;
            let options = self
                .inner
                .parse_options(value)
                .map_err(|e| JsValue::from_str(&e))?;
            self.inner
                .export_pdf_vector(&options)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn stats(&self) -> String {
            serde_json::to_string(self.inner.stats()).expect("finite stats")
        }
        pub fn resolve_layout(&self, document: &str) -> Result<String, JsValue> {
            layout::changes(document, &self.inner.fonts).map_err(|e| JsValue::from_str(&e))
        }
        pub fn resolve_components_full(&mut self, document:&str)->Result<String,JsValue>{
            self.component_updates.full(document,&self.inner.fonts).map_err(|e|JsValue::from_str(&e))
        }
        pub fn resolve_components_patch(&mut self, patch:&str, receipt:u32)->Result<String,JsValue>{
            self.component_updates.patch(patch,receipt,&self.inner.fonts).map_err(|e|JsValue::from_str(&e))
        }
        pub fn resolve_components_pose_patch(&mut self, patch:&str, receipt:u32)->Result<Option<String>,JsValue>{
            self.component_updates.try_pose(patch,receipt,&self.inner.fonts).map_err(|e|JsValue::from_str(&e))
        }
        pub fn resolve_components(&self, document: &str) -> Result<String, JsValue> {
            components::changes(document, &self.inner.fonts).map_err(|e| JsValue::from_str(&e))
        }
        pub fn compile_gpu(&mut self, options: &str) -> Result<String, JsValue> {
            let scene = self.inner.compile_gpu_request(options).map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&scene).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        pub fn gpu_compile_cache_stats(&self) -> String { self.inner.gpu_compile_cache_stats().to_string() }
        pub fn fork_static_render_engine(&self) -> Option<VectorEngine> {
            self.inner.snapshot_static_worker().map(|inner| VectorEngine {
                inner, staged_tiled_bytes: Vec::new(), component_updates:Default::default(),
            })
        }
        pub fn bind_frame_scene_scope(&mut self, scope: &str) -> Result<(), JsValue> {
            self.inner.bind_frame_scene_scope(scope).map_err(|e|JsValue::from_str(&e))
        }
        pub fn compile_gpu_packet(&mut self, options: &str) -> Result<Vec<u8>, JsValue> {
            self.inner.compile_gpu_packet_request(options)
                .map_err(|e| JsValue::from_str(&e))
        }
        pub fn compile_gpu_packet_cancellable(&mut self, options: &str, probe: js_sys::Function) -> Result<Vec<u8>, JsValue> {
            crate::render_cancellation::with_probe(move || probe.call0(&JsValue::NULL)
                .ok().and_then(|v|v.as_bool()).unwrap_or(true), || self.inner.compile_gpu_packet_request(options))
                .map_err(|e|JsValue::from_str(&e))
        }
    }
    #[wasm_bindgen]
    pub fn compiled_scene_source_key(json: &str) -> Result<Vec<u8>, JsValue> {
        gpu::scene_plan::source_key_json(json).map_err(|e|JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn compiled_scene_plan_json(json: &str) -> Result<String, JsValue> {
        gpu::scene_plan::from_json(json).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn geometry_json(json: &str) -> Result<String, JsValue> {
        geometry(json).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn font_faces_json(bytes: &[u8]) -> Result<String, JsValue> {
        font::faces_json(bytes).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn hit_test_device_json(
        json: &str,
        matrix: &str,
        x: f64,
        y: f64,
        tolerance: f64,
    ) -> Result<bool, JsValue> {
        let node = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix =
            serde_json::from_str(matrix).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        hit_test_device(&node, math::Point::new(x, y), matrix, tolerance)
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn hit_test_fill_device_json(
        json: &str,
        matrix: &str,
        x: f64,
        y: f64,
    ) -> Result<bool, JsValue> {
        let node = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let matrix =
            serde_json::from_str(matrix).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        hit_test_fill_device(&node, math::Point::new(x, y), matrix)
            .map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn hit_test_json(json: &str, x: f64, y: f64, tolerance: f64) -> Result<bool, JsValue> {
        let node = serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        hit_test(&node, math::Point::new(x, y), tolerance).map_err(|e| JsValue::from_str(&e))
    }
    /// Encode a validated document as the versioned binary format.
    /// The authored JSON value is retained, including ignored fields, explicit
    /// nulls and extension payloads. No GraphApi session is involved.
    #[wasm_bindgen]
    pub fn binfmt_encode(document_json: &str) -> Result<Vec<u8>, JsValue> {
        crate::binfmt::encode_authored_json(document_json).map_err(|e| JsValue::from_str(&e))
    }
    /// Decode binary document bytes back to the authored JSON value. Checksum,
    /// format and document-validation errors surface instead of partial files.
    #[wasm_bindgen]
    pub fn binfmt_decode(bytes: &[u8]) -> Result<String, JsValue> {
        crate::binfmt::decode_authored_json(bytes).map_err(|e| JsValue::from_str(&e))
    }

    /// Handle-based editing surface: nodes, facets, ops, undo and tiles
    /// without per-call JSON shuttling.
    #[wasm_bindgen]
    pub struct GraphApi {
        inner: graph_api::GraphApi,
    }

    #[wasm_bindgen]
    impl GraphApi {
        #[wasm_bindgen(constructor)]
        pub fn new(document_json: &str) -> Result<GraphApi, JsValue> {
            graph_api::GraphApi::new(document_json)
                .map(|inner| GraphApi { inner })
                .map_err(|e| JsValue::from_str(&e.to_string()))
        }

        pub fn document_json(&self) -> String {
            self.inner.document_json()
        }

        pub fn replace_document(&mut self, document_json: &str) -> Result<u32, JsValue> {
            self.inner
                .replace_document(document_json)
                .map(|r| r as u32)
                .map_err(err)
        }

        pub fn replace_document_scoped(&mut self, document_json: &str, scope_json: &str) -> Result<u32, JsValue> {
            let scope = serde_json::from_str(scope_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            self.inner.replace_document_scoped(document_json, scope).map(|r| r as u32).map_err(err)
        }

        pub fn set_edit_scope_strict(&mut self, strict: bool) { self.inner.set_edit_scope_strict(strict); }

        pub fn last_edit_scope_json(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.inner.last_commit_scope()).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        pub fn node_handle(&mut self, id: &str) -> u32 {
            self.inner.node_handle(id)
        }

        pub fn node_exists(&self, handle: u32) -> bool {
            self.inner.node_exists(handle)
        }

        pub fn node_id(&self, handle: u32) -> Result<String, JsValue> {
            self.inner.node_id_string(handle).map_err(err)
        }

        pub fn node_kind(&self, handle: u32) -> Result<String, JsValue> {
            self.inner.node_kind(handle).map_err(err)
        }

        pub fn node_name(&self, handle: u32) -> Result<String, JsValue> {
            self.inner.node_name(handle).map_err(err)
        }

        pub fn node_children(&mut self, handle: u32) -> Result<Vec<u32>, JsValue> {
            self.inner.node_children(handle).map_err(err)
        }

        pub fn node_parent(&mut self, handle: u32) -> Result<u32, JsValue> {
            self.inner.node_parent(handle).map_err(err)
        }

        pub fn find_containing_page(&mut self, handle: u32) -> Result<u32, JsValue> {
            self.inner.find_containing_page(handle).map_err(err)
        }

        pub fn node_transform(&self, handle: u32) -> Result<Vec<f64>, JsValue> {
            Ok(self.inner.node_transform(handle).map_err(err)?.to_vec())
        }

        pub fn node_visible(&self, handle: u32) -> Result<bool, JsValue> {
            self.inner.node_visible(handle).map_err(err)
        }

        pub fn node_opacity(&self, handle: u32) -> Result<f64, JsValue> {
            self.inner.node_opacity(handle).map_err(err)
        }

        pub fn set_name(&mut self, handle: u32, name: &str) -> Result<(), JsValue> {
            self.inner.set_name(handle, name).map_err(err)
        }

        pub fn set_visible(&mut self, handle: u32, visible: bool) -> Result<(), JsValue> {
            self.inner.set_visible(handle, visible).map_err(err)
        }

        pub fn set_opacity(&mut self, handle: u32, opacity: f64) -> Result<(), JsValue> {
            self.inner.set_opacity(handle, opacity).map_err(err)
        }

        pub fn set_transform(
            &mut self,
            handle: u32,
            a: f64,
            b: f64,
            c: f64,
            d: f64,
            tx: f64,
            ty: f64,
        ) -> Result<(), JsValue> {
            self.inner
                .set_transform(handle, [a, b, c, d, tx, ty])
                .map_err(err)
        }

        pub fn resize(&mut self, handle: u32, width: f64, height: f64) -> Result<(), JsValue> {
            self.inner.resize(handle, width, height).map_err(err)
        }

        pub fn apply_scale_transform(&mut self, handle: u32, factor: f64) -> Result<(), JsValue> {
            self.inner
                .apply_scale_transform(handle, factor)
                .map_err(err)
        }

        pub fn apply_scale_transform_scoped(&mut self, handle: u32, factor: f64, scope_json: &str) -> Result<(), JsValue> {
            let scope = serde_json::from_str(scope_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let token = self.inner.open_edit_scope(scope);
            let result = self.inner.apply_scale_transform(handle, factor);
            self.inner.close_edit_scope(token).map_err(err)?;
            result.map_err(err)
        }

        pub fn facet_kinds(&self, handle: u32) -> Result<Vec<String>, JsValue> {
            self.inner.facet_kinds(handle).map_err(err)
        }

        pub fn facet_json(&self, handle: u32, kind: &str) -> Result<Option<String>, JsValue> {
            self.inner.facet_json(handle, kind).map_err(err)
        }

        pub fn facet_capabilities_json(&self, handle: u32) -> Result<String, JsValue> {
            self.inner.facet_capabilities_json(handle).map_err(err)
        }

        pub fn apply_facet_json(
            &mut self,
            handle: u32,
            kind: &str,
            json: &str,
        ) -> Result<(), JsValue> {
            self.inner.apply_facet_json(handle, kind, json).map_err(err)
        }

        pub fn undo(&mut self) -> Result<bool, JsValue> {
            self.inner.undo().map_err(err)
        }

        pub fn redo(&mut self) -> Result<bool, JsValue> {
            self.inner.redo().map_err(err)
        }

        pub fn undo_depth(&self) -> u32 {
            self.inner.undo_depth() as u32
        }

        pub fn redo_depth(&self) -> u32 {
            self.inner.redo_depth() as u32
        }

        pub fn apply_ops_json(&mut self, json: &str) -> Result<(), JsValue> {
            self.inner.apply_ops_json(json).map_err(err)
        }

        pub fn ops_frame(&self, json: &str, revision: u32, lz4: bool) -> Result<Vec<u8>, JsValue> {
            self.inner
                .ops_frame(json, revision as u64, lz4)
                .map_err(err)
        }

        pub fn decode_ops_frame(&self, bytes: &[u8], lz4: bool) -> Result<Vec<String>, JsValue> {
            let (revision, json) = self.inner.decode_ops_frame(bytes, lz4).map_err(err)?;
            Ok(vec![revision.to_string(), json])
        }

        pub fn export_binary(&self) -> Vec<u8> {
            self.inner.export_binary()
        }

        pub fn import_binary(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
            self.inner.import_binary(bytes).map_err(err)
        }

        pub fn import_binary_scoped(&mut self, bytes: &[u8], scope_json: &str) -> Result<(), JsValue> {
            let scope = serde_json::from_str(scope_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let token = self.inner.open_edit_scope(scope);
            let result = self.inner.import_binary(bytes);
            self.inner.close_edit_scope(token).map_err(err)?;
            result.map_err(err)
        }

        pub fn level_for_zoom(zoom: f64) -> i32 {
            graph_api::GraphApi::level_for_zoom(zoom)
        }

        pub fn tile_handle(&mut self, level: i32, x: i32, y: i32) -> u32 {
            self.inner.tile_handle(level, x, y)
        }

        pub fn tile_viewport(&self, handle: u32) -> Result<Vec<i32>, JsValue> {
            let r = self.inner.tile_viewport(handle).map_err(err)?;
            Ok(vec![r.x, r.y, r.w, r.h])
        }

        pub fn tile_scissor_for_clear(&self, handle: u32) -> Result<Vec<i32>, JsValue> {
            let r = self.inner.tile_scissor_for_clear(handle).map_err(err)?;
            Ok(vec![r.x, r.y, r.w, r.h])
        }

        pub fn tile_uv_rect(&self, handle: u32) -> Result<Vec<f64>, JsValue> {
            Ok(self.inner.tile_uv_rect(handle).map_err(err)?.to_vec())
        }

        pub fn tile_needs_color_clear(&self, handle: u32) -> Result<bool, JsValue> {
            self.inner.tile_needs_color_clear(handle).map_err(err)
        }

        pub fn tile_to_node(&self, level: i32, x: i32, y: i32) -> Vec<f64> {
            self.inner.tile_to_node(level, x, y).to_vec()
        }

        pub fn tile_release(&mut self, handle: u32) -> bool {
            self.inner.tile_release(handle)
        }

        pub fn tiles_for_rect(
            &mut self,
            level: i32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            pad: i32,
        ) -> Vec<u32> {
            self.inner.tiles_for_rect(level, x, y, w, h, pad)
        }
    }

    #[wasm_bindgen]
    pub fn raster_tile_addresses_json(
        bounds: &[f64],
        zoom: f64,
        limit: usize,
        phase: &[f64],
    ) -> Result<String, JsValue> {
        let bounds: [f64; 4] = bounds
            .try_into()
            .map_err(|_| JsValue::from_str("Expected four bounds values"))?;
        let phase: [f64; 2] = phase
            .try_into()
            .map_err(|_| JsValue::from_str("Expected two phase values"))?;
        let plan = tile_stack::raster_addresses(bounds, zoom, limit, phase)
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&plan).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// One packed zoom/pan refine decision. Callers pass facts; this does not
    /// parse JSON and does not release a texture a presented frame still samples.
    #[wasm_bindgen]
    pub fn zoom_refine_select(
        flags: u32,
        exact_missing: f64,
        overview_candidates: u32,
        prefetch_missing: u32,
        optional_delay_ms: f64,
        raster_scale: f64,
        shown_count: u32,
        tile_count: u32,
        cold_budget: u32,
        source_nodes: u32,
        source_width: f64,
        source_height: f64,
    ) -> u32 {
        zoom_refine_schedule::select_packed(
            flags,
            exact_missing,
            overview_candidates,
            prefetch_missing,
            optional_delay_ms,
            raster_scale,
            shown_count,
            tile_count,
            cold_budget,
            source_nodes,
            source_width,
            source_height,
        )
    }

    /// Packed preview admission. Bit 4 and bit 5 stay clear: cancellation does
    /// not release a resource the presenter still samples.
    #[wasm_bindgen]
    pub fn zoom_refine_admit(flags: u32) -> u32 {
        zoom_refine_schedule::admit_packed(flags)
    }

    #[wasm_bindgen]
    pub fn import_sketch_json(bytes: &[u8]) -> Result<String, JsValue> {
        let report = interop::import_sketch_report(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Attach local .sketch libraries by symbol/style ID, then admit. Each
    /// library is a Uint8Array. Missing IDs stay blocked; names are not guessed.
    #[wasm_bindgen]
    pub fn import_sketch_with_libraries_json(bytes: &[u8], libraries: Array) -> Result<String, JsValue> {
        if libraries.length() == 0 || libraries.length() > 8 {
            return Err(JsValue::from_str("打开前请附上 1 到 8 个本地 .sketch 库"));
        }
        let mut owned = Vec::with_capacity(libraries.length() as usize);
        for value in libraries.iter() {
            if !value.is_instance_of::<Uint8Array>() {
                return Err(JsValue::from_str("Sketch 库必须是未解码的文件字节"));
            }
            owned.push(Uint8Array::new(&value).to_vec());
        }
        let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
        let report = interop::import_sketch_report_with_libraries(bytes, &refs)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Compatibility export uses the same document admission and codec on both hosts.
    #[wasm_bindgen]
    pub fn export_sketch_json(json: &str) -> Result<Vec<u8>, JsValue> {
        crate::validate_document_json(json).map_err(|e| JsValue::from_str(&e))?;
        let document: scene::Document = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        interop::export_sketch(&document).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn import_pdf_json(bytes: &[u8]) -> Result<String, JsValue> {
        crate::pdf_import::import_pdf(bytes)
            .map(|doc| serde_json::to_string(&doc).expect("validated document"))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn import_pdf_report_json(bytes: &[u8]) -> Result<String, JsValue> {
        let report = crate::pdf_import::import_pdf_report(bytes).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn lod_bucket_scale(scale: f64) -> f64 {
        tile_stack::lod_bucket_scale(scale)
    }

    #[wasm_bindgen]
    pub fn exact_bucket_scale(scale: f64) -> f64 {
        tile_stack::exact_bucket_scale(scale)
    }

    /// Smart-guide snapping for the canvas move gesture. Rectangles arrive as
    /// flat [x,y,w,h] world f64 arrays; `parent` is the immediate container and
    /// `siblings` every other snap target, concatenated 4-by-4. Ruler guides participate
    /// as zero-width/zero-height rectangles. Returns
    /// {"dx":f64,"dy":f64,"guides":[null|{"axis":"x"|"y","position":f64,
    /// "start":f64,"end":f64},…]} and fails closed on malformed input.
    #[wasm_bindgen]
    pub fn smart_guides_snap(
        moving: &[f64],
        parent: Option<Vec<f64>>,
        siblings: &[f64],
        threshold: f64,
    ) -> String {
        let fail_closed = serde_json::json!({"dx": 0., "dy": 0., "guides": [null, null]});
        let Some(moving) = guide_rect(moving) else {
            return fail_closed.to_string();
        };
        let parent = parent.as_deref().and_then(guide_rect);
        let targets: Vec<_> = siblings.chunks(4).filter_map(guide_rect).collect();
        let snap = smart_guides::snap_world(moving, parent, &targets, threshold);
        guide_json(snap)
    }

    fn guide_rect(flat: &[f64]) -> Option<smart_guides::WorldRect> {
            let v: [f64; 4] = flat.try_into().ok()?;
            if !v.iter().all(|n| n.is_finite()) || v[2]<0. || v[3]<0. {
                return None;
            }
            Some(smart_guides::WorldRect{x:v[0],y:v[1],w:v[2],h:v[3]})
    }

    fn guide_json(snap: smart_guides::Snap) -> String {
        let guide = |g: Option<smart_guides::Guide>| match g {
            Some(g) => serde_json::json!({
                "axis": if matches!(g.axis, smart_guides::Axis::X) { "x" } else { "y" },
                "position": g.position,
                "start": g.start,
                "end": g.end,
            }),
            None => serde_json::Value::Null,
        };
        serde_json::json!({
            "dx": snap.dx,
            "dy": snap.dy,
            "guides": [guide(snap.guides[0]), guide(snap.guides[1])],
            "targetSpans": snap.target_spans,
        })
        .to_string()
    }

    #[wasm_bindgen]
    pub struct SmartGuidesIndex { inner: smart_guides::Index }
    #[wasm_bindgen]
    impl SmartGuidesIndex {
        #[wasm_bindgen(constructor)]
        pub fn new(parent: Option<Vec<f64>>, siblings: &[f64]) -> SmartGuidesIndex {
            let parent=parent.as_deref().and_then(guide_rect);
            let targets:Vec<_>=siblings.chunks(4).filter_map(guide_rect).collect();
            Self {inner:smart_guides::Index::new_world(parent,&targets)}
        }
        pub fn snap(&self,moving:&[f64],threshold:f64)->String {
            guide_json(guide_rect(moving).map(|r|self.inner.snap(r,threshold)).unwrap_or_default())
        }
    }

    #[wasm_bindgen]
    pub struct ShortcutApi {
        inner: shortcuts::ShortcutTable,
    }
    #[wasm_bindgen]
    impl ShortcutApi {
        #[wasm_bindgen(constructor)]
        pub fn new(json: &str) -> Result<ShortcutApi, JsValue> {
            Ok(Self {
                inner: shortcuts::ShortcutTable::parse(json)
                    .map_err(|e| JsValue::from_str(&e.to_string()))?,
            })
        }
        pub fn actions(&self, combo: &str, os: &str) -> Vec<String> {
            self.inner.actions_for_combo(combo, os)
        }
        pub fn display(&self, action: &str, os: &str, layout: Option<String>) -> Option<String> {
            self.inner.display(action, os, layout.as_deref())
        }
    }

    #[wasm_bindgen]
    pub fn inferred_layout_json(document_json: &str, frame_id: &str) -> Result<String, JsValue> {
        let doc: scene::Document =
            serde_json::from_str(document_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_json::to_string(&animation_plan_wrap(&doc, frame_id))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    fn animation_plan_wrap(
        doc: &scene::Document,
        frame_id: &str,
    ) -> inferred_layout::InferredLayout {
        inferred_layout::infer(doc, frame_id)
    }

    /// Layout-grid track packing: row/column sizes -> axis payload and lit
    /// spans (the shader's section predicate, evaluated on the CPU side).
    #[wasm_bindgen]
    pub fn layout_grid_frame_json(document: &str, frame: &str) -> Result<String, JsValue> {
        let doc: scene::Document =
            serde_json::from_str(document).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let (cols, rows) = layout::grid_tracks(&doc, frame).map_err(|e| JsValue::from_str(&e))?;
        let l = doc.nodes[frame].layout.as_ref().unwrap();
        let pack = |sizes: Vec<f64>, gap: f64| {
            let mut tracks = Vec::new();
            for (i, size) in sizes.into_iter().enumerate() {
                if i > 0 {
                    tracks.push(gap);
                }
                tracks.push(size);
            }
            layout_grid::tracks_to_spans(&tracks).1
        };
        serde_json::to_string(&serde_json::json!({ "cols": pack(cols, l.gap), "rows": pack(rows, l.line_gap), "padding": l.padding }))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen]
    pub fn layout_grid_tracks_json(tracks_json: &str) -> Result<String, JsValue> {
        let tracks: Vec<f64> =
            serde_json::from_str(tracks_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let (axis, spans) = layout_grid::tracks_to_spans(&tracks);
        serde_json::to_string(&(axis, spans)).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Uniform pack for the one-pass GPU gradient-blur composite (shared
    /// WGSL mode 46): affine strength-field coefficients derived in f64,
    /// followed by the counts and the smooth-tier flag.
    /// `[a, b, c, smooth, startCount, endCount]`.
    #[wasm_bindgen]
    pub fn gradient_blur_composite_uniforms(
        rect_json: &str,
        matrix: &[f64],
        params_json: &str,
    ) -> Result<Vec<f32>, JsValue> {
        let r: math::Rect =
            serde_json::from_str(rect_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid gradient matrix"))?;
        let params: scene::GradientBlurParameters =
            serde_json::from_str(params_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let effect: scene::Effect = serde_json::from_value(
            serde_json::json!({"kind":"blur","color":"#000000","gradientBlur":params}),
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        effect
            .validate_material()
            .map_err(|e| JsValue::from_str(&e))?;
        let inverse = math::Transform(matrix)
            .inverse_composed(r)
            .map_err(|e| JsValue::from_str(&e))?;
        let field = gradient_blur::CompositeField::new(&inverse, &params);
        Ok(vec![
            field.a,
            field.b,
            field.c,
            f32::from(field.smooth),
            field.start_count,
            field.end_count,
        ])
    }

    /// Gradient-blur single-pixel evaluation: strength + blend weights +
    /// composite of blurred/sharp samples at one point.
    #[wasm_bindgen]
    pub fn gradient_blur_composite_rgba(
        rect_json: &str,
        matrix: &[f64],
        params_json: &str,
        sharp: &[f32],
        blurred: &[f32],
        byte_surface: bool,
    ) -> Result<Vec<f32>, JsValue> {
        let r: math::Rect =
            serde_json::from_str(rect_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let matrix: [f64; 6] = matrix
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid gradient matrix"))?;
        let params: scene::GradientBlurParameters =
            serde_json::from_str(params_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let effect: scene::Effect = serde_json::from_value(
            serde_json::json!({"kind":"blur","color":"#000000","gradientBlur":params}),
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        effect
            .validate_material()
            .map_err(|e| JsValue::from_str(&e))?;
        if r.w as u64 * r.h as u64 > 8_388_608
            || sharp.len() != r.w as usize * r.h as usize * 4
            || blurred.len() != sharp.len()
            || sharp.iter().chain(blurred).any(|v| !v.is_finite())
        {
            return Err(JsValue::from_str("Invalid gradient surfaces"));
        }
        let mut a = blend::Surface::new(r).map_err(|e| JsValue::from_str(&e))?;
        let mut b = blend::Surface::new(r).map_err(|e| JsValue::from_str(&e))?;
        for (p, v) in a.pixels.iter_mut().zip(sharp.chunks_exact(4)) {
            p.0.copy_from_slice(v);
        }
        for (p, v) in b.pixels.iter_mut().zip(blurred.chunks_exact(4)) {
            p.0.copy_from_slice(v);
        }
        let inverse = math::Transform(matrix)
            .inverse_composed(r)
            .map_err(|e| JsValue::from_str(&e))?;
        effects::gradient_blur_composite(&mut a, &b, &inverse, &params);
        if byte_surface {
            a.quantize_rgba8();
        }
        Ok(a.pixels.into_iter().flat_map(|p| p.0).collect())
    }

    #[wasm_bindgen]
    pub fn gradient_blur_sample(
        x: f64,
        y: f64,
        sx: f64,
        sy: f64,
        ex: f64,
        ey: f64,
        start_count: f64,
        end_count: f64,
        smooth: bool,
        blurred: &[f64],
        sharp: &[f64],
    ) -> Vec<f64> {
        let g = gradient_blur::GradientBlur {
            start: [sx, sy],
            end: [ex, ey],
            start_count,
            end_count,
            tier: if smooth {
                gradient_blur::Tier::Smooth
            } else {
                gradient_blur::Tier::Tight
            },
        };
        let b = g.intensity(x, y);
        let (wb, ws) = g.weights(b);
        let sample = |v: &[f64]| {
            [
                v.first().copied().unwrap_or(0.),
                v.get(1).copied().unwrap_or(0.),
                v.get(2).copied().unwrap_or(0.),
                v.get(3).copied().unwrap_or(0.),
            ]
        };
        let out = g.composite(sample(blurred), sample(sharp), b);
        vec![g.t_at(x, y), b, wb, ws, out[0], out[1], out[2], out[3]]
    }

    #[wasm_bindgen]
    pub fn animation_plan_sample_json(
        document: &str,
        from: &str,
        to: &str,
        progress: f64,
    ) -> Result<String, JsValue> {
        let doc: scene::Document =
            serde_json::from_str(document).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let sampled = animation_plan::PlanTree::sample_document(&doc, from, to, progress)
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&sampled).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Animation plan between two scene snapshots (prototype transition):
    /// matched tweens, dissolve sides, magic-move pairs, frame delta.
    #[wasm_bindgen]
    pub fn animation_plan_json(
        old_json: &str,
        new_json: &str,
        old_root: &str,
        new_root: &str,
    ) -> Result<String, JsValue> {
        let old_doc: scene::Document =
            serde_json::from_str(old_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let new_doc: scene::Document =
            serde_json::from_str(new_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let tree = animation_plan::PlanTree::build(&old_doc, &new_doc, old_root, new_root);
        let magic: Vec<(String, [f64; 6], [f64; 6])> = tree
            .get_magic_move_plan()
            .into_iter()
            .map(|(n, a, b)| (n.scene_node_id.clone().unwrap_or_default(), a, b))
            .collect();
        let dissolve_start: Vec<String> = tree
            .for_dissolve_start()
            .iter()
            .map(|n| n.scene_node_id.clone().unwrap_or_default())
            .collect();
        let dissolve_end: Vec<String> = tree
            .for_dissolve_end()
            .iter()
            .map(|n| n.scene_node_id.clone().unwrap_or_default())
            .collect();
        serde_json::to_string(&serde_json::json!({
            "framePairDragTranslationDelta": tree.frame_pair_drag_translation_delta,
            "magicMove": magic,
            "dissolveStart": dissolve_start,
            "dissolveEnd": dissolve_end,
        }))
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Stateful Smart-Animate bake session: the wasm entry to the bake
    /// track's cache + in-flight mutex (`SaBakeContext`, native-only until
    /// now). One `bake` per transition, then any number of `sample_json`
    /// ticks served from the held plan without a rebuild — the loop the
    /// stateless `animation_plan_sample_json` cannot express. `.free()` (or
    /// GC finalization) drops the session, releasing the in-flight pair.
    ///
    /// All sessions share one global context — the engine's in-flight list is
    /// likewise instance-global — so replays hit the plan cache across
    /// sessions and overlapping live pairs conflict across preview surfaces.
    /// Wasm is single-threaded; the `Arc<Mutex<_>>` internals stay sound.
    #[wasm_bindgen]
    pub struct AnimationBakeSession {
        inner: animation_bake::SaBakeSession,
    }

    thread_local! {
        static SHARED_BAKE_CONTEXT: animation_bake::SaBakeContext =
            animation_bake::SaBakeContext::new();
    }

    fn bake_conflict_error(conflict: animation_bake::BakeConflict) -> JsValue {
        let error = js_sys::Error::new(conflict.message);
        let set = |key: &str, value: JsValue| {
            let _ = js_sys::Reflect::set(&error, &JsValue::from_str(key), &value);
        };
        let frame_ref = |r: &animation_bake::SaFrameRef| {
            let entry = js_sys::Object::new();
            let _ = js_sys::Reflect::set(
                &entry,
                &JsValue::from_str("frameId"),
                &JsValue::from_str(&r.frame_id),
            );
            let _ = js_sys::Reflect::set(
                &entry,
                &JsValue::from_str("generation"),
                &JsValue::from_f64(r.generation as f64),
            );
            entry
        };
        let pair = |p: &(animation_bake::SaFrameRef, animation_bake::SaFrameRef)| {
            let entry = js_sys::Array::new();
            entry.push(&frame_ref(&p.0));
            entry.push(&frame_ref(&p.1));
            entry
        };
        set("kind", JsValue::from_f64(conflict.kind as f64));
        set("tag", JsValue::from_str(conflict.tag));
        set(
            "source",
            JsValue::from_str(&format!("{}:{}", conflict.source_file, conflict.line)),
        );
        set("requested", pair(&conflict.requested).into());
        set("inFlight", pair(&conflict.in_flight).into());
        error.into()
    }

    #[wasm_bindgen]
    impl AnimationBakeSession {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: SHARED_BAKE_CONTEXT
                    .with(|context| animation_bake::SaBakeSession::with_context(context.clone())),
            }
        }

        /// Bake the transition `(old_root, revision) -> (new_root, revision)`
        /// once per playback. Replaces any previous bake (dropping its guard
        /// releases the old pair). `revision` is the document revision — the
        /// cache's version triple — validated like `DocumentHistory.apply`.
        pub fn bake(
            &mut self,
            old_json: &str,
            new_json: &str,
            old_root: &str,
            new_root: &str,
            revision: f64,
        ) -> Result<(), JsValue> {
            if !revision.is_finite()
                || revision < 0.
                || revision.fract() != 0.
                || revision > 9_007_199_254_740_991.
            {
                return Err(JsValue::from_str("Invalid revision"));
            }
            let old_doc: scene::Document =
                serde_json::from_str(old_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            let new_doc: scene::Document =
                serde_json::from_str(new_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
            self.inner
                .bake(&old_doc, &new_doc, old_root, new_root, revision as u64)
                .map_err(bake_conflict_error)
        }

        /// Per-frame sample of the held plan; same JSON shape as
        /// `animation_plan_sample_json` so callers swap transparently.
        pub fn sample_json(&self, progress: f64) -> Result<String, JsValue> {
            let sampled = self
                .inner
                .sample(progress)
                .map_err(|e| JsValue::from_str(&e))?;
            serde_json::to_string(&sampled).map_err(|e| JsValue::from_str(&e.to_string()))
        }

        /// Bake-cache telemetry (`{hits, lookups, misses}`) — the wiring's
        /// observability hook.
        pub fn stats_json(&self) -> String {
            serde_json::to_string(&self.inner.stats()).unwrap_or_else(|_| "{}".into())
        }
    }

    fn err(error: graph_api::Error) -> JsValue {
        JsValue::from_str(&error.to_string())
    }
}

#[cfg(target_arch = "wasm32")]
mod portable_wasm {
    use super::*;
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    pub fn transcode_export_png(png: &[u8], format: &str, scale: f64) -> Result<Vec<u8>, JsValue> {
        export_formats::transcode(png, format, scale).map_err(|e| JsValue::from_str(&e))
    }
    /// Portable Forma files retain authored JSON, including extension fields.
    #[wasm_bindgen]
    pub fn forma_encode_json(json: &str) -> Result<Vec<u8>, JsValue> {
        binfmt::encode_authored_json(json).map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen]
    pub fn forma_decode_json(bytes: &[u8]) -> Result<String, JsValue> {
        binfmt::decode_authored_json(bytes).map_err(|e| JsValue::from_str(&e))
    }
}
