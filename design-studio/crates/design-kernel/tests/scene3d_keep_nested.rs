//! Baseline measurements for issue #527, taken against the pre-change kernel.
//! The same harness is re-run after the nested 3D change. Documents here have
//! no 3D fields, so the numbers are the non-3D save/reopen, update, and
//! overlap-paint costs.

use futureox_design_kernel::scene::{Document, Node};
use futureox_design_kernel::{
    Engine, RenderOptions, View, editing::DocumentEditor, editing::DocumentPatch,
};
use serde_json::json;
use std::time::Instant;

fn bench_document(frames: usize, per: usize) -> Document {
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::with_capacity(frames);
    for frame in 0..frames {
        let id = format!("f{frame}");
        let mut children = Vec::with_capacity(per);
        for child in 0..per {
            let cid = format!("f{frame}c{child}");
            children.push(cid.clone());
            nodes.insert(
                cid.clone(),
                json!({
                    "id": cid,
                    "kind": "rectangle",
                    "transform": [1, 0, 0, 1, (child % 10) as f64 * 18., (child / 10) as f64 * 14.],
                    "width": 36.,
                    "height": 22.,
                    "fills": [{"kind":"solid","color":"#3366cc","opacity":1,"visible":true,"stops":[],"blend":"normal"}]
                }),
            );
        }
        roots.push(id.clone());
        nodes.insert(
            id.clone(),
            json!({
                "id": id,
                "kind": "frame",
                "transform": [1, 0, 0, 1, (frame % 20) as f64 * 40., (frame / 20) as f64 * 50.],
                "width": 220.,
                "height": 140.,
                "children": children,
                "clip": false,
                "fills": []
            }),
        );
    }
    serde_json::from_value(json!({
        "schemaVersion": 23,
        "id": "bench",
        "name": "bench",
        "pages": [{"id":"p","name":"p","background":"#ffffff","children": roots}],
        "nodes": nodes
    }))
    .unwrap()
}

fn overlap_document() -> serde_json::Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for i in 0..80 {
        let id = format!("c{i}");
        children.push(id.clone());
        let z = if i % 2 == 0 { 0. } else { 8. };
        nodes.insert(
            id.clone(),
            json!({
                "id": id,
                "kind": "rectangle",
                "transform": [1, 0, 0, 1, 20. + (i % 8) as f64 * 6., 16. + z + (i / 8) as f64 * 4.],
                "width": 48.,
                "height": 28.,
                "fills": [{"kind":"solid","color": if i % 2 == 0 { "#cc3344" } else { "#2266aa" }, "opacity":1,"visible":true,"stops":[],"blend":"normal"}]
            }),
        );
    }
    nodes.insert(
        "frame".into(),
        json!({
            "id": "frame",
            "kind": "frame",
            "transform": [1, 0, 0, 1, 0, 0],
            "width": 200.,
            "height": 150.,
            "children": children,
            "fills": []
        }),
    );
    json!({
        "schemaVersion": 23,
        "id": "overlap",
        "name": "overlap",
        "pages": [{"id":"p","name":"p","background":"#ffffff","children":["frame"]}],
        "nodes": nodes
    })
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(|a, b| a.total_cmp(b));
    samples[samples.len() / 2]
}

fn time_ms(samples: usize, mut body: impl FnMut()) -> (f64, f64) {
    let mut out = Vec::with_capacity(samples);
    for _ in 0..samples {
        let start = Instant::now();
        body();
        out.push(start.elapsed().as_secs_f64() * 1000.);
    }
    (
        *out.iter().min_by(|a, b| a.total_cmp(b)).unwrap(),
        median(out),
    )
}

#[test]
fn measure_non_3d_save_update_and_overlap() {
    eprintln!("node_bytes {}", std::mem::size_of::<Node>());
    let doc = bench_document(200, 10);
    assert!(doc.validate().is_ok(), "baseline document must validate");
    assert_eq!(doc.nodes.len(), 2200);

    let (save_min, save_med) = time_ms(5, || {
        let bytes = serde_json::to_vec(&doc).unwrap();
        let restored: Document = serde_json::from_slice(&bytes).unwrap();
        restored.validate().unwrap();
        std::hint::black_box(bytes.len());
    });
    let (fd_min, fd_med) = time_ms(5, || {
        let encoded = futureox_design_kernel::binfmt::encode(&doc);
        let restored = futureox_design_kernel::binfmt::decode(&encoded).unwrap();
        restored.validate().unwrap();
        std::hint::black_box(encoded.len());
    });

    let mut editor = DocumentEditor::new(doc.clone()).unwrap();
    let mut node = editor.document().nodes["f0c0"].clone();
    node.opacity = 0.5;
    let patch = DocumentPatch {
        nodes: [("f0c0".into(), Some(node))].into(),
        ..Default::default()
    };
    let (edit_min, edit_med) = time_ms(30, || {
        let revision = editor.revision();
        editor.apply(revision, patch.clone()).unwrap();
        editor.undo().unwrap();
    });

    let overlap = overlap_document();
    let mut engine = Engine::new();
    engine.load_document(&overlap.to_string()).unwrap();
    let options = RenderOptions {
        page_id: "p".into(),
        width: 200,
        height: 150,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    };
    let warm = engine.render(&options).unwrap();
    assert!(warm.len() > 1000);
    let (paint_min, paint_med) = time_ms(5, || {
        std::hint::black_box(engine.render(&options).unwrap());
    });

    let mut scene = overlap_document();
    scene["schemaVersion"] = json!(24);
    scene["nodes"]["frame"]["scene3d"] = json!({"perspective": 400, "preserve3d": true});
    for i in 0..80 {
        let z = if i % 2 == 0 { 40. } else { -40. };
        scene["nodes"][&format!("c{i}")]["transform3d"] =
            json!({"type":"FIXED_ORDER","translateZ":z,"rotateX":0,"rotateY":0,"rotateZ":0});
    }
    let mut scene_engine = Engine::new();
    scene_engine.load_document(&scene.to_string()).unwrap();
    let warm_scene = scene_engine.render(&options).unwrap();
    assert!(warm_scene.len() > 1000);
    let (scene_min, scene_med) = time_ms(5, || {
        std::hint::black_box(scene_engine.render(&options).unwrap());
    });
    let scene_doc: Document = serde_json::from_value(scene).unwrap();
    let mut scene_editor = DocumentEditor::new(scene_doc).unwrap();
    let (toggle_min, toggle_med) = time_ms(30, || {
        let mut frame = scene_editor.document().nodes["frame"].clone();
        let preserve = !futureox_design_kernel::scene3d::preserves(&frame);
        frame.scene3d = Some(Box::new(futureox_design_kernel::scene3d::Scene3d::new(
            400., preserve,
        )));
        let revision = scene_editor.revision();
        scene_editor
            .apply(
                revision,
                DocumentPatch {
                    nodes: [("frame".into(), Some(frame))].into(),
                    ..Default::default()
                },
            )
            .unwrap();
        scene_editor.undo().unwrap();
    });

    eprintln!(
        "MEASURE node_bytes={}\n  save_reopen_json_ms min={save_min:.3} median={save_med:.3}\n  save_reopen_fd_ms min={fd_min:.3} median={fd_med:.3}\n  property_update_undo_ms min={edit_min:.3} median={edit_med:.3}\n  overlap_paint_ms min={paint_min:.3} median={paint_med:.3}\n  scene3d_overlap_paint_ms min={scene_min:.3} median={scene_med:.3}\n  preserve_toggle_undo_ms min={toggle_min:.3} median={toggle_med:.3}",
        std::mem::size_of::<Node>()
    );
}

fn paint(color: &str) -> serde_json::Value {
    json!({"kind":"solid","color":color,"opacity":1,"visible":true,"stops":[],"blend":"normal"})
}

fn doc(nodes: serde_json::Value) -> Document {
    serde_json::from_value(json!({
        "schemaVersion": 24,
        "id": "d",
        "name": "nested-3d",
        "pages": [{"id":"p","name":"p","background":"#ffffff","children":["frame"]}],
        "nodes": nodes
    }))
    .unwrap()
}

fn render(doc: &Document, w: u32, h: u32) -> Vec<u8> {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    engine
        .render(&RenderOptions {
            page_id: "p".into(),
            width: w,
            height: h,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: true,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap()
}

fn pixel(bytes: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
    bytes[(y * w + x) * 4..(y * w + x) * 4 + 4]
        .try_into()
        .unwrap()
}

fn cards(preserve: bool, perspective: f64, perspective_visible: bool) -> Document {
    doc(json!({
        "frame": {"id":"frame","kind":"frame","width":300,"height":200,"children":["near","far"],"fills":[],
            "scene3d": {"perspective": perspective, "preserve3d": preserve, "visible": perspective_visible}},
        "near": {"id":"near","kind":"rectangle","width":80,"height":50,"transform":[1,0,0,1,110,80],
            "fills":[paint("#ff0000")],
            "transform3d":{"type":"FIXED_ORDER","translateZ":60,"rotateX":0,"rotateY":0,"rotateZ":0}},
        "far": {"id":"far","kind":"rectangle","width":120,"height":80,"transform":[1,0,0,1,90,60],
            "fills":[paint("#0000ff")],
            "transform3d":{"type":"FIXED_ORDER","translateZ":-80,"rotateX":0,"rotateY":0,"rotateZ":0}}
    }))
}

#[test]
fn flat_and_preserve_change_occlusion_and_share_perspective() {
    let view = render(&cards(true, 400., true), 300, 200);
    assert_eq!(
        pixel(&view, 300, 150, 100),
        [255, 0, 0, 255],
        "closer card wins inside the overlap"
    );
    assert_eq!(
        pixel(&view, 300, 105, 105),
        [255, 0, 0, 255],
        "shared perspective enlarges the near card"
    );
    let flat = render(&cards(false, 400., true), 300, 200);
    assert_eq!(
        pixel(&flat, 300, 150, 100),
        [0, 0, 255, 255],
        "flat plane keeps layer order"
    );
    assert_eq!(
        pixel(&flat, 300, 105, 105),
        [0, 0, 255, 255],
        "flat plane still uses the shared camera"
    );
    let hidden = render(&cards(true, 400., false), 300, 200);
    assert_eq!(
        pixel(&hidden, 300, 150, 100),
        [255, 0, 0, 255],
        "preserve-3D sorts even when perspective is hidden"
    );
    assert_eq!(
        pixel(&hidden, 300, 105, 105),
        [0, 0, 255, 255],
        "hidden perspective does not scale depth"
    );
}

#[test]
fn nested_preserve_sorts_inside_a_flat_parent_and_joins_a_preserve_parent() {
    let nested = |outer_preserve: bool| {
        doc(json!({
            "frame": {"id":"frame","kind":"frame","width":300,"height":200,"children":["inner","badge"],"fills":[],
                "scene3d": {"perspective":400,"preserve3d": outer_preserve}},
            "inner": {"id":"inner","kind":"frame","width":300,"height":200,"children":["near","far"],"fills":[],
                "scene3d": {"perspective":-1,"preserve3d":true}},
            "near": {"id":"near","kind":"rectangle","width":80,"height":50,"transform":[1,0,0,1,110,80],
                "fills":[paint("#ff0000")],
                "transform3d":{"type":"FIXED_ORDER","translateZ":60,"rotateX":0,"rotateY":0,"rotateZ":0}},
            "far": {"id":"far","kind":"rectangle","width":120,"height":80,"transform":[1,0,0,1,90,60],
                "fills":[paint("#0000ff")],
                "transform3d":{"type":"FIXED_ORDER","translateZ":-80,"rotateX":0,"rotateY":0,"rotateZ":0}},
            "badge": {"id":"badge","kind":"rectangle","width":40,"height":30,"transform":[1,0,0,1,140,90],
                "fills":[paint("#00aa00")],
                "transform3d":{"type":"FIXED_ORDER","translateZ":-30,"rotateX":0,"rotateY":0,"rotateZ":0}}
        }))
    };
    let flat_outer = render(&nested(false), 300, 200);
    assert_eq!(
        pixel(&flat_outer, 300, 120, 100),
        [255, 0, 0, 255],
        "inner preserve-3D sorts the cards"
    );
    assert_eq!(
        pixel(&flat_outer, 300, 160, 100),
        [0, 170, 0, 255],
        "flat outer paints the later badge over the scene"
    );
    let preserve_outer = render(&nested(true), 300, 200);
    assert_eq!(
        pixel(&preserve_outer, 300, 160, 100),
        [255, 0, 0, 255],
        "outer preserve-3D puts the badge behind the near card"
    );
}

#[test]
fn backface_hides_or_mirrors_a_turned_frame() {
    let turned = |backface: bool| {
        doc(json!({
            "frame": {"id":"frame","kind":"frame","width":100,"height":60,"transform":[1,0,0,1,100,70],
                "children":["left","right"],"fills":[],
                "transform3d":{"type":"FIXED_ORDER","translateZ":0,"rotateX":0,"rotateY":180,"rotateZ":0,"backfaceVisible":backface}},
            "left": {"id":"left","kind":"rectangle","width":50,"height":60,"fills":[paint("#ff0000")]},
            "right": {"id":"right","kind":"rectangle","width":50,"height":60,"transform":[1,0,0,1,50,0],"fills":[paint("#00ff00")]}
        }))
    };
    let mirrored = render(&turned(true), 300, 200);
    assert_eq!(
        pixel(&mirrored, 300, 125, 100),
        [0, 255, 0, 255],
        "visible backface mirrors the right half onto the left"
    );
    assert_eq!(
        pixel(&mirrored, 300, 175, 100),
        [255, 0, 0, 255],
        "visible backface mirrors the left half onto the right"
    );
    let hidden = render(&turned(false), 300, 200);
    assert_eq!(pixel(&hidden, 300, 125, 100)[3], 0);
    assert_eq!(pixel(&hidden, 300, 175, 100)[3], 0);
}

#[test]
fn transform_origin_moves_the_pivot() {
    let card = |origin: Option<serde_json::Value>| {
        let frame = json!({"id":"frame","kind":"frame","width":220,"height":160,"children":["card"],"fills":[]});
        let mut node = json!({"id":"card","kind":"rectangle","width":100,"height":60,"transform":[1,0,0,1,100,70],
            "fills":[paint("#ff0000")],
            "transform3d":{"type":"FIXED_ORDER","translateZ":0,"rotateX":0,"rotateY":40,"rotateZ":0}});
        if let Some(origin) = origin {
            node["transformOrigin"] = origin;
        }
        doc(json!({"frame": frame, "card": node}))
    };
    let centered = render(&card(None), 320, 200);
    let hinged = render(
        &card(Some(
            json!({"x":{"unit":"PERCENT","value":0},"y":{"unit":"PERCENT","value":50}}),
        )),
        320,
        200,
    );
    assert_eq!(
        pixel(&centered, 320, 105, 100)[3],
        0,
        "center pivot pulls the left edge inward"
    );
    assert_eq!(
        pixel(&hinged, 320, 105, 100),
        [255, 0, 0, 255],
        "left-edge pivot keeps the hinge covered"
    );
}

#[test]
fn preserve_ignores_opacity_clip_and_blur_until_flat() {
    let mut nodes = json!({
        "frame": {"id":"frame","kind":"frame","width":80,"height":60,"transform":[1,0,0,1,40,30],
            "children":["card"],"fills":[paint("#ffffff")],"opacity":0,"clip":true,
            "effects":[{"kind":"blur","radius":20,"color":"#000000","opacity":1,"visible":true}],
            "scene3d":{"perspective":-1,"preserve3d":true}},
        "card": {"id":"card","kind":"rectangle","width":30,"height":30,"transform":[1,0,0,1,-20,10],"fills":[paint("#ff0000")]}
    });
    let kept = render(&doc(nodes.clone()), 160, 120);
    assert_eq!(
        pixel(&kept, 160, 25, 50),
        [255, 0, 0, 255],
        "preserve-3D shows the child outside the clip at full opacity"
    );
    assert_eq!(
        pixel(&kept, 160, 8, 50)[3],
        0,
        "the ignored blur does not bleed"
    );
    nodes["frame"]["scene3d"]["preserve3d"] = json!(false);
    nodes["frame"]["opacity"] = json!(1);
    nodes["frame"]["effects"] = json!([]);
    let flat = render(&doc(nodes), 160, 120);
    assert_eq!(
        pixel(&flat, 160, 25, 50)[3],
        0,
        "flat clip hides the overflow"
    );
}

#[test]
fn intersecting_rotations_split_by_depth_only_when_preserved() {
    let scene = |preserve: bool| {
        doc(json!({
            "frame": {"id":"frame","kind":"frame","width":300,"height":200,"children":["left","right"],"fills":[],
                "scene3d":{"perspective":-1,"preserve3d":preserve}},
            "left": {"id":"left","kind":"rectangle","width":120,"height":60,"transform":[1,0,0,1,70,70],
                "fills":[paint("#ff0000")],
                "transform3d":{"type":"FIXED_ORDER","translateZ":0,"rotateX":0,"rotateY":55,"rotateZ":0}},
            "right": {"id":"right","kind":"rectangle","width":120,"height":60,"transform":[1,0,0,1,110,70],
                "fills":[paint("#0000ff")],
                "transform3d":{"type":"FIXED_ORDER","translateZ":0,"rotateX":0,"rotateY":-55,"rotateZ":0}}
        }))
    };
    let kept = render(&scene(true), 300, 200);
    let flat = render(&scene(false), 300, 200);
    assert_eq!(
        pixel(&kept, 300, 140, 100),
        [255, 0, 0, 255],
        "the left card's nearer half stays in front"
    );
    assert_eq!(
        pixel(&kept, 300, 160, 100),
        [0, 0, 255, 255],
        "the right card's nearer half stays in front"
    );
    assert_eq!(
        pixel(&flat, 300, 140, 100),
        [0, 0, 255, 255],
        "flat order paints the later card across the crossing"
    );
    assert_eq!(pixel(&flat, 300, 160, 100), [0, 0, 255, 255]);
}

#[test]
fn undo_and_reopen_keep_the_scene_switch() {
    let original = cards(false, 400., true);
    let mut editor = DocumentEditor::new(original.clone()).unwrap();
    let mut frame = editor.document().nodes["frame"].clone();
    frame.scene3d = Some(Box::new(futureox_design_kernel::scene3d::Scene3d::new(
        400., true,
    )));
    editor
        .apply(
            0,
            DocumentPatch {
                nodes: [("frame".into(), Some(frame))].into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(futureox_design_kernel::scene3d::preserves(
        &editor.document().nodes["frame"]
    ));
    editor.undo().unwrap();
    assert!(!futureox_design_kernel::scene3d::preserves(
        &editor.document().nodes["frame"]
    ));
    editor.redo().unwrap();
    let kept = render(editor.document(), 300, 200);
    assert_eq!(pixel(&kept, 300, 150, 100), [255, 0, 0, 255]);
    let encoded = futureox_design_kernel::binfmt::encode(editor.document());
    let opened = futureox_design_kernel::binfmt::decode(&encoded).unwrap();
    opened.validate().unwrap();
    assert_eq!(
        opened.nodes["frame"].scene3d,
        editor.document().nodes["frame"].scene3d
    );
    assert_eq!(
        opened.nodes["near"].transform3d,
        editor.document().nodes["near"].transform3d
    );
    let again = render(&opened, 300, 200);
    assert_eq!(pixel(&again, 300, 105, 105), [255, 0, 0, 255]);
    let mut stale = opened.clone();
    stale.schema_version = 23;
    assert!(stale.validate().unwrap_err().contains("schema 24"));
}

#[test]
fn zero_pose_matches_the_flat_painter() {
    let plain = doc(json!({
        "frame": {"id":"frame","kind":"frame","width":80,"height":40,"children":["card"],"fills":[]},
        "card": {"id":"card","kind":"rectangle","width":40,"height":20,"transform":[1,0,0,1,10,8],"fills":[paint("#ff0000")]}
    }));
    let mut posed = plain.clone();
    posed.nodes.get_mut("card").unwrap().transform3d = Some(Box::new(
        futureox_design_kernel::scene3d::Transform3d::fixed(0., 0., 0., 0.),
    ));
    posed.schema_version = 24;
    assert_eq!(render(&plain, 80, 40), render(&posed, 80, 40));
}
