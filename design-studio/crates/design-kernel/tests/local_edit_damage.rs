use futureox_design_kernel::{Engine, dirty_region::PatchDamage, editing::DocumentPatch, scene::Document};
use serde_json::{Value, json};

fn fixture() -> Document {
    serde_json::from_value(json!({"schemaVersion":16,"id":"local","name":"local","colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
      "pages":[{"id":"p","name":"p","background":"#ffffff","children":["stack","far"]}],
      "nodes":{
        "stack":{"id":"stack","kind":"frame","width":260,"height":100,
          "transform":[1,0,0,1,20,20],"layout":{"mode":"horizontal","gap":20},"children":["a","b"]},
        "a":{"id":"a","kind":"rectangle","width":40,"height":40,"transform":[1,0,0,1,9000,9000],
          "fills":[{"kind":"solid","color":"#ff0000"}]},
        "b":{"id":"b","kind":"rectangle","width":40,"height":40,"fills":[{"kind":"solid","color":"#00ff00"}]},
        "far":{"id":"far","kind":"rectangle","width":80,"height":80,"transform":[1,0,0,1,400,20],
          "fills":[{"kind":"solid","color":"#0000ff"}]}
      }})).unwrap()
}
fn options() -> Value { json!({"pageId":"p","width":512,"height":160,"view":{"x":0,"y":0,"zoom":1}}) }
fn load(doc: &Document) -> Engine {
    let mut engine=Engine::new();engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();engine
}
fn verify(before: &Document, after: &Document, expect_local: bool) -> PatchDamage {
    let mut engine=load(before);let options=engine.parse_options(options()).unwrap();
    let old=engine.render_linear(&options).unwrap();
    let damage=engine.apply_document_patch_with_damage(&DocumentPatch::between(before,after).unwrap()).unwrap();
    assert_eq!(!damage.full,expect_local,"unexpected damage {:?}",damage.reason);
    let actual=engine.render_linear(&options).unwrap();let expected=load(after).render_linear(&options).unwrap();
    let words=|pixels:Vec<futureox_design_kernel::blend::Pixel>|pixels.into_iter().flat_map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>();
    assert_eq!(words(actual.clone()),words(expected),"incremental result differs from a fresh render");
    let mut changes=0;
    for (index,(old,new)) in old.iter().zip(&actual).enumerate() {
        if old.0.map(f32::to_bits)==new.0.map(f32::to_bits){continue}
        changes+=1;
        if expect_local {
            let (x,y)=((index%512) as f64,(index/512) as f64);
            assert!(damage.rects.as_ref().unwrap().iter().any(|r|x>=r[0]&&y>=r[1]&&x<r[0]+r[2]&&y<r[1]+r[3]),"changed pixel outside certificate: {x},{y}");
        }
    }
    assert!(changes>0,"the edit must change actual pixels");damage
}

#[test]
fn resolved_material_edits_do_not_invalidate_layout_siblings() {
    for opacity in [false,true] {
        let before=fixture();let mut after=before.clone();
        if opacity {after.nodes.get_mut("a").unwrap().opacity=0.5;}
        else {after.nodes.get_mut("a").unwrap().fills[0].color="#aa00ff".into();}
        let damage=verify(&before,&after,true);
        let bounds=damage.bounds.unwrap();
        assert!(bounds[0]<100.&&bounds[1]<100.,"must use resolved placement, not authored (9000,9000)");
        assert!(bounds[0]+bounds[2]<100.,"unchanged sibling b must remain reusable");
    }
}

#[test]
fn geometry_edit_under_layout_still_uses_conservative_invalidation() {
    let before=fixture();let mut after=before.clone();after.nodes.get_mut("a").unwrap().width=70.;
    verify(&before,&after,false);
}

fn add_lens(doc:&mut Document, separate_page:bool, passthrough:bool){
    doc.nodes.insert("board".into(),serde_json::from_value(json!({"id":"board","kind":"frame","width":100,"height":100,
       "transform":[1,0,0,1,300,20],"blend":if passthrough{"pass-through"}else{"normal"},"children":["lens"]})).unwrap());
    doc.nodes.insert("lens".into(),serde_json::from_value(json!({"id":"lens","kind":"rectangle","width":40,"height":40,
       "effects":[{"kind":"glass","radius":4,"color":"#000000"}]})).unwrap());
    if separate_page {doc.pages.push(serde_json::from_value(json!({"id":"q","name":"q","background":"#ffffff","children":["board"]})).unwrap());}
    else {doc.pages[0].children.push("board".into());}
}

#[test]
fn unrelated_page_or_isolated_glass_does_not_discard_local_pixels(){
    for separate_page in [true,false] {
        let mut before=fixture();add_lens(&mut before,separate_page,false);
        let mut after=before.clone();after.nodes.get_mut("far").unwrap().opacity=0.5;
        verify(&before,&after,true);
        let mut moved=before.clone();moved.nodes.get_mut("far").unwrap().transform.0[4]+=8.;
        verify(&before,&moved,true);
    }
}

#[test]
fn same_page_pass_through_glass_keeps_unknown_read_guard(){
    let mut before=fixture();add_lens(&mut before,false,true);
    let mut after=before.clone();after.nodes.get_mut("far").unwrap().opacity=0.5;
    let damage=verify(&before,&after,false);assert_eq!(damage.reason,Some("glass-effect"));
}

#[test]
fn nested_mask_material_edit_dirties_its_consumers_but_not_other_roots(){
    let mut before=fixture();before.nodes.get_mut("stack").unwrap().layout=None;
    before.nodes.get_mut("a").unwrap().transform.0[4]=0.;before.nodes.get_mut("a").unwrap().transform.0[5]=0.;
    before.nodes.get_mut("a").unwrap().mask=true;
    before.nodes.get_mut("b").unwrap().width=100.;
    let mut after=before.clone();after.nodes.get_mut("a").unwrap().opacity=0.5;
    let damage=verify(&before,&after,true);
    assert!(damage.bounds.unwrap()[0]+damage.bounds.unwrap()[2]<400.,"far root must remain reusable");
}

#[test]
fn page_root_mask_material_edit_keeps_unbounded_sibling_guard(){
    let mut before=fixture();before.pages[0].children=vec!["far".into(),"stack".into()];
    before.nodes.get_mut("far").unwrap().mask=true;
    // Keep the mask over the layout output so this control also changes pixels.
    before.nodes.get_mut("far").unwrap().transform.0[4]=20.;
    let mut after=before.clone();after.nodes.get_mut("far").unwrap().opacity=0.5;
    verify(&before,&after,false);
}

#[test]
fn newly_connected_optical_scope_is_not_reused(){
    let mut before=fixture();add_lens(&mut before,false,false);
    let mut after=before.clone();after.nodes.get_mut("board").unwrap().blend="pass-through".into();
    after.nodes.get_mut("far").unwrap().opacity=0.5;
    assert_eq!(verify(&before,&after,false).reason,Some("glass-effect"));
}

#[test]
fn other_page_blurs_do_not_spend_current_page_dependency_capacity(){
    let mut before=fixture();
    before.pages.push(serde_json::from_value(json!({"id":"q","name":"q","background":"#ffffff","children":[]})).unwrap());
    for i in 0..513 {
        let id=format!("blur-{i}");before.pages[1].children.push(id.clone());
        before.nodes.insert(id.clone(),serde_json::from_value(json!({"id":id,"kind":"rectangle","width":30,"height":30,
            "effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]})).unwrap());
    }
    let mut after=before.clone();after.nodes.get_mut("far").unwrap().opacity=0.5;
    verify(&before,&after,true);
}

#[test]
fn local_material_damage_preserves_hdr_and_negative_float_channels(){
    let mut before=fixture();
    before.nodes.get_mut("a").unwrap().fills[0].color="color(srgb-linear 8 -8 0.125 / 0.5)".into();
    let mut after=before.clone();after.nodes.get_mut("a").unwrap().opacity=0.5;
    verify(&before,&after,true);
    let mut engine=load(&after);let options=engine.parse_options(options()).unwrap();
    let pixels=engine.render_linear(&options).unwrap();
    assert!(pixels.iter().any(|p|p.0[0]>1.&&p.0[1]<0.),"HDR and negative channels must survive composition");
}
