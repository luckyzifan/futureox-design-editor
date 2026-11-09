//! Regression coverage for FIG files that used to be rejected as a whole.
use futureox_design_kernel::{fig, scene::Document};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn hairline_network() -> Vec<u8> {
    let mut bytes = Vec::new();
    let word = |bytes: &mut Vec<u8>, value: u32| bytes.extend(value.to_le_bytes());
    let float = |bytes: &mut Vec<u8>, value: f32| word(bytes, value.to_bits());
    word(&mut bytes, 2);
    word(&mut bytes, 1);
    word(&mut bytes, 0);
    word(&mut bytes, 0);
    float(&mut bytes, 0.);
    float(&mut bytes, 0.);
    word(&mut bytes, 0);
    float(&mut bytes, 14.);
    float(&mut bytes, 0.);
    word(&mut bytes, 0);
    word(&mut bytes, 0);
    float(&mut bytes, 0.);
    float(&mut bytes, 0.);
    word(&mut bytes, 1);
    float(&mut bytes, 0.);
    float(&mut bytes, 0.);
    bytes
}

#[test]
fn variable_sets_aliases_and_hairline_vectors_do_not_reject_the_file() {
    let input = json!({"nodeChanges":[
        {"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT","name":"Tokens"},
        {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","name":"Page","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},
        {"guid":{"sessionID":1,"localID":3},"type":"VARIABLE_SET","name":"Primitives","key":"set-key",
            "variableSetModes":[{"name":"Light","id":{"sessionID":9,"localID":1}},{"name":"Dark","id":{"sessionID":9,"localID":2}}]},
        {"guid":{"sessionID":1,"localID":4},"type":"VARIABLE","name":"Gap","key":"gap-key","variableResolvedType":"FLOAT",
            "variableSetID":{"assetRef":{"key":"set-key"}},
            "variableDataValues":{"entries":[
                {"modeID":{"sessionID":9,"localID":1},"variableData":{"value":{"floatValue":8.}}},
                {"modeID":{"sessionID":9,"localID":2},"variableData":{"value":{"floatValue":12.}}}
            ]}},
        {"guid":{"sessionID":1,"localID":5},"type":"VARIABLE","name":"Gap alias","key":"gap-alias","variableResolvedType":"FLOAT",
            "variableSetID":{"assetRef":{"key":"set-key"}},
            "variableDataValues":{"entries":[
                {"modeID":{"sessionID":9,"localID":1},"variableData":{"value":{"alias":{"assetRef":{"key":"gap-key"}}}}},
                {"modeID":{"sessionID":9,"localID":2},"variableData":{"value":{"alias":{"assetRef":{"key":"gap-key"}}}}}
            ]}},
        {"guid":{"sessionID":1,"localID":6},"type":"RECTANGLE","name":"Chip","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},
            "size":{"x":40,"y":24},
            "variableConsumptionMap":{"entries":[
                {"variableField":"WIDTH","variableData":{"value":{"alias":{"assetRef":{"key":"gap-key"}}}}},
                {"variableField":"RECTANGLE_TOP_LEFT_CORNER_RADIUS","variableData":{"value":{"alias":{"assetRef":{"key":"gap-key"}}}}}
            ]}},
        {"guid":{"sessionID":1,"localID":7},"type":"VECTOR","name":"Rule","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"b"},
            "size":{"x":14,"y":0},"vectorData":{"normalizedSize":{"x":14,"y":0},"vectorNetworkBlob":0}},
        {"guid":{"sessionID":1,"localID":8},"type":"WIDGET","name":"Not a layer","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"c"}}
    ]});
    let rejected = fig::document_from_canvas(&input, BTreeMap::new(), vec![hairline_network()]);
    assert!(
        rejected.unwrap_err().to_string().contains("WIDGET"),
        "unknown nodes still reject the file"
    );
    input_without_widget(&input);
}

fn input_without_widget(input: &Value) {
    let mut input = input.clone();
    input["nodeChanges"].as_array_mut().unwrap().pop();
    let doc = fig::document_from_canvas(&input, BTreeMap::new(), vec![hairline_network()]).unwrap();
    doc.validate().unwrap();
    assert!(
        !doc.nodes.contains_key("fig-1-3"),
        "a variable set is not a layer"
    );
    assert!(!doc.nodes.contains_key("fig-1-4"));
    let system = doc.design_system.as_ref().unwrap();
    assert_eq!(
        system.collections["set-key"].modes,
        ["Light".to_string(), "Dark".to_string()]
    );
    assert_eq!(
        system.variables["fig-1-5"].values["Light"]["alias"],
        "fig-1-4"
    );
    let resolved =
        futureox_design_kernel::design_system::value(system, "fig-1-5", &system.active_modes)
            .unwrap();
    assert_eq!(resolved, json!(8.));
    assert_eq!(doc.nodes["fig-1-6"].bindings["width"], "fig-1-4");
    let retained =
        system.sketch_containers["nodeMetadata"]["fig-1-6"]["bindings"]["figVariableConsumption"]
            .as_str()
            .unwrap();
    assert!(
        retained.contains("RECTANGLE_TOP_LEFT_CORNER_RADIUS"),
        "{retained}"
    );
    assert!((doc.nodes["fig-1-7"].height - 0.01).abs() < 1e-9);
    assert_eq!(
        doc.nodes["fig-1-7"].network.as_ref().unwrap().vertices[1].x,
        14.
    );
    let opened =
        futureox_design_kernel::binfmt::decode(&futureox_design_kernel::binfmt::encode(&doc))
            .unwrap();
    assert_eq!(
        opened.design_system.as_ref().unwrap().variables["fig-1-5"].values["Dark"]["alias"],
        "fig-1-4"
    );
    assert_eq!(opened.nodes["fig-1-6"].bindings["width"], "fig-1-4");
    opened.validate().unwrap();
}

#[test]
fn component_corner_override_imports_and_unknown_override_fields_are_reported() {
    let input = json!({"nodeChanges":[
        {"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT","name":"Kit"},
        {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},
        {"guid":{"sessionID":1,"localID":3},"type":"SYMBOL","name":"Chip","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},"size":{"x":40,"y":24}},
        {"guid":{"sessionID":1,"localID":4},"type":"RECTANGLE","name":"Face","parentIndex":{"guid":{"sessionID":1,"localID":3},"position":"a"},"size":{"x":40,"y":24}},
        {"guid":{"sessionID":1,"localID":5},"type":"INSTANCE","name":"Use","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"b"},"size":{"x":40,"y":24},
            "symbolData":{"symbolID":{"sessionID":1,"localID":3},"symbolOverrides":[{
                "overrideKey":{"sessionID":1,"localID":4},
                "cornerRadius":8,
                "size":{"x":20,"y":10},
                "rectangleTopLeftCornerRadius":1,"rectangleTopRightCornerRadius":2,
                "rectangleBottomRightCornerRadius":3,"rectangleBottomLeftCornerRadius":4,
                "pluginData":[]
            }]}}
    ]});
    let doc = fig::document_from_canvas(&input, BTreeMap::new(), vec![]).unwrap();
    doc.validate().unwrap();
    let fields = &doc.nodes["fig-1-5"].instance.as_ref().unwrap().overrides["fig-1-4"];
    assert_eq!(fields["cornerRadius"], json!(8.));
    assert_eq!(fields["width"], json!(20.));
    assert_eq!(fields["height"], json!(10.));
    assert_eq!(fields["radii"], json!([1., 2., 3., 4.]));
    let notes =
        doc.design_system.as_ref().unwrap().sketch_containers["figDocument"]["notes"].to_string();
    assert!(notes.contains("pluginData"), "{notes}");
}

fn checker_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&[
            255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255,
        ])
        .unwrap();
    bytes
}

fn tiled_document(extra: Value) -> Document {
    let mut paint = json!({"type":"IMAGE","image":{"dataRef":"img"},"imageScaleMode":"TILE"});
    paint
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let input = json!({"nodeChanges":[
        {"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT"},
        {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},
        {"guid":{"sessionID":1,"localID":3},"type":"RECTANGLE","name":"Tile","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},
            "size":{"x":4,"y":4},"fillPaints":[paint]}
    ]});
    let doc = fig::document_from_canvas(
        &input,
        BTreeMap::from([("img".into(), checker_png())]),
        vec![],
    )
    .unwrap();
    doc.validate().unwrap();
    doc
}

fn rendered(doc: &Document) -> Vec<u8> {
    let mut engine = futureox_design_kernel::renderer::Engine::new();
    engine
        .load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    let options = serde_json::from_value(json!({"pageId":doc.pages[0].id,"width":4,"height":4,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
    engine.render(&options).unwrap()
}

#[test]
fn nondefault_image_tiles_import_and_change_pixels() {
    let plain = tiled_document(json!({}));
    let scaled = tiled_document(json!({"scale":2.5,"rotation":90.}));
    let gapped =
        tiled_document(json!({"patternSpacing":{"x":2.,"y":0.},"horizontalAlignment":"CENTER"}));
    assert_eq!(
        plain.nodes["fig-1-3"].fills[0].tile.as_ref().unwrap().scale,
        1.
    );
    let tile = scaled.nodes["fig-1-3"].fills[0].tile.as_ref().unwrap();
    assert_eq!(tile.scale, 2.5);
    assert_eq!(tile.rotation, 90.);
    assert_eq!(
        gapped.nodes["fig-1-3"].fills[0]
            .tile
            .as_ref()
            .unwrap()
            .spacing,
        [2., 0.]
    );
    assert_eq!(
        gapped.nodes["fig-1-3"].fills[0]
            .tile
            .as_ref()
            .unwrap()
            .alignment[0],
        "center"
    );
    let plain_pixels = rendered(&plain);
    let scaled_pixels = rendered(&scaled);
    let gapped_pixels = rendered(&gapped);
    assert_ne!(
        plain_pixels, scaled_pixels,
        "scale and rotation must change the tile"
    );
    assert_ne!(plain_pixels, gapped_pixels, "spacing must change the tile");
    assert!(plain_pixels.chunks_exact(4).any(|pixel| pixel[3] == 255));
    let rejected = json!({"nodeChanges":[
        {"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT"},
        {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},
        {"guid":{"sessionID":1,"localID":3},"type":"RECTANGLE","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},
            "size":{"x":4,"y":4},"fillPaints":[{"type":"IMAGE","image":{"dataRef":"img"},"imageScaleMode":"TILE","scale":0.}]}
    ]});
    assert!(
        fig::document_from_canvas(
            &rejected,
            BTreeMap::from([("img".into(), checker_png())]),
            vec![]
        )
        .unwrap_err()
        .to_string()
        .contains("out of range")
    );
    let reopened: Document =
        serde_json::from_str(&serde_json::to_string(&scaled).unwrap()).unwrap();
    assert_eq!(
        reopened.nodes["fig-1-3"].fills[0]
            .tile
            .as_ref()
            .unwrap()
            .rotation,
        90.
    );
}
