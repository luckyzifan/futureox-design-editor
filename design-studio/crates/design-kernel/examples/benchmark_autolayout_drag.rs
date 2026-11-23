//! Auto-layout / stack / flex drag stages on the CPU.
//!
//! Measures layout solve, JSON interchange, damage classification, scene
//! preparation and a software raster rectangle. This is not hardware WebGPU,
//! Metal, Electron, or a presented frame rate.
//!
//! Setup, fixture hashing and the fresh-engine packet oracle sit outside the
//! timed windows. Samples are batch-free single gestures after a fixed warmup.

use futureox_design_kernel::{
    Engine, RenderOptions,
    dirty_region::patch_damage,
    editing::DocumentPatch,
    font::Fonts,
    layout,
    scene::Document,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

fn stats(mut values: Vec<f64>) -> Value {
    if values.is_empty() {
        return json!({"p50Ms": null, "p95Ms": null, "samples": 0});
    }
    values.sort_by(f64::total_cmp);
    json!({
        "p50Ms": values[values.len() / 2],
        "p95Ms": values[(values.len() - 1) * 95 / 100],
        "minMs": values[0],
        "maxMs": values[values.len() - 1],
        "samples": values.len(),
    })
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, fill: bool) -> Value {
    let mut node = json!({
        "id": id,
        "kind": "rectangle",
        "name": id,
        "width": w,
        "height": h,
        "transform": [1, 0, 0, 1, x, y],
        "fills": [{"kind": "solid", "color": if fill { "#3d7ea6" } else { "#d08a3e" }}]
    });
    if fill {
        node["sizing"] = json!({"width": "fill", "height": "fixed"});
    }
    node
}

/// Page-level horizontal stack plus an outer vertical stack that contains a
/// nested horizontal frame. Cold rectangles sit beside them so interchange and
/// scene preparation can scale independently of the layout island.
fn fixture(children: usize, cold: usize) -> Document {
    let mut nodes = serde_json::Map::new();
    let mut page = vec!["stack".to_string(), "outer".to_string()];
    let mut stack_children = Vec::new();
    for i in 0..children {
        let id = format!("s{i:03}");
        stack_children.push(id.clone());
        nodes.insert(id.clone(), rect(&id, 0., 0., 36., 28., i % 2 == 1));
    }
    nodes.insert(
        "stack".into(),
        json!({
            "id": "stack", "kind": "frame", "name": "stack",
            "width": 160. + children as f64 * 90., "height": 96.,
            "transform": [1, 0, 0, 1, 48, 48],
            "fills": [{"kind": "solid", "color": "#f4f1ea"}],
            "layout": {"mode": "horizontal", "padding": [8, 8, 8, 8], "gap": 8, "lineGap": 4},
            "children": stack_children
        }),
    );
    nodes.insert("inner".into(), rect("inner", 0., 0., 80., 36., false));
    nodes.insert("tail".into(), rect("tail", 0., 0., 80., 36., false));
    nodes.insert(
        "outer".into(),
        json!({
            "id": "outer", "kind": "frame", "name": "outer",
            "width": 240., "height": 220.,
            "transform": [1, 0, 0, 1, 760, 48],
            "fills": [{"kind": "solid", "color": "#efe7f6"}],
            "layout": {"mode": "vertical", "padding": [8, 8, 8, 8], "gap": 12, "lineGap": 4},
            "children": ["inner", "tail"]
        }),
    );
    for i in 0..cold {
        let id = format!("cold{i:05}");
        page.push(id.clone());
        let x = 48. + (i % 80) as f64 * 18.;
        let y = 420. + (i / 80) as f64 * 18.;
        nodes.insert(id.clone(), rect(&id, x, y, 12., 12., false));
    }
    let mut doc: Document = serde_json::from_value(json!({
        "schemaVersion": 1,
        "id": "autolayout-drag",
        "name": "Auto-layout drag",
        "pages": [{"id": "p", "name": "Page", "children": page, "background": "#ffffff"}],
        "nodes": nodes
    }))
    .expect("fixture");
    doc.validate().expect("fixture validates");
    layout::resolve(&mut doc, &Fonts::new()).expect("initial solve");
    doc.validate().expect("solved fixture validates");
    doc
}

fn child_locals(doc: &Document, id: &str) -> Vec<(String, [f64; 6], f64, f64)> {
    doc.nodes[id]
        .children
        .iter()
        .map(|child| {
            let n = &doc.nodes[child];
            (child.clone(), n.transform.0, n.width, n.height)
        })
        .collect()
}

fn locals_delta(before: &[(String, [f64; 6], f64, f64)], after: &[(String, [f64; 6], f64, f64)]) -> f64 {
    before
        .iter()
        .zip(after)
        .map(|(a, b)| {
            a.1.iter().zip(b.1).map(|(x, y)| (x - y).abs()).fold(0., f64::max)
                .max((a.2 - b.2).abs())
                .max((a.3 - b.3).abs())
        })
        .fold(0., f64::max)
}

fn time_ms(mut body: impl FnMut()) -> f64 {
    let start = Instant::now();
    body();
    start.elapsed().as_secs_f64() * 1000.
}

fn measure(mut body: impl FnMut(), warmup: usize, samples: usize) -> Value {
    for _ in 0..warmup {
        body();
    }
    let mut values = Vec::with_capacity(samples);
    for _ in 0..samples {
        values.push(time_ms(&mut body));
    }
    stats(values)
}

fn options() -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p",
        "width": 960,
        "height": 540,
        "view": {"x": 0, "y": 0, "zoom": 1},
        "grid": false
    }))
    .expect("render options")
}

fn compile_request() -> String {
    // Production GPU crops are one tile plus the gutter (512+2). A larger
    // viewport is rejected before preparation, so this matches the existing
    // native preparation benchmark instead of inventing a full-frame GPU pass.
    json!({
        "pageId": "p",
        "width": 514,
        "height": 514,
        "view": {"x": 0.125, "y": 0.375, "zoom": 1},
        "rasterProfile": "figmaSubpixel",
        "gpuViewport": {"x": -1, "y": -1, "w": 514, "h": 514},
        "prepareViewport": {"x": -32, "y": -32, "w": 1100, "h": 1400}
    })
    .to_string()
}

fn damage_summary(before: &Document, after: &Document) -> Value {
    let patch = DocumentPatch::between(before, after).expect("patch");
    let started = Instant::now();
    let damage = patch_damage(before, after, &patch);
    let ms = started.elapsed().as_secs_f64() * 1000.;
    let area = damage.bounds.map(|b| b[2] * b[3]);
    json!({
        "classifyMs": ms,
        "patchNodes": patch.nodes.len(),
        "full": damage.full,
        "reason": damage.reason,
        "bounds": damage.bounds,
        "boundsArea": area,
        "translationOnly": damage.translation_only,
    })
}

fn geometry(doc: &Document, ids: &[String]) -> Vec<(String, [u64; 6], u64, u64)> {
    ids.iter().map(|id| {
        let n = &doc.nodes[id];
        (id.clone(), n.transform.0.map(f64::to_bits), n.width.to_bits(), n.height.to_bits())
    }).collect()
}

fn island_document(doc: &Document, root: &str, frame: &str, next_children: Vec<String>) -> Document {
    let mut nodes = serde_json::Map::new();
    fn walk(doc: &Document, id: &str, frame: &str, next: &[String], nodes: &mut serde_json::Map<String, Value>) {
        let mut value = serde_json::to_value(&doc.nodes[id]).expect("node");
        if id == frame {
            value["children"] = json!(next);
        }
        let children: Vec<String> = value.get("children").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
        nodes.insert(id.to_string(), value);
        for child in children {
            if !nodes.contains_key(&child) { walk(doc, &child, frame, next, nodes); }
        }
    }
    walk(doc, root, frame, &next_children, &mut nodes);
    serde_json::from_value(json!({
        "schemaVersion": doc.schema_version,
        "id": doc.id,
        "name": doc.name,
        "pages": [{"id": "p", "name": "Page", "children": [root], "background": "#ffffff"}],
        "nodes": nodes
    })).expect("island")
}

/// The same root rule as layoutFlowIsland: the highest layout or hug ancestor.
fn reflow_root(doc: &Document, id: &str) -> String {
    let parents: std::collections::BTreeMap<&str, &str> = doc.nodes.iter()
        .flat_map(|(id, n)| n.children.iter().map(move |child| (child.as_str(), id.as_str())))
        .chain(doc.pages.iter().flat_map(|page| page.children.iter().map(move |child| (child.as_str(), page.id.as_str()))))
        .collect();
    let mut root = id.to_string();
    let mut at = parents.get(id).copied();
    let mut seen = std::collections::BTreeSet::from([id.to_string()]);
    while let Some(parent) = at {
        if !seen.insert(parent.to_string()) { break; }
        if let Some(node) = doc.nodes.get(parent) {
            let layout = node.layout.as_ref().is_some_and(|l| l.mode != layout::Flow::None);
            let hug = node.sizing.as_ref().is_some_and(|s| s.width == layout::SizeMode::Hug || s.height == layout::SizeMode::Hug);
            if layout || hug { root = parent.to_string(); }
            at = parents.get(parent).copied();
        } else { break; }
    }
    root
}

fn assert_island_matches_full() -> Result<(), String> {
    let cold = fixture(8, 12);
    let original = cold.nodes["stack"].children.clone();
    let mut reordered = original.clone();
    let moved = reordered.pop().unwrap();
    reordered.insert(0, moved);
    let root = reflow_root(&cold, "stack");
    if root != "stack" { return Err(format!("page stack root was {root}")); }
    let mut full = cold.clone();
    full.nodes.get_mut("stack").unwrap().children = reordered.clone();
    layout::resolve(&mut full, &Fonts::new()).map_err(|e| e.to_string())?;
    let mut island = island_document(&cold, &root, "stack", reordered);
    layout::resolve(&mut island, &Fonts::new()).map_err(|e| e.to_string())?;
    let ids: Vec<_> = std::iter::once("stack".to_string()).chain(original).collect();
    if geometry(&full, &ids) != geometry(&island, &ids) {
        return Err("reorder island diverged from the full solve".into());
    }
    for id in cold.pages[0].children.iter().filter(|id| id.starts_with("cold")) {
        if cold.nodes[id].transform.0 != full.nodes[id].transform.0 || cold.nodes[id].width != full.nodes[id].width {
            return Err(format!("cold node {id} moved during a stack reorder"));
        }
    }

    let mut wrap = fixture(0, 0);
    // Replace the generated stack with a wrapping row whose order changes the line count.
    let narrow = |id: &str, width: f64| rect(id, 0., 0., width, 20., false);
    for (id, width) in [("w0", 40.), ("w1", 80.), ("w2", 40.)] {
        wrap.nodes.insert(id.into(), serde_json::from_value(narrow(id, width)).unwrap());
    }
    let stack = serde_json::from_value::<futureox_design_kernel::scene::Node>(json!({
        "id": "wrap", "kind": "frame", "name": "wrap", "width": 100., "height": 40.,
        "fills": [{"kind": "solid", "color": "#f4f1ea"}],
        "layout": {"mode": "horizontal", "wrap": true, "padding": [0, 0, 0, 0], "gap": 0, "lineGap": 0},
        "sizing": {"width": "fixed", "height": "hug"},
        "children": ["w0", "w1", "w2"]
    })).unwrap();
    let outer = serde_json::from_value::<futureox_design_kernel::scene::Node>(json!({
        "id": "outer2", "kind": "frame", "name": "outer2", "width": 120., "height": 80.,
        "transform": [1, 0, 0, 1, 20, 20],
        "fills": [{"kind": "solid", "color": "#efe7f6"}],
        "layout": {"mode": "vertical", "padding": [0, 0, 0, 0], "gap": 0, "lineGap": 0},
        "sizing": {"width": "fixed", "height": "hug"},
        "children": ["wrap", "tail2"]
    })).unwrap();
    wrap.nodes.insert("tail2".into(), serde_json::from_value(rect("tail2", 0., 0., 30., 16., false)).unwrap());
    wrap.nodes.insert("wrap".into(), stack);
    wrap.nodes.insert("outer2".into(), outer);
    wrap.pages[0].children = vec!["outer2".into()];
    // Drop the fixture stack so the page is only this nest. Keep the nodes map
    // otherwise; the page list is what the solver walks.
    layout::resolve(&mut wrap, &Fonts::new()).map_err(|e| e.to_string())?;
    let packed_tail = wrap.nodes["tail2"].transform.0[5];
    let mut shifted = wrap.clone();
    shifted.nodes.get_mut("wrap").unwrap().children = vec!["w0".into(), "w2".into(), "w1".into()];
    let mut shifted_full = shifted.clone();
    layout::resolve(&mut shifted_full, &Fonts::new()).map_err(|e| e.to_string())?;
    let shifted_tail = shifted_full.nodes["tail2"].transform.0[5];
    if (shifted_tail - packed_tail).abs() < 1. {
        return Err(format!("wrap reorder did not move the tail: {packed_tail} -> {shifted_tail}"));
    }
    let root = reflow_root(&shifted, "wrap");
    if root != "outer2" { return Err(format!("wrap root was {root}")); }
    let mut shifted_island = island_document(&shifted, &root, "wrap", vec!["w0".into(), "w2".into(), "w1".into()]);
    layout::resolve(&mut shifted_island, &Fonts::new()).map_err(|e| e.to_string())?;
    let watch = ["outer2".into(), "wrap".into(), "w0".into(), "w1".into(), "w2".into(), "tail2".into()];
    if geometry(&shifted_full, &watch) != geometry(&shifted_island, &watch) {
        return Err("wrapping hug island diverged from the full solve".into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    assert_island_matches_full()?;
    let warmup = 2usize;
    let samples = 7usize;
    let mut rows = Vec::new();
    for (children, cold) in [(32usize, 0usize), (32, 3000)] {
        let base = fixture(children, cold);
        let solved_children = child_locals(&base, "stack");
        let mut translated = base.clone();
        translated.nodes.get_mut("stack").unwrap().transform.0[4] += 17.;
        let mut translated_solved = translated.clone();
        layout::resolve(&mut translated_solved, &Fonts::new())?;
        let translation_child_delta = locals_delta(&solved_children, &child_locals(&translated_solved, "stack"));

        let mut resized = base.clone();
        resized.nodes.get_mut("stack").unwrap().width += 48.;
        let mut resized_solved = resized.clone();
        layout::resolve(&mut resized_solved, &Fonts::new())?;
        let resize_child_delta = locals_delta(&solved_children, &child_locals(&resized_solved, "stack"));
        if resize_child_delta < 1. {
            return Err(format!("fill children did not resize with the frame (delta {resize_child_delta})").into());
        }

        let mut reordered = base.clone();
        {
            let children = &mut reordered.nodes.get_mut("stack").unwrap().children;
            let last = children.pop().expect("stack child");
            children.insert(0, last);
        }
        let mut reordered_solved = reordered.clone();
        layout::resolve(&mut reordered_solved, &Fonts::new())?;
        let reorder_child_delta = locals_delta(&solved_children, &child_locals(&reordered_solved, "stack"));

        let full_json = serde_json::to_string(&base)?;
        let island = island_of(&base, "stack");
        let island_json = serde_json::to_string(&island)?;
        let resized_json = serde_json::to_string(&resized)?;
        let resized_island_json = serde_json::to_string(&island_of(&resized, "stack"))?;

        let clone_resize = measure(|| { black_box(resized.clone()); }, warmup, samples);
        let resolve_resize = measure(
            || {
                let mut doc = resized.clone();
                layout::resolve(&mut doc, &Fonts::new()).unwrap();
                black_box(doc.nodes["s001"].width);
            },
            warmup,
            samples,
        );
        let resolve_reorder = measure(
            || {
                let mut doc = reordered.clone();
                layout::resolve(&mut doc, &Fonts::new()).unwrap();
                black_box(doc.nodes["s000"].transform.0[4]);
            },
            warmup,
            samples,
        );
        let resolve_translate = measure(
            || {
                let mut doc = translated.clone();
                layout::resolve(&mut doc, &Fonts::new()).unwrap();
                black_box(doc.nodes["stack"].transform.0[4]);
            },
            warmup,
            samples,
        );
        let changes_full = measure(
            || {
                let patch = layout::changes(&resized_json, &Fonts::new()).unwrap();
                black_box(patch.len());
            },
            warmup,
            samples,
        );
        let changes_island = measure(
            || {
                let patch = layout::changes(&resized_island_json, &Fonts::new()).unwrap();
                black_box(patch.len());
            },
            warmup,
            samples,
        );
        let full_patch: Value = serde_json::from_str(&layout::changes(&resized_json, &Fonts::new())?)?;
        let island_patch: Value = serde_json::from_str(&layout::changes(&resized_island_json, &Fonts::new())?)?;
        let island_matches = stack_patch_matches(&full_patch, &island_patch);

        let mut engine = Engine::new();
        engine.load_document(&full_json)?;
        let request = compile_request();
        let warm_packet = engine.compile_gpu_request(&request)?.into_packet()?;
        let pose = {
            let mut accepted = None;
            let pose_ms = measure(
                || {
                    let mut shift = base.nodes["stack"].transform;
                    shift.0[4] += 17.;
                    let transforms = [("stack".to_string(), shift)].into_iter().collect();
                    accepted = Some(engine.apply_interaction_transforms(&transforms).unwrap());
                    if accepted == Some(true) {
                        let back = [("stack".to_string(), base.nodes["stack"].transform)].into_iter().collect();
                        assert!(engine.apply_interaction_transforms(&back).unwrap());
                    }
                },
                warmup,
                samples,
            );
            json!({"accepted": accepted, "roundTripMs": pose_ms})
        };
        // The loop above leaves the frame at its solved origin when the pose is accepted.
        let nested = {
            let mut shift = base.nodes["inner"].transform;
            shift.0[4] += 9.;
            let transforms = [("inner".to_string(), shift)].into_iter().collect();
            engine.apply_interaction_transforms(&transforms)
        };

        let engine_warmup = 1;
        let engine_samples = 3;
        let resize_engine = engine_drag(&full_json, &request, &base, &resized_solved, engine_warmup, engine_samples)?;
        let reorder_engine = engine_drag(&full_json, &request, &base, &reordered_solved, engine_warmup, engine_samples)?;
        let translate_engine = engine_drag(&full_json, &request, &base, &translated, engine_warmup, engine_samples)?;

        let mut raster_engine = Engine::new();
        raster_engine.load_document(&serde_json::to_string(&resized_solved)?)?;
        let raster_options = options();
        let local_raster = time_ms(|| {
            black_box(raster_engine.render_device_rect(&raster_options, 48, 48, 160, 96).unwrap());
        });
        let wide_raster = time_ms(|| {
            black_box(raster_engine.render_device_rect(&raster_options, 0, 0, 960, 540).unwrap());
        });

        rows.push(json!({
            "children": children,
            "cold": cold,
            "nodes": base.nodes.len(),
            "fullJsonBytes": full_json.len(),
            "islandJsonBytes": island_json.len(),
            "translationChildLocalDelta": translation_child_delta,
            "resizeChildLocalDelta": resize_child_delta,
            "reorderChildLocalDelta": reorder_child_delta,
            "resizePatchKeys": full_patch.as_object().map(|m| m.len()),
            "islandResizePatchKeys": island_patch.as_object().map(|m| m.len()),
            "islandPatchMatchesStack": island_matches,
            "cloneResizedDocument": clone_resize,
            "resolveResizeIncludingClone": resolve_resize,
            "resolveReorder": resolve_reorder,
            "resolveTranslate": resolve_translate,
            "changesFullResize": changes_full,
            "changesIslandResize": changes_island,
            "damageResizeSolved": damage_summary(&base, &resized_solved),
            "damageResizeAuthoredOnly": damage_summary(&base, &resized),
            "damageReorderSolved": damage_summary(&base, &reordered_solved),
            "damageTranslateFrameOnly": damage_summary(&base, &translated),
            "interactionFrame": pose,
            "interactionNestedChildAccepted": nested.as_ref().ok().copied(),
            "interactionNestedChildError": nested.as_ref().err().map(|e| e.to_string()),
            "engineResize": resize_engine,
            "engineReorder": reorder_engine,
            "engineTranslateAuthored": translate_engine,
            "softwareRaster": {"localRectMs": local_raster, "viewportMs": wide_raster, "note": "CPU render_device_rect, not GPU present"},
            "warmPacketSha256": hash_bytes(&warm_packet),
        }));
        eprintln!("{}", rows.last().expect("row"));
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "optimized" },
        "optLevel": std::env::var("OPT_LEVEL").ok(),
        "arch": std::env::consts::ARCH,
        "scope": "Native CPU. Layout solve vs JSON interchange vs damage vs scene preparation vs software raster. No hardware WebGPU, Metal, Electron, or presented FPS.",
        "notRun": ["hardware WebGPU", "macOS", "Metal", "Electron", "official desktop", "/dev/dri"],
        "rows": rows
    }))?);
    Ok(())
}

fn island_of(doc: &Document, root: &str) -> Document {
    let mut nodes = serde_json::Map::new();
    fn walk(doc: &Document, id: &str, nodes: &mut serde_json::Map<String, Value>) {
        nodes.insert(id.to_string(), serde_json::to_value(&doc.nodes[id]).expect("node"));
        for child in &doc.nodes[id].children {
            walk(doc, child, nodes);
        }
    }
    walk(doc, root, &mut nodes);
    serde_json::from_value(json!({
        "schemaVersion": doc.schema_version,
        "id": doc.id,
        "name": doc.name,
        "pages": [{"id": "p", "name": "Page", "children": [root], "background": "#ffffff"}],
        "nodes": nodes
    }))
    .expect("island")
}

fn stack_patch_matches(full: &Value, island: &Value) -> bool {
    let Some(full) = full.as_object() else { return false };
    let Some(island) = island.as_object() else { return false };
    full.iter().filter(|(id, _)| id.starts_with('s') || id.as_str() == "stack").all(|(id, value)| island.get(id) == Some(value))
        && island.iter().filter(|(id, _)| id.starts_with('s') || id.as_str() == "stack").all(|(id, value)| full.get(id) == Some(value))
}

fn engine_drag(
    original_json: &str,
    request: &str,
    before: &Document,
    after: &Document,
    warmup: usize,
    samples: usize,
) -> Result<Value, Box<dyn std::error::Error>> {
    let patch = DocumentPatch::between(before, after)?;
    let mut apply_ms = Vec::new();
    let mut compile_ms = Vec::new();
    let mut full = None;
    let mut reason = None;
    let mut packet = None;
    for sample in 0..(warmup + samples) {
        let mut engine = Engine::new();
        engine.load_document(original_json)?;
        engine.compile_gpu_request(request)?;
        let start = Instant::now();
        let damage = engine.apply_document_patch_with_damage(&patch)?;
        let applied = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        let compiled = engine.compile_gpu_request(request)?.into_packet()?;
        let compiled_ms = start.elapsed().as_secs_f64() * 1000.;
        if sample >= warmup {
            apply_ms.push(applied);
            compile_ms.push(compiled_ms);
            full = Some(damage.full);
            reason = damage.reason.map(str::to_string);
            packet = Some(compiled);
        }
    }
    let mut fresh = Engine::new();
    fresh.load_document(&serde_json::to_string(after)?)?;
    let fresh_packet = fresh.compile_gpu_request(request)?.into_packet()?;
    let got = packet.unwrap_or_default();
    Ok(json!({
        "apply": stats(apply_ms),
        "compileAfter": stats(compile_ms),
        "damageFull": full,
        "damageReason": reason,
        "packetMatchesFresh": got == fresh_packet,
        "packetBytes": got.len(),
    }))
}
