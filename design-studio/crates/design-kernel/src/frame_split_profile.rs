//! Production-entry split of one pan / zoom / pose frame.
//!
//! Times the Rust functions the WASM boundary calls. GPU command encoding,
//! queue submit and presentation stay in the TypeScript WebGPU driver and are
//! not timed here. Pointer integration is timed by the frontend script that
//! imports `canvas-camera.ts`.
use crate::{
    blend::Pixel,
    hit_test_device,
    math::{Point, Transform},
    scene::Node,
    Engine, RenderOptions,
};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, hint::black_box, time::Instant};

#[derive(Clone, Copy)]
pub struct MeasureConfig {
    pub nodes: usize,
    pub width: u32,
    pub height: u32,
    pub samples: usize,
    pub warmup: usize,
    pub pan_steps: usize,
}

impl Default for MeasureConfig {
    fn default() -> Self {
        Self {
            nodes: 300,
            width: 256,
            height: 256,
            samples: 7,
            warmup: 3,
            pan_steps: 8,
        }
    }
}

struct Series {
    samples_ms: Vec<f64>,
}

impl Series {
    fn once<T>(body: impl FnOnce() -> T) -> (f64, T) {
        let started = Instant::now();
        let value = body();
        (started.elapsed().as_secs_f64() * 1e3, value)
    }

    fn collect(warmup: usize, samples: usize, mut body: impl FnMut()) -> Self {
        for _ in 0..warmup {
            body();
        }
        let mut samples_ms = Vec::with_capacity(samples);
        for _ in 0..samples {
            let started = Instant::now();
            body();
            samples_ms.push(started.elapsed().as_secs_f64() * 1e3);
        }
        Self { samples_ms }
    }

    fn json(&self) -> Value {
        let mut ordered = self.samples_ms.clone();
        ordered.sort_by(f64::total_cmp);
        let n = ordered.len();
        json!({
            "samples": self.samples_ms,
            "p50Ms": ordered[n / 2],
            "p95Ms": ordered[((n.saturating_mul(95)) / 100).min(n - 1)],
        })
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hash_programs(scene: &crate::gpu::GpuScene) -> String {
    let mut hasher = Sha256::new();
    for value in scene.vertices.iter().chain(scene.curves.iter()) {
        hasher.update(value.to_bits().to_le_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hash_placement(scene: &crate::gpu::GpuScene) -> String {
    let mut hasher = Sha256::new();
    for (id, node) in &scene.nodes {
        hasher.update(id.as_bytes());
        for value in node.matrix.0.into_iter().chain(node.inverse.0) {
            hasher.update(value.to_bits().to_le_bytes());
        }
        for value in [node.rect.x, node.rect.y] {
            hasher.update(value.to_le_bytes());
        }
        for value in [node.rect.w, node.rect.h] {
            hasher.update(value.to_le_bytes());
        }
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn document(count: usize, image: Option<&str>) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for index in 0..count {
        let id = format!("n{index:04}");
        children.push(id.clone());
        nodes.insert(id.clone(), json!({
            "id": id,
            "kind": "rectangle",
            "name": format!("Layer {index}"),
            "width": 10.0,
            "height": 8.0,
            "transform": [1, 0, 0, 1, (index % 20) as f64 * 12.0, (index / 20) as f64 * 10.0],
            "fills": [{"kind": "solid", "color": "#527acc", "opacity": 1, "visible": true}],
            "strokes": [{"width": 0.5, "paint": {"kind": "solid", "color": "#203040", "opacity": 1, "visible": true}}],
        }));
    }
    if let Some(image) = image {
        children.push("image-0".into());
        nodes.insert("image-0".into(), json!({
            "id": "image-0",
            "kind": "rectangle",
            "name": "Image",
            "width": 32.0,
            "height": 32.0,
            "transform": [1, 0, 0, 1, 4, 4],
            "fills": [{"kind": "image", "color": "#000000", "image": image, "fit": "stretch", "opacity": 1, "visible": true}],
        }));
    }
    json!({
        "schemaVersion": 1,
        "id": "frame-split",
        "name": "Frame split",
        "pages": [{"id": "page", "name": "Page", "background": "#ffffff", "children": children}],
        "nodes": nodes,
    })
}

fn png_uri(width: u32, height: u32) -> String {
    let mut image = image::RgbaImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x * 13 + y * 7) as u8, 40, 180, 255]);
    }
    let mut output = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, image::ImageFormat::Png)
        .expect("png");
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
    )
}

fn options_json(width: u32, height: u32, x: f64, y: f64, zoom: f64) -> String {
    json!({
        "pageId": "page",
        "width": width,
        "height": height,
        "view": {"x": x, "y": y, "zoom": zoom},
        "grid": false,
        "transparent": true,
        "rasterProfile": "analytic",
    })
    .to_string()
}

fn load(document: &Value) -> Result<Engine, String> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string())?;
    Ok(engine)
}

fn parsed_options(engine: &Engine, raw: &str) -> Result<RenderOptions, String> {
    engine.parse_options(serde_json::from_str(raw).map_err(|error| error.to_string())?)
}

fn packet_parts(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < 24 || &bytes[0..4] != b"FGSC" {
        return Err("packet is not FGSC".into());
    }
    let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    let metadata = word(8);
    let vertices = word(12);
    let curves = word(16);
    let resources = word(20);
    let start = (24 + metadata).div_ceil(4) * 4;
    if start + (vertices + curves) * 4 + resources != bytes.len() {
        return Err(format!(
            "packet length {} does not match header",
            bytes.len()
        ));
    }
    Ok(json!({
        "bytes": bytes.len(),
        "metadataBytes": metadata,
        "vertexFloats": vertices,
        "curveFloats": curves,
        "geometryBytes": (vertices + curves) * 4,
        "resourceBytes": resources,
        "sha256": sha256(bytes),
    }))
}

fn device_matrix(node: &Transform, point: Point, zoom: f64) -> Transform {
    Transform([
        node.0[0] * zoom,
        node.0[1] * zoom,
        node.0[2] * zoom,
        node.0[3] * zoom,
        (node.0[4] - point.x) * zoom,
        (node.0[5] - point.y) * zoom,
    ])
}

fn differing_bytes(left: &[u8], right: &[u8]) -> usize {
    left.iter().zip(right).filter(|(a, b)| a != b).count() + left.len().abs_diff(right.len())
}

pub struct SplitCheck {
    pub same_camera_packets_equal: bool,
    pub pan_packet_differs: bool,
    pub pan_vertices_differ: bool,
    pub pan_placement_differs: bool,
    pub zoom_vertices_differ: bool,
    pub zoom_placement_differs: bool,
    pub pan_view_moved: bool,
    pub pan_cpu_pixels_differ: usize,
    pub pose_accepted: bool,
    pub pose_packet_differs: bool,
    pub pose_json_bytes: usize,
    pub hit_agrees: bool,
    pub image_floats: usize,
    pub image_width: u32,
    pub image_height: u32,
    pub packet_bytes: usize,
    pub scoped_repeat_identical: bool,
}

/// One deterministic pass through the production entries. No timing threshold.
pub fn verify(nodes: usize, side: u32) -> Result<SplitCheck, String> {
    let image = png_uri(4, 4);
    let document = document(nodes, Some(&image));
    let mut engine = load(&document)?;
    let base_raw = options_json(side, side, 0., 0., 1.);
    let base = parsed_options(&engine, &base_raw)?;
    let first = engine.compile_gpu(&base)?;
    let first_vertices = hash_programs(&first);
    let first_placement = hash_placement(&first);
    let first_packet = first.into_packet()?;
    let second = engine.compile_gpu(&base)?.into_packet()?;
    let pan_raw = options_json(side, side, 0.5, 0., 1.);
    let pan_options = parsed_options(&engine, &pan_raw)?;
    let panned = engine.compile_gpu(&pan_options)?;
    let pan_vertices = hash_programs(&panned);
    let pan_placement = hash_placement(&panned);
    let pan_view = panned.view.x;
    let pan_packet = panned.into_packet()?;
    let zoom_options = parsed_options(&engine, &options_json(side, side, 0., 0., 2.))?;
    let zoomed = engine.compile_gpu(&zoom_options)?;
    let zoom_vertices = hash_programs(&zoomed);
    let zoom_placement = hash_placement(&zoomed);

    let mut pixels = load(&document)?;
    let origin = pixels.render_device_rect(&base, 0, 0, side, side)?;
    let shifted = pixels.render_device_rect(&pan_options, 0, 0, side, side)?;

    let pose_json = serde_json::to_string(&BTreeMap::from([(
        "n0000".to_owned(),
        Transform([1., 0., 0., 1., 3.5, 1.25]),
    )]))
    .map_err(|error| error.to_string())?;
    let transforms: BTreeMap<String, Transform> =
        serde_json::from_str(&pose_json).map_err(|error| error.to_string())?;
    let mut posed = load(&document)?;
    let pose_base = parsed_options(&posed, &base_raw)?;
    posed.compile_gpu(&pose_base)?;
    let accepted = posed.apply_interaction_transforms(&transforms)?;
    let before = load(&document)?.compile_gpu_packet_request(&base_raw)?;
    let after = posed.compile_gpu_packet_request(&base_raw)?;

    let node: Node = serde_json::from_value(document["nodes"]["n0000"].clone())
        .map_err(|error| error.to_string())?;
    let point = Point::new(4., 3.);
    let matrix = device_matrix(&node.transform, point, 1.);
    let direct = hit_test_device(&node, Point::new(0., 0.), matrix, 5.)?;
    let parsed: Node =
        serde_json::from_str(&serde_json::to_string(&node).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let parsed_matrix: Transform =
        serde_json::from_str(&serde_json::to_string(&matrix.0).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let crossed = hit_test_device(&parsed, Point::new(0., 0.), parsed_matrix, 5.)?;

    let mut images = Engine::new();
    let decoded = images.image_data(&image)?;
    let floats: Vec<f32> = decoded.pixels.iter().flat_map(|pixel| pixel.0).collect();
    let mut scoped = load(&document)?;
    scoped.bind_frame_scene_scope("frame-split-check")?;
    let scoped_first = scoped.compile_gpu_packet_request(&base_raw)?;
    let scoped_second = scoped.compile_gpu_packet_request(&base_raw)?;

    Ok(SplitCheck {
        same_camera_packets_equal: first_packet == second,
        pan_packet_differs: first_packet != pan_packet,
        pan_vertices_differ: first_vertices != pan_vertices,
        pan_placement_differs: first_placement != pan_placement,
        zoom_vertices_differ: first_vertices != zoom_vertices,
        zoom_placement_differs: first_placement != zoom_placement,
        pan_view_moved: pan_view.to_bits() != 0_f64.to_bits(),
        pan_cpu_pixels_differ: differing_bytes(&origin, &shifted),
        pose_accepted: accepted,
        pose_packet_differs: before != after,
        pose_json_bytes: pose_json.len(),
        hit_agrees: direct && crossed,
        image_floats: floats.len(),
        image_width: decoded.rect.w,
        image_height: decoded.rect.h,
        packet_bytes: first_packet.len(),
        scoped_repeat_identical: scoped_first == scoped_second && !scoped_first.is_empty(),
    })
}

fn stage(series: Series) -> Value {
    series.json()
}

pub fn sample_packet(nodes: usize, side: u32) -> Result<Vec<u8>, String> {
    let document = document(nodes, None);
    let mut engine = load(&document)?;
    let raw = options_json(side, side, 0., 0., 1.);
    engine.compile_gpu_packet_request(&raw)
}

pub fn measure(config: MeasureConfig) -> Result<Value, String> {
    if config.nodes < 2
        || config.samples < 1
        || config.width < 16
        || config.height < 16
        || config.pan_steps < 1
    {
        return Err("invalid frame-split measurement config".into());
    }
    let image = png_uri(32, 32);
    let document = document(config.nodes, Some(&image));
    let document_json = document.to_string();
    let base_raw = options_json(config.width, config.height, 0., 0., 1.);
    let mut engine = load(&document)?;
    let (parse_cold_ms, parsed) = Series::once(|| parsed_options(&engine, &base_raw).unwrap());
    let parse = Series::collect(config.warmup, config.samples, || {
        black_box(parsed_options(&engine, &base_raw).unwrap());
    });
    let (compile_cold_ms, cold_scene) = Series::once(|| engine.compile_gpu(&parsed).unwrap());
    let cold_vertex_hash = hash_programs(&cold_scene);
    let cold_placement = hash_placement(&cold_scene);
    let cold_vertices = cold_scene.vertices.len();
    let (packet_cold_ms, cold_packet) = Series::once(|| cold_scene.into_packet().unwrap());
    let cold_parts = packet_parts(&cold_packet)?;
    let compile_warm = Series::collect(config.warmup, config.samples, || {
        black_box(engine.compile_gpu(&parsed).unwrap());
    });
    let packet_warm = Series::collect(config.warmup, config.samples, || {
        black_box(engine.compile_gpu(&parsed).unwrap().into_packet().unwrap());
    });
    let production_packet = Series::collect(config.warmup, config.samples, || {
        black_box(engine.compile_gpu_packet_request(&base_raw).unwrap());
    });
    let mut scoped = load(&document)?;
    scoped.bind_frame_scene_scope("frame-split")?;
    let (scoped_cold_ms, scoped_first) =
        Series::once(|| scoped.compile_gpu_packet_request(&base_raw).unwrap());
    let scoped_repeat = Series::collect(config.warmup, config.samples, || {
        black_box(scoped.compile_gpu_packet_request(&base_raw).unwrap());
    });
    let scoped_repeat_bytes = scoped.compile_gpu_packet_request(&base_raw)?.len();
    let warm_stats = engine.gpu_compile_cache_stats();

    let mut pan_steps = Vec::new();
    let mut previous_vertices = cold_vertex_hash.clone();
    let mut previous_placement = cold_placement;
    for step in 1..=config.pan_steps {
        let raw = options_json(config.width, config.height, step as f64 * 4., 0., 1.);
        let options = parsed_options(&engine, &raw)?;
        let (compile_ms, scene) = Series::once(|| engine.compile_gpu(&options).unwrap());
        let vertex_hash = hash_programs(&scene);
        let placement = hash_placement(&scene);
        let programs_changed = vertex_hash != previous_vertices;
        let placement_changed = placement != previous_placement;
        previous_vertices = vertex_hash;
        previous_placement = placement;
        let curve_floats = scene.curves.len();
        let vertex_floats = scene.vertices.len();
        let (encode_ms, packet) = Series::once(|| scene.into_packet().unwrap());
        pan_steps.push(json!({
            "dx": step as f64 * 4.,
            "compileMs": compile_ms,
            "packetEncodeMs": encode_ms,
            "packetBytes": packet.len(),
            "programsChanged": programs_changed,
            "vertexFloats": vertex_floats,
            "curveFloats": curve_floats,
            "placementChanged": placement_changed,
        }));
    }
    let repeated_pan = options_json(
        config.width,
        config.height,
        config.pan_steps as f64 * 4.,
        0.,
        1.,
    );
    let repeated_options = parsed_options(&engine, &repeated_pan)?;
    let pan_repeat = Series::collect(config.warmup, config.samples, || {
        black_box(
            engine
                .compile_gpu(&repeated_options)
                .unwrap()
                .into_packet()
                .unwrap(),
        );
    });
    let pan_stats = engine.gpu_compile_cache_stats();

    let mut zoom_rows = Vec::new();
    for zoom in [2.0_f64, 0.5] {
        let mut zoom_engine = load(&document)?;
        let raw = options_json(config.width, config.height, 0., 0., zoom);
        let options = parsed_options(&zoom_engine, &raw)?;
        let (cold_ms, scene) = Series::once(|| zoom_engine.compile_gpu(&options).unwrap());
        let vertex_hash = hash_programs(&scene);
        let placement = hash_placement(&scene);
        let (encode_ms, packet) = Series::once(|| scene.into_packet().unwrap());
        let warm = Series::collect(1, config.samples, || {
            black_box(zoom_engine.compile_gpu_packet_request(&raw).unwrap());
        });
        zoom_rows.push(json!({
            "zoom": zoom,
            "compileColdMs": cold_ms,
            "verticesMatchOrigin": vertex_hash == cold_vertex_hash,
            "placementSha256": &placement[..16],
            "packetEncodeMs": encode_ms,
            "packet": packet_parts(&packet)?,
            "repeatedPacket": warm.json(),
        }));
    }

    let pose_a = serde_json::to_string(&BTreeMap::from([(
        "n0000".to_owned(),
        Transform([1., 0., 0., 1., 3.5, 1.25]),
    )]))
    .map_err(|error| error.to_string())?;
    let pose_b = serde_json::to_string(&BTreeMap::from([(
        "n0000".to_owned(),
        Transform([1., 0., 0., 1., 0., 0.]),
    )]))
    .map_err(|error| error.to_string())?;
    let parsed_pose_a: BTreeMap<String, Transform> =
        serde_json::from_str(&pose_a).map_err(|error| error.to_string())?;
    let parsed_pose_b: BTreeMap<String, Transform> =
        serde_json::from_str(&pose_b).map_err(|error| error.to_string())?;
    let mut pose_engine = load(&document)?;
    let pose_options = parsed_options(&pose_engine, &base_raw)?;
    pose_engine.compile_gpu(&pose_options)?;
    let mut toggle = false;
    let pose_parse = Series::collect(config.warmup, config.samples, || {
        toggle = !toggle;
        let raw = if toggle { &pose_a } else { &pose_b };
        let parsed: BTreeMap<String, Transform> = serde_json::from_str(raw).unwrap();
        black_box(parsed);
    });
    toggle = false;
    let pose_apply = Series::collect(config.warmup, config.samples, || {
        toggle = !toggle;
        let parsed = if toggle {
            &parsed_pose_a
        } else {
            &parsed_pose_b
        };
        assert!(pose_engine.apply_interaction_transforms(parsed).unwrap());
    });
    let (pose_compile_ms, pose_scene) = Series::once(|| pose_engine.compile_gpu(&parsed).unwrap());
    let (pose_packet_ms, pose_packet) = Series::once(|| pose_scene.into_packet().unwrap());

    let node: Node = serde_json::from_value(document["nodes"]["n0000"].clone())
        .map_err(|error| error.to_string())?;
    let point = Point::new(4., 3.);
    let matrix = device_matrix(&node.transform, point, 1.);
    let node_json = serde_json::to_string(&node).map_err(|error| error.to_string())?;
    let matrix_json = serde_json::to_string(&matrix.0).map_err(|error| error.to_string())?;
    let hit_direct = Series::collect(config.warmup, config.samples, || {
        black_box(hit_test_device(&node, Point::new(0., 0.), matrix, 5.).unwrap());
    });
    let hit_boundary = Series::collect(config.warmup, config.samples, || {
        let parsed: Node = serde_json::from_str(&node_json).unwrap();
        let parsed_matrix: Transform = serde_json::from_str(&matrix_json).unwrap();
        black_box(hit_test_device(&parsed, Point::new(0., 0.), parsed_matrix, 5.).unwrap());
    });

    let mut image_engine = Engine::new();
    let (image_cold_ms, decoded) = Series::once(|| image_engine.image_data(&image).unwrap());
    let image_warm = Series::collect(config.warmup, config.samples, || {
        black_box(image_engine.image_data(&image).unwrap());
    });
    let pixels = decoded.pixels.clone();
    let image_copy = Series::collect(config.warmup, config.samples, || {
        let floats: Vec<f32> = pixels.iter().flat_map(|pixel: &Pixel| pixel.0).collect();
        black_box(floats);
    });
    let geometry_scene = engine.compile_gpu(&parsed).unwrap();
    let geometry_bytes = (geometry_scene.vertices.len() + geometry_scene.curves.len()) * 4;
    let geometry_vertices = geometry_scene.vertices;
    let geometry_curves = geometry_scene.curves;
    let geometry_copy = Series::collect(config.warmup, config.samples, || {
        let mut copy = Vec::with_capacity(geometry_vertices.len() + geometry_curves.len());
        copy.extend_from_slice(&geometry_vertices);
        copy.extend_from_slice(&geometry_curves);
        black_box(copy);
    });

    let mut raster = load(&document)?;
    let raster_side = 32.min(config.width).min(config.height);
    let raster_options = parsed_options(&raster, &base_raw)?;
    let (raster_a_ms, pixels_a) = Series::once(|| {
        raster
            .render_device_rect(&raster_options, 0, 0, raster_side, raster_side)
            .unwrap()
    });
    let shifted = parsed_options(
        &raster,
        &options_json(config.width, config.height, 0.5, 0., 1.),
    )?;
    let (raster_b_ms, pixels_b) = Series::once(|| {
        raster
            .render_device_rect(&shifted, 0, 0, raster_side, raster_side)
            .unwrap()
    });

    Ok(json!({
        "optimized": !cfg!(debug_assertions),
        "arch": std::env::consts::ARCH,
        "build": {
            "profileLto": std::env::var("CARGO_PROFILE_RELEASE_LTO").unwrap_or_else(|_| "default".into()),
            "codegenUnits": std::env::var("CARGO_PROFILE_RELEASE_CODEGEN_UNITS").unwrap_or_else(|_| "default".into()),
        },
        "config": {"nodes": config.nodes, "width": config.width, "height": config.height, "samples": config.samples, "warmup": config.warmup, "panSteps": config.pan_steps},
        "document": {"bytes": document_json.len(), "sha256": sha256(document_json.as_bytes()), "rectangles": config.nodes, "images": 1},
        "ownership": {
            "pointer": "typescript",
            "poseApply": "rust",
            "poseJson": "typescript-to-wasm",
            "compileAndProjection": "rust",
            "scenePacket": "rust-encode-typescript-decode",
            "gpuEncodePresent": "typescript-webgpu",
            "hitTest": "rust-via-json",
            "imageDecode": "rust",
            "imageUpload": "typescript-webgpu-after-cache-miss",
            "instanceGeometry": "rust-packet-vertices-uploaded-by-typescript",
        },
        "notRun": [
            "hardware-webgpu", "macos", "metal", "electron", "official-desktop-fps",
            "gpu-command-encode", "gpu-present", "swiftshader",
        ],
        "stages": {
            "parseOptionsMs": stage(parse),
            "compileWarmMs": stage(compile_warm),
            "packetEncodeWarmMs": stage(packet_warm),
            "productionPacketEntryMs": stage(production_packet),
            "scopedPacketRepeatMs": stage(scoped_repeat),
            "poseParseMs": stage(pose_parse),
            "poseApplyMs": stage(pose_apply),
            "hitDirectMs": stage(hit_direct),
            "hitJsonBoundaryMs": stage(hit_boundary),
            "imageDecodeWarmMs": stage(image_warm),
            "imageFlattenCopyMs": stage(image_copy),
            "geometryCopyMs": stage(geometry_copy),
            "panRepeatPacketMs": stage(pan_repeat),
        },
        "once": {
            "parseOptionsColdMs": parse_cold_ms,
            "compileColdMs": compile_cold_ms,
            "packetEncodeColdMs": packet_cold_ms,
            "scopedPacketColdMs": scoped_cold_ms,
            "scopedPacketBytes": scoped_first.len(),
            "scopedRepeatBytes": scoped_repeat_bytes,
            "coldPacket": cold_parts,
            "coldVertexFloats": cold_vertices,
            "poseJsonBytes": pose_a.len(),
            "poseCompileMs": pose_compile_ms,
            "posePacketEncodeMs": pose_packet_ms,
            "posePacketBytes": pose_packet.len(),
            "optionsJsonBytes": base_raw.len(),
            "hitNodeJsonBytes": node_json.len(),
            "hitMatrixJsonBytes": matrix_json.len(),
            "imageDecodeColdMs": image_cold_ms,
            "imageFloatBytes": decoded.pixels.len() * 16,
            "geometryCopyBytes": geometry_bytes,
            "cpuRasterOriginMs": raster_a_ms,
            "cpuRasterPanMs": raster_b_ms,
            "cpuPanPixelBytesDiffer": differing_bytes(&pixels_a, &pixels_b),
            "cpuRasterBytes": pixels_a.len(),
        },
        "panSteps": pan_steps,
        "zoom": zoom_rows,
        "cacheAfterWarm": warm_stats,
        "cacheAfterPan": pan_stats,
        "scope": "Native CPU wall time of production Engine entries. Packet bytes are the WASM return copy. geometryCopyMs is a memcpy floor, not a GPU upload. No WebGPU, Electron, Metal or desktop FPS claim.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_split_entries_keep_pose_projection_and_boundary() {
        let check = verify(12, 48).expect("split check");
        assert!(
            check.same_camera_packets_equal,
            "same camera must republish the same FGSC packet"
        );
        assert!(
            check.pan_packet_differs,
            "a half-pixel pan must publish a different packet"
        );
        assert!(
            check.pan_view_moved,
            "compiled scene must carry the panned camera"
        );
        assert!(
            check.pan_placement_differs || check.pan_vertices_differ,
            "translation vertices={} placement={}",
            check.pan_vertices_differ,
            check.pan_placement_differs,
        );
        assert!(
            check.zoom_vertices_differ || check.zoom_placement_differs,
            "zoom vertices={} placement={}",
            check.zoom_vertices_differ,
            check.zoom_placement_differs,
        );
        assert!(
            check.pan_cpu_pixels_differ > 0,
            "exact CPU raster must change at the new sample phase"
        );
        assert!(
            check.pose_accepted,
            "plain rectangle pose must stay on the retained Rust pose path"
        );
        assert!(
            check.pose_packet_differs,
            "accepted pose must change the packet"
        );
        assert!(check.pose_json_bytes < 65_536);
        assert!(
            check.pose_json_bytes < check.packet_bytes,
            "pose JSON is smaller than the scene packet"
        );
        assert!(
            check.hit_agrees,
            "JSON boundary hit must match the direct kernel hit"
        );
        assert!(
            check.scoped_repeat_identical,
            "a scoped repeat of the same camera must return the same packet"
        );
        assert_eq!(
            check.image_floats,
            check.image_width as usize * check.image_height as usize * 4
        );
        let report = measure(MeasureConfig {
            nodes: 12,
            width: 48,
            height: 48,
            samples: 3,
            warmup: 1,
            pan_steps: 2,
        })
        .expect("measurement");
        for key in [
            "parseOptionsMs",
            "compileWarmMs",
            "packetEncodeWarmMs",
            "productionPacketEntryMs",
            "scopedPacketRepeatMs",
            "poseParseMs",
            "poseApplyMs",
            "hitDirectMs",
            "hitJsonBoundaryMs",
            "imageDecodeWarmMs",
            "imageFlattenCopyMs",
            "geometryCopyMs",
            "panRepeatPacketMs",
        ] {
            let median = report["stages"][key]["p50Ms"].as_f64().unwrap_or(f64::NAN);
            assert!(median.is_finite() && median >= 0., "{key} median {median}");
        }
        assert!(report["notRun"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "hardware-webgpu"));
        assert!(report["once"]["cpuPanPixelBytesDiffer"].as_u64().unwrap() > 0);
        assert_eq!(report["ownership"]["compileAndProjection"], "rust");
        assert_eq!(report["ownership"]["gpuEncodePresent"], "typescript-webgpu");
        assert_eq!(report["ownership"]["pointer"], "typescript");
    }
}
