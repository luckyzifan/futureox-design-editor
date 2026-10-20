use futureox_design_kernel::{
    components, scene::Document,
};
use serde_json::{Value, json};
fn shape(id: &str, kind: &str) -> Value {
    json!({"id":id,"name":id,"kind":kind,"width":100,"height":40,"transform":[1,0,0,1,0,0],"fills":[{"kind":"solid","color":"#8899cc"}]})
}
fn main_node(id: &str, children: &[&str]) -> Value {
    let mut n = shape(id, "frame");
    n["children"] = json!(children);
    n["component"] = json!({});
    n
}
fn instance(id: &str, component: &str) -> Value {
    let mut n = shape(id, "frame");
    n["instance"] = json!({"componentId":component});
    n
}
fn doc(nodes: Vec<Value>, roots: &[&str]) -> Document {
    let nodes: serde_json::Map<_, _> = nodes
        .into_iter()
        .map(|n| (n["id"].as_str().unwrap().to_owned(), n))
        .collect();
    serde_json::from_value(json!({"schemaVersion":1,"id":"d","name":"components","pages":[{"id":"page","name":"page","background":"#ffffff","children":roots}],"nodes":nodes})).unwrap()
}
fn basic() -> Document {
    let mut label = shape("label", "text");
    label["text"] = json!("Default");
    doc(
        vec![main_node("main", &["label"]), label, instance("i", "main")],
        &["main", "i"],
    )
}
fn resolve(d: &mut Document) {
    d.validate().unwrap();
    components::resolve(d).unwrap();
    d.validate().unwrap()
}
fn generated(d: &Document, owner: &str, key: &str) -> String {
    d.nodes
        .values()
        .find(|n| {
            n.instance_origin
                .as_ref()
                .is_some_and(|o| o.owner == owner && o.key == key)
        })
        .unwrap()
        .id
        .clone()
}

fn slots() -> Document {
    let mut d = basic();
    d.schema_version = 15;
    let mut host = shape("host", "frame"); host["children"] = json!(["label"]);
    d.nodes.insert("host".into(), serde_json::from_value(host).unwrap());
    d.nodes.get_mut("main").unwrap().children = vec!["host".into()];
    d.nodes.get_mut("main").unwrap().component.as_mut().unwrap().slots.insert("body".into(), components::Slot { name: "Body".into(), target_key: "host".into() });
    resolve(&mut d); d
}
fn assign(d: &mut Document) -> String {
    let host = generated(d, "i", "host");
    d.nodes.insert("content".into(), serde_json::from_value(shape("content", "rectangle")).unwrap());
    d.nodes.get_mut(&host).unwrap().children.push("content".into());
    d.nodes.get_mut("i").unwrap().instance.as_mut().unwrap().slot_contents.insert("body".into(), vec!["content".into()]);
    host
}
#[test]
fn fallback_assignment_stable_ids_and_reopen() {
    let mut d = slots();
    assert!(d.nodes.values().any(|n| n.instance_origin.as_ref().is_some_and(|o| o.key == "label")));
    let host = assign(&mut d); resolve(&mut d);
    assert_eq!(d.nodes[&host].children, vec!["content"]);
    assert!(d.nodes["content"].instance_origin.is_none());
    d.nodes.get_mut("content").unwrap().name = "Custom content".into();
    d.nodes.get_mut("host").unwrap().width = 333.;
    resolve(&mut d);
    assert_eq!(d.nodes["content"].name, "Custom content");
    assert_eq!(d.nodes[&host].width, 333.);
    let encoded = serde_json::to_string(&d).unwrap();
    let mut restored: Document = serde_json::from_str(&encoded).unwrap(); resolve(&mut restored);
    assert_eq!(restored, d);
}
#[test]
fn invalid_ownership_missing_slot_and_missing_root_fail() {
    let mut d = slots(); assign(&mut d); resolve(&mut d);
    let mut bad = d.clone(); bad.nodes.get_mut("i").unwrap().instance.as_mut().unwrap().slot_contents.insert("missing".into(), vec![]);
    assert!(components::resolve(&mut bad).is_err());
    let mut bad = d.clone(); bad.nodes.get_mut("i").unwrap().instance.as_mut().unwrap().slot_contents.insert("body".into(), vec!["main".into()]);
    assert!(components::resolve(&mut bad).is_err());
    let mut bad = d.clone(); bad.nodes.get_mut("i").unwrap().instance.as_mut().unwrap().slot_contents.insert("body".into(), vec!["absent".into()]);
    assert!(components::resolve(&mut bad).is_err());
    let mut bad = d.clone(); bad.nodes.get_mut("main").unwrap().component.as_mut().unwrap().slots.clear();
    assert!(components::resolve(&mut bad).is_err());
}
#[test]
fn arbitrary_nested_instance_content_materializes_once() {
    let mut d = slots(); let host = assign(&mut d);
    let nested: futureox_design_kernel::scene::Node = serde_json::from_value(main_node("other", &["other-label"])).unwrap();
    d.nodes.insert("other".into(), nested);
    d.nodes.insert("other-label".into(), serde_json::from_value(shape("other-label", "rectangle")).unwrap());
    d.pages[0].children.push("other".into());
    d.nodes.get_mut("content").unwrap().instance = Some(serde_json::from_value(json!({"componentId":"other"})).unwrap());
    resolve(&mut d); let child = d.nodes["content"].children[0].clone();
    assert_eq!(d.nodes[&host].children, vec!["content"]);
    resolve(&mut d); assert_eq!(d.nodes["content"].children, vec![child]);
}

#[test]
fn binary_roundtrip_and_cpu_render_keep_slot_content() {
    use futureox_design_kernel::{Engine, RenderOptions, View};
    let mut d = slots(); assign(&mut d); resolve(&mut d);
    d.nodes.get_mut("main").unwrap().transform.0[4] = 200.;
    d.nodes.get_mut("content").unwrap().fills = serde_json::from_value(json!([{"kind":"solid","color":"#ff0000"}])).unwrap();
    let encoded = futureox_design_kernel::binfmt::encode(&d);
    let restored = futureox_design_kernel::binfmt::decode(&encoded).unwrap();
    assert_eq!(restored, d);
    let mut engine = Engine::new();
    engine.load_font(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap()).unwrap();
    engine.load_document(&serde_json::to_string(&restored).unwrap()).unwrap();
    let options = RenderOptions { page_id: "page".into(), width: 120, height: 60, view: View {x:0., y:0., zoom:1.}, transparent:true, grid:false, pixel_preview:None, animation:None, raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic, interactive_effects:false, checkerboard:false };
    let pixels = engine.render(&options).unwrap();
    assert_eq!(&pixels[(5 * 120 + 5) * 4..(5 * 120 + 5) * 4 + 4], &[255, 0, 0, 255]);
    assert!(futureox_design_kernel::hit_test(&restored.nodes["content"], futureox_design_kernel::math::Point::new(5., 5.), 0.).unwrap());
    let mut legacy = restored.clone(); legacy.schema_version = 14; assert!(legacy.validate().is_err());
}
#[test]
fn deep_slot_content_is_bounded() {
    let mut d = slots(); assign(&mut d);
    let mut parent = "content".to_owned();
    for i in 0..66 { let id = format!("deep-{i}"); d.nodes.insert(id.clone(), serde_json::from_value(shape(&id,"frame")).unwrap()); d.nodes.get_mut(&parent).unwrap().children.push(id.clone()); parent=id; }
    assert!(components::resolve(&mut d).is_err());
}
