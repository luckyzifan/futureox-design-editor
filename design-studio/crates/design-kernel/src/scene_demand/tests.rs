use super::*;
use crate::scene_store;
use serde_json::json;
use std::{fs, path::PathBuf, sync::atomic::AtomicU64};

struct Fixture {
    path: PathBuf,
    descriptor: Descriptor,
    catalog: Arc<Catalog>,
    document: Document,
}
impl Fixture {
    fn new(document: Document) -> Self {
        Self::with_fonts(document, &Fonts::new())
    }
    fn with_fonts(document: Document, fonts: &Fonts) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "futureox-demand-{}-{}.scene",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let cancel = AtomicBool::new(false);
        let descriptor = scene_store::write(&path, "d:7", &document, &[], &cancel).unwrap();
        let stage = document.pages[0].children[0].clone();
        let result = Catalog::open(&path, &descriptor, &stage, fonts, &cancel);
        if result.is_err() {
            let _ = fs::remove_file(&path);
        }
        let catalog = result.unwrap();
        Self {
            path,
            descriptor,
            catalog,
            document,
        }
    }
    fn load(&self, ids: &[&str]) -> LoadedDemand {
        let cancel = AtomicBool::new(false);
        self.catalog
            .objects(
                &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                &cancel,
            )
            .unwrap()
            .load(&self.path, &self.descriptor, &cancel)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
fn document() -> Document {
    serde_json::from_value(json!({"schemaVersion":20,"id":"d","name":"d","pages":[{"id":"p","name":"p","background":"#ffffff","children":["stage"]}],"nodes":{
        "stage":{"id":"stage","kind":"frame","width":20000,"height":20000,"blend":"pass-through","children":["a","b","c"]},
        "a":{"id":"a","kind":"rectangle","width":20,"height":20,"fills":[{"kind":"solid","color":"#ff0000"}]},
        "b":{"id":"b","kind":"rectangle","width":20,"height":20,"transform":[1,0,0,1,10000,0],"fills":[{"kind":"solid","color":"#00ff00"}]},
        "c":{"id":"c","kind":"rectangle","width":20,"height":20,"transform":[1,0,0,1,20000,0],"fills":[{"kind":"solid","color":"#0000ff"}]}
    }})).unwrap()
}
#[test]
fn viewport_reads_only_demanded_payload_and_keeps_cold_identity() {
    let f = Fixture::new(document());
    let cancel = AtomicBool::new(false);
    let demand = f
        .catalog
        .viewport(Transform::default(), Rect::new(0, 0, 64, 64), &cancel)
        .unwrap();
    assert_eq!(demand.stats().required_nodes, 2);
    let loaded = demand.load(&f.path, &f.descriptor, &cancel).unwrap();
    assert!(matches!(loaded.lookup("a"), Lookup::Loaded(_)));
    assert!(matches!(loaded.lookup("b"), Lookup::Cold));
    assert!(matches!(loaded.lookup("missing"), Lookup::Absent));
    assert_eq!(loaded.reads().node_reads, 2);
    assert_eq!(loaded.reads().metadata_reads, 0);
    assert_eq!(loaded.nodes()["a"], f.document.nodes["a"]);
    let moved = f
        .catalog
        .viewport(
            Transform([1., 0., 0., 1., -10000., 0.]),
            Rect::new(0, 0, 64, 64),
            &cancel,
        )
        .unwrap()
        .load(&f.path, &f.descriptor, &cancel)
        .unwrap();
    assert!(matches!(moved.lookup("b"), Lookup::Loaded(_)));
    assert!(matches!(moved.lookup("a"), Lookup::Cold));
}
#[test]
fn backdrop_acquires_preceding_painter_inputs_but_not_later_roots() {
    let mut d = document();
    d.nodes.get_mut("b").unwrap().effects =
        serde_json::from_value(json!([{"kind":"background-blur","radius":10,"color":"#000000"}]))
            .unwrap();
    let f = Fixture::new(d);
    let cancel = AtomicBool::new(false);
    let loaded = f
        .catalog
        .viewport(
            Transform([1., 0., 0., 1., -10000., 0.]),
            Rect::new(0, 0, 64, 64),
            &cancel,
        )
        .unwrap()
        .load(&f.path, &f.descriptor, &cancel)
        .unwrap();
    assert!(matches!(loaded.lookup("a"), Lookup::Loaded(_)));
    assert!(matches!(loaded.lookup("b"), Lookup::Loaded(_)));
    assert!(matches!(loaded.lookup("c"), Lookup::Cold));
    assert_eq!(loaded.stats().painter_prefix_roots, 1);
    // An offscreen backdrop is not itself a reason to read the entire page.
    assert_eq!(
        f.catalog
            .viewport(Transform::default(), Rect::new(0, 0, 64, 64), &cancel)
            .unwrap()
            .stats()
            .required_nodes,
        2
    );
}
#[test]
fn components_and_connectors_promote_dependencies_to_whole_owning_units() {
    let mut d = document();
    d.nodes.get_mut("b").unwrap().kind = "frame".into();
    d.nodes.get_mut("b").unwrap().component = Some(serde_json::from_value(json!({})).unwrap());
    d.nodes.get_mut("a").unwrap().kind = "frame".into();
    d.nodes.get_mut("a").unwrap().instance =
        Some(serde_json::from_value(json!({"componentId":"b","overrides":{}})).unwrap());
    d.nodes
        .get_mut("stage")
        .unwrap()
        .children
        .retain(|id| id != "b");
    d.pages.push(crate::scene::Page {
        id: "library".into(),
        name: "library".into(),
        children: vec!["b".into()],
        background: "#ffffff".into(),
        guides: vec![],
    });
    let f = Fixture::new(d);
    let loaded = f.load(&["a"]);
    assert!(matches!(loaded.lookup("b"), Lookup::Loaded(_)));
    assert!(matches!(loaded.lookup("c"), Lookup::Cold));
    let mut d = document();
    d.nodes.get_mut("a").unwrap().kind = "vector".into();
    d.nodes.get_mut("a").unwrap().connector=Some(serde_json::from_value(json!({"from":{"point":{"x":0,"y":0},"nodeId":"b","anchor":{"x":0,"y":0}},"to":{"point":{"x":10,"y":10},"nodeId":"c","anchor":{"x":1,"y":1}},"style":"straight"})).unwrap());
    let f = Fixture::new(d);
    let loaded = f.load(&["a"]);
    assert_eq!(loaded.nodes().len(), 4);
}
#[test]
fn generation_cancel_and_changed_content_never_publish_partial_success() {
    let f = Fixture::new(document());
    let cancel = AtomicBool::new(false);
    let mut wrong = f.descriptor.clone();
    wrong.generation = "d:8".into();
    assert!(
        f.catalog
            .objects(&["a".into()], &cancel)
            .unwrap()
            .load(&f.path, &wrong, &cancel)
            .is_err()
    );
    assert!(f.catalog.objects(&["missing".into()], &cancel).is_err());
    assert!(
        f.catalog
            .viewport(
                Transform::default(),
                Rect::new(0, 0, 64, 64),
                &AtomicBool::new(true)
            )
            .is_err()
    );
    let demand = f.catalog.objects(&["a".into()], &cancel).unwrap();
    assert!(
        demand
            .load(&f.path, &f.descriptor, &AtomicBool::new(true))
            .is_err()
    );
    let mut bytes = fs::read(&f.path).unwrap();
    let at = bytes.windows(7).position(|b| b == b"#ff0000").unwrap();
    bytes[at + 1] = b'0';
    fs::write(&f.path, bytes).unwrap();
    assert!(
        f.catalog
            .objects(&["a".into()], &cancel)
            .unwrap()
            .load(&f.path, &f.descriptor, &cancel)
            .is_err()
    );
    assert!(Catalog::open(&f.path, &f.descriptor, "stage", &Fonts::new(), &cancel).is_err());
}
#[test]
fn inspection_preserves_parent_layout_and_stage_request_is_complete() {
    let mut d = document();
    let leaf = d.nodes.remove("c").unwrap();
    d.nodes
        .get_mut("stage")
        .unwrap()
        .children
        .retain(|id| id != "c");
    d.nodes.get_mut("b").unwrap().kind = "group".into();
    d.nodes.get_mut("b").unwrap().children.push("c".into());
    d.nodes.insert("c".into(), leaf);
    let f = Fixture::new(d);
    let loaded = f.load(&["c"]);
    assert!(matches!(loaded.lookup("b"), Lookup::Loaded(_)));
    assert!(matches!(loaded.lookup("a"), Lookup::Cold));
    assert!(f.load(&["stage"]).nodes().iter().eq(&f.document.nodes));
}
#[test]
fn unknown_optics_and_page_masks_remain_conservative() {
    let mut d = document();
    d.nodes.get_mut("b").unwrap().path_offset = 1.;
    let f = Fixture::new(d);
    let cancel = AtomicBool::new(false);
    let demand = f
        .catalog
        .viewport(Transform::default(), Rect::new(0, 0, 64, 64), &cancel)
        .unwrap();
    assert!(demand.visible.contains(&"b".to_owned()));
    let mut d = document();
    d.nodes.get_mut("a").unwrap().mask = true;
    let f = Fixture::new(d);
    assert_eq!(
        f.catalog
            .viewport(
                Transform([1., 0., 0., 1., -10000., 0.]),
                Rect::new(0, 0, 64, 64),
                &cancel
            )
            .unwrap()
            .stats()
            .required_nodes,
        4
    );
}
#[test]
fn optical_support_includes_child_overflow_and_shadow_casters() {
    let mut d = document();
    let mut child = d.nodes["a"].clone();
    child.id = "leaf".into();
    child.transform = Transform([1., 0., 0., 1., -10000., 0.]);
    d.nodes.get_mut("b").unwrap().kind = "group".into();
    d.nodes.get_mut("b").unwrap().children.push("leaf".into());
    d.nodes.insert("leaf".into(), child);
    d.nodes.get_mut("c").unwrap().effects =
        serde_json::from_value(json!([{"kind":"shadow","radius":4,"x":-20000,"color":"#000000"}]))
            .unwrap();
    let f = Fixture::new(d);
    let cancel = AtomicBool::new(false);
    let demand = f
        .catalog
        .viewport(Transform::default(), Rect::new(0, 0, 64, 64), &cancel)
        .unwrap();
    assert_eq!(demand.visible, vec!["a", "b", "c"]);
}

#[test]
#[ignore = "manual full topology source model; no GUI/GPU"]
fn complete_topology_viewport_and_dependency_acquisition_matches_source() {
    use sha2::{Digest, Sha256};
    use std::io::{BufReader, Read};
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
    let path = std::env::var("FUTUREOX_TOPOLOGY_MODEL").expect("frozen topology source model");
    let mut input = Input {
        file: fs::File::open(path).unwrap(),
        hash: Sha256::new(),
    };
    let doc: Document = serde_json::from_reader(BufReader::new(&mut input)).unwrap();
    assert_eq!(
        (input.hash.finalize()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "e1678121c271d815b218cd21c233f9c584dcce3d2246d13870ae4801bee6548e"
    );
    assert_eq!(doc.nodes.len(), 124447);
    let stage = doc.pages[0].children[0].clone();
    assert_eq!(doc.nodes[&stage].children.len(), 306);
    let font_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf");
    let font = fs::read(font_path).unwrap();
    let font_hash = (Sha256::digest(&font)).iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut fonts = Fonts::new();
    fonts.load(&font).unwrap();
    eprintln!("topology: verified input; writing store and building resolved catalog");
    let f = Fixture::with_fonts(doc, &fonts);
    eprintln!("topology: catalog ready");
    let cancel = AtomicBool::new(false);
    let mut reports = Vec::new();
    let backdrop = f
        .catalog
        .roots
        .iter()
        .enumerate()
        .find(|(rank, (_, u))| *rank > 0 && f.catalog.units[*u].backdrop)
        .unwrap();
    let center = f.catalog.support.output_center(&backdrop.1.0).unwrap();
    let first = f
        .catalog
        .support
        .output_center(&f.catalog.roots[0].0)
        .unwrap();
    let scenarios = [
        ("origin", 0., 0., 1.),
        (
            "material-950pct",
            512. - first.x * 9.5,
            384. - first.y * 9.5,
            9.5,
        ),
        ("backdrop-material", 512. - center.x, 384. - center.y, 1.),
        ("empty-corner", -16000., -30000., 1.),
    ];
    for (name, x, y, zoom) in scenarios {
        let demand = f
            .catalog
            .viewport(
                Transform([zoom, 0., 0., zoom, x, y]),
                Rect::new(0, 0, 1024, 768),
                &cancel,
            )
            .unwrap();
        eprintln!(
            "topology demand: {}",
            serde_json::to_string(&demand.stats()).unwrap()
        );
        if name != "empty-corner" {
            assert!(demand.stats().visible_roots > 0);
        }
        if name == "backdrop-material" {
            assert!(demand.stats().painter_prefix_roots > 0);
        }
        let loaded = demand.load(&f.path, &f.descriptor, &cancel).unwrap();
        for (id, node) in loaded.nodes() {
            assert_eq!(node, &f.document.nodes[id]);
        }
        assert_eq!(loaded.reads().metadata_reads, 0);
        assert_eq!(loaded.reads().node_reads, loaded.nodes().len() as u64);
        let LoadedAuthority::Planned(planned) = &loaded.demand else { panic!("expected planned source demand") };
        for unit in &planned.units {
            for dep in &f.catalog.units[*unit].dependencies {
                assert!(planned.units.contains(dep));
            }
        }
        reports.push(json!({"name":name,"camera":[x,y,zoom],"demand":loaded.stats(),"nodeBytes":loaded.reads().node_bytes,"proofBytes":loaded.reads().index_bytes_verified,"metadataReads":0,"sourceNodesEqual":true}));
    }
    let requested = f
        .catalog
        .roots
        .iter()
        .filter(|(_, u)| !f.catalog.units[*u].backdrop)
        .min_by_key(|(_, u)| f.catalog.units[*u].nodes.len())
        .unwrap()
        .0
        .as_str();
    let loaded = f.load(&[requested]);
    assert!(loaded.nodes().len() < f.document.nodes.len());
    let unknown=f.catalog.roots.iter().enumerate().filter(|(_, (id,_))|!f.catalog.support.known_output(id)).map(|(rank,(id,u))|json!({"rank":rank,"name":f.document.nodes[id].name,"nodes":f.catalog.units[*u].nodes.len(),"backdrop":f.catalog.units[*u].backdrop})).collect::<Vec<_>>();
    println!(
        "{}",
        json!({"scope":"complete topology native acquisition module, no renderer speed/GPU/GUI acceptance","nodes":124447,"roots":306,"fontHash":font_hash,"viewports":reports,"explicitObjectNodes":loaded.nodes().len(),"unknownRoots":unknown,"seconds":started.elapsed().as_secs_f64()})
    );
}

#[test]
fn pointwise_color_controls_do_not_require_offscreen_painter_inputs() {
    let mut d = document();
    d.nodes.get_mut("b").unwrap().effects=serde_json::from_value(json!([{"kind":"color-controls","radius":0,"color":"#000000","colorControls":{"brightness":0.2,"contrast":1.5,"saturation":0.5,"hue":0}}])).unwrap();
    let f = Fixture::new(d);
    let cancel = AtomicBool::new(false);
    let demand = f
        .catalog
        .viewport(Transform::default(), Rect::new(0, 0, 64, 64), &cancel)
        .unwrap();
    assert_eq!(demand.stats().required_nodes, 2);
    assert_eq!(demand.stats().painter_prefix_roots, 0);
}

#[test]
fn viewport_rejects_unrepresentable_rectangles_before_support_queries() {
    let f = Fixture::new(document());
    let cancel = AtomicBool::new(false);
    for viewport in [
        Rect::new(i32::MAX, 0, 1, 1),
        Rect::new(0, i32::MAX, 1, 1),
        Rect::new(0, 0, u32::MAX, 1),
        Rect::new(0, 0, 1, 0),
    ] {
        assert!(
            f.catalog
                .viewport(Transform::default(), viewport, &cancel)
                .is_err()
        );
    }
}

#[test]
fn cancellation_between_records_does_not_publish_or_poison_a_later_demand() {
    let f = Fixture::new(document());
    let cancel = AtomicBool::new(false);
    let demand = f.catalog.objects(&["a".into()], &cancel).unwrap();
    let calls = std::rc::Rc::new(std::cell::Cell::new(0));
    let observed = calls.clone();
    let result = crate::render_cancellation::with_probe(
        move || {
            observed.set(observed.get() + 1);
            observed.get() > 2
        },
        || demand.load(&f.path, &f.descriptor, &cancel),
    );
    assert!(result.is_err());
    assert!(calls.get() > 2);
    let loaded = f.load(&["a"]);
    assert_eq!(loaded.nodes()["a"], f.document.nodes["a"]);
    assert_eq!(loaded.reads().node_reads, 2);
}
