//! Format semantics checked independently of the importer's private Kiwi writer.
use futureox_design_kernel::{fig, scene::Document};
use serde_json::{json, Value};
use std::collections::BTreeMap;
fn tree(layer: Value) -> Value {
    let mut node = json!({"guid":{"sessionID":1,"localID":3},"type":"RECTANGLE","name":"Subject",
        "parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},"size":{"x":40,"y":24},
        "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1}}]});
    node.as_object_mut().unwrap().extend(layer.as_object().unwrap().clone());
    json!({"nodeChanges":[{"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT","documentColorProfile":"SRGB"},
        {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},node]})
}
fn import(layer: Value) -> Document {
    let doc=fig::document_from_canvas(&tree(layer),BTreeMap::new(),vec![]).unwrap();
    doc.validate().unwrap(); doc
}
#[test]
fn rectangle_is_renderable_and_native_fixture_passes_admission() {
    let doc=import(json!({}));let n=&doc.nodes["fig-1-3"];
    assert_eq!(n.kind,"rectangle"); assert!(!n.paths().unwrap().0.commands.is_empty());
    let bytes=include_bytes!("../../../../testing/fixtures/design/figma-materials-native-2026-10-08.fig");
    let doc=fig::import_fig_native(bytes).unwrap(); doc.validate().unwrap();
    assert_eq!(doc.nodes.len(),381);assert!(doc.nodes.values().all(|n| !matches!(n.kind.as_str(),"rect"|"path")));
}
#[test]
fn disabled_paint_blend_and_stop_alpha_are_authored_data() {
    let doc=import(json!({"blendMode":"PASS_THROUGH","fillPaints":[{"type":"GRADIENT_LINEAR","visible":false,"blendMode":"LINEAR_BURN","opacity":0.4,
        "stops":[{"position":0,"color":{"r":0.125,"g":0.25,"b":0.5,"a":0.125}},{"position":1,"color":{"r":1,"g":1,"b":1,"a":0.75}}]}]}));
    let n=&doc.nodes["fig-1-3"];assert_eq!(n.blend,"pass-through");assert_eq!(n.fills.len(),1);
    let p=&n.fills[0];assert!(!p.visible);assert_eq!(p.blend,"linear-burn");assert_eq!(p.opacity,0.4);
    assert_eq!(p.stops[0].color,"color(srgb 0.125 0.25 0.5 / 0.125)");
}
#[test]
fn image_v106_hash_and_blob_use_the_real_scale_modes() {
    use base64::Engine;
    let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==").unwrap();
    for (mode,fit) in [("STRETCH","stretch"),("FIT","contain"),("FILL","cover")] {
        for image in [json!({"dataBlob":0}),json!({"hash":[10,255]})] {
            let doc=fig::document_from_canvas(&tree(json!({"fillPaints":[{"type":"IMAGE","image":image,"imageScaleMode":mode}]})),
                BTreeMap::from([("0aff".into(),png.clone())]),vec![png.clone()]).unwrap();
            doc.validate().unwrap();let p=&doc.nodes["fig-1-3"].fills[0];assert!(p.image.is_some());assert_eq!(p.fit,fit);
        }
    }
}
#[test]
fn unsupported_active_semantics_never_return_silent_success() {
    for layer in [json!({"fillPaints":[{"type":"IMAGE","image":{"dataBlob":5}}]}),
        json!({"effects":[{"type":"REPEAT"}]}),json!({"blendMode":"FUTURE_BLEND"}),
        json!({"mask":true,"maskType":"FUTURE_MASK"}),json!({"type":"BOOLEAN_OPERATION","booleanOperation":"FUTURE_OP"}),
        json!({"colorProfile":"DISPLAY_P3"}),json!({"fillPaints":[{"type":"GRADIENT_LINEAR","interpolationColorSpace":"OKLAB"}]})] {
        assert!(fig::document_from_canvas(&tree(layer.clone()),BTreeMap::new(),vec![]).is_err(),"{layer}");
    }
}
#[test]
fn zero_dimension_line_keeps_endpoints_and_zero_stroke() {
    let doc=import(json!({"type":"LINE","size":{"x":40,"y":0},"fillPaints":[],"strokeWeight":0,
        "strokePaints":[{"type":"SOLID","color":{"r":0,"g":0,"b":0,"a":1}}]}));
    let n=&doc.nodes["fig-1-3"];assert_eq!(n.kind,"vector");assert_eq!(n.network.as_ref().unwrap().vertices[1].y,0.);
    assert_eq!(n.strokes[0].width,0.);
}

#[test]
fn component_properties_target_real_layers_and_execute_assigned_literals() {
    let mut input=tree(json!({"type":"SYMBOL","componentPropDefs":[
        {"id":{"sessionID":9,"localID":1},"name":"Shown","type":"BOOL","initialValue":{"boolValue":true}},
        {"id":{"sessionID":9,"localID":2},"name":"Label","type":"TEXT","initialValue":{"textValue":{"characters":"Default"}}}]}));
    let changes=input["nodeChanges"].as_array_mut().unwrap();
    changes.push(json!({"guid":{"sessionID":1,"localID":4},"type":"TEXT","parentIndex":{"guid":{"sessionID":1,"localID":3},"position":"a"},
        "size":{"x":30,"y":20},"textData":{"characters":"Original"},"componentPropRefs":[
        {"defID":{"sessionID":9,"localID":1},"componentPropNodeField":"VISIBLE"},
        {"defID":{"sessionID":9,"localID":2},"componentPropNodeField":"TEXT_DATA"}]}));
    changes.push(json!({"guid":{"sessionID":1,"localID":5},"type":"INSTANCE","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"b"},
        "size":{"x":40,"y":24},"symbolData":{"symbolID":{"sessionID":1,"localID":3}},"componentPropAssignments":[
        {"defID":{"sessionID":9,"localID":1},"value":{"boolValue":false}},
        {"defID":{"sessionID":9,"localID":2},"value":{"textValue":{"characters":"Edited"}}}]}));
    let mut doc=fig::document_from_canvas(&input,BTreeMap::new(),vec![]).unwrap();doc.validate().unwrap();
    let prop=&doc.nodes["fig-1-3"].component.as_ref().unwrap().properties["fig-9-2"];
    assert_eq!(prop.target_key,"fig-1-4");assert_eq!(prop.default_value,"Default");
    futureox_design_kernel::components::resolve(&mut doc).unwrap();
    let rendered=doc.nodes.values().find(|n|n.instance_origin.as_ref().is_some_and(|o|o.owner=="fig-1-5") && n.kind=="text").unwrap();
    assert_eq!(rendered.text,"Edited");assert!(!rendered.visible);doc.validate().unwrap();
}

#[test]
fn shared_native_schema_corpus_passes_import_validation_resolution_and_render() {
    let bytes=include_bytes!("../../../../testing/fixtures/design/fig-interop-v106.fig");
    let report=futureox_design_kernel::interop::import_fig_report(bytes).unwrap();
    assert_eq!(report.backend,"rust-native-fig");assert!(report.native_error.is_none());
    let mut doc=report.document;doc.validate().unwrap();
    let named=|name:&str|doc.nodes.values().find(|n|n.name==name).unwrap();
    assert_eq!(named("XOR").boolean_operation,Some(futureox_design_kernel::boolean::Operation::Exclude));
    for (name,fit) in [("STRETCH","stretch"),("FIT","contain"),("FILL","cover"),("TILE","cover")] {
        let p=&named(name).fills[0];assert_eq!(p.fit,fit);assert!(p.image.is_some());assert_eq!(p.tile.is_some(),name=="TILE");
    }
    futureox_design_kernel::components::resolve(&mut doc).unwrap();doc.validate().unwrap();
    assert!(doc.nodes.values().any(|n|n.text=="Edited" && !n.visible && n.instance_origin.is_some()));
    let mut engine=futureox_design_kernel::renderer::Engine::new();
    engine.load_font(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let options=serde_json::from_value(json!({"pageId":doc.pages[0].id,"width":64,"height":32,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
    let pixels=engine.render(&options).unwrap();assert_eq!(pixels.len(),64*32*4);assert!(pixels.chunks_exact(4).any(|p|p[3]>0));
}

#[test]
fn native_arc_data_preserves_sweep_and_donut_hole_in_actual_pixels() {
    let doc=import(json!({"type":"ELLIPSE","arcData":{"startingAngle":0.25,"endingAngle":1.75,"innerRadius":0.4}}));
    let arc=doc.nodes["fig-1-3"].arc.unwrap();assert_eq!(arc.start_angle,0.25);assert_eq!(arc.sweep_angle,1.5);assert_eq!(arc.inner_radius,0.4);
    let mut engine=futureox_design_kernel::renderer::Engine::new();engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let options=serde_json::from_value(json!({"pageId":doc.pages[0].id,"width":40,"height":24,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
    let pixels=engine.render(&options).unwrap();let alpha=|x:usize,y:usize|pixels[(y*40+x)*4+3];
    assert_eq!(alpha(20,12),0);assert_eq!(alpha(30,18),255);assert_eq!(alpha(20,2),0);
}


#[test]
fn resized_group_frames_preserve_overflow_pixels_and_do_not_become_auto_layout_frames() {
    let mut input=tree(json!({"type":"FRAME","resizeToFit":true,"frameMaskDisabled":false,"fillPaints":[]}));
    input["nodeChanges"].as_array_mut().unwrap().push(json!({"guid":{"sessionID":1,"localID":4},"type":"RECTANGLE",
      "parentIndex":{"guid":{"sessionID":1,"localID":3},"position":"a"},"size":{"x":20,"y":20},
      "transform":{"m00":1,"m01":0,"m02":30,"m10":0,"m11":1,"m12":0},
      "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1}}]}));
    let doc=fig::document_from_canvas(&input,BTreeMap::new(),vec![]).unwrap();
    assert_eq!(doc.nodes["fig-1-3"].kind,"group");assert!(!doc.nodes["fig-1-3"].clip);
    let mut engine=futureox_design_kernel::renderer::Engine::new();engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let options=serde_json::from_value(json!({"pageId":doc.pages[0].id,"width":64,"height":32,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
    let pixels=engine.render(&options).unwrap();assert_eq!(pixels[(10*64+45)*4+3],255);
    for fields in [json!({"stackMode":"HORIZONTAL"}),json!({"isStateGroup":true}),json!({"resizeToFit":false})] {
      let mut record=json!({"type":"FRAME","resizeToFit":true});record.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
      assert_eq!(import(record).nodes["fig-1-3"].kind,"frame");
    }
}

#[test]
fn figma_document_pages_styles_component_set_and_save_open() {
    let input = json!({"variableCollections":[{"id":"collection","name":"Theme","modes":["Light"]}],
        "nodeChanges":[
        {"guid":{"sessionID":2,"localID":1},"type":"DOCUMENT","name":"Brand kit","documentColorProfile":"SRGB"},
        {"guid":{"sessionID":2,"localID":2},"type":"CANVAS","name":"Cover","parentIndex":{"guid":{"sessionID":2,"localID":1},"position":"a"},
            "backgroundColor":{"r":1,"g":1,"b":1,"a":1},"guides":[{"axis":"X","offset":12},{"axis":"Y","offset":-4}]},
        {"guid":{"sessionID":2,"localID":3},"type":"CANVAS","name":"Components","internalOnly":true,"parentIndex":{"guid":{"sessionID":2,"localID":1},"position":"b"}},
        {"guid":{"sessionID":2,"localID":4},"type":"COMPONENT_SET","name":"Button","parentIndex":{"guid":{"sessionID":2,"localID":3},"position":"a"},"size":{"x":200,"y":80}},
        {"guid":{"sessionID":2,"localID":5},"type":"SYMBOL","name":"Size=Small","parentIndex":{"guid":{"sessionID":2,"localID":4},"position":"a"},"size":{"x":40,"y":24},"componentKey":"pub-small",
            "componentPropDefs":[{"id":{"sessionID":8,"localID":1},"name":"Size","type":"VARIANT"}]},
        {"guid":{"sessionID":2,"localID":6},"type":"SYMBOL","name":"Size=Large","parentIndex":{"guid":{"sessionID":2,"localID":4},"position":"b"},"size":{"x":80,"y":24}},
        {"guid":{"sessionID":2,"localID":7},"type":"RECTANGLE","name":"Swatch","styleType":"FILL","fillPaints":[{"type":"SOLID","color":{"r":0.2,"g":0.4,"b":0.6,"a":1},"opacity":1}]},
        {"guid":{"sessionID":2,"localID":8},"type":"RECTANGLE","name":"Chip","parentIndex":{"guid":{"sessionID":2,"localID":2},"position":"a"},"size":{"x":40,"y":24},
            "inheritFillStyleID":{"sessionID":2,"localID":7},"fillPaints":[{"type":"SOLID","color":{"r":0.2,"g":0.4,"b":0.6,"a":1}}],
            "boundVariables":{"fill":"collection/color"}},
        {"guid":{"sessionID":2,"localID":9},"type":"TEXT","name":"Label style","styleType":"TEXT","fontSize":18,"textAlignHorizontal":"CENTER","fontName":{"family":"Inter","style":"Bold"}},
        {"guid":{"sessionID":2,"localID":10},"type":"TEXT","name":"Title","parentIndex":{"guid":{"sessionID":2,"localID":2},"position":"b"},"size":{"x":80,"y":24},
            "textData":{"characters":"Hi"},"inheritTextStyleID":{"sessionID":2,"localID":9},"fontSize":18},
        {"guid":{"sessionID":2,"localID":11},"type":"INSTANCE","name":"Use","parentIndex":{"guid":{"sessionID":2,"localID":2},"position":"c"},"size":{"x":40,"y":24},
            "symbolData":{"symbolID":{"sessionID":2,"localID":5}}},
        {"guid":{"sessionID":2,"localID":12},"type":"FRAME","name":"Columns","styleType":"GRID","internalOnly":true},
        {"guid":{"sessionID":2,"localID":13},"type":"WIDGET","name":"Hidden helper","internalOnly":true,"parentIndex":{"guid":{"sessionID":2,"localID":2},"position":"d"}}
    ]});
    let doc = fig::document_from_canvas(&input, BTreeMap::new(), vec![]).unwrap();
    assert_eq!(doc.name, "Brand kit");
    assert_eq!(doc.pages.iter().map(|page| page.name.as_str()).collect::<Vec<_>>(), ["Cover", "Components"]);
    assert_eq!(doc.pages[0].guides.len(), 2);
    assert_eq!(doc.pages[0].guides[0].axis, "x");
    assert!((doc.pages[0].guides[0].position - 12.).abs() < 1e-9);
    assert_eq!(doc.pages[0].guides[1].axis, "y");
    assert!(doc.pages[1].children.iter().any(|id| id == "fig-2-4"));
    assert!(doc.nodes["fig-2-4"].component_set);
    assert_eq!(doc.nodes["fig-2-5"].component.as_ref().unwrap().variants["Size"], "Small");
    assert_eq!(doc.nodes["fig-2-6"].component.as_ref().unwrap().variants["Size"], "Large");
    assert!(!doc.nodes.contains_key("fig-2-7"), "library styles are not layers");
    assert!(!doc.nodes.contains_key("fig-2-12"));
    assert!(!doc.nodes.contains_key("fig-2-13"), "internal helpers on a user page stay out of the scene");
    assert_eq!(doc.nodes["fig-2-8"].style_refs["fills"], "fig-2-7");
    assert_eq!(doc.nodes["fig-2-10"].style_refs["textStyle"], "fig-2-9");
    assert_eq!(doc.nodes["fig-2-11"].instance.as_ref().unwrap().component_id, "fig-2-5");
    let system = doc.design_system.as_ref().unwrap();
    assert_eq!(system.styles["fig-2-7"].kind, "paint");
    assert_eq!(system.styles["fig-2-7"].name, "Swatch");
    assert_eq!(system.styles["fig-2-9"].kind, "text");
    assert_eq!(system.styles["fig-2-9"].value["align"], "center");
    assert_eq!(system.styles["fig-2-9"].value["weight"], 700.0);
    let receipt = system.sketch_containers.get("figDocument").unwrap();
    assert_eq!(receipt["source"], "figma");
    assert_eq!(receipt["documentId"], "fig-2-1");
    assert_eq!(receipt["colorProfile"], "SRGB");
    assert_eq!(receipt["internalPages"][0], "fig-2-3");
    assert_eq!(receipt["variables"]["variableCollections"][0]["name"], "Theme");
    let metadata = system.sketch_containers.get("nodeMetadata").unwrap();
    assert_eq!(metadata["fig-2-5"]["bindings"]["figComponentKey"], "pub-small");
    assert!(metadata["fig-2-8"]["bindings"]["figBoundVariables"].as_str().unwrap().contains("collection/color"));
    assert!(receipt["notes"].as_array().unwrap().iter().any(|note| note.as_str().unwrap_or("").contains("GRID")));
    let reopened: Document = serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
    assert_eq!(reopened, doc);
    let opened = futureox_design_kernel::binfmt::decode(&futureox_design_kernel::binfmt::encode(&doc)).unwrap();
    assert_eq!(opened.name, doc.name);
    assert_eq!(opened.pages, doc.pages);
    assert_eq!(opened.design_system, doc.design_system);
    assert_eq!(opened.nodes["fig-2-4"].component_set, true);
    assert_eq!(opened.nodes["fig-2-8"].style_refs, doc.nodes["fig-2-8"].style_refs);
    opened.validate().unwrap();
}
