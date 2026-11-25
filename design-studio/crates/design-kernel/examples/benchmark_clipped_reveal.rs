//! CPU cost of revealing a clipped board during a drag.
//!
//! The live path compiles a full viewport scene on every pose. The retained
//! path compiles only the newly visible 514px edge tile of the original
//! document, then reuses those pixels. This process times those compiles and
//! the packet encode. It does not submit GPU work, present a window, or
//! sample a display.
use futureox_design_kernel::{
    math::{Rect, Transform},
    renderer::RenderOptions,
    tile_stack::{raster_addresses, TILE_SIZE},
    Engine,
};
use serde_json::{json, Value};
use std::{hint::black_box, time::Instant};

const ZOOM: f64 = 2.5;
const VIEW_W: u32 = 1280;
const VIEW_H: u32 = 800;
const STEPS: usize = 16;
const ROUNDS: usize = 3;

fn document() -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for row in 0..32 {
        for col in 0..28 {
            let id = format!("cell-{row:02}-{col:02}");
            children.push(id.clone());
            let vector = (row + col) % 17 == 0;
            let mut node = json!({
                "id": id,
                "kind": if vector { "vector" } else { "rectangle" },
                "width": 36,
                "height": 22,
                "transform": [1, 0, 0, 1, 16. + col as f64 * 48., 28. + row as f64 * 30.],
                "fills": [{"kind": "solid", "color": "#dbe8ef"}],
                "strokes": [{"width": 1, "paint": {"kind": "solid", "color": "#5d6b75"}}]
            });
            if vector {
                node["vectorGeometry"] = json!({
                    "fillRule": "nonzero",
                    "fill": [{"move": [0, 0]}, {"line": [36, 4]}, {"line": [28, 22]}, {"line": [2, 16]}, "close"]
                });
            }
            nodes.insert(id, node);
        }
    }
    nodes.insert("board".into(), json!({
        "id": "board", "kind": "frame", "name": "Board", "width": 1440, "height": 1030, "clip": true,
        "transform": [1, 0, 0, 1, 0, 0],
        "fills": [{"kind": "solid", "color": "#dbe8ef"}],
        "children": children
    }));
    for board in 1..4 {
        let id = format!("board-{board}");
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "frame", "width": 1440, "height": 1030, "clip": true,
            "transform": [1, 0, 0, 1, board as f64 * 1600., 0],
            "fills": [{"kind": "solid", "color": "#e8e8e8"}]
        }));
    }
    json!({
        "schemaVersion": 16, "id": "clipped-reveal", "name": "Clipped reveal",
        "pages": [{"id": "p", "name": "Page", "children": ["board", "board-1", "board-2", "board-3"],
            "background": "#ffffff"}],
        "nodes": nodes
    })
}

fn viewport() -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": VIEW_W, "height": VIEW_H,
        "view": {"x": 0.0, "y": 0.0, "zoom": ZOOM},
        "rasterProfile": "figma", "transparent": false, "grid": false
    }))
    .unwrap()
}

fn tile_rect(address: [i32; 2]) -> Rect {
    Rect::new(address[0] * TILE_SIZE - 1, address[1] * TILE_SIZE - 1, TILE_SIZE as u32 + 2, TILE_SIZE as u32 + 2)
}

fn compile_viewport(engine: &mut Engine, options: &RenderOptions) -> usize {
    let scene = engine.compile_gpu(options).unwrap();
    let packet = scene.into_packet().unwrap();
    black_box(packet.len())
}

fn compile_tile(engine: &mut Engine, options: &RenderOptions, address: [i32; 2]) -> usize {
    let region = tile_rect(address);
    let scene = engine.compile_gpu_region(options, region, Some(region)).unwrap();
    let packet = scene.into_packet().unwrap();
    black_box(packet.len())
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn main() {
    let doc = document();
    let nodes = doc["nodes"].as_object().unwrap().len();
    let doc_json = doc.to_string();
    let options = viewport();
    let visible = [0., 0., VIEW_W as f64 / ZOOM, VIEW_H as f64 / ZOOM];
    let board = [0., 0., 1440., 1030.];
    let limit = 64usize;
    let visible_tiles = raster_addresses(visible, ZOOM, limit, [0., 0.]).unwrap();
    let board_tiles = raster_addresses(board, ZOOM, 256, [0., 0.]).unwrap();
    let reveal = 16. * STEPS as f64;
    let revealed = [0., 0., VIEW_W as f64 / ZOOM + reveal, VIEW_H as f64 / ZOOM];
    let revealed_tiles = raster_addresses(revealed, ZOOM, limit, [0., 0.]).unwrap();
    let visible_set: std::collections::BTreeSet<_> = visible_tiles.iter().copied().collect();
    let edge: Vec<_> = revealed_tiles.iter().copied().filter(|tile| !visible_set.contains(tile)).collect();
    assert!(!edge.is_empty(), "the drag must expose a tile the viewport did not already cover");

    let mut warm = Engine::new();
    warm.load_document(&doc_json).unwrap();
    black_box(compile_viewport(&mut warm, &options));
    black_box(compile_tile(&mut warm, &options, edge[0]));

    let mut live_totals = Vec::new();
    let mut edge_totals = Vec::new();
    let mut live_samples = Vec::new();
    let mut edge_packets = 0usize;
    let mut live_packets = 0usize;
    for _ in 0..ROUNDS {
        let mut live = Engine::new();
        live.load_document(&doc_json).unwrap();
        // The pose lane needs the render index that the first compile builds.
        // That warmup is not part of the timed drag.
        black_box(compile_viewport(&mut live, &options));
        let mut live_total = 0.;
        for step in 1..=STEPS {
            let x = -(step as f64 * 16.);
            assert!(live
                .apply_interaction_transforms(&[("board".into(), Transform([1., 0., 0., 1., x, 0.]))].into())
                .unwrap());
            let started = Instant::now();
            live_packets = compile_viewport(&mut live, &options);
            let ms = started.elapsed().as_secs_f64() * 1000.;
            live_total += ms;
            live_samples.push(ms);
        }
        live_totals.push(live_total);

        let mut retained = Engine::new();
        retained.load_document(&doc_json).unwrap();
        let started = Instant::now();
        for address in &edge {
            edge_packets = compile_tile(&mut retained, &options, *address);
        }
        edge_totals.push(started.elapsed().as_secs_f64() * 1000.);
    }

    let live_median = median(&mut live_totals);
    let edge_median = median(&mut edge_totals);
    let sample_median = median(&mut live_samples);
    let ratio = edge_median / live_median;

    // CPU pixels for one integer reveal. The wide render is the original
    // document; the fresh render is the moved document. This is Engine raster
    // output, not a GPU tile.
    let pixel_w = 256u32;
    let pixel_h = 128u32;
    let shift = 32i32;
    let pixel_options = serde_json::from_value::<RenderOptions>(json!({
        "pageId": "p", "width": pixel_w, "height": pixel_h,
        "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "rasterProfile": "analytic", "transparent": false, "grid": false
    }))
    .unwrap();
    let mut wide_options = pixel_options.clone();
    wide_options.width = pixel_w + shift as u32;
    let mut pixels = Engine::new();
    pixels.load_document(&doc_json).unwrap();
    let raster_started = Instant::now();
    let wide = pixels.render_device_rect(&wide_options, 0, 0, wide_options.width, pixel_h).unwrap();
    let wide_ms = raster_started.elapsed().as_secs_f64() * 1000.;
    let viewport_started = Instant::now();
    let viewport_pixels = pixels.render_device_rect(&pixel_options, 0, 0, pixel_w, pixel_h).unwrap();
    let viewport_raster_ms = viewport_started.elapsed().as_secs_f64() * 1000.;
    let moved = {
        let mut node = doc.clone();
        node["nodes"]["board"]["transform"] = json!([1, 0, 0, 1, -(shift as f64), 0]);
        let mut engine = Engine::new();
        engine.load_document(&node.to_string()).unwrap();
        engine.render_device_rect(&pixel_options, 0, 0, pixel_w, pixel_h).unwrap()
    };
    let background = {
        let i = 0usize;
        [wide[i], wide[i + 1], wide[i + 2], wide[i + 3]]
    };
    let preview = translate_board(&wide, wide_options.width, pixel_w, pixel_h, (0, 0, 1440, 1030), (-shift, 0), background);
    let pixels_match = preview == moved;
    let viewport_prefix = wide.len() >= viewport_pixels.len()
        && (0..pixel_h as usize).all(|y| {
            let from = y * wide_options.width as usize * 4;
            let to = y * pixel_w as usize * 4;
            wide[from..from + pixel_w as usize * 4] == viewport_pixels[to..to + pixel_w as usize * 4]
        });

    println!("{}", serde_json::to_string_pretty(&json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "arch": std::env::consts::ARCH,
        "nodes": nodes,
        "zoom": ZOOM,
        "viewport": [VIEW_W, VIEW_H],
        "steps": STEPS,
        "rounds": ROUNDS,
        "visibleTiles": visible_tiles.len(),
        "boardTiles": board_tiles.len(),
        "edgeTiles": edge,
        "livePoseCompileMedianMs": sample_median,
        "liveDragMedianMs": live_median,
        "edgeDragMedianMs": edge_median,
        "edgeOverLive": ratio,
        "livePacketBytes": live_packets,
        "edgePacketBytes": edge_packets,
        "cpuWideRasterMs": wide_ms,
        "cpuViewportRasterMs": viewport_raster_ms,
        "cpuViewportMatchesWidePrefix": viewport_prefix,
        "cpuRetainedPreviewMatchesFresh": pixels_match,
        "threshold": 0.5,
        "withinThreshold": ratio <= 0.5,
        "scope": "CPU scene compile, packet encode, and Engine::render_device_rect. GPU draw, Electron, Metal, and display scanout are not measured."
    })).unwrap());
}

fn translate_board(
    cache: &[u8], cache_width: u32, view_width: u32, view_height: u32,
    board: (i32, i32, i32, i32), shift: (i32, i32), background: [u8; 4],
) -> Vec<u8> {
    let mut out = vec![0u8; (view_width * view_height * 4) as usize];
    for y in 0..view_height {
        let row = (y * cache_width * 4) as usize;
        let dest = (y * view_width * 4) as usize;
        let bytes = (view_width * 4) as usize;
        out[dest..dest + bytes].copy_from_slice(&cache[row..row + bytes]);
    }
    let (bx, by, bw, bh) = board;
    for row in by..by + bh {
        for col in bx..bx + bw {
            if col >= 0 && row >= 0 && (col as u32) < view_width && (row as u32) < view_height {
                let i = ((row as u32 * view_width + col as u32) * 4) as usize;
                out[i..i + 4].copy_from_slice(&background);
            }
        }
    }
    let (dx, dy) = shift;
    for y in 0..bh {
        for x in 0..bw {
            let sx = bx + x;
            let sy = by + y;
            let tx = sx + dx;
            let ty = sy + dy;
            if sx < 0 || sy < 0 || tx < 0 || ty < 0 { continue; }
            if (sx as u32) >= cache_width || (sy as u32) >= view_height || (tx as u32) >= view_width || (ty as u32) >= view_height {
                continue;
            }
            let source = ((sy as u32 * cache_width + sx as u32) * 4) as usize;
            let dest = ((ty as u32 * view_width + tx as u32) * 4) as usize;
            out[dest..dest + 4].copy_from_slice(&cache[source..source + 4]);
        }
    }
    out
}
