use super::*;
use crate::scene::Document;
#[path = "../../tests/support/frame_scene.rs"]
mod wire;
fn document() -> Document {
    let mut doc:Document=serde_json::from_value(json!({"schemaVersion":20,"id":"source","name":"source","pages":[{"id":"page","name":"page","children":["stage"],"background":"#ffffff"}],"nodes":{
        "stage":{"id":"stage","kind":"frame","width":3000,"height":2000,"children":["a","b","c"],"blend":"pass-through"},
        "a":{"id":"a","kind":"rectangle","width":100,"height":100,"transform":[1,0,0,1,500,500],"fills":[{"kind":"solid","color":"#ff0011","opacity":0.7}]},
        "b":{"id":"b","kind":"rectangle","width":100,"height":100,"transform":[1,0,0,1,1500,500],"fills":[{"kind":"solid","color":"#0011ff"}]},
        "c":{"id":"c","kind":"rectangle","width":100,"height":100,"transform":[1,0,0,1,2500,500],"fills":[{"kind":"solid","color":"#11ff00"}]}
    }})).unwrap();
    doc.color_management = Some(Default::default());
    doc
}
fn request(x: f64, y: f64, zoom: f64) -> Value {
    json!({"pageId":"page","width":64,"height":64,"view":{"x":x,"y":y,"zoom":zoom},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":64,"h":64},"prepareViewport":{"x":-64,"y":-64,"w":192,"h":192},"gpuPageBackground":true})
}
fn owner(doc: Document, scope: &str) -> Engine {
    let mut e = Engine::new();
    crate::capacity::with_source_storage_scope(true, || e.load_source_document(doc)).unwrap();
    e.bind_frame_scene_scope(scope).unwrap();
    e
}
fn descriptor(doc: &Document) -> Descriptor {
    Descriptor {
        generation: "source:1:0".into(),
        document_id: doc.id.clone(),
        nodes: doc.nodes.len() as u64,
        bytes: 1,
        footer_hash: [0; 32],
    }
}
fn assert_projection_equivalent(a:&[u8],b:&[u8]) {
        // Camera-independent output support may be more conservative than
        // the old device traversal. It is acceleration metadata, not drawable
        // geometry: compare every other field and geometry word unchanged.
        let mut actual_scene=wire::scene(a);let mut expected_scene=wire::scene(b);
        let support=actual_scene.as_object_mut().unwrap().remove("pagePaintRects");
        expected_scene.as_object_mut().unwrap().remove("pagePaintRects");
        wire::assert_fields(&actual_scene,&expected_scene);
        assert_eq!(wire::geometry_words(a),wire::geometry_words(b));
        if let Some(Value::Array(bounds))=support {
            let viewport=&actual_scene["output"];
            let x=viewport["x"].as_f64().unwrap();let y=viewport["y"].as_f64().unwrap();
            let right=x+viewport["w"].as_f64().unwrap();let bottom=y+viewport["h"].as_f64().unwrap();
            for node in actual_scene["nodes"].as_object().unwrap().values() {
                if ["fills","strokes","effects"].iter().all(|field|node[*field].as_array().is_none_or(|a|a.is_empty())){continue}
                let r=&node["rect"];let x0=r["x"].as_f64().unwrap().max(x);let y0=r["y"].as_f64().unwrap().max(y);
                let x1=(r["x"].as_f64().unwrap()+r["w"].as_f64().unwrap()).min(right);
                let y1=(r["y"].as_f64().unwrap()+r["h"].as_f64().unwrap()).min(bottom);
                if x0>=x1||y0>=y1{continue}
                assert!(bounds.iter().any(|b|b[0].as_f64().unwrap()<=x0&&b[1].as_f64().unwrap()<=y0&&b[2].as_f64().unwrap()>=x1&&b[3].as_f64().unwrap()>=y1),"complete support missed drawn output: {}",node["id"]);
            }
        }
 }
fn compare(
    runtime: &mut Runtime,
    actual: &mut Engine,
    expected: &mut Engine,
    desc: &Descriptor,
    r: &Value,
) -> Vec<u8> {
    crate::capacity::with_source_storage_scope(true, || {
        let a = runtime
            .compile(actual, desc, "stage", "page", &r.to_string())
            .unwrap();
        let b = expected.compile_gpu_packet_request(&r.to_string()).unwrap();
        assert_projection_equivalent(&a,&b);
        a
    })
}
#[test]
fn default_source_compiler_uses_subset_and_reuses_it_across_cameras() {
    let d = document();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d.clone(), "live");
    let mut runtime = Runtime::default();
    let first = compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-480.25, -480.375, 1.),
    );
    assert_eq!(runtime.stats["mode"], "demand");
    assert_eq!(runtime.stats["resolvedCompileNodes"], 2);
    assert_eq!(runtime.stats["projectionRebuilds"], 1);
    assert_eq!(runtime.stats["projectionDecision"], "rebuild");
    let repeat = compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-480.25, -480.375, 1.),
    );
    assert_eq!(first, repeat);
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-510.125, -510.375, 1.),
    );
    assert_eq!(runtime.stats["projectionRebuilds"], 1);
    assert_eq!(runtime.stats["projectionReuses"], 2);
    assert_eq!(runtime.stats["projectionDecision"], "reuse");
    assert_eq!(runtime.stats["globalMarginEvaluations"], 1);
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-1480.25, -480.375, 1.),
    );
    assert_eq!(runtime.stats["projectionRebuilds"], 2);
    assert_eq!(actual.authored_document().unwrap(), &d);
    assert_eq!(actual.doc.as_ref().unwrap().nodes.len(), 4);
}
#[test]
fn analytic_overview_tiles_match_complete_packets_at_adjacent_crops() {
    let mut d = document();
    d.color_management = None;
    d.nodes.get_mut("c").unwrap().effects =
        serde_json::from_value(json!([{"kind":"background-blur","radius":8,"color":"#000000"}]))
            .unwrap();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "analytic-complete");
    let mut actual = owner(d, "analytic-overview");
    let mut runtime = Runtime::default();
    let mut r = request(-240.25, -240.375, 0.5);
    r["rasterProfile"] = json!("analytic");
    for x in [0, 64] {
        r["gpuViewport"]["x"] = json!(x);
        compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
        assert_eq!(runtime.stats["mode"], "demand");
    }
    r["view"]["zoom"] = json!(2.0);
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(runtime.stats["reason"], "request-contract");
}

#[test]
fn analytic_source_projection_preserves_sketch_bitmap_sampling() {
    let mut d = document();
    d.color_management = None;
    d.nodes.get_mut("a").unwrap().fills[0] = serde_json::from_value(json!({
        "kind": "image", "fit": "cover", "color": "#ffffff",
        "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
    })).unwrap();
    d.design_system = serde_json::from_value(json!({
        "sketchContainers": {"nodeMetadata": {"a": {"bindings": {"sketchSourceBitmap": "true"}}}}
    })).unwrap();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "bitmap-complete");
    let mut actual = owner(d, "bitmap-demand");
    let mut runtime = Runtime::default();
    let mut r = request(-240.25, -240.375, 0.5);
    r["rasterProfile"] = json!("analytic");
    let packet = compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(runtime.stats["mode"], "demand");
    assert_eq!(wire::scene(&packet)["nodes"]["a"]["fills"][0]["sketchBitmapSampling"], true);
}

#[test]
fn maximum_ui_zoom_compiles_at_native_dpr_without_relaxing_pixel_budgets() {
    let d=document();let desc=descriptor(&d);
    let mut actual=owner(d.clone(),"high-zoom");let mut expected=owner(d,"high-zoom-reference");
    let mut runtime=Runtime::default();
    for zoom in [128.,256.,512.,768.,1024.] {
        let r=request(-500.*zoom+8.25,-500.*zoom+16.375,zoom);
        compare(&mut runtime,&mut actual,&mut expected,&desc,&r);
        assert_eq!(runtime.stats["mode"],"demand");
    }
    let mut oversized=request(-500.*512.,-500.*512.,512.);
    oversized["gpuViewport"]["w"]=json!(515);
    assert!(runtime.compile(&mut actual,&desc,"stage","page",&oversized.to_string()).is_err());
}
#[test]
fn global_backdrop_flags_margin_and_pointwise_controls_match_complete_packets() {
    for kind in [
        "background-blur",
        "gaussian-blur",
        "shadow",
        "color-controls",
    ] {
        let mut d = document();
        let value = if kind == "color-controls" {
            json!({"kind":kind,"radius":0,"color":"#000000","colorControls":{"brightness":0.2,"contrast":1.5,"saturation":0.7,"hue":0}})
        } else {
            json!({"kind":kind,"radius":8,"x":3.25,"color":"#000000"})
        };
        d.nodes.get_mut("c").unwrap().effects = serde_json::from_value(json!([value])).unwrap();
        let desc = descriptor(&d);
        let mut expected = owner(d.clone(), "oracle");
        let mut actual = owner(d, "live");
        let mut runtime = Runtime::default();
        compare(
            &mut runtime,
            &mut actual,
            &mut expected,
            &desc,
            &request(-480.25, -480.375, 1.),
        );
        assert_eq!(runtime.stats["mode"], "demand", "{kind}");
    }
}
#[test]
fn backdrop_prefix_keeps_earlier_content_and_can_drop_later_content() {
    let mut d = document();
    d.nodes.get_mut("a").unwrap().transform = Transform([1., 0., 0., 1., 1480., 500.]);
    d.nodes.get_mut("b").unwrap().fills[0].opacity = 0.5;
    d.nodes.get_mut("b").unwrap().effects =
        serde_json::from_value(json!([{"kind":"background-blur","radius":8,"color":"#000000"}]))
            .unwrap();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-1480.25, -480.375, 1.),
    );
    assert_eq!(runtime.stats["resolvedCompileNodes"], 3);
}
#[test]
fn complete_fallback_and_projection_share_one_resource_owner() {
    let d = document();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    let r = request(-480.25, -480.375, 1.);
    let first = compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    let mut export = r.clone();
    export["rasterProfile"] = json!("figma");
    compare(&mut runtime, &mut actual, &mut expected, &desc, &export);
    assert_eq!(runtime.stats["mode"], "complete");
    assert!(runtime.stats.get("timingUs").is_none());
    runtime.time_fallbacks = true;
    compare(&mut runtime, &mut actual, &mut expected, &desc, &export);
    assert_eq!(runtime.stats["reason"], "request-contract");
    for phase in ["beforeFallback", "reset", "fullPacket", "restore"] {
        assert!(runtime.stats["timingUs"][phase].is_u64(), "{phase}");
    }
    let returned = compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert!(runtime.stats.get("timingUs").is_none());
    assert_eq!(wire::scope(&first), wire::scope(&returned));
    assert_ne!(first, returned);
    let mut acknowledged = r;
    acknowledged["frameResources"] = json!({"scope":"live","ranges":[[1,u32::MAX]]});
    let packet = crate::capacity::with_source_storage_scope(true, || {
        runtime.compile(
            &mut actual,
            &desc,
            "stage",
            "page",
            &acknowledged.to_string(),
        )
    })
    .unwrap();
    assert_eq!(u32::from_le_bytes(packet[20..24].try_into().unwrap()), 0);
}
#[test]
fn a_failed_or_cancelled_compile_preserves_scope_and_authority() {
    let d = document();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d.clone(), "live");
    let mut runtime = Runtime::default();
    let r = request(-480.25, -480.375, 1.);
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    let mut bad = r.clone();
    bad["frameResources"] = json!({"scope":"live","ranges":[[2,1]]});
    assert!(
        crate::capacity::with_source_storage_scope(true, || runtime.compile(
            &mut actual,
            &desc,
            "stage",
            "page",
            &bad.to_string()
        ))
        .is_err()
    );
    let cancelled = crate::render_cancellation::with_probe(
        || true,
        || runtime.compile(&mut actual, &desc, "stage", "page", &r.to_string()),
    );
    assert!(cancelled.is_err());
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(actual.authored_document().unwrap(), &d);
}
#[test]
fn union_of_tile_crops_and_near_stage_edges_stays_complete() {
    let mut d = document();
    d.nodes.get_mut("c").unwrap().transform = Transform([1., 0., 0., 1., -500., 500.]);
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    let mut r = request(-480.25, -480.375, 1.);
    r["prepareViewport"] = json!({"x":-64,"y":-64,"w":1200,"h":192});
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    r["gpuViewport"] = json!({"x":1000,"y":0,"w":64,"h":64});
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    let outside = request(5000., 5000., 1.);
    compare(&mut runtime, &mut actual, &mut expected, &desc, &outside);
    assert_eq!(runtime.stats["mode"], "demand");
    assert!(runtime.stats["resolvedCompileNodes"].as_u64().unwrap() < desc.nodes);
}

fn bundled_font() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
    )
    .unwrap()
}
#[test]
fn resolved_component_and_glyph_identity_survive_projection_without_relayout() {
    let mut d = document();
    d.nodes.get_mut("b").unwrap().kind = "frame".into();
    d.nodes.get_mut("b").unwrap().component = Some(serde_json::from_value(json!({})).unwrap());
    d.nodes.get_mut("b").unwrap().children = vec!["label".into()];
    d.nodes.insert("label".into(),serde_json::from_value(json!({"id":"label","kind":"text","text":"Topology 字形","width":100,"height":100,"fontSize":18,"fills":[{"kind":"solid","color":"#123456"}]})).unwrap());
    d.nodes.get_mut("a").unwrap().kind = "frame".into();
    d.nodes.get_mut("a").unwrap().instance =
        Some(serde_json::from_value(json!({"componentId":"b","overrides":{}})).unwrap());
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let font = bundled_font();
    expected.load_font(&font).unwrap();
    actual.load_font(&font).unwrap();
    let mut runtime = Runtime::default();
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-480.25, -480.375, 1.),
    );
    assert_eq!(runtime.stats["mode"], "demand");
    for (id, node) in &runtime
        .compiler
        .as_ref()
        .unwrap()
        .doc
        .as_ref()
        .unwrap()
        .nodes
    {
        if id != "stage" {
            assert_eq!(node, &actual.doc.as_ref().unwrap().nodes[id]);
        }
    }
}
#[test]
fn cancellation_inside_packet_compilation_restores_the_shared_resource_owner() {
    let mut inside = 0;
    for cutoff in [1, 4, 8, 12, 20, 32, 48, 64] {
        let d = document();
        let desc = descriptor(&d);
        let mut expected = owner(d.clone(), "oracle");
        let mut actual = owner(d, "live");
        let mut runtime = Runtime::default();
        compare(
            &mut runtime,
            &mut actual,
            &mut expected,
            &desc,
            &request(-480.25, -480.375, 1.),
        );
        runtime.stats = Value::Null;
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let observed = calls.clone();
        let r = request(-490.25, -490.375, 1.);
        let result = crate::capacity::with_source_storage_scope(true, || {
            crate::render_cancellation::with_probe(
                move || {
                    observed.set(observed.get() + 1);
                    observed.get() > cutoff
                },
                || runtime.compile(&mut actual, &desc, "stage", "page", &r.to_string()),
            )
        });
        if result.is_err() && runtime.stats["mode"] == "demand" {
            inside += 1;
        }
        compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    }
    assert!(
        inside > 0,
        "must interrupt after the wire-resource owner was transferred"
    );
}

#[test]
#[ignore = "complete topology native compiler oracle; no GPU device or Electron"]
fn complete_topology_native_entry_compiles_demand_against_full_source_oracle() {
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{BufReader, Read},
    };
    struct Input {
        file: fs::File,
        hash: Sha256,
    }
    impl Read for Input {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            let n = self.file.read(b)?;
            self.hash.update(&b[..n]);
            Ok(n)
        }
    }
    let started = std::time::Instant::now();
    struct Owned(Option<std::path::PathBuf>);
    impl Drop for Owned {
        fn drop(&mut self) {
            if let Some(path) = &self.0 {
                let _ = fs::remove_file(path);
            }
        }
    }
    let mut owned = Owned(None);
    let (document, descriptor, fixture) = if let Ok(path) =
        std::env::var("FUTUREOX_TOPOLOGY_SNAPSHOT")
    {
        let bytes = fs::read(path).unwrap();
        assert_eq!(
            (Sha256::digest(&bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "d41ef73ea643d31c5a83a017755c1ac1024bbfcadca02d66a3bbd8680fc68c36"
        );
        let descriptor: Value = serde_json::from_slice(&bytes).unwrap();
        let store: Descriptor = serde_json::from_value(descriptor["store"].clone()).unwrap();
        let source = std::path::Path::new(descriptor["path"].as_str().unwrap());
        let (document, _) =
            crate::scene_store::Reader::open(source, &store, &AtomicBool::new(false))
                .unwrap()
                .into_document(&AtomicBool::new(false))
                .unwrap();
        let mut stack = vec!["70806B41-C915-4EB2-954C-449E746E4426"];
        let mut gaussian = 0;
        while let Some(id) = stack.pop() {
            let n = &document.nodes[id];
            gaussian += n
                .effects
                .iter()
                .filter(|e| e.kind == "gaussian-blur" && e.visible)
                .count();
            stack.extend(n.children.iter().map(String::as_str));
        }
        assert_eq!(
            gaussian, 9,
            "latest import must retain this material's restored numeric-enabled blurs"
        );
        (
            document,
            descriptor,
            json!({"kind":"latest-complete-scene-store","descriptorHash":"d41ef73ea643d31c5a83a017755c1ac1024bbfcadca02d66a3bbd8680fc68c36","restoredMaterialGaussians":gaussian}),
        )
    } else {
        let source_path =
            std::env::var("FUTUREOX_TOPOLOGY_MODEL").expect("frozen complete topology source");
        let mut input = Input {
            file: fs::File::open(source_path).unwrap(),
            hash: Sha256::new(),
        };
        let document: Document = serde_json::from_reader(BufReader::new(&mut input)).unwrap();
        assert_eq!(
            (input.hash.finalize()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "e1678121c271d815b218cd21c233f9c584dcce3d2246d13870ae4801bee6548e"
        );
        let path = std::env::temp_dir().join(format!(
            "futureox-module3-topology-{}.scene",
            std::process::id()
        ));
        owned.0 = Some(path.clone());
        let desc =
            crate::scene_store::write(&path, "module3:0", &document, &[], &AtomicBool::new(false))
                .unwrap();
        let descriptor = json!({"path":path,"store":desc,"documentId":document.id,"pageId":document.pages[0].id,"stageId":document.pages[0].children[0],"nodes":document.nodes.len()});
        (
            document,
            descriptor,
            json!({"kind":"historical-complete-model","modelHash":"e1678121c271d815b218cd21c233f9c584dcce3d2246d13870ae4801bee6548e"}),
        )
    };
    assert_eq!(document.nodes.len(), 124447);
    let page = document.pages[0].id.clone();
    let stage = document.pages[0].children[0].clone();
    assert_eq!(document.nodes[&stage].children.len(), 306);
    let font = bundled_font();
    let font_hash = (Sha256::digest(&font)).iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut native = crate::preparation::Preparation::new(&font).unwrap();
    eprintln!("topology: source verified and indexed; loading both compiler owners");
    native
        .request("canvas", "load_source_snapshot", &[descriptor])
        .unwrap();
    let mut oracle = owner(document, "topology-oracle");
    oracle.load_font(&font).unwrap();
    let cameras = [
        ("local", -369.2813895642924, -642., 1.),
        ("950pct", -7860.173200860778, -9363.000000000002, 9.5),
        ("backdrop", -1997.2813895642926, -642.0000000000002, 1.),
        ("empty", -16000., -30000., 1.),
        ("pan", -385.5313895642924, -651.375, 1.),
        ("return", -369.2813895642924, -642., 1.),
        (
            "restored-material",
            -45439.99987792969,
            -26364.166015625,
            4.,
        ),
    ];
    let mut reports = vec![];
    let mut demands = 0;
    for (name, x, y, zoom) in cameras {
        let region = if name == "restored-material" {
            json!({"x":0,"y":0,"w":256,"h":192})
        } else {
            json!({"x":256,"y":128,"w":514,"h":514})
        };
        let prepare = if name == "restored-material" {
            json!({"x":-1,"y":-1,"w":258,"h":194})
        } else {
            json!({"x":255,"y":127,"w":516,"h":516})
        };
        let options=json!({"pageId":page,"width":1024,"height":768,"view":{"x":x,"y":y,"zoom":zoom},"rasterProfile":"figmaSubpixel","gpuPageBackground":true,
            "gpuViewport":region,"prepareViewport":prepare}).to_string();
        let t = std::time::Instant::now();
        let expected = crate::capacity::with_source_storage_scope(true, || {
            oracle.compile_gpu_packet_request(&options)
        })
        .unwrap();
        let reference_ms = t.elapsed().as_secs_f64() * 1000.;
        let t = std::time::Instant::now();
        let actual = native
            .request("canvas", "compile_gpu_packet", &[json!(options)])
            .unwrap();
        let actual_ms = t.elapsed().as_secs_f64() * 1000.;
        assert_projection_equivalent(&actual.bytes, &expected);
        if name == "restored-material" && fixture["kind"] == "latest-complete-scene-store" {
            assert!(
                wire::scene(&actual.bytes)["nodes"]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|n| n["effects"].as_array().is_some_and(|effects| effects
                        .iter()
                        .any(|e| e["kind"] == "gaussian-blur"))),
                "must compile restored Gaussian operators in this actual material view"
            );
        }
        let stats = &actual.metadata["compileStats"]["sourceDemand"];
        if stats["mode"] == "demand" {
            demands += 1;
            assert!(stats["residentAuthoredNodes"].as_u64().unwrap() < 124447);
        }
        if name != "empty" {
            assert_eq!(stats["mode"], "demand", "{name}: {stats}");
            assert!(
                wire::scene(&actual.bytes)["nodes"]
                    .as_object()
                    .unwrap()
                    .len()
                    > 1
            );
        }
        let record = json!({"name":name,"camera":[x,y,zoom],"sourceDemand":stats,"compileCache":actual.metadata["compileStats"],"packetEquivalent":true,"packetBytes":actual.bytes.len(),"referenceUnoptimizedMs":reference_ms,"candidateUnoptimizedMs":actual_ms});
        eprintln!("topology case: {}", record);
        reports.push(record);
    }
    assert!(demands >= 4);
    println!(
        "{}",
        json!({"scope":"complete topology source, actual native compile entry; exact packet oracle, no GPU/GUI/performance acceptance","sourceNodes":124447,"roots":306,"fixture":fixture,"fontHash":font_hash,"cases":reports,"seconds":started.elapsed().as_secs_f64()})
    );
}

#[test]
fn global_prepare_padding_does_not_expand_acquisition_and_boolean_raw_children_stay_available() {
    let mut d = document();
    let c = d.nodes.get_mut("c").unwrap();
    c.kind = "vector".into();
    c.boolean_operation = Some(serde_json::from_value(json!("union")).unwrap());
    c.children = vec!["c1".into(), "c2".into()];
    for (id, x) in [("c1", 0.), ("c2", 50.)] {
        d.nodes.insert(id.into(),serde_json::from_value(json!({"id":id,"kind":"rectangle","width":50,"height":50,"transform":[1,0,0,1,x,0],"fills":[{"kind":"solid","color":"#123456"}],"effects":[{"kind":"gaussian-blur","radius":1000,"color":"#000000"}]})).unwrap());
    }
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-480.25, -480.375, 1.),
    );
    assert_eq!(runtime.stats["mode"], "demand");
    assert_eq!(runtime.stats["resolvedCompileNodes"], 2);
    assert!(runtime.stats["globalPadding"].as_i64().unwrap() > 3000);
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-2480.25, -480.375, 1.),
    );
    assert!(
        runtime
            .compiler
            .as_ref()
            .unwrap()
            .doc
            .as_ref()
            .unwrap()
            .nodes
            .contains_key("c1")
    );
}

#[test]
fn offscreen_stage_bounds_do_not_request_an_unobserved_backdrop_prefix() {
    let mut d = document();
    d.nodes.get_mut("c").unwrap().transform = Transform([1., 0., 0., 1., 2995., 500.]);
    d.nodes.get_mut("c").unwrap().effects =
        serde_json::from_value(json!([{"kind":"background-blur","radius":8,"color":"#000000"}]))
            .unwrap();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    compare(
        &mut runtime,
        &mut actual,
        &mut expected,
        &desc,
        &request(-480.25, -480.375, 1.),
    );
    assert_eq!(runtime.stats["mode"], "demand");
    // The edge backdrop misses this tile, so it is not part of the closure.
    assert_eq!(runtime.stats["residentAuthoredNodes"], 2);
    assert!(!runtime.compiler.as_ref().unwrap().doc.as_ref().unwrap().nodes.contains_key("c"));
}
#[test]
fn actual_compile_extent_adds_offscreen_records_before_wire_publication() {
    let mut d = document();
    d.color_management = None;
    d.nodes.get_mut("a").unwrap().effects =
        serde_json::from_value(json!([{"kind":"gaussian-blur","radius":10,"color":"#000000"}]))
            .unwrap();
    let b = d.nodes.get_mut("b").unwrap();
    b.width = 10.;
    b.height = 10.;
    b.transform = Transform([1., 0., 0., 1., 450., 500.]);
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    let mut r = request(-480., -480., 1.);
    r["prepareViewport"] = r["gpuViewport"].clone();
    let first = compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(runtime.stats["scopeExpansions"], 1);
    assert_eq!(runtime.stats["residentAuthoredNodes"], 3);
    let repeated = compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(first, repeated);
    assert_eq!(runtime.stats["projectionRebuilds"], 2);
    assert_eq!(runtime.stats["residentAuthoredNodes"], 3);
}

#[test]
fn backdrop_capture_extent_acquires_offscreen_producers_before_publish() {
    let mut d = document();
    d.color_management = None;
    let a = d.nodes.get_mut("a").unwrap();
    a.width = 10.;
    a.height = 10.;
    a.transform = Transform([1., 0., 0., 1., 455., 500.]);
    let b = d.nodes.get_mut("b").unwrap();
    b.transform = Transform([1., 0., 0., 1., 500., 500.]);
    b.fills[0].opacity = 0.5;
    b.effects =
        serde_json::from_value(json!([{"kind":"background-blur","radius":64,"color":"#000000"}]))
            .unwrap();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    let mut r = request(-480., -480., 1.);
    r["prepareViewport"] = r["gpuViewport"].clone();
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(runtime.stats["scopeExpansions"], 1);
    assert_eq!(runtime.stats["residentAuthoredNodes"], 3);
}

#[test]
fn unknown_capture_policy_keeps_the_complete_compiler() {
    let d = document();
    let desc = descriptor(&d);
    let mut expected = owner(d.clone(), "oracle");
    let mut actual = owner(d, "live");
    let mut runtime = Runtime::default();
    let mut r = request(-480.25, -480.375, 1.);
    r["futureCapturePolicy"] = json!(true);
    compare(&mut runtime, &mut actual, &mut expected, &desc, &r);
    assert_eq!(runtime.stats["mode"], "complete");
}

#[test]
fn exact_source_revisit_skips_projection_and_geometry_but_reissues_resources_and_sequence() {
    let d=document();let desc=descriptor(&d);
    let mut actual=owner(d.clone(),"revisit");let mut expected=owner(d.clone(),"oracle");
    let mut runtime=Runtime::default();
    let a=request(-480.25,-480.375,1.);let b=request(-1480.25,-480.375,1.);
    let first=compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    compare(&mut runtime,&mut actual,&mut expected,&desc,&b);
    let builds=runtime.rebuilds;
    let returned=compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    assert_eq!(runtime.rebuilds,builds,"revisit must not reconstruct a projection");
    assert_eq!(runtime.stats["mode"],"demand-replay");
    assert_projection_equivalent(&returned,&first);
    assert_ne!(first,returned,"revisit publishes a new frame sequence");
    assert_eq!(compare(&mut runtime,&mut actual,&mut expected,&desc,&a),returned);
    assert!(actual.frame_scene.bytes()<=CACHE);
    let mut ack=a.clone();ack["frameResources"]=json!({"scope":"revisit","ranges":[[1,u32::MAX]]});
    let packet=runtime.compile(&mut actual,&desc,"stage","page",&ack.to_string()).unwrap();
    assert_eq!(u32::from_le_bytes(packet[20..24].try_into().unwrap()),0);
    ack["frameResources"]=json!({"scope":"revisit","ranges":[[2,1]]});
    assert!(runtime.compile(&mut actual,&desc,"stage","page",&ack.to_string()).is_err());
    let cancelled=crate::render_cancellation::with_probe(||true,||runtime.compile(&mut actual,&desc,"stage","page",&a.to_string()));
    assert!(cancelled.is_err());
    actual.bind_frame_scene_scope("replacement").unwrap();
    let packet=compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    assert_eq!(wire::scope(&packet),"replacement");
    assert_ne!(runtime.stats["mode"],"demand-replay");
    actual.frame_scene.limit_retention(Some(0));
    assert_eq!(actual.frame_scene.bytes(),0);
    compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    assert_ne!(runtime.stats["mode"],"demand-replay");
}

#[test]
fn source_replay_cannot_cross_revision_or_source_descriptor() {
    let d=document();let mut desc=descriptor(&d);let mut actual=owner(d.clone(),"live");
    let mut expected=owner(d.clone(),"reference");let mut runtime=Runtime::default();let a=request(-480.25,-480.375,1.);
    compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    desc.footer_hash[0]=1;
    compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    assert_ne!(runtime.stats["mode"],"demand-replay");
    let mut changed=d;changed.nodes.get_mut("a").unwrap().opacity=0.25;
    crate::capacity::with_source_storage_scope(true,||actual.load_source_document(changed.clone())).unwrap();
    crate::capacity::with_source_storage_scope(true,||expected.load_source_document(changed)).unwrap();
    compare(&mut runtime,&mut actual,&mut expected,&desc,&a);
    assert_ne!(runtime.stats["mode"],"demand-replay");
}

#[test]
fn a_known_miss_outside_the_stage_stays_out_of_the_tile_and_a_reaching_shadow_stays_in() {
    let mut far = document();
    far.nodes.get_mut("c").unwrap().transform = Transform([1., 0., 0., 1., 20_000., 500.]);
    let desc = descriptor(&far);
    let mut expected = owner(far.clone(), "oracle-far");
    let mut actual = owner(far, "live-far");
    let mut runtime = Runtime::default();
    compare(&mut runtime, &mut actual, &mut expected, &desc, &request(-480.25, -480.375, 1.));
    assert_eq!(runtime.stats["mode"], "demand");
    assert!(runtime.stats["resolvedCompileNodes"].as_u64().unwrap() < desc.nodes);
    assert!(!runtime.compiler.as_ref().unwrap().doc.as_ref().unwrap().nodes.contains_key("c"));

    let mut reaching = document();
    let c = reaching.nodes.get_mut("c").unwrap();
    c.transform = Transform([1., 0., 0., 1., 20_000., 500.]);
    c.effects = serde_json::from_value(json!([{"kind":"shadow","radius":8,"x":-20000,"color":"#000000","opacity":0.8}])).unwrap();
    let desc = descriptor(&reaching);
    let mut expected = owner(reaching.clone(), "oracle-shadow");
    let mut actual = owner(reaching, "live-shadow");
    let mut runtime = Runtime::default();
    compare(&mut runtime, &mut actual, &mut expected, &desc, &request(-480.25, -480.375, 1.));
    assert!(runtime.compiler.as_ref().unwrap().doc.as_ref().unwrap().nodes.contains_key("c"));
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

/// Many authored roots under one neutral stage. The shared prepare window
/// covers every root except the last row and column; each compile is still
/// one 514px tile. A reaching shadow and a component master sit outside the
/// first tile box and must remain in that tile's closure.
fn spread_document(cols: usize, rows: usize, children: usize) -> (Document, String, String, String) {
    let mut doc = document();
    for id in ["a", "b", "c"] {
        doc.nodes.remove(id);
    }
    let pitch = 256.0;
    let mut rect: crate::scene::Node = serde_json::from_value(json!({
        "id": "rect", "kind": "rectangle", "width": 18.0, "height": 12.0,
        "fills": [{"kind": "solid", "color": "#3777cc"}]
    }))
    .unwrap();
    let mut frame: crate::scene::Node = serde_json::from_value(json!({
        "id": "frame", "kind": "frame", "width": 200.0, "height": 160.0,
        "fills": [{"kind": "solid", "color": "#f7f4ee"}]
    }))
    .unwrap();
    let mut stage_children = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            let id = format!("r{row}_{col}");
            let mut kids = Vec::with_capacity(children);
            for index in 0..children {
                let child = format!("{id}_{index}");
                rect.id = child.clone();
                rect.transform = Transform([1., 0., 0., 1., 4. + (index % 8) as f64 * 22., 4. + (index / 8) as f64 * 16.]);
                doc.nodes.insert(child.clone(), rect.clone());
                kids.push(child);
            }
            if row == 0 && col == 0 {
                let use_master = "use-master".to_owned();
                let mut host = frame.clone();
                host.id = use_master.clone();
                host.children.clear();
                host.width = 48.;
                host.height = 32.;
                host.transform = Transform([1., 0., 0., 1., 8., 8.]);
                host.instance =
                    Some(serde_json::from_value(json!({"componentId": "master", "overrides": {}})).unwrap());
                doc.nodes.insert(use_master.clone(), host);
                kids.push(use_master);
            }
            frame.id = id.clone();
            frame.transform = Transform([1., 0., 0., 1., col as f64 * pitch, row as f64 * pitch]);
            frame.children = kids;
            doc.nodes.insert(id.clone(), frame.clone());
            stage_children.push(id);
        }
    }
    let mut reach = frame.clone();
    reach.id = "reach".into();
    reach.children.clear();
    reach.transform = Transform([1., 0., 0., 1., 620., 48.]);
    reach.width = 72.;
    reach.height = 64.;
    reach.effects = serde_json::from_value(
        json!([{"kind": "shadow", "radius": 8, "x": -180, "color": "#102030", "opacity": 0.85}]),
    )
    .unwrap();
    doc.nodes.insert("reach".into(), reach);
    stage_children.push("reach".into());
    let mut master_leaf = rect.clone();
    master_leaf.id = "master-leaf".into();
    master_leaf.transform = Transform([1., 0., 0., 1., 4., 4.]);
    master_leaf.fills[0].color = "#c4512c".into();
    doc.nodes.insert("master-leaf".into(), master_leaf);
    let mut master = frame.clone();
    master.id = "master".into();
    master.children = vec!["master-leaf".into()];
    master.width = 48.;
    master.height = 32.;
    master.transform = Transform([1., 0., 0., 1., 20_000., 40.]);
    master.component = Some(serde_json::from_value(json!({})).unwrap());
    master.effects.clear();
    doc.nodes.insert("master".into(), master);
    stage_children.push("master".into());
    let stage = doc.nodes.get_mut("stage").unwrap();
    stage.children = stage_children;
    stage.width = cols as f64 * pitch + 240.;
    stage.height = rows as f64 * pitch + 240.;
    let far = format!("r{}_{}", rows - 1, cols - 1);
    (doc, far, "reach".into(), "master".into())
}

#[test]
fn shared_prepare_window_does_not_repeat_distant_roots_on_every_tile() {
    let cols = env_usize("FUTUREOX_TILE_CONTEXT_COLS", 8);
    let rows = env_usize("FUTUREOX_TILE_CONTEXT_ROWS", 6);
    let children = env_usize("FUTUREOX_TILE_CONTEXT_CHILDREN", 8);
    let tiles = env_usize("FUTUREOX_TILE_CONTEXT_TILES", 2);
    let (doc, far, reach, master) = spread_document(cols, rows, children);
    let desc = descriptor(&doc);
    let document_json_bytes = serde_json::to_vec(&doc).unwrap().len();
    let pitch = 256i32;
    let tile = 514i32;
    let step = 512i32;
    let tile_edge = (tiles as i32 - 1) * step + tile;
    let last_x = (cols as i32 - 1) * pitch;
    let last_y = (rows as i32 - 1) * pitch;
    assert!(last_x > tile_edge && last_y > tile_edge, "the outer roots must sit outside the tile grid");
    let prepare_right = tile_edge.max(last_x - 64);
    let prepare_bottom = tile_edge.max(last_y - 64);
    assert!(prepare_right < last_x && prepare_bottom < last_y);
    assert!(prepare_right >= tile_edge && prepare_bottom >= tile_edge);
    let prepare = json!({"x": -16, "y": -16, "w": prepare_right + 16, "h": prepare_bottom + 16});
    let mut expected = owner(doc.clone(), "spread-oracle");
    let mut actual = owner(doc, "spread-live");
    let mut runtime = Runtime::default();
    let mut records = Vec::new();
    let mut first_tile = None;
    let wall = std::time::Instant::now();
    for row in 0..tiles {
        for col in 0..tiles {
            let x = col as i32 * step;
            let y = row as i32 * step;
            let request = json!({
                "pageId": "page", "width": tile, "height": tile,
                "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
                "rasterProfile": "figmaSubpixel", "gpuPageBackground": true,
                "gpuViewport": {"x": x, "y": y, "w": tile, "h": tile},
                "prepareViewport": prepare,
            });
            let demand_started = std::time::Instant::now();
            let packet = crate::capacity::with_source_storage_scope(true, || {
                runtime.compile(&mut actual, &desc, "stage", "page", &request.to_string())
            })
            .unwrap();
            let demand_ms = demand_started.elapsed().as_secs_f64() * 1000.;
            let oracle_started = std::time::Instant::now();
            let full = crate::capacity::with_source_storage_scope(true, || {
                expected.compile_gpu_packet_request(&request.to_string())
            })
            .unwrap();
            let oracle_ms = oracle_started.elapsed().as_secs_f64() * 1000.;
            assert_projection_equivalent(&packet, &full);
            let stats = runtime.stats.clone();
            let resolved = stats["resolvedCompileNodes"].as_u64().unwrap_or(0);
            let record = json!({
                "x": x, "y": y, "demandMs": demand_ms, "oracleMs": oracle_ms,
                "mode": stats["mode"], "resolvedCompileNodes": stats["resolvedCompileNodes"],
                "residentAuthoredNodes": stats["residentAuthoredNodes"],
                "projectionDecision": stats["projectionDecision"],
                "projectionRebuilds": stats["projectionRebuilds"],
                "projectionReuses": stats["projectionReuses"],
                "scopeExpansions": stats["scopeExpansions"],
                "packetBytes": packet.len(),
                "estimatedClosureBytes": document_json_bytes as u64 * resolved / desc.nodes.max(1),
                "frameScene": stats["frameScene"],
                "cache": stats["cache"],
            });
            if first_tile.is_none() {
                let compiled = runtime.compiler.as_ref().and_then(|engine| engine.doc.as_ref());
                first_tile = Some(json!({
                    "containsReach": compiled.is_some_and(|doc| doc.nodes.contains_key(&reach)),
                    "omitsFarRoot": compiled.is_some_and(|doc| !doc.nodes.contains_key(&far)),
                    "containsMaster": compiled.is_some_and(|doc| doc.nodes.contains_key(&master)),
                }));
            }
            if std::env::var("FUTUREOX_TILE_CONTEXT_LOG").ok().as_deref() == Some("1") {
                eprintln!("TILE_CONTEXT_TILE {record}");
                let _ = std::io::Write::flush(&mut std::io::stderr());
            }
            records.push(record);
        }
    }
    let nodes = records
        .iter()
        .map(|record| record["resolvedCompileNodes"].as_u64().unwrap_or(0))
        .collect::<Vec<_>>();
    let sum = nodes.iter().copied().sum::<u64>();
    let max = nodes.iter().copied().max().unwrap_or(0);
    let summary = json!({
        "nodes": desc.nodes,
        "documentJsonBytes": document_json_bytes,
        "cols": cols, "rows": rows, "children": children, "tiles": tiles,
        "prepare": prepare,
        "sumResolvedCompileNodes": sum,
        "maxResolvedCompileNodes": max,
        "minResolvedCompileNodes": nodes.iter().copied().min().unwrap_or(0),
        "demandWallMs": records.iter().map(|record| record["demandMs"].as_f64().unwrap_or(0.)).sum::<f64>(),
        "oracleWallMs": records.iter().map(|record| record["oracleMs"].as_f64().unwrap_or(0.)).sum::<f64>(),
        "totalWallMs": wall.elapsed().as_secs_f64() * 1000.,
        "firstTile": first_tile.clone(),
        "projectionRebuilds": runtime.stats["projectionRebuilds"],
        "projectionReuses": runtime.stats["projectionReuses"],
        "tiles": records,
    });
    if std::env::var("FUTUREOX_TILE_CONTEXT_LOG").ok().as_deref() == Some("1") {
        eprintln!("TILE_CONTEXT_SUMMARY {summary}");
    } else {
        eprintln!(
            "TILE_CONTEXT_SUMMARY nodes={} sumResolved={} maxResolved={} minResolved={} demandMs={:.1} oracleMs={:.1} rebuilds={} reuses={} first={}",
            summary["nodes"], summary["sumResolvedCompileNodes"], summary["maxResolvedCompileNodes"],
            summary["minResolvedCompileNodes"], summary["demandWallMs"].as_f64().unwrap_or(0.),
            summary["oracleWallMs"].as_f64().unwrap_or(0.), summary["projectionRebuilds"],
            summary["projectionReuses"], summary["firstTile"]
        );
    }
    let _ = std::io::Write::flush(&mut std::io::stderr());
    let first = first_tile.unwrap();
    assert_eq!(runtime.stats["mode"], "demand", "partial viewport must stay on the demand compiler: {}", runtime.stats);
    assert_eq!(first["containsReach"], true, "a shadow that reaches the tile stays in the closure");
    assert_eq!(first["containsMaster"], true, "an instance master stays in the closure");
    assert_eq!(first["omitsFarRoot"], true, "a root outside this tile and the published extent stays out");
    assert!(
        sum * 2 < desc.nodes * records.len() as u64,
        "tile compiles repeated the shared prepare context: sum {sum} max {max} source {}",
        desc.nodes
    );
}
