//! Regression coverage for FIG files that used to be rejected as a whole.
use futureox_design_kernel::binfmt;
use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
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
    // Rectangle rounding is Node.radii. cornerRadius is only the polygon/star fillet.
    assert!(fields.get("cornerRadius").is_none(), "{fields:?}");
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

#[test]
fn imported_tile_alignment_paints_edits_undo_and_reopens() {
    let start = tiled_document(json!({}));
    let centered =
        tiled_document(json!({"horizontalAlignment":"CENTER","verticalAlignment":"CENTER"}));
    let start_pixels = rendered(&start);
    let centered_pixels = rendered(&centered);
    // 2×2 checker, native period 2, 4×4 fill. Start reads the red texel at
    // the origin. Center pins the image center to the fill center, so that
    // same pixel reads the white texel.
    assert_eq!(&start_pixels[0..4], &[255, 0, 0, 255]);
    assert_eq!(&centered_pixels[0..4], &[255, 255, 255, 255]);
    let mut editor = DocumentEditor::new(centered).unwrap();
    let mut edited = editor.document().clone();
    edited.nodes.get_mut("fig-1-3").unwrap().fills[0]
        .tile
        .as_mut()
        .unwrap()
        .alignment = ["end".into(), "end".into()];
    edited.nodes.get_mut("fig-1-3").unwrap().fills[0]
        .tile
        .as_mut()
        .unwrap()
        .scale = 2.5;
    let patch = DocumentPatch::between(editor.document(), &edited).unwrap();
    editor.apply(editor.revision(), patch).unwrap();
    let edited_pixels = rendered(editor.document());
    assert_ne!(edited_pixels, centered_pixels);
    assert_eq!(
        editor.document().nodes["fig-1-3"].fills[0]
            .tile
            .as_ref()
            .unwrap()
            .scale,
        2.5
    );
    editor.undo().unwrap();
    assert_eq!(rendered(editor.document()), centered_pixels);
    editor.redo().unwrap();
    assert_eq!(rendered(editor.document()), edited_pixels);
    let reopened = binfmt::decode(&binfmt::encode(editor.document())).unwrap();
    reopened.validate().unwrap();
    let tile = reopened.nodes["fig-1-3"].fills[0].tile.as_ref().unwrap();
    assert_eq!(tile.alignment, ["end".to_string(), "end".to_string()]);
    assert_eq!(tile.scale, 2.5);
    assert_eq!(rendered(&reopened), edited_pixels);
    let spaced = tiled_document(json!({
        "scale":2.5,"rotation":90.,"spacing":9.,
        "patternSpacing":{"x":2.},
        "horizontalAlignment":"CENTER","verticalAlignment":"END"
    }));
    let opened = binfmt::decode(&binfmt::encode(&spaced)).unwrap();
    let tile = opened.nodes["fig-1-3"].fills[0].tile.as_ref().unwrap();
    assert_eq!(tile.scale, 2.5);
    assert_eq!(tile.rotation, 90.);
    assert_eq!(
        tile.spacing,
        [2., 0.],
        "patternSpacing replaces scalar spacing"
    );
    assert_eq!(tile.alignment, ["center".to_string(), "end".to_string()]);
    assert_eq!(rendered(&opened), rendered(&spaced));
    let textual = json!({"nodeChanges":[
        {"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT"},
        {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},
        {"guid":{"sessionID":1,"localID":3},"type":"RECTANGLE","parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},
            "size":{"x":4,"y":4},"fillPaints":[{"type":"IMAGE","image":{"dataRef":"img"},"imageScaleMode":"TILE","scale":"2.5"}]}
    ]});
    assert!(
        fig::document_from_canvas(
            &textual,
            BTreeMap::from([("img".into(), checker_png())]),
            vec![]
        )
        .unwrap_err()
        .to_string()
        .contains("not a finite number")
    );
}

fn guid(session: u64, local: u64) -> Value {
    json!({"sessionID": session, "localID": local})
}

fn import_canvas(input: &Value) -> Result<Document, String> {
    fig::document_from_canvas(input, BTreeMap::new(), vec![]).map_err(|error| error.to_string())
}

fn resolved_width(doc: &Document, id: &str) -> Result<f64, String> {
    let mut copy = doc.clone();
    futureox_design_kernel::design_system::resolve(&mut copy)?;
    copy.nodes
        .get(id)
        .map(|node| node.width)
        .ok_or_else(|| format!("missing {id}"))
}

fn resolved_line_gap(doc: &Document, id: &str) -> Result<f64, String> {
    let mut copy = doc.clone();
    futureox_design_kernel::design_system::resolve(&mut copy)?;
    copy.nodes
        .get(id)
        .and_then(|node| node.layout.as_ref().map(|layout| layout.line_gap))
        .ok_or_else(|| format!("missing layout on {id}"))
}

fn document_notes(doc: &Document) -> String {
    doc.design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("figDocument"))
        .and_then(|receipt| receipt.get("notes"))
        .map(|notes| notes.to_string())
        .unwrap_or_default()
}

/// Source oracle for issue #78. The numbers are the values written into the
/// canvas, not a screenshot and not `gold-preview.fig`.
fn variable_fidelity_report() -> Value {
    let page = json!({"guid": guid(1, 1), "type": "DOCUMENT", "name": "Tokens"});
    let canvas = json!({"guid": guid(1, 2), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": guid(1, 1), "position": "a"}});
    let set = json!({"guid": guid(1, 3), "type": "VARIABLE_SET", "name": "Primitives", "key": "set-key",
    "variableSetModes": [
        {"name": "Light", "id": guid(9, 1)},
        {"name": "Dark", "id": guid(9, 2)}
    ]});
    let gap = json!({"guid": guid(1, 4), "type": "VARIABLE", "name": "Gap", "key": "gap-key", "variableResolvedType": "FLOAT",
    "variableSetID": {"assetRef": {"key": "set-key"}},
    "variableDataValues": {"entries": [
        {"modeID": guid(9, 1), "variableData": {"value": {"floatValue": 8.}}},
        {"modeID": guid(9, 2), "variableData": {"value": {"floatValue": 12.}}}
    ]}});
    let alias = json!({"guid": guid(1, 5), "type": "VARIABLE", "name": "Gap alias", "key": "gap-alias", "variableResolvedType": "FLOAT",
    "variableSetID": {"assetRef": {"key": "set-key"}},
    "variableDataValues": {"entries": [
        {"modeID": guid(9, 1), "variableData": {"value": {"alias": {"assetRef": {"key": "gap-key"}}}}},
        {"modeID": guid(9, 2), "variableData": {"value": {"alias": {"assetRef": {"key": "gap-key"}}}}}
    ]}});
    let paragraph = json!({"guid": guid(1, 8), "type": "VARIABLE", "name": "Paragraph", "key": "para-key", "variableResolvedType": "FLOAT",
    "variableSetID": {"assetRef": {"key": "set-key"}},
    "variableDataValues": {"entries": [
        {"modeID": guid(9, 1), "variableData": {"value": {"floatValue": 3.}}},
        {"modeID": guid(9, 2), "variableData": {"value": {"floatValue": 4.}}}
    ]}});
    let frame = json!({"guid": guid(1, 6), "type": "FRAME", "name": "Board", "parentIndex": {"guid": guid(1, 2), "position": "a"},
    "size": {"x": 80., "y": 40.}, "stackMode": "HORIZONTAL", "stackSpacing": 4.,
    "variableConsumptionMap": {"entries": [
        {"variableField": "WIDTH", "variableData": {"value": {"alias": {"assetRef": {"key": "gap-key"}}}}},
        {"variableField": "STACK_COUNTER_SPACING", "variableData": {"value": {"alias": {"assetRef": {"key": "gap-key"}}}}},
        {"variableField": "PARAGRAPH_SPACING", "variableData": {"value": {"alias": {"assetRef": {"key": "para-key"}}}}}
    ]},
    "variableModeBySetMap": {"entries": [
        {"variableSetID": {"assetRef": {"key": "set-key"}}, "variableModeID": guid(9, 2)}
    ]}});
    let symbol = json!({"guid": guid(1, 10), "type": "SYMBOL", "name": "Chip", "parentIndex": {"guid": guid(1, 2), "position": "b"}, "size": {"x": 40., "y": 24.}});
    let face = json!({"guid": guid(1, 11), "type": "RECTANGLE", "name": "Face", "parentIndex": {"guid": guid(1, 10), "position": "a"}, "size": {"x": 40., "y": 24.}});
    let instance = json!({"guid": guid(1, 12), "type": "INSTANCE", "name": "Use", "parentIndex": {"guid": guid(1, 2), "position": "c"}, "size": {"x": 40., "y": 24.},
        "symbolData": {"symbolID": guid(1, 10), "symbolOverrides": []}});
    let input = json!({"nodeChanges": [page, canvas, set, gap, alias, paragraph, frame, symbol, face, instance]});

    let mut report = json!({});
    match import_canvas(&input) {
        Ok(doc) => {
            let system = doc.design_system.as_ref();
            let node = doc.nodes.get("fig-1-6");
            let modes = node.map(|node| node.variable_modes.get("set-key").cloned());
            let line_gap_binding =
                node.and_then(|node| node.bindings.get("layout.lineGap").cloned());
            let width_binding = node.and_then(|node| node.bindings.get("width").cloned());
            let retained = system
                .and_then(|system| system.sketch_containers.get("nodeMetadata"))
                .and_then(|metadata| metadata.pointer("/fig-1-6/bindings/figVariableConsumption"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let width = resolved_width(&doc, "fig-1-6").ok();
            let line_gap = resolved_line_gap(&doc, "fig-1-6").ok();
            report["node_mode_document_imports"] = json!(true);
            report["schema_version"] = json!(doc.schema_version);
            report["variable_count"] =
                json!(system.map(|system| system.variables.len()).unwrap_or(0));
            report["selected_mode"] = json!(modes.flatten());
            report["width_binding"] = json!(width_binding);
            report["line_gap_binding"] = json!(line_gap_binding);
            report["paragraph_retained"] = json!(retained.contains("PARAGRAPH_SPACING"));
            report["resolved_width"] = json!(width);
            report["resolved_line_gap"] = json!(line_gap);
            report["resolved_width_matches_dark_source"] =
                json!(width.is_some_and(|value| (value - 12.).abs() < 1e-9));
            report["resolved_line_gap_matches_dark_source"] =
                json!(line_gap.is_some_and(|value| (value - 12.).abs() < 1e-9));
            report["line_gap_binding_is_counter_axis_variable"] =
                json!(line_gap_binding.as_deref() == Some("fig-1-4"));
            report["paragraph_not_used_as_line_gap"] =
                json!(line_gap_binding.as_deref() != Some("fig-1-8"));
            report["alias_kept"] = json!(
                system
                    .and_then(|system| system.variables.get("fig-1-5"))
                    .is_some_and(|variable| variable
                        .values
                        .get("Dark")
                        .and_then(|value| value.get("alias"))
                        .and_then(Value::as_str)
                        == Some("fig-1-4"))
            );
            report["component_kept"] = json!(
                doc.nodes
                    .get("fig-1-10")
                    .is_some_and(|node| node.component.is_some())
            );
            report["instance_kept"] = json!(
                doc.nodes
                    .get("fig-1-12")
                    .is_some_and(|node| node.instance.is_some())
            );
            report["dark_source_value"] = json!(
                system
                    .and_then(|system| system.variables.get("fig-1-4"))
                    .and_then(|variable| variable.values.get("Dark"))
                    .cloned()
            );

            let mut edited = doc.clone();
            let edit = (|| {
                let mut editor = futureox_design_kernel::editing::DocumentEditor::new(doc.clone())
                    .map_err(|error| error.to_string())?;
                let mut system = editor
                    .document()
                    .design_system
                    .clone()
                    .ok_or("missing design system")?;
                system
                    .variables
                    .get_mut("fig-1-4")
                    .ok_or("missing gap variable")?
                    .values
                    .insert("Dark".into(), json!(15.));
                let patch = futureox_design_kernel::editing::DocumentPatch {
                    fields: BTreeMap::from([(
                        "designSystem".into(),
                        serde_json::to_value(&system).map_err(|error| error.to_string())?,
                    )]),
                    ..futureox_design_kernel::editing::DocumentPatch::default()
                };
                editor
                    .apply(editor.revision(), patch)
                    .map_err(|error| error.to_string())?;
                let edited_width = resolved_width(editor.document(), "fig-1-6")?;
                editor.undo().map_err(|error| error.to_string())?;
                let restored = editor
                    .document()
                    .design_system
                    .as_ref()
                    .and_then(|system| system.variables.get("fig-1-4"))
                    .and_then(|variable| variable.values.get("Dark"))
                    .cloned();
                let reopened = futureox_design_kernel::binfmt::decode(
                    &futureox_design_kernel::binfmt::encode(editor.document()),
                )
                .map_err(|error| error.to_string())?;
                edited = reopened;
                Ok::<_, String>(json!({
                    "edited_width": edited_width,
                    "edited_width_matches_new_dark": (edited_width - 15.).abs() < 1e-9,
                    "undo_restored_dark": restored == Some(json!(12.)),
                }))
            })();
            match edit {
                Ok(edit) => {
                    report["edit"] = edit;
                    let system = edited.design_system.as_ref();
                    report["reopen_variable_count"] =
                        json!(system.map(|system| system.variables.len()).unwrap_or(0));
                    report["reopen_dark_value"] = json!(
                        system
                            .and_then(|system| system.variables.get("fig-1-4"))
                            .and_then(|variable| variable.values.get("Dark"))
                            .cloned()
                    );
                    report["reopen_alias"] = json!(
                        system
                            .and_then(|system| system.variables.get("fig-1-5"))
                            .and_then(|variable| variable.values.get("Dark"))
                            .and_then(|value| value.get("alias"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    );
                    report["reopen_mode"] = json!(
                        edited
                            .nodes
                            .get("fig-1-6")
                            .and_then(|node| node.variable_modes.get("set-key"))
                            .cloned()
                    );
                    report["reopen_width_binding"] = json!(
                        edited
                            .nodes
                            .get("fig-1-6")
                            .and_then(|node| node.bindings.get("width"))
                            .cloned()
                    );
                    report["reopen_component"] = json!(
                        edited
                            .nodes
                            .get("fig-1-10")
                            .is_some_and(|node| node.component.is_some())
                    );
                    report["reopen_instance"] = json!(
                        edited
                            .nodes
                            .get("fig-1-12")
                            .is_some_and(|node| node.instance.is_some())
                    );
                }
                Err(error) => {
                    report["edit_error"] = json!(error);
                }
            }
        }
        Err(error) => {
            report["node_mode_document_imports"] = json!(false);
            report["node_mode_error"] = json!(error);
        }
    }

    let mut override_input = input.clone();
    override_input["nodeChanges"]
        .as_array_mut()
        .unwrap()
        .retain(|record| {
            record
                .get("guid")
                .and_then(|guid| guid.get("localID"))
                .and_then(Value::as_u64)
                != Some(12)
        });
    override_input["nodeChanges"].as_array_mut().unwrap().push(json!({
        "guid": guid(1, 12), "type": "INSTANCE", "name": "Use",
        "parentIndex": {"guid": guid(1, 2), "position": "c"}, "size": {"x": 40., "y": 24.},
        "symbolData": {"symbolID": guid(1, 10), "symbolOverrides": [{
            "guidPath": {"guids": [guid(1, 11)]},
            "variableModeBySetMap": {"entries": [
                {"variableSetID": {"assetRef": {"key": "set-key"}}, "variableModeID": guid(9, 2)}
            ]}
        }]}
    }));
    // The template layer carries the width binding. The instance selects Dark.
    for record in override_input["nodeChanges"].as_array_mut().unwrap() {
        if record
            .get("guid")
            .and_then(|guid| guid.get("localID"))
            .and_then(Value::as_u64)
            == Some(11)
        {
            record["variableConsumptionMap"] = json!({"entries": [
                {"variableField": "WIDTH", "variableData": {"value": {"alias": {"assetRef": {"key": "gap-key"}}}}}
            ]});
        }
    }
    match import_canvas(&override_input) {
        Ok(doc) => {
            let mut resolved = doc.clone();
            let child = futureox_design_kernel::design_system::resolve(&mut resolved)
                .ok()
                .and_then(|_| {
                    resolved
                        .nodes
                        .values()
                        .find(|node| {
                            node.instance_origin.as_ref().is_some_and(|origin| {
                                origin.owner == "fig-1-12" && origin.key == "fig-1-11"
                            })
                        })
                        .map(|node| node.width)
                });
            report["instance_mode_document_imports"] = json!(true);
            report["instance_schema_version"] = json!(doc.schema_version);
            report["instance_child_width"] = json!(child);
            report["instance_child_width_matches_dark_source"] =
                json!(child.is_some_and(|value| (value - 12.).abs() < 1e-9));
            report["instance_override_mode"] = json!(
                doc.nodes
                    .get("fig-1-12")
                    .and_then(|node| node.instance.as_ref())
                    .and_then(|instance| instance.overrides.get("fig-1-11"))
                    .and_then(|fields| fields.get("variableModes"))
                    .cloned()
            );
        }
        Err(error) => {
            report["instance_mode_document_imports"] = json!(false);
            report["instance_mode_error"] = json!(error);
            report["instance_child_width_matches_dark_source"] = json!(false);
        }
    }

    let mut wide_modes = Vec::new();
    let mut wide_entries = Vec::new();
    let mut second_entries = Vec::new();
    for index in 0..33 {
        wide_modes.push(json!({"name": format!("M{index:02}"), "id": guid(3, index)}));
        wide_entries.push(json!({"modeID": guid(3, index), "variableData": {"value": {"floatValue": index as f64 + 0.5}}}));
        if index == 0 {
            second_entries.push(
                json!({"modeID": guid(3, index), "variableData": {"value": {"floatValue": 7.}}}),
            );
        }
    }
    let wide = json!({"nodeChanges": [
        {"guid": guid(2, 1), "type": "DOCUMENT", "name": "Wide"},
        {"guid": guid(2, 2), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": guid(2, 1), "position": "a"}},
        {"guid": guid(2, 3), "type": "VARIABLE_SET", "name": "Wide", "key": "wide", "variableSetModes": wide_modes},
        {"guid": guid(2, 4), "type": "VARIABLE", "name": "A", "key": "wide-a", "variableResolvedType": "FLOAT",
            "variableSetID": {"assetRef": {"key": "wide"}}, "variableDataValues": {"entries": wide_entries}},
        {"guid": guid(2, 5), "type": "VARIABLE", "name": "B", "key": "wide-b", "variableResolvedType": "FLOAT",
            "variableSetID": {"assetRef": {"key": "wide"}}, "variableDataValues": {"entries": second_entries}}
    ]});
    match import_canvas(&wide) {
        Ok(doc) => {
            let system = doc.design_system.as_ref();
            let collection = system.and_then(|system| system.collections.get("wide"));
            let variable = system.and_then(|system| system.variables.get("fig-2-4"));
            report["wide_imports"] = json!(true);
            report["wide_variable_count"] =
                json!(system.map(|system| system.variables.len()).unwrap_or(0));
            report["wide_mode_count"] = json!(
                collection
                    .map(|collection| collection.modes.len())
                    .unwrap_or(0)
            );
            report["wide_first_mode"] = json!(
                collection
                    .and_then(|collection| collection.modes.first())
                    .cloned()
            );
            report["wide_m00"] = json!(
                variable
                    .and_then(|variable| variable.values.get("M00"))
                    .cloned()
            );
            report["wide_has_second_variable"] =
                json!(system.is_some_and(|system| system.variables.contains_key("fig-2-5")));
            report["wide_notes"] = json!(document_notes(&doc));
        }
        Err(error) => {
            report["wide_imports"] = json!(false);
            report["wide_error"] = json!(error);
        }
    }

    let nested = json!({"nodeChanges": [
        {"guid": guid(4, 1), "type": "DOCUMENT", "name": "Nested"},
        {"guid": guid(4, 2), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": guid(4, 1), "position": "a"}},
        {"guid": guid(2082, 2349), "type": "VARIABLE_SET", "name": "USWDS Theme", "variableSetModes": [
            {"name": "Project theme", "id": guid(4, 3)}
        ]},
        {"guid": guid(4, 4), "type": "VARIABLE", "name": "theme/font/role/ui", "variableResolvedType": "STRING",
            "variableSetID": {"guid": guid(2082, 2349)},
            "variableDataValues": {"entries": [
                {"modeID": guid(4, 3), "variableData": {"value": {"textValue": {"characters": "Source Sans Pro"}}}}
            ]}},
        {"guid": guid(4, 5), "type": "VARIABLE", "name": "theme/font/role/heading", "variableResolvedType": "STRING",
            "variableSetID": {"guid": guid(2082, 2349)},
            "variableDataValues": {"entries": [
                {"modeID": guid(4, 3), "variableData": {"value": {"textValue": {"characters": "Merriweather"}}}}
            ]}}
    ]});
    match import_canvas(&nested) {
        Ok(doc) => {
            let system = doc.design_system.as_ref();
            let collections: Vec<_> = system
                .map(|system| system.collections.keys().cloned().collect())
                .unwrap_or_default();
            report["nested_collection_ids"] = json!(collections);
            report["nested_same_collection"] = json!(system.is_some_and(|system| {
                system
                    .variables
                    .get("fig-4-4")
                    .map(|variable| variable.collection.as_str())
                    == system
                        .variables
                        .get("fig-4-5")
                        .map(|variable| variable.collection.as_str())
                    && system
                        .variables
                        .get("fig-4-4")
                        .map(|variable| variable.collection.as_str())
                        == Some("fig-2082-2349")
            }));
            report["nested_ui_value"] = json!(
                system
                    .and_then(|system| system.variables.get("fig-4-4"))
                    .and_then(|variable| variable.values.get("Project theme"))
                    .cloned()
            );
        }
        Err(error) => {
            report["nested_error"] = json!(error);
            report["nested_same_collection"] = json!(false);
        }
    }

    let mut unknown = input.clone();
    unknown["nodeChanges"].as_array_mut().unwrap().push(json!({
        "guid": guid(1, 20), "type": "WIDGET", "name": "Not a layer",
        "parentIndex": {"guid": guid(1, 2), "position": "d"}
    }));
    report["unknown_node_error"] = json!(
        import_canvas(&unknown)
            .err()
            .unwrap_or_else(|| "imported".into())
    );
    report
}

#[test]
fn variable_modes_bindings_and_edits_match_the_fig_source() {
    let report = variable_fidelity_report();
    let encoded = serde_json::to_string_pretty(&report).unwrap();
    std::fs::write("/tmp/fig-variable-fidelity.json", &encoded).unwrap();
    eprintln!("{encoded}");
    assert_eq!(
        report["node_mode_document_imports"],
        json!(true),
        "{report}"
    );
    assert_eq!(
        report["resolved_width_matches_dark_source"],
        json!(true),
        "{report}"
    );
    assert_eq!(
        report["resolved_line_gap_matches_dark_source"],
        json!(true),
        "{report}"
    );
    assert_eq!(
        report["line_gap_binding_is_counter_axis_variable"],
        json!(true),
        "{report}"
    );
    assert_eq!(
        report["paragraph_not_used_as_line_gap"],
        json!(true),
        "{report}"
    );
    assert_eq!(report["paragraph_retained"], json!(true), "{report}");
    assert_eq!(report["alias_kept"], json!(true), "{report}");
    assert_eq!(report["component_kept"], json!(true), "{report}");
    assert_eq!(report["instance_kept"], json!(true), "{report}");
    assert_eq!(report["dark_source_value"], json!(12.), "{report}");
    assert_eq!(
        report["edit"]["edited_width_matches_new_dark"],
        json!(true),
        "{report}"
    );
    assert_eq!(
        report["edit"]["undo_restored_dark"],
        json!(true),
        "{report}"
    );
    assert_eq!(report["reopen_variable_count"], json!(3), "{report}");
    assert_eq!(report["reopen_dark_value"], json!(12.), "{report}");
    assert_eq!(report["reopen_alias"], json!("fig-1-4"), "{report}");
    assert_eq!(report["reopen_mode"], json!("Dark"), "{report}");
    assert_eq!(report["reopen_width_binding"], json!("fig-1-4"), "{report}");
    assert_eq!(report["reopen_component"], json!(true), "{report}");
    assert_eq!(report["reopen_instance"], json!(true), "{report}");
    assert_eq!(
        report["instance_mode_document_imports"],
        json!(true),
        "{report}"
    );
    assert_eq!(
        report["instance_child_width_matches_dark_source"],
        json!(true),
        "{report}"
    );
    assert_eq!(report["wide_imports"], json!(true), "{report}");
    assert_eq!(report["wide_variable_count"], json!(2), "{report}");
    assert_eq!(report["wide_mode_count"], json!(32), "{report}");
    assert_eq!(report["wide_first_mode"], json!("M00"), "{report}");
    assert_eq!(report["wide_m00"], json!(0.5), "{report}");
    assert_eq!(report["wide_has_second_variable"], json!(true), "{report}");
    assert!(
        report["wide_notes"].as_str().unwrap_or("").contains("32"),
        "{report}"
    );
    assert!(
        report["unknown_node_error"]
            .as_str()
            .unwrap_or("")
            .contains("WIDGET"),
        "{report}"
    );
    assert_eq!(report["nested_same_collection"], json!(true), "{report}");
    assert_eq!(
        report["nested_ui_value"],
        json!("Source Sans Pro"),
        "{report}"
    );
}
