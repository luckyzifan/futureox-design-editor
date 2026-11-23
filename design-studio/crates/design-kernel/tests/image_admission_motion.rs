//! CPU image admission during pan, zoom and drag.
//! Measures decode, mip materialisation and coordinate-grid rebuild separately
//! from the pixel copy a shelf-pack would move. Not a GPU, WebGPU or desktop FPS result.
use base64::Engine as _;
use futureox_design_kernel::math::Transform;
use futureox_design_kernel::paint::{Images, image_mip_level, image_sampling_grid_at_level};
use futureox_design_kernel::scene::Paint;
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Instant;

fn png(width: u32, height: u32, rgba: [u8; 4]) -> String {
    let mut raw = vec![0u8; (width * height * 4) as usize];
    for pixel in raw.chunks_exact_mut(4) {
        pixel.copy_from_slice(&rgba);
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&raw).unwrap();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encoded)
    )
}

fn red_count(frame: &[u8]) -> usize {
    frame.chunks_exact(4).filter(|p| p[0] > 200 && p[1] < 40 && p[2] < 40 && p[3] == 255).count()
}

fn options(width: u32, height: u32, x: f64, y: f64, zoom: f64) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": width, "height": height,
        "view": { "x": x, "y": y, "zoom": zoom },
        "transparent": false, "grid": false, "rasterProfile": "analytic"
    }))
    .unwrap()
}

#[test]
fn image_pan_zoom_drag_keeps_opaque_pixels_and_reports_admission_stages() {
    let uri = png(64, 64, [220, 10, 10, 255]);
    let paint: Paint = serde_json::from_value(json!({
        "kind": "image", "color": "#000000", "image": uri, "fit": "stretch", "opacity": 1
    }))
    .unwrap();
    let mut images = Images::default();
    images.set_mip_enabled(true);
    let started = Instant::now();
    let base = images.image(&paint.image.clone().unwrap()).unwrap();
    let decode_ms = started.elapsed().as_secs_f64() * 1000.;
    let decoded_pixels = images.resident_pixels();
    let again = Instant::now();
    let cached = images.image(paint.image.as_deref().unwrap()).unwrap();
    let cache_hit_ms = again.elapsed().as_secs_f64() * 1000.;
    assert!(std::sync::Arc::ptr_eq(&base, &cached));
    assert_eq!(images.resident_pixels(), decoded_pixels);

    let rect = futureox_design_kernel::math::Rect::new(0, 0, 64, 64);
    let matrix = Transform([1., 0., 0., 1., 0., 0.]);
    let size = [64., 64.];
    let dims = [base.rect.w, base.rect.h];
    let level = image_mip_level(rect, matrix, size, dims, &paint).unwrap();
    assert_eq!(level, 0, "identity placement stays on the base");
    let zoomed = Transform([0.25, 0., 0., 0.25, 0., 0.]);
    let mip = image_mip_level(rect, zoomed, size, dims, &paint).unwrap();
    assert!(mip >= 1, "quarter scale must select a mip, got {mip}");
    let mip_started = Instant::now();
    let level_surface = images.image_at(&paint.image.clone().unwrap(), mip).unwrap();
    let mip_ms = mip_started.elapsed().as_secs_f64() * 1000.;
    let with_mip = images.resident_pixels();
    assert!(with_mip > decoded_pixels);
    assert_eq!(level_surface.rect.w, 64 >> mip);
    let mip_again = Instant::now();
    let _ = images.image_at(paint.image.as_deref().unwrap(), mip).unwrap();
    let mip_hit_ms = mip_again.elapsed().as_secs_f64() * 1000.;
    assert_eq!(images.resident_pixels(), with_mip);

    let grid_started = Instant::now();
    let mut grid_bytes = 0usize;
    for step in 0..8 {
        let placed = Transform([1., 0., 0., 1., step as f64 * 4., 0.]);
        let values = image_sampling_grid_at_level(rect, placed, size, dims, &paint, None, 0).unwrap();
        grid_bytes += values.len() * 4;
        assert!(values.chunks_exact(4).any(|v| v[0] >= 0.), "pan {step} dropped every image sample");
    }
    let grid_ms = grid_started.elapsed().as_secs_f64() * 1000.;

    let pack_started = Instant::now();
    let side = 1024usize;
    let mut page = vec![0f32; side * side * 4];
    let pixels = base.rect.w as usize * base.rect.h as usize;
    for (index, pixel) in base.pixels.iter().enumerate() {
        let x = 1 + index % base.rect.w as usize;
        let y = 1 + index / base.rect.w as usize;
        let dst = (y * side + x) * 4;
        page[dst..dst + 4].copy_from_slice(&pixel.0);
    }
    let pack_ms = pack_started.elapsed().as_secs_f64() * 1000.;
    let pack_bytes = page.len() * 4;
    assert_eq!(page[side * 4 + 4..side * 4 + 8], base.pixels[0].0);
    assert_eq!(page[..4], [0., 0., 0., 0.], "atlas pad stays empty");
    assert_eq!(pixels, 64 * 64);

    let icons: Vec<String> = (0..8).map(|i| png(32, 32, [220, 8 + i, 12, 255])).collect();
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    nodes.insert("hero".into(), json!({
        "id": "hero", "kind": "rectangle", "width": 64, "height": 64,
        "fills": [{ "kind": "image", "color": "#000000", "image": uri, "fit": "stretch" }]
    }));
    roots.push("hero".to_string());
    for (i, icon) in icons.iter().enumerate() {
        let id = format!("icon-{i}");
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 32, "height": 32,
            "transform": [1, 0, 0, 1, 80 + i * 40, 8],
            "fills": [{ "kind": "image", "color": "#000000", "image": icon, "fit": "stretch" }]
        }));
        roots.push(id);
    }
    let document = json!({
        "schemaVersion": 5, "id": "images", "name": "image motion",
        "pages": [{ "id": "p", "name": "p", "children": roots, "background": "#ffffff" }],
        "nodes": nodes
    });
    let mut engine = Engine::new();
    engine.set_image_mips(true);
    engine.load_document(&document.to_string()).unwrap();
    let cold_started = Instant::now();
    let cold = engine.render(&options(48, 48, 0., 0., 1.)).unwrap();
    let cold_ms = cold_started.elapsed().as_secs_f64() * 1000.;
    let cold_red = red_count(&cold);
    assert!(cold_red > 100, "first view lost the image: {cold_red} red pixels");

    let mut pan_ms = 0.;
    let mut pan_red = 0;
    for step in 0..4 {
        let started = Instant::now();
        let frame = engine.render(&options(48, 48, -8. * step as f64, 0., 1.)).unwrap();
        pan_ms += started.elapsed().as_secs_f64() * 1000.;
        pan_red = red_count(&frame);
        assert!(pan_red > 100, "pan {step} punched a hole: {pan_red} red pixels");
    }
    let zoom_started = Instant::now();
    let zoomed_frame = engine.render(&options(48, 48, 0., 0., 0.25)).unwrap();
    let zoom_ms = zoom_started.elapsed().as_secs_f64() * 1000.;
    let zoom_red = red_count(&zoomed_frame);
    assert!(zoom_red > 16, "zoom-out blanked the image: {zoom_red} red pixels");
    let zoom_again_started = Instant::now();
    let zoom_again = engine.render(&options(48, 48, 0., 0., 0.25)).unwrap();
    let zoom_again_ms = zoom_again_started.elapsed().as_secs_f64() * 1000.;
    assert_eq!(red_count(&zoom_again), zoom_red, "repeat zoom changed coverage");

    let mut transforms = BTreeMap::new();
    transforms.insert("hero".into(), Transform([1., 0., 0., 1., 12., 4.]));
    assert!(engine.apply_interaction_transforms(&transforms).unwrap());
    let drag_started = Instant::now();
    let dragged = engine.render(&options(48, 48, 0., 0., 1.)).unwrap();
    let drag_ms = drag_started.elapsed().as_secs_f64() * 1000.;
    let drag_red = red_count(&dragged);
    assert!(drag_red > 100, "drag blanked the image: {drag_red} red pixels");
    let held = engine.render(&options(48, 48, 0., 0., 1.)).unwrap();
    assert_eq!(red_count(&held), drag_red, "held drag redrew a different image");

    eprintln!(
        "{}",
        json!({
            "scope": "CPU analytic raster and image cache. Not hardware WebGPU, Metal, Electron, or desktop FPS.",
            "decodeMs": decode_ms,
            "cacheHitMs": cache_hit_ms,
            "decodedPixels": decoded_pixels,
            "mip": mip,
            "mipMs": mip_ms,
            "mipHitMs": mip_hit_ms,
            "mipPixels": with_mip,
            "gridMs": grid_ms,
            "gridBytes": grid_bytes,
            "atlasPackMs": pack_ms,
            "atlasPackBytes": pack_bytes,
            "coldRenderMs": cold_ms,
            "coldRed": cold_red,
            "panMs": pan_ms,
            "panRed": pan_red,
            "zoomMs": zoom_ms,
            "zoomAgainMs": zoom_again_ms,
            "zoomRed": zoom_red,
            "dragMs": drag_ms,
            "dragRed": drag_red
        })
    );
}
