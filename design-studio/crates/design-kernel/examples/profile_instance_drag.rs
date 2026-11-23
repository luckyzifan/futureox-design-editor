//! Measure what a top-level component-instance drag recompiles, reinstantiates,
//! and redraws. This is a CPU/software harness. It does not claim hardware
//! WebGPU, Metal, Electron, or desktop frame rates.
//!
//! A transform-only patch of a qualifying instance now keeps the retained pose,
//! so the "patch" timing is no longer a full component resolve. `--perf-full`
//! renames the instance on each sample to force that resolve.
//!
//! Cases:
//! - equality: a transform-only edit of an already resolved instance versus a
//!   full component/layout/text resolve
//! - timing: retained interaction pose versus the ordinary document patch,
//!   then GPU-scene compile and a software redraw
use futureox_design_kernel::{
    components, curve_boolean, editing::DocumentPatch, font::Fonts, layout, scene::Document, Engine,
    RenderOptions,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Instant;

fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, color: &str) -> Value {
    json!({"id":id,"name":id,"kind":"rectangle","width":w,"height":h,
        "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":color}]})
}

fn frame(id: &str, x: f64, y: f64, w: f64, h: f64, children: Vec<String>, clip: bool) -> Value {
    json!({"id":id,"name":id,"kind":"frame","width":w,"height":h,"clip":clip,
        "transform":[1,0,0,1,x,y],"children":children})
}

fn document(nodes: Vec<Value>, roots: &[&str]) -> Document {
    let nodes: serde_json::Map<_, _> = nodes.into_iter().map(|n| (n["id"].as_str().unwrap().to_owned(), n)).collect();
    serde_json::from_value(json!({"schemaVersion":21,"id":"instance-drag","name":"instance drag",
        "pages":[{"id":"page","name":"page","background":"#ffffff","children":roots}],"nodes":nodes})).unwrap()
}

fn symbol(children: usize, shadow: bool) -> Vec<Value> {
    let mut ids = Vec::new();
    let mut nodes = Vec::new();
    for i in 0..children {
        let id = format!("child-{i}");
        let mut n = rect(&id, (i % 4) as f64 * 18., (i / 4) as f64 * 16., 14., 12., "#3d7ea6");
        if shadow && i == 0 {
            n["effects"] = json!([{"kind":"shadow","radius":4,"x":2,"y":3,"spread":0,"color":"#204060","opacity":0.8}]);
        }
        ids.push(id);
        nodes.push(n);
    }
    let mut master = frame("master", 0., 0., 80., 64., ids, false);
    master["component"] = json!({});
    nodes.insert(0, master);
    nodes
}

fn instances(count: usize, children: usize) -> (Document, String) {
    let mut nodes = symbol(children, true);
    let mut ids = Vec::new();
    for i in 0..count {
        let id = format!("instance-{i}");
        let mut n = frame(&id, (i % 10) as f64 * 90. + 8., (i / 10) as f64 * 72. + 8., 80., 64., Vec::new(), true);
        n["instance"] = json!({"componentId":"master","overrides":{},"propertyValues":{}});
        ids.push(id);
        nodes.push(n);
    }
    let board = frame("board", 0., 0., 980., 1800., ids, true);
    nodes.push(board);
    (document(nodes, &["master", "board"]), "instance-0".into())
}

fn plain_groups(count: usize, children: usize) -> (Document, String) {
    let mut nodes = Vec::new();
    let mut ids = Vec::new();
    for g in 0..count {
        let mut kids = Vec::new();
        for i in 0..children {
            let id = format!("g{g}-c{i}");
            let mut n = rect(&id, (i % 4) as f64 * 18., (i / 4) as f64 * 16., 14., 12., "#3d7ea6");
            if i == 0 {
                n["effects"] = json!([{"kind":"shadow","radius":4,"x":2,"y":3,"spread":0,"color":"#204060","opacity":0.8}]);
            }
            kids.push(id.clone());
            nodes.push(n);
        }
        let id = format!("group-{g}");
        nodes.push(frame(&id, (g % 10) as f64 * 90. + 8., (g / 10) as f64 * 72. + 8., 80., 64., kids, true));
        ids.push(id);
    }
    nodes.push(frame("board", 0., 0., 980., 1800., ids, true));
    (document(nodes, &["board"]), "group-0".into())
}

fn resolve_all(doc: &mut Document, fonts: &Fonts) {
    components::resolve(doc).unwrap();
    layout::resolve(doc, fonts).unwrap();
    curve_boolean::resolve(doc).unwrap();
    futureox_design_kernel::font::expand_rich_text(doc, fonts).unwrap();
    doc.validate().unwrap();
}

fn changed_ids(before: &Document, after: &Document) -> Vec<String> {
    let mut ids: Vec<_> = before.nodes.keys().filter(|id| after.nodes.get(*id) != before.nodes.get(*id)).cloned().collect();
    ids.extend(after.nodes.keys().filter(|id| !before.nodes.contains_key(*id)).cloned());
    ids.sort();
    ids
}

fn field_delta(before: &Document, after: &Document, id: &str) -> Vec<String> {
    let (Some(a), Some(b)) = (before.nodes.get(id), after.nodes.get(id)) else { return vec!["missing".into()] };
    let a = serde_json::to_value(a).unwrap();
    let b = serde_json::to_value(b).unwrap();
    let (Some(a), Some(b)) = (a.as_object(), b.as_object()) else { return vec!["non-object".into()] };
    let mut keys: Vec<_> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).cloned().collect();
    keys.sort();
    keys.dedup();
    keys
}

fn equality_case(name: &str, mut doc: Document, id: &str, fonts: &Fonts) -> Value {
    resolve_all(&mut doc, fonts);
    let resolved_nodes = doc.nodes.len();
    let mut pose = doc.clone();
    pose.nodes.get_mut(id).unwrap().transform.0[4] += 17.25;
    pose.nodes.get_mut(id).unwrap().transform.0[5] -= 9.5;
    let mut rebuilt = pose.clone();
    let at = Instant::now();
    resolve_all(&mut rebuilt, fonts);
    let resolve_ms = at.elapsed().as_secs_f64() * 1000.;
    let ids = changed_ids(&pose, &rebuilt);
    let fields: BTreeMap<_, _> = ids.iter().map(|id| (id.clone(), field_delta(&pose, &rebuilt, id))).collect();
    json!({"case":name,"resolvedNodes":resolved_nodes,"resolveMs":resolve_ms,
        "poseMatchesFullResolve":pose==rebuilt,"changed":ids,"fields":fields})
}

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"page","width":160,"height":120,
        "view":{"x":0,"y":0,"zoom":1},"transparent":false,"grid":false,"rasterProfile":"analytic"})).unwrap()
}

fn patch_for(doc: &Document, id: &str, x: f64, y: f64) -> DocumentPatch {
    let mut node = doc.nodes[id].clone();
    node.transform.0[4] = x;
    node.transform.0[5] = y;
    DocumentPatch { nodes: BTreeMap::from([(id.to_owned(), Some(node))]), fields: BTreeMap::new() }
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn drag(label: &str, doc: &Document, id: &str, mode: &str, draw: bool) -> Value {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
    let options = options();
    engine.compile_gpu(&options).unwrap();
    let mut samples = Vec::new();
    let mut accepted = Vec::new();
    let mut build_deltas = Vec::new();
    let mut fragment_deltas = Vec::new();
    for step in 0..10 {
        let x = 30. + step as f64 * 6.5;
        let y = 140. - step as f64 * 3.25;
        let transform = futureox_design_kernel::math::Transform([1., 0., 0., 1., x, y]);
        let builds_before = engine.gpu_compile_cache_stats()["builds"].as_u64().unwrap_or(0);
        let fragments_before = engine.gpu_compile_cache_stats()["fragmentBuilds"].as_u64().unwrap_or(0);
        let at = Instant::now();
        let pose_ok = if mode == "interaction" {
            engine.apply_interaction_transforms(&BTreeMap::from([(id.to_owned(), transform)])).unwrap()
        } else {
            false
        };
        let pose_ms = at.elapsed().as_secs_f64() * 1000.;
        let at = Instant::now();
        let damage = if pose_ok {
            None
        } else {
            Some(engine.apply_document_patch_with_damage(&patch_for(doc, id, x, y)).unwrap())
        };
        let patch_ms = at.elapsed().as_secs_f64() * 1000.;
        let at = Instant::now();
        let scene = engine.compile_gpu(&options).unwrap();
        let compile_ms = at.elapsed().as_secs_f64() * 1000.;
        let at = Instant::now();
        let render_ms = if draw && step == 9 {
            let pixels = engine.render(&options).unwrap();
            std::hint::black_box(pixels.len());
            at.elapsed().as_secs_f64() * 1000.
        } else { 0. };
        let stats = engine.gpu_compile_cache_stats();
        let builds_now = stats["builds"].as_u64().unwrap_or(0);
        let fragments_now = stats["fragmentBuilds"].as_u64().unwrap_or(0);
        let cache_reset = builds_now < builds_before || fragments_now < fragments_before;
        let builds = if cache_reset { builds_now } else { builds_now.saturating_sub(builds_before) };
        let fragments = if cache_reset { fragments_now } else { fragments_now.saturating_sub(fragments_before) };
        if step >= 2 {
            samples.push(json!({"poseMs":pose_ms,"patchMs":patch_ms,"compileMs":compile_ms,"renderMs":render_ms,
                "sceneNodes":scene.nodes.len(),"programBuilds":builds,"fragmentBuilds":fragments,
                "cacheReset":cache_reset,"preparedNodes":stats["preparedNodes"],"retainedNodes":stats["retainedNodes"],
                "damageFull":damage.as_ref().map(|d| d.full)}));
            build_deltas.push(builds as f64);
            fragment_deltas.push(fragments as f64);
        }
        accepted.push(pose_ok);
    }
    json!({"label":label,"mode":mode,"moved":id,"accepted":accepted,
        "medianCompileMs":median(samples.iter().map(|s| s["compileMs"].as_f64().unwrap()).collect()),
        "medianPatchMs":median(samples.iter().map(|s| s["patchMs"].as_f64().unwrap()).collect()),
        "medianPoseMs":median(samples.iter().map(|s| s["poseMs"].as_f64().unwrap()).collect()),
        "medianRenderMs":median(samples.iter().map(|s| s["renderMs"].as_f64().unwrap()).collect()),
        "medianProgramBuilds":median(build_deltas),"medianFragmentBuilds":median(fragment_deltas),
        "samples":samples})
}

fn interchange(doc: &Document, fonts: &Fonts) -> Value {
    let mut resolved = doc.clone();
    resolve_all(&mut resolved, fonts);
    let at = Instant::now();
    let bytes = serde_json::to_vec(&resolved).unwrap().len();
    let json_ms = at.elapsed().as_secs_f64() * 1000.;
    let at = Instant::now();
    let cloned = resolved.clone();
    let clone_ms = at.elapsed().as_secs_f64() * 1000.;
    std::hint::black_box(&cloned);
    json!({"nodes":resolved.nodes.len(),"jsonBytes":bytes,"jsonMs":json_ms,"cloneMs":clone_ms})
}

fn verify(name: &str, doc: &Document, id: &str) -> Value {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
    let options = options();
    engine.compile_gpu(&options).unwrap();
    let transform = futureox_design_kernel::math::Transform([0.6, 0.8, -0.8, 0.6, 36.5, 22.25]);
    let accepted = engine.apply_interaction_transforms(&BTreeMap::from([(id.to_owned(), transform)])).unwrap();
    if !accepted {
        return json!({"case":name,"accepted":false});
    }
    let scene = engine.compile_gpu(&options).unwrap().into_packet().unwrap();
    let pixels = engine.render(&options).unwrap();
    let mut authored = doc.clone();
    authored.nodes.get_mut(id).unwrap().transform = transform;
    let mut fresh = Engine::new();
    fresh.load_document(&serde_json::to_string(&authored).unwrap()).unwrap();
    let fresh_scene = fresh.compile_gpu(&options).unwrap().into_packet().unwrap();
    let fresh_pixels = fresh.render(&options).unwrap();
    json!({"case":name,"accepted":true,"sceneMatch":scene==fresh_scene,"pixelsMatch":pixels==fresh_pixels,"pixelBytes":pixels.len()})
}

fn perf_loop(mode: &str) {
    let (doc, id) = instances(48, 16);
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let options = options();
    engine.compile_gpu(&options).unwrap();
    let frames: usize = std::env::var("INSTANCE_DRAG_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    for step in 0..frames {
        let x = 12. + step as f64 * 3.5;
        let y = 18. + (step % 5) as f64;
        let transform = futureox_design_kernel::math::Transform([1., 0., 0., 1., x, y]);
        let accepted = mode == "pose" && engine.apply_interaction_transforms(&BTreeMap::from([(id.clone(), transform)])).unwrap();
        if !accepted {
            let mut patch = patch_for(&doc, &id, x, y);
            if mode == "full" {
                // Defeat the transform-only proof so this loop still pays instance resolution.
                patch.nodes.get_mut(&id).unwrap().as_mut().unwrap().name = format!("moved-{step}");
            }
            engine.apply_document_patch_with_damage(&patch).unwrap();
        }
        std::hint::black_box(engine.compile_gpu(&options).unwrap().nodes.len());
    }
    println!("{{\"perf\":true,\"mode\":\"{mode}\"}}");
}

fn main() {
    if let Some(mode) = std::env::args().nth(1) {
        if mode == "--perf-pose" || mode == "--perf-patch" || mode == "--perf-full" {
            perf_loop(mode.trim_start_matches("--perf-"));
            return;
        }
    }
    let fonts = Fonts::new();
    let mut equality = Vec::new();
    let (plain, id) = instances(1, 8);
    equality.push(equality_case("plain-symbol", plain, &id, &fonts));
    let mut nodes = symbol(4, false);
    let icon = rect("icon-shape", 4., 4., 10., 10., "#d45500");
    nodes.push(icon.clone());
    let mut icon_master = frame("icon", 200., 0., 20., 20., vec!["icon-shape".into()], false);
    icon_master["component"] = json!({});
    nodes.push(icon_master);
    nodes[0]["children"].as_array_mut().unwrap().push(json!("nested"));
    nodes.push(json!({"id":"nested","name":"nested","kind":"frame","width":20,"height":20,
        "transform":[1,0,0,1,4,4],"instance":{"componentId":"icon"},"children":[]}));
    let mut inst = frame("instance-0", 40., 80., 80., 64., Vec::new(), true);
    inst["instance"] = json!({"componentId":"master","overrides":{"child-0":{"fills":[{"kind":"solid","color":"#11aa55"}]}},"propertyValues":{}});
    nodes.push(inst);
    equality.push(equality_case("nested-instance-and-override", document(nodes, &["master", "icon", "instance-0"]), "instance-0", &fonts));
    let mut nodes = symbol(3, false);
    nodes[0]["layout"] = json!({"mode":"horizontal"});
    let mut inst = frame("instance-0", 30., 90., 80., 64., Vec::new(), false);
    inst["instance"] = json!({"componentId":"master"});
    nodes.push(inst);
    equality.push(equality_case("auto-layout-symbol", document(nodes, &["master", "instance-0"]), "instance-0", &fonts));
    let mut label = rect("label", 4., 4., 40., 16., "#222222");
    label["kind"] = json!("text");
    label["text"] = json!("Label");
    label["fontSize"] = json!(14);
    let mut master = frame("master", 0., 0., 80., 40., vec!["label".into()], false);
    master["component"] = json!({});
    let mut inst = frame("instance-0", 20., 70., 80., 40., Vec::new(), false);
    inst["instance"] = json!({"componentId":"master"});
    let text_doc = document(vec![master, label, inst], &["master", "instance-0"]);
    let font_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf");
    if let Ok(bytes) = std::fs::read(font_path) {
        let mut fonts = Fonts::new();
        fonts.load(&bytes).unwrap();
        equality.push(equality_case("text-symbol", text_doc, "instance-0", &fonts));
    } else {
        equality.push(json!({"case":"text-symbol","skipped":true}));
    }

    let (small, small_id) = instances(1, 16);
    let (mid, mid_id) = instances(48, 16);
    let (wide, wide_id) = instances(240, 12);
    let (groups, group_id) = plain_groups(48, 16);
    println!("{}", serde_json::to_string_pretty(&json!({
        "tier":"CPU isolated + software raster. hardware WebGPU, macOS, Metal, Electron, official desktop: NOT_RUN",
        "profile":"desktop-dev opt-level 1, not release and not a hardware GPU",
        "equality":equality,
        "oracle":[
            verify("plain-symbol",&instances(1,8).0,"instance-0"),
            verify("plain-group",&plain_groups(1,8).0,"group-0")
        ],
        "interchange":{"one":interchange(&small,&fonts),"fortyEight":interchange(&mid,&fonts),"twoForty":interchange(&wide,&fonts),"plainGroups48":interchange(&groups,&fonts)},
        "drag":[
            drag("instance-1", &small, &small_id, "patch", true),
            drag("instance-1", &small, &small_id, "interaction", true),
            drag("instance-48", &mid, &mid_id, "patch", true),
            drag("instance-48", &mid, &mid_id, "interaction", true),
            drag("instance-240", &wide, &wide_id, "patch", false),
            drag("instance-240", &wide, &wide_id, "interaction", false),
            drag("plain-group-48", &groups, &group_id, "patch", false),
            drag("plain-group-48", &groups, &group_id, "interaction", false)
        ]
    })).unwrap());
}
