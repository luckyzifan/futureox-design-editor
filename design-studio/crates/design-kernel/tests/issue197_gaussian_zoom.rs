//! Issue 197: unmanaged 117-style Gaussian at device zoom 64 (3200% × DPR 2).
//! The whole-surface cap stays 512. A tile whose device sigma is above that
//! cap uses the existing regional three-box plan and must not call uniform_box.
use futureox_design_kernel::{effects, rational_filter::RationalKernel, Engine};
use serde_json::json;

const AUTHORED_RADIUS: f64 = 9.564871788024902;

fn document() -> String {
    json!({
        "schemaVersion": 20,
        "id": "issue-197",
        "name": "issue-197",
        "pages": [{"id": "p", "name": "p", "children": ["ellipse"], "background": "#ffffff"}],
        "nodes": {"ellipse": {
            "id": "ellipse",
            "kind": "ellipse",
            "name": "椭圆 11",
            "width": 120.0,
            "height": 120.0,
            "fills": [{"kind": "solid", "color": "#59aeff"}],
            "effects": [{"kind": "gaussian-blur", "radius": AUTHORED_RADIUS, "color": "#000000"}]
        }}
    })
    .to_string()
}

fn engine() -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&document()).expect("load");
    engine
}

fn compile(zoom: f64) -> Result<futureox_design_kernel::gpu::GpuScene, String> {
    let mut engine = engine();
    let request = json!({
        "pageId": "p",
        "width": 514,
        "height": 514,
        "view": {"x": 0.0, "y": 0.0, "zoom": zoom},
        "rasterProfile": "analytic",
        "gpuViewport": {"x": 0, "y": 0, "w": 514, "h": 514}
    });
    engine.compile_gpu_request(&request.to_string())
}

#[test]
fn unmanaged_device_zoom_64_uses_regional_gaussian_without_raising_the_cap() {
    let sigma = AUTHORED_RADIUS * 64.;
    assert!(
        (sigma - 612.1517944335938).abs() < 1e-9,
        "effective pixel sigma {sigma}"
    );
    let whole = effects::gaussian_box_radii(sigma);
    assert!(
        whole
            .as_ref()
            .unwrap_err()
            .contains("Gaussian sigma must be in [0,512]"),
        "{whole:?}"
    );
    assert!(
        effects::gaussian_box_radii(AUTHORED_RADIUS * 32.).is_ok(),
        "100% device zoom 32 still fits"
    );

    let scene = compile(64.).expect("514 tile at device zoom 64");
    assert!(
        scene.color_management.is_none(),
        "encoded sRGB stays unmanaged"
    );
    // Analytic display is float compositing without a color-management block
    // and without four coherent samples.
    assert!(scene.float_compositing);
    assert!(!scene.coherent_samples);
    assert!(!scene.integrated_blur);
    assert!(u64::from(scene.extent.w) * u64::from(scene.extent.h) <= 16_777_216);
    let node = &scene.nodes["ellipse"];
    let effect = node
        .effects
        .iter()
        .find(|effect| effect.kind == "gaussian-blur")
        .expect("effect retained");
    assert_eq!(effect.radius.to_bits(), AUTHORED_RADIUS.to_bits());
    let plan = node.gaussian_region.as_ref().expect("regional plan");
    assert!(plan.factor.is_none(), "full output density");
    assert_eq!(
        plan.radii,
        [611, 612, 612],
        "existing regional three-box radii"
    );
    let area = node
        .fill
        .area
        .as_ref()
        .expect("byte mask needs the existing area program");
    let header = scene.curves[area.first as usize * 4];
    assert_eq!(header, 0., "analytic continuous area header");
    for radius in plan.radii {
        let uniform = RationalKernel::uniform_box(radius);
        assert!(
            uniform
                .as_ref()
                .unwrap_err()
                .contains("Box filter radius exceeds 512"),
            "{uniform:?}"
        );
    }

    let mild = compile(32.).expect("100% device zoom");
    assert!(
        mild.nodes["ellipse"].gaussian_region.is_none(),
        "zoom 32 stays on the whole-surface cap"
    );
    assert_eq!(
        mild.nodes["ellipse"].effects[0].radius.to_bits(),
        AUTHORED_RADIUS.to_bits()
    );
}
