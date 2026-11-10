//! A packed high-zoom blur cover is a capture, not a production tile.
//! `gpuViewport` keeps `TILE_SIZE + 2`. The existing capture viewport admits
//! the 2×3 cover used for a 514-pixel grid. A large Gaussian on that cover
//! still has to satisfy the existing regional plan; this test does not widen it.
use futureox_design_kernel::Engine;
use serde_json::json;

const AUTHORED: f64 = 9.564871788024902;

fn tent_document(gaussian: bool) -> String {
    let mut nodes = serde_json::Map::new();
    nodes.insert("image".into(), json!({
        "id": "image",
        "kind": "rectangle",
        "width": 4096.0,
        "height": 4096.0,
        "fills": [{"kind": "solid", "color": "#ad3344"}],
        "effects": [{"kind": "blur", "color": "#000000", "radius": AUTHORED}]
    }));
    let mut children = vec!["image".to_string()];
    if gaussian {
        nodes.insert("ellipse".into(), json!({
            "id": "ellipse",
            "kind": "ellipse",
            "width": 120.0,
            "height": 120.0,
            "fills": [{"kind": "solid", "color": "#59aeff"}],
            "effects": [{"kind": "gaussian-blur", "radius": AUTHORED, "color": "#000000"}]
        }));
        children.push("ellipse".into());
    }
    json!({
        "schemaVersion": 20,
        "id": "settled-cover",
        "name": "settled-cover",
        "pages": [{"id": "p", "name": "p", "children": children, "background": "#ffffff"}],
        "nodes": nodes
    })
    .to_string()
}

fn compile(document: &str, viewport: &str, zoom: f64, width: u32, height: u32) -> Result<futureox_design_kernel::gpu::GpuScene, String> {
    let mut engine = Engine::new();
    engine.load_document(document)?;
    let mut request = json!({
        "pageId": "p",
        "width": width,
        "height": height,
        "view": {"x": 0.0, "y": 0.0, "zoom": zoom},
        "rasterProfile": "figmaSubpixel",
        "transparent": false,
        "grid": false
    });
    request[viewport] = json!({"x": 0, "y": 0, "w": width, "h": height});
    engine.compile_gpu_request(&request.to_string())
}

#[test]
fn packed_cover_uses_capture_and_a_tile_viewport_of_that_size_stays_rejected() {
    let document = tent_document(false);
    let tile = match compile(&document, "gpuViewport", 64.0, 2050, 514) {
        Ok(_) => panic!("a four-tile row is not one tile"),
        Err(error) => error,
    };
    assert!(
        tile.contains("Invalid GPU tile viewport"),
        "tile compiler must keep TILE_SIZE+2: {tile}"
    );

    let scene = compile(&document, "captureViewport", 64.0, 2050, 514)
        .expect("existing capture viewport admits the scale-64 row");
    assert!(scene.extent.pixels() <= 16_777_216, "extent {}", scene.extent.pixels());
    assert_eq!(scene.output.map(|rect| (rect.w, rect.h)), Some((2050, 514)));
    let effect = scene.nodes["image"].effects.iter().find(|effect| effect.kind == "blur").expect("blur retained");
    assert_eq!(effect.radius.to_bits(), AUTHORED.to_bits());

    let wider = match compile(&document, "captureViewport", 128.0, 1026, 1538) {
        Ok(_) => panic!("device radius 1224 exceeds the existing surface budget"),
        Err(error) => error,
    };
    assert!(!wider.contains("Invalid GPU tile viewport"), "{wider}");
    assert!(wider.contains("GPU surface budget exceeded"), "{wider}");
}

#[test]
fn a_large_gaussian_on_the_packed_cover_is_not_a_tile_rejection_and_the_514_plan_stays() {
    let mixed = tent_document(true);
    match compile(&mixed, "captureViewport", 64.0, 2050, 514) {
        Ok(scene) => {
            assert!(scene.extent.pixels() <= 16_777_216, "extent {}", scene.extent.pixels());
            let ellipse = &scene.nodes["ellipse"];
            if ellipse.effects.iter().any(|effect| effect.kind == "gaussian-blur") {
                assert!(
                    ellipse.gaussian_region.is_some(),
                    "a compiled cover must not drop the existing regional Gaussian plan"
                );
                assert!(ellipse.gaussian_region.as_ref().unwrap().output.w <= 1024);
                assert!(ellipse.gaussian_region.as_ref().unwrap().output.h <= 1024);
            }
        }
        Err(error) => {
            assert!(
                !error.contains("Invalid GPU tile viewport"),
                "capture admission must not report the tile-viewport error: {error}"
            );
            assert!(
                error.contains("GPU surface budget exceeded"),
                "unexpected capture failure: {error}"
            );
        }
    }

    let tile = compile(&mixed, "gpuViewport", 64.0, 514, 514).expect("per-tile Gaussian path");
    let ellipse = &tile.nodes["ellipse"];
    assert!(ellipse.gaussian_region.is_some(), "514 unmanaged tile keeps the regional plan");
    assert_eq!(
        ellipse.effects.iter().find(|effect| effect.kind == "gaussian-blur").unwrap().radius.to_bits(),
        AUTHORED.to_bits()
    );
}
