//! Correctness-only, explicitly invoked CPU regression. No timing acceptance claim.
use futureox_design_kernel::renderer::{Engine, RenderOptions};
use serde_json::json;

fn engine(shadow: bool) -> Engine {
    let mut e = Engine::new();
    e.load_document(&json!({"schemaVersion":5,"id":"d","name":"Visible shadow",
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,70,80],
            "width":700,"height":570,"fills":[{"kind":"solid","color":"#8073dd"}],
            "effects":if shadow {json!([{"kind":"shadow","radius":8,"x":0,"y":8,"spread":0,"color":"#172033","opacity":0.25}])}else{json!([])}}}
    }).to_string()).unwrap();
    e
}
fn check(corner: bool, transparent: bool) {
    let options: RenderOptions=serde_json::from_value(json!({"pageId":"p","width":640,"height":480,
        "transparent":transparent,"rasterProfile":"analytic","view":{"zoom":32,"x":320-70*32,"y":240-if corner {80*32}else{140*32}}})).unwrap();
    let mut direct = engine(true);
    let pixels = direct.render(&options).unwrap();
    let ledger = direct.compositing_ledger();
    assert_eq!(ledger.budget_rejections, 0);
    assert!(ledger.scene_peak_bytes <= 256 * 1024 * 1024);
    eprintln!(
        "corner={corner} transparent={transparent} cold direct peak={}",
        ledger.scene_peak_bytes
    );
    let no_shadow = engine(false).render(&options).unwrap();
    let outside_changed = (0..480)
        .flat_map(|y| (0..320).map(move |x| (y * 640 + x) * 4))
        .filter(|&i| pixels[i..i + 4] != no_shadow[i..i + 4])
        .count();
    assert!(
        outside_changed > 0,
        "shadow must visibly affect exterior pixels"
    );
    assert!(pixels.chunks_exact(4).any(|p| p != &pixels[0..4]));
    if transparent {
        assert!(
            pixels.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255),
            "must contain partial shadow alpha"
        );
    }
    let mut tiled = engine(true);
    let frame = tiled.render_tiled_frame(&options, None).unwrap();
    assert_eq!(
        frame.level_scale, 32.,
        "fresh 32x must not reuse another density bucket"
    );
    assert_eq!(frame.rgba, pixels, "fresh tiled/direct exact pixels");
    let ledger = tiled.compositing_ledger();
    assert_eq!(ledger.budget_rejections, 0);
    assert!(ledger.scene_peak_bytes <= 256 * 1024 * 1024);
    eprintln!(
        "corner={corner} transparent={transparent} cold tiled peak={} level={} outside_changed={outside_changed}",
        ledger.scene_peak_bytes, frame.level_scale
    );
    // This crop crosses the left geometric edge and, for corner=true, the top edge.
    let (x, y, w, h) = (307, 227, 31, 27);
    let crop = engine(true)
        .render_device_rect(&options, x, y, w, h)
        .unwrap();
    let mut tiny_options = options.clone();
    tiny_options.width = w;
    tiny_options.height = h;
    tiny_options.view.x -= x as f64;
    tiny_options.view.y -= y as f64;
    let tiny = engine(true).render(&tiny_options).unwrap();
    assert_eq!(crop, tiny, "independent same-grid tiny viewport oracle");
    for row in 0..h as usize {
        assert_eq!(
            &crop[row * w as usize * 4..(row + 1) * w as usize * 4],
            &pixels[((row + y as usize) * 640 + x as usize) * 4
                ..((row + y as usize) * 640 + (x + w) as usize) * 4]
        );
    }
}
#[test]
#[ignore = "large real CPU correctness regression; run explicitly"]
fn cold_3200_percent_visible_shadow_edge_exact_crop() {
    check(false, false);
}
#[test]
#[ignore = "large real CPU correctness regression; run explicitly"]
fn cold_3200_percent_visible_shadow_corner_exact_alpha_crop() {
    check(true, true);
}
