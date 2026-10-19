use futureox_design_kernel::{
    Engine, RenderOptions, View,
    font::Fonts,
    layout::{self, SizeMode},
    scene::Document,
};
use serde_json::{Value, json};
fn shape(id: &str, w: f64, h: f64) -> Value {
    json!({"id":id,"kind":"rectangle","width":w,"height":h,"fills":[{"kind":"solid","color":"#7788cc"}]})
}
fn doc(mut parent: Value, children: Vec<Value>) -> Document {
    parent["id"] = json!("p");
    parent["kind"] = json!("frame");
    parent["children"] = json!(
        children
            .iter()
            .map(|n| n["id"].as_str().unwrap())
            .collect::<Vec<_>>()
    );
    let mut nodes = serde_json::Map::new();
    nodes.insert("p".into(), parent);
    for n in children {
        nodes.insert(n["id"].as_str().unwrap().into(), n);
    }
    serde_json::from_value(json!({"schemaVersion":1,"id":"d","name":"layout","pages":[{"id":"page","name":"page","background":"#ffffff","children":["p"]}],"nodes":nodes})).unwrap()
}
fn parent(w: f64, h: f64, mode: &str) -> Value {
    json!({"id":"p","kind":"frame","width":w,"height":h,"layout":{"mode":mode,"padding":[10,10,10,10],"gap":10,"lineGap":5}})
}
fn solve(d: &mut Document) {
    d.validate().unwrap();
    layout::resolve(d, &Fonts::new()).unwrap();
    d.validate().unwrap();
}
fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "{a} != {b}")
}
#[test]
fn horizontal_padding_alignment() {
    let mut p = parent(300., 100., "horizontal");
    p["layout"]["padding"] = json!([5, 15, 7, 10]);
    p["layout"]["align"] = json!("center");
    let mut d = doc(p, vec![shape("a", 30., 20.), shape("b", 40., 25.)]);
    solve(&mut d);
    close(d.nodes["a"].transform.0[4], 10.);
    close(d.nodes["b"].transform.0[4], 50.);
    close(d.nodes["a"].transform.0[5], 39.);
    close(d.nodes["b"].transform.0[5], 36.5);
}
#[test]
fn fill_redistributes_at_max_and_shrinks() {
    let mut a = shape("a", 20., 20.);
    a["sizing"] = json!({"width":"fill","height":"fill","minWidth":20,"maxWidth":60});
    let mut b = shape("b", 30., 20.);
    b["sizing"] = json!({"width":"fill","height":"fill","minWidth":30});
    let mut d = doc(
        parent(300., 100., "horizontal"),
        vec![shape("fixed", 50., 20.), a, b],
    );
    solve(&mut d);
    close(d.nodes["a"].width, 60.);
    close(d.nodes["b"].width, 150.);
    close(d.nodes["a"].height, 80.);
    d.nodes.get_mut("p").unwrap().width = 150.;
    d.nodes.get_mut("p").unwrap().height = 70.;
    solve(&mut d);
    close(d.nodes["a"].width, 25.);
    close(d.nodes["b"].width, 35.);
    close(d.nodes["a"].height, 50.);
}
#[test]
fn hidden_and_absolute_children_do_not_expand_hug() {
    let mut p = parent(100., 100., "horizontal");
    p["sizing"] = json!({"width":"hug","height":"hug"});
    let mut hidden = shape("hidden", 500., 500.);
    hidden["visible"] = json!(false);
    let mut absolute = shape("absolute", 10., 10.);
    absolute["transform"] = json!([1, 0, 0, 1, 85, 0]);
    absolute["sizing"] = json!({"absolute":true});
    absolute["constraints"] = json!({"horizontal":"end"});
    let mut d = doc(p, vec![shape("a", 30., 20.), hidden, absolute]);
    solve(&mut d);
    close(d.nodes["p"].width, 50.);
    close(d.nodes["p"].height, 40.);
    close(d.nodes["absolute"].transform.0[4], 35.);
}
#[test]
fn hug_fill_cycle_converts_parent_axis_to_fixed() {
    let mut p = parent(120., 80., "horizontal");
    p["sizing"] = json!({"width":"hug","height":"hug"});
    let mut a = shape("a", 30., 20.);
    a["sizing"] = json!({"width":"fill"});
    let mut d = doc(p, vec![a]);
    solve(&mut d);
    assert_eq!(d.nodes["p"].sizing.as_ref().unwrap().width, SizeMode::Fixed);
    close(d.nodes["a"].width, 100.);
    close(d.nodes["p"].height, 40.);
}
#[test]
fn horizontal_wrap_and_vertical_wrap() {
    for vertical in [false, true] {
        let mut p = parent(
            if vertical { 100. } else { 130. },
            if vertical { 130. } else { 100. },
            if vertical { "vertical" } else { "horizontal" },
        );
        p["layout"]["wrap"] = json!(true);
        p["sizing"] = if vertical {
            json!({"width":"hug"})
        } else {
            json!({"height":"hug"})
        };
        let mut d = doc(
            p,
            ["a", "b", "c"]
                .iter()
                .map(|id| {
                    shape(
                        id,
                        if vertical { 20. } else { 50. },
                        if vertical { 50. } else { 20. },
                    )
                })
                .collect(),
        );
        solve(&mut d);
        let c = &d.nodes["c"];
        close(c.transform.0[if vertical { 4 } else { 5 }], 35.);
        close(
            if vertical {
                d.nodes["p"].width
            } else {
                d.nodes["p"].height
            },
            65.,
        );
    }
}
#[test]
fn grid_spans_and_hug_rows() {
    let mut p = parent(320., 200., "grid");
    p["layout"]["columns"] = json!(3);
    p["layout"]["lineGap"] = json!(8);
    p["sizing"] = json!({"height":"hug"});
    let mut a = shape("a", 40., 90.);
    a["sizing"] = json!({"width":"fill","columnSpan":2,"rowSpan":2});
    let mut d = doc(p, vec![a, shape("b", 30., 30.), shape("c", 25., 20.)]);
    solve(&mut d);
    close(d.nodes["a"].width, 196.6666666667);
    close(d.nodes["c"].transform.0[4], 216.6666666667);
    close(d.nodes["c"].transform.0[5], 59.);
    close(d.nodes["p"].height, 110.);
}
#[test]
fn nested_fill_reflows_child_hug_height() {
    let mut inner = parent(40., 10., "horizontal");
    inner["id"] = json!("inner");
    inner["children"] = json!(["a", "b", "c"]);
    inner["layout"]["wrap"] = json!(true);
    inner["sizing"] = json!({"width":"fill","height":"hug"});
    let mut p = parent(200., 100., "vertical");
    p["sizing"] = json!({"height":"hug"});
    let mut d = doc(p, vec![inner]);
    for id in ["a", "b", "c"] {
        d.nodes.insert(
            id.into(),
            serde_json::from_value(shape(id, 60., 20.)).unwrap(),
        );
    }
    solve(&mut d);
    close(d.nodes["inner"].width, 180.);
    close(d.nodes["inner"].height, 65.);
    close(d.nodes["p"].height, 85.);
    d.nodes.get_mut("p").unwrap().width = 300.;
    solve(&mut d);
    close(d.nodes["inner"].height, 40.);
    close(d.nodes["p"].height, 60.);
}
#[test]
fn constraint_anchors_and_idempotence() {
    let mut cs = Vec::new();
    for mode in ["start", "center", "end", "stretch", "scale"] {
        let mut n = shape(mode, 20., 10.);
        n["transform"] = json!([1, 0, 0, 1, 10, 5]);
        n["constraints"] =
            json!({"horizontal":mode,"vertical":mode,"referenceWidth":100,"referenceHeight":80});
        cs.push(n);
    }
    let mut p = parent(200., 160., "none");
    p.as_object_mut().unwrap().remove("layout");
    let mut d = doc(p, cs);
    solve(&mut d);
    for (mode, x, w) in [
        ("start", 10., 20.),
        ("center", 60., 20.),
        ("end", 110., 20.),
        ("stretch", 10., 120.),
        ("scale", 20., 40.),
    ] {
        close(d.nodes[mode].transform.0[4], x);
        close(d.nodes[mode].width, w);
    }
    let before = d.clone();
    solve(&mut d);
    assert_eq!(d, before);
    assert_eq!(
        layout::changes(&serde_json::to_string(&d).unwrap(), &Fonts::new()).unwrap(),
        "{}"
    );
}
#[test]
fn native_cpu_and_gpu_compiler_resolve_same_layout() {
    let mut d = doc(parent(100., 80., "horizontal"), vec![shape("a", 20., 20.)]);
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    let options = RenderOptions {
        page_id: "page".into(),
        width: 120,
        height: 100,
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
    let plan = e.compile_gpu(&options).unwrap();
    close(plan.nodes["a"].matrix.0[4], 10.);
    let actual = e.render(&options).unwrap();
    solve(&mut d);
    let mut reference = Engine::new();
    reference
        .load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    assert_eq!(actual, reference.render(&options).unwrap());
}
#[test]
fn text_advance_drives_hug_width() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf");
    let mut fonts = Fonts::new();
    fonts.load(&std::fs::read(path).unwrap()).unwrap();
    let mut p = parent(100., 80., "horizontal");
    p["sizing"] = json!({"width":"hug","height":"hug"});
    let mut text = shape("label", 100., 40.);
    text["kind"] = json!("text");
    text["text"] = json!("设计");
    text["fontSize"] = json!(20);
    text["sizing"] = json!({"width":"hug","height":"hug"});
    let mut d = doc(p, vec![text]);
    layout::resolve(&mut d, &fonts).unwrap();
    let old = d.nodes["p"].width;
    d.nodes.get_mut("label").unwrap().text = "让想法自由生长".into();
    layout::resolve(&mut d, &fonts).unwrap();
    assert!(d.nodes["p"].width > old);
    close(d.nodes["p"].width, d.nodes["label"].width + 20.);
}
#[test]
fn invalid_layout_values_are_rejected() {
    for patch in [
        json!({"width":"fill","minWidth":200,"maxWidth":100}),
        json!({"rowSpan":1000}),
    ] {
        let mut child = shape("a", 10., 10.);
        child["sizing"] = patch;
        assert!(
            doc(parent(100., 80., "horizontal"), vec![child])
                .validate()
                .is_err()
        );
    }
}

#[test]
fn fractional_grid_is_stable_across_json_roundtrips() {
    let mut p = parent(360., 220., "grid");
    p["layout"]["padding"] = json!([16, 16, 16, 16]);
    p["layout"]["gap"] = json!(12);
    p["layout"]["lineGap"] = json!(12);
    p["layout"]["fillRows"] = json!(true);
    let children=(0..5).map(|i|{let mut n=shape(&format!("n{i}"),40.,35.);n["sizing"]=json!({"width":"fill","height":"fill","columnSpan":if i==0{2}else{1},"rowSpan":if i==0{2}else{1}});n}).collect();
    let mut d = doc(p, children);
    solve(&mut d);
    assert_eq!(
        layout::changes(&serde_json::to_string(&d).unwrap(), &Fonts::new()).unwrap(),
        "{}"
    );
}
