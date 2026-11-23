//! Integer clipped-board drags can be reproduced by translating pixels that
//! were already rasterized. The oracle is a fresh render of the moved
//! document, not the blit itself.
use futureox_design_kernel::{math::Transform, renderer::RenderOptions, Engine};
use serde_json::{json, Value};

fn document(board_x: f64) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for i in 0..24 {
        let id = format!("cell-{i:02}");
        children.push(id.clone());
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 8, "height": 6,
            "transform": [1, 0, 0, 1, 6 + (i % 12) * 12, 6 + (i / 12) * 14],
            "fills": [{"kind": "solid", "color": if i % 2 == 0 { "#224466" } else { "#88aa66" } }]
        }));
    }
    nodes.insert("board".into(), json!({
        "id": "board", "kind": "frame", "width": 150, "height": 40, "clip": true,
        "transform": [1, 0, 0, 1, board_x, 8],
        "fills": [{"kind": "solid", "color": "#dbe8f0"}],
        "children": children
    }));
    nodes.insert("sibling".into(), json!({
        "id": "sibling", "kind": "frame", "width": 10, "height": 10, "clip": true,
        "transform": [1, 0, 0, 1, 2, 50],
        "fills": [{"kind": "solid", "color": "#111111"}]
    }));
    json!({
        "schemaVersion": 2, "id": "clipped", "name": "clipped",
        "pages": [{"id": "p", "name": "p", "children": ["board", "sibling"], "background": "#e8e8e8"}],
        "nodes": nodes
    })
}

fn options(width: u32) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": width, "height": 64,
        "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": false, "grid": false,
        "rasterProfile": "analytic"
    })).unwrap()
}

fn pixel(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    buf[i..i + 4].try_into().unwrap()
}

fn put(buf: &mut [u8], width: u32, x: u32, y: u32, px: [u8; 4]) {
    let i = ((y * width + x) * 4) as usize;
    buf[i..i + 4].copy_from_slice(&px);
}

fn fill_rect(buf: &mut [u8], width: u32, height: u32, x: i32, y: i32, w: i32, h: i32, color: [u8; 4]) {
    for row in y..y + h {
        for col in x..x + w {
            if col >= 0 && row >= 0 && (col as u32) < width && (row as u32) < height {
                put(buf, width, col as u32, row as u32, color);
            }
        }
    }
}

/// Translate the board rectangle inside an already rendered page image.
/// `cache` is the unshifted page. Only the viewport's left columns are kept.
fn translate_board(cache: &[u8], cache_width: u32, view_width: u32, view_height: u32,
    board: (i32, i32, i32, i32), shift: (i32, i32), background: [u8; 4]) -> Vec<u8> {
    let mut out = vec![0u8; (view_width * view_height * 4) as usize];
    for y in 0..view_height {
        let row = (y * cache_width * 4) as usize;
        let dest = (y * view_width * 4) as usize;
        let bytes = (view_width * 4) as usize;
        out[dest..dest + bytes].copy_from_slice(&cache[row..row + bytes]);
    }
    let (bx, by, bw, bh) = board;
    fill_rect(&mut out, view_width, view_height, bx, by, bw, bh, background);
    let (dx, dy) = shift;
    for y in 0..bh {
        for x in 0..bw {
            let sx = bx + x;
            let sy = by + y;
            let tx = sx + dx;
            let ty = sy + dy;
            if sx < 0 || sy < 0 || tx < 0 || ty < 0 { continue; }
            if sx as u32 >= cache_width || sy as u32 >= view_height || tx as u32 >= view_width || ty as u32 >= view_height {
                continue;
            }
            put(&mut out, view_width, tx as u32, ty as u32, pixel(cache, cache_width, sx as u32, sy as u32));
        }
    }
    out
}

fn render(doc: &Value, width: u32) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    engine.render_device_rect(&options(width), 0, 0, width, 64).unwrap()
}

fn first_mismatch(actual: &[u8], expected: &[u8], width: u32) -> Option<(u32, u32, [u8; 4], [u8; 4])> {
    for (i, (a, b)) in actual.chunks_exact(4).zip(expected.chunks_exact(4)).enumerate() {
        if a != b {
            let x = i as u32 % width;
            let y = i as u32 / width;
            return Some((x, y, a.try_into().unwrap(), b.try_into().unwrap()));
        }
    }
    None
}

#[test]
fn integer_clipped_board_translation_matches_a_fresh_render_and_undo() {
    let original = document(16.);
    let wide = 192u32;
    let view = 96u32;
    let cache = render(&original, wide);
    let background = pixel(&cache, wide, 0, 0);
    let narrow = render(&original, view);
    let mut crop = vec![0u8; (view * 64 * 4) as usize];
    for y in 0..64u32 {
        let source = (y * wide * 4) as usize;
        let dest = (y * view * 4) as usize;
        let bytes = (view * 4) as usize;
        crop[dest..dest + bytes].copy_from_slice(&cache[source..source + bytes]);
    }
    let mismatch = first_mismatch(&narrow, &crop, view);
    assert!(mismatch.is_none(), "viewport render diverged from the wide crop: {mismatch:?}");

    let board = (16, 8, 150, 40);
    for shift in [10, -24] {
        let moved_doc = document(16. + shift as f64);
        let fresh = render(&moved_doc, view);
        let preview = translate_board(&cache, wide, view, 64, board, (shift, 0), background);
        let mismatch = first_mismatch(&preview, &fresh, view);
        assert!(mismatch.is_none(), "shift {shift} preview diverged: {mismatch:?}");
    }

    let mut engine = Engine::new();
    engine.load_document(&original.to_string()).unwrap();
    let before = engine.render_device_rect(&options(view), 0, 0, view, 64).unwrap();
    assert!(engine.apply_interaction_transforms(&[("board".into(), Transform([1., 0., 0., 1., -8., 8.]))].into()).unwrap());
    let committed = engine.render_device_rect(&options(view), 0, 0, view, 64).unwrap();
    assert_eq!(committed, render(&document(-8.), view));
    assert!(engine.apply_interaction_transforms(&[("board".into(), Transform([1., 0., 0., 1., 16., 8.]))].into()).unwrap());
    let undone = engine.render_device_rect(&options(view), 0, 0, view, 64).unwrap();
    assert_eq!(undone, before);
    assert_ne!(committed, before);
}
