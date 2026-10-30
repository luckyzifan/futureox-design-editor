//! Canvas chrome tier: the in-engine checkerboard (Figma renders its canvas
//! chrome in the engine; this is the kernel tier of that contract).
//! Screen-anchored 16px cells in the CSS tier's colors, under content.

use futureox_design_kernel::render_instruction::render_trait;
use futureox_design_kernel::{Engine, RenderOptions, View};

fn doc() -> String {
    serde_json::json!({
        "schemaVersion": 1, "id": "c", "name": "c",
        "pages": [{"id": "p", "name": "p", "children": [], "background": "#ffffff"}],
        "nodes": {}
    })
    .to_string()
}

fn frame(checkerboard: bool, view: View) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 48,
        height: 32,
        view,
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard,
    }
}

fn pixel(bytes: &[u8], x: usize, y: usize, w: usize) -> [u8; 4] {
    let i = (y * w + x) * 4;
    [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
}

#[test]
fn checkerboard_paints_screen_anchored_cells_under_content() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let flat = engine
        .render(&frame(false, View { x: 0., y: 0., zoom: 1. }))
        .expect("flat");
    let check = engine
        .render(&frame(true, View { x: 0., y: 0., zoom: 1. }))
        .expect("checker");
    // 16px 设备锚定双色:#fff 与 #eee(238)。
    assert_eq!(pixel(&check, 0, 0, 48), [255, 255, 255, 255]);
    assert_eq!(pixel(&check, 16, 0, 48), [238, 238, 238, 255]);
    assert_eq!(pixel(&check, 0, 16, 48), [238, 238, 238, 255]);
    assert_eq!(pixel(&check, 16, 16, 48), [255, 255, 255, 255]);
    // 单元格内部稳定,过 16px 边界即换色(同轴奇偶翻转,对角同色)。
    assert_eq!(pixel(&check, 15, 15, 48), [255, 255, 255, 255]);
    assert_eq!(pixel(&check, 17, 1, 48), [238, 238, 238, 255]);
    // 默认关:与平铺背景一致(整帧全白)。
    assert_eq!(pixel(&flat, 16, 0, 48), [255, 255, 255, 255]);
    assert_ne!(flat, check);
    // 屏幕锚定:平移相机不移动棋盘(设备坐标不变)。
    let panned = engine
        .render(&frame(true, View { x: -100., y: -64., zoom: 1. }))
        .expect("panned checker");
    assert_eq!(pixel(&panned, 0, 0, 48), [255, 255, 255, 255]);
    assert_eq!(pixel(&panned, 16, 0, 48), [238, 238, 238, 255]);
}

#[test]
fn instructions_separate_chrome_through_the_options_bit() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let off = engine
        .render_instruction_for(&frame(false, View { x: 0., y: 0., zoom: 1. }))
        .expect("instruction");
    let on = engine
        .render_instruction_for(&frame(true, View { x: 0., y: 0., zoom: 1. }))
        .expect("instruction");
    assert!(off.traits_differing(&on) & render_trait::OPTIONS != 0);
    assert_eq!(off.traits_differing(&off), 0);
}

#[test]
fn supersampled_checker_matches_gpu_packet_and_keeps_output_cell_size() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).unwrap();
    let mut options = frame(true, View { x: 0.25, y: 0.5, zoom: 1. });
    options.raster_profile = futureox_design_kernel::fidelity::RasterProfile::Figma;
    let pixels = engine.render(&options).unwrap();
    assert_eq!(pixel(&pixels, 8, 0, 48), [255, 255, 255, 255]);
    assert_eq!(pixel(&pixels, 16, 0, 48), [238, 238, 238, 255]);
    let scene = engine.compile_gpu(&options).unwrap();
    assert!(scene.checkerboard);
    assert_eq!(scene.checkerboard_size, 32);
    options.transparent = true;
    assert!(!engine.compile_gpu(&options).unwrap().checkerboard);
}
