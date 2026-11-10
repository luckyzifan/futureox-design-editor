//! FIG instance overrides that map onto kernel fields must execute. Fields the
//! kernel cannot run stay in the document note, and variable consumption maps
//! stay in node metadata. `gold-preview.fig` still depends on the unmerged
//! import fixes in PR #108 (zero-size vector scale) before this path can be
//! checked on that file; this fixture covers the same override fields.
use futureox_design_kernel::binfmt;
use futureox_design_kernel::design_system::resolve;
use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
use futureox_design_kernel::fig::document_from_canvas;
use futureox_design_kernel::scene::{Document, Node};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn node<'a>(doc: &'a Document, session: u64, local: u64) -> &'a Node {
    doc.nodes
        .get(&format!("fig-{session}-{local}"))
        .unwrap_or_else(|| panic!("missing fig-{session}-{local}"))
}

fn notes(doc: &Document) -> String {
    doc.design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("figDocument"))
        .and_then(|receipt| receipt.get("notes"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn generated<'a>(doc: &'a Document, key: &str) -> &'a Node {
    doc.nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == key)
        })
        .unwrap_or_else(|| panic!("missing generated {key}"))
}

#[test]
fn instance_override_fields_execute_or_stay_reported() {
    let g = |session: u64, local: u64| json!({"sessionID": session, "localID": local});
    let placed = |kind: &str, session: u64, local: u64, parent: (u64, u64), position: &str| {
        json!({
            "guid": g(session, local),
            "type": kind,
            "name": format!("{kind}-{local}"),
            "parentIndex": {"guid": g(parent.0, parent.1), "position": position},
            "size": {"x": 40., "y": 20.},
        })
    };
    let mut symbol = placed("SYMBOL", 1, 2, (0, 1), "a");
    symbol["size"] = json!({"x": 200., "y": 120.});
    symbol["stackMode"] = json!("VERTICAL");
    symbol["stackSpacing"] = json!(4.);
    symbol["stackHorizontalPadding"] = json!(2.);
    symbol["stackVerticalPadding"] = json!(2.);
    let mut stroked = placed("RECTANGLE", 1, 3, (1, 2), "b");
    stroked["strokePaints"] = json!([{
        "type": "SOLID",
        "color": {"r": 1., "g": 0., "b": 0., "a": 1.},
        "opacity": 1.,
        "visible": true
    }]);
    stroked["strokeWeight"] = json!(1.);
    stroked["strokeAlign"] = json!("CENTER");
    let styled = placed("RECTANGLE", 1, 6, (1, 2), "c");
    let mut text = placed("TEXT", 1, 4, (1, 2), "d");
    text["textData"] = json!({"characters": "No"});
    text["fontSize"] = json!(16.);
    let mut bound = placed("RECTANGLE", 1, 7, (1, 2), "e");
    bound["size"] = json!({"x": 10., "y": 20.});
    let mut instance = placed("INSTANCE", 1, 5, (0, 1), "f");
    instance["size"] = json!({"x": 200., "y": 120.});
    instance["symbolData"] = json!({
        "symbolID": g(1, 2),
        "symbolOverrides": [
            {
                "guidPath": {"guids": [g(1, 3)]},
                "cornerRadius": 8.,
                "rectangleTopLeftCornerRadius": 2.,
                "size": {"x": 50., "y": 30.},
                "strokeAlign": "INSIDE",
                "strokeWeight": 6.,
                "borderStrokeWeightsIndependent": true,
                "borderTopWeight": 1.,
                "borderRightWeight": 2.,
                "borderBottomWeight": 3.,
                "borderLeftWeight": 4.,
                "pluginData": [{"key": "k", "value": "v"}]
            },
            {
                "guidPath": {"guids": [g(1, 6)]},
                "styleIdForStrokeFill": {"guid": g(8, 1)},
                "styleIdForEffect": {"guid": g(8, 2)}
            },
            {
                "guidPath": {"guids": [g(1, 4)]},
                "textAlignHorizontal": "CENTER",
                "textData": {"characters": "Hi", "layoutVersion": 3}
            },
            {
                "guidPath": {"guids": [g(1, 7)]},
                "variableConsumptionMap": {"entries": [
                    {"variableField": "WIDTH", "variableData": {"value": {"alias": {"guid": g(9, 3), "assetRef": {"key": "width-token"}}}}},
                    {"variableField": "STROKE_WEIGHT", "variableData": {"value": {"alias": {"guid": g(9, 3), "assetRef": {"key": "width-token"}}}}}
                ]},
                "parameterConsumptionMap": {"entries": [
                    {"variableField": "WIDTH", "variableData": {"value": {"alias": {"guid": g(9, 3)}}}},
                    {"variableField": "FONT_FAMILY", "variableData": {"value": {"alias": {"guid": g(9, 3)}}}}
                ]}
            },
            {"stackPaddingRight": 18.}
        ]
    });
    instance["componentPropAssignments"] = json!([
        {"defID": g(1, 99), "value": {"boolValue": true}}
    ]);
    let changes = vec![
        json!({"guid": g(0, 1), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": g(0, 0), "position": ""}}),
        json!({"guid": g(9, 1), "type": "VARIABLE_SET", "name": "Tokens", "key": "tokens", "variableSetModes": [{"id": g(9, 2), "name": "Light"}]}),
        json!({
            "guid": g(9, 3),
            "type": "VARIABLE",
            "name": "Width",
            "key": "width-token",
            "variableResolvedType": "FLOAT",
            "variableSetID": {"assetRef": {"key": "tokens"}},
            "variableDataValues": {"entries": [{
                "modeID": g(9, 2),
                "variableData": {"value": {"floatValue": 40.}}
            }]}
        }),
        json!({
            "guid": g(8, 1),
            "type": "RECTANGLE",
            "styleType": "STROKE",
            "name": "Brand stroke",
            "strokeWeight": 3.,
            "strokePaints": [{
                "type": "SOLID",
                "color": {"r": 0., "g": 0., "b": 1., "a": 1.},
                "opacity": 1.,
                "visible": true
            }]
        }),
        json!({
            "guid": g(8, 2),
            "type": "RECTANGLE",
            "styleType": "EFFECT",
            "name": "Shadow",
            "effects": [{
                "type": "DROP_SHADOW",
                "color": {"r": 0., "g": 0., "b": 0., "a": 1.},
                "radius": 4.,
                "visible": true
            }]
        }),
        symbol,
        stroked,
        styled,
        text,
        bound,
        instance,
    ];
    let doc = document_from_canvas(
        &json!({"nodeChanges": changes}),
        BTreeMap::new(),
        Vec::new(),
    )
    .expect("executable and reported overrides must not reject the file");
    let instance = node(&doc, 1, 5);
    let spec = instance.instance.as_ref().unwrap();
    let stroke_fields = spec.overrides.get("fig-1-3").unwrap();
    assert_eq!(stroke_fields["radii"], json!([2., 8., 8., 8.]));
    assert!(stroke_fields.get("cornerRadius").is_none());
    assert_eq!(stroke_fields["width"], json!(50.));
    assert_eq!(stroke_fields["height"], json!(30.));
    assert_eq!(stroke_fields["strokes"][0]["width"], json!(6.));
    assert_eq!(stroke_fields["strokes"][0]["align"], "inside");
    let style_fields = spec.overrides.get("fig-1-6").unwrap();
    assert_eq!(style_fields["styleRefs"]["strokes"], "fig-8-1");
    assert_eq!(style_fields["styleRefs"]["effects"], "fig-8-2");
    let text_fields = spec.overrides.get("fig-1-4").unwrap();
    assert_eq!(text_fields["text"], "Hi");
    assert_eq!(text_fields["textStyle"]["align"], "center");
    let bound_fields = spec.overrides.get("fig-1-7").unwrap();
    assert_eq!(bound_fields["bindings"]["width"], "fig-9-3");
    assert!(bound_fields["bindings"].get("strokes").is_none());
    assert_eq!(spec.overrides["$root"]["layout"]["padding"][1], json!(18.));
    let retained = doc
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers
        .get("nodeMetadata")
        .unwrap()
        .get("fig-1-5")
        .unwrap()
        .get("bindings")
        .unwrap()
        .get("figOverrideVariableConsumption")
        .and_then(Value::as_str)
        .unwrap();
    assert!(retained.contains("STROKE_WEIGHT"), "{retained}");
    assert!(retained.contains("parameterConsumptionMap"), "{retained}");
    assert!(retained.contains("fig-1-7"), "{retained}");
    let notes = notes(&doc);
    for name in [
        "pluginData",
        "borderStrokeWeightsIndependent",
        "textData.layoutVersion",
        "variableConsumptionMap.STROKE_WEIGHT",
        "parameterConsumptionMap.FONT_FAMILY",
        "property assignment fig-1-99",
    ] {
        assert!(notes.contains(name), "missing {name} in {notes}");
    }
    let reported = notes
        .split("left unchanged: ")
        .nth(1)
        .unwrap_or("")
        .split(", ")
        .collect::<Vec<_>>();
    for executed in [
        "strokeAlign",
        "strokeWeight",
        "cornerRadius",
        "textAlignHorizontal",
        "styleIdForStrokeFill",
        "styleIdForEffect",
        "parameterConsumptionMap.WIDTH",
    ] {
        assert!(
            !reported.contains(&executed),
            "{executed} was reported as unchanged: {notes}"
        );
    }

    let authored = doc.clone();
    let reopened: Document =
        serde_json::from_str(&serde_json::to_string(&authored).unwrap()).unwrap();
    reopened
        .validate()
        .expect("saved override document reopens");
    let mut edited = reopened.clone();
    edited
        .nodes
        .get_mut("fig-1-5")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .get_mut("fig-1-3")
        .unwrap()
        .insert("opacity".into(), json!(0.25));
    resolve(&mut edited).unwrap();
    let edited_child = generated(&edited, "fig-1-3");
    assert!((edited_child.opacity - 0.25).abs() < 1e-9);
    assert!((edited_child.width - 50.).abs() < 1e-9);
    assert_eq!(edited_child.strokes[0].align, "inside");
    let mut undone = authored.clone();
    resolve(&mut undone).unwrap();
    let restored = generated(&undone, "fig-1-3");
    assert!((restored.opacity - 1.).abs() < 1e-9);
    assert_eq!(restored.radii, [2., 8., 8., 8.]);
    let styled_node = generated(&undone, "fig-1-6");
    assert!((styled_node.strokes[0].width - 3.).abs() < 1e-9);
    assert_eq!(styled_node.strokes[0].paint.color, "#0000ff");
    assert_eq!(styled_node.effects[0].kind, "shadow");
    let text_node = generated(&undone, "fig-1-4");
    assert_eq!(text_node.text, "Hi");
    assert_eq!(text_node.text_style.as_ref().unwrap().align, "center");
    let bound_node = generated(&undone, "fig-1-7");
    assert!(
        (bound_node.width - 40.).abs() < 1e-9,
        "{}",
        bound_node.width
    );
    assert!((bound_node.height - 20.).abs() < 1e-9);
    assert!((undone.nodes["fig-1-5"].layout.as_ref().unwrap().padding[1] - 18.).abs() < 1e-9);
    undone.validate().expect("resolved overrides stay valid");
}

#[test]
fn in_file_layout_font_variants_and_missing_targets_stay_partial() {
    let g = |session: u64, local: u64| json!({"sessionID": session, "localID": local});
    let placed = |kind: &str, session: u64, local: u64, parent: (u64, u64), position: &str| {
        json!({
            "guid": g(session, local),
            "type": kind,
            "name": format!("{kind}-{local}"),
            "parentIndex": {"guid": g(parent.0, parent.1), "position": position},
            "size": {"x": 80., "y": 40.},
        })
    };
    let mut symbol = placed("SYMBOL", 1, 2, (0, 1), "a");
    symbol["size"] = json!({"x": 200., "y": 160.});
    symbol["stackMode"] = json!("VERTICAL");
    symbol["stackSpacing"] = json!(4.);
    symbol["stackHorizontalPadding"] = json!(2.);
    symbol["stackVerticalPadding"] = json!(2.);
    let mut frame = placed("FRAME", 1, 10, (1, 2), "b");
    frame["stackMode"] = json!("HORIZONTAL");
    frame["stackSpacing"] = json!(4.);
    frame["stackHorizontalPadding"] = json!(1.);
    frame["stackVerticalPadding"] = json!(1.);
    let child = placed("RECTANGLE", 1, 11, (1, 2), "c");
    let absolute = placed("RECTANGLE", 1, 12, (1, 2), "d");
    let mut text = placed("TEXT", 1, 4, (1, 2), "e");
    text["textData"] = json!({"characters": "Ag"});
    text["fontSize"] = json!(16.);
    let corner = placed("RECTANGLE", 1, 13, (1, 2), "f");
    let mut instance = placed("INSTANCE", 1, 5, (0, 1), "g");
    instance["size"] = json!({"x": 200., "y": 160.});
    instance["symbolData"] = json!({
        "symbolID": g(1, 2),
        "symbolOverrides": [
            {
                "guidPath": {"guids": [g(1, 10)]},
                "stackSpacing": 12.,
                "stackHorizontalPadding": 6.,
                "stackVerticalPadding": 3.,
                "stackPaddingRight": 9.,
                "stackPrimarySizing": "FIXED",
                "stackCounterSizing": "FIXED",
                "stackPrimaryAlignItems": "CENTER",
                "proportionsConstrained": true
            },
            {
                "guidPath": {"guids": [g(1, 11)]},
                "stackChildAlignSelf": "STRETCH",
                "stackChildPrimaryGrow": 1.
            },
            {
                "guidPath": {"guids": [g(1, 12)]},
                "stackPositioning": "ABSOLUTE"
            },
            {
                "guidPath": {"guids": [g(1, 4)]},
                "fontVariantCommonLigatures": false,
                "fontVariantCaps": "SMALL",
                "fontVariantNumericSpacing": "TABULAR",
                "toggledOnOTFeatures": ["KERN"],
                "fontVariations": [
                    {"axisTag": u32::from_be_bytes(*b"wght"), "value": 700.},
                    {"axisTag": u32::from_be_bytes(*b"wdth"), "value": 75.}
                ],
                "textTracking": 120.,
                "fontVersion": "v1",
                "detachOpticalSizeFromFontSize": true
            },
            {
                "guidPath": {"guids": [g(1, 13)]},
                "rectangleCornerRadiiIndependent": true,
                "variableConsumptionMap": {"entries": [{
                    "variableField": "RECTANGLE_TOP_LEFT_CORNER_RADIUS",
                    "variableData": {"value": {"alias": {"guid": g(9, 3), "assetRef": {"key": "width-token"}}}}
                }]}
            },
            {
                "guidPath": {"guids": [g(44, 1)]},
                "stackPaddingRight": 4.,
                "fontVariantCaps": "SMALL",
                "fontVariantNumericFraction": "NOT_A_FRACTION"
            }
        ]
    });
    let changes = vec![
        json!({"guid": g(0, 1), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": g(0, 0), "position": ""}}),
        json!({"guid": g(9, 1), "type": "VARIABLE_SET", "name": "Tokens", "key": "tokens", "variableSetModes": [{"id": g(9, 2), "name": "Light"}]}),
        json!({
            "guid": g(9, 3),
            "type": "VARIABLE",
            "name": "Width",
            "key": "width-token",
            "variableResolvedType": "FLOAT",
            "variableSetID": {"assetRef": {"key": "tokens"}},
            "variableDataValues": {"entries": [{
                "modeID": g(9, 2),
                "variableData": {"value": {"floatValue": 40.}}
            }]}
        }),
        symbol,
        frame,
        child,
        absolute,
        text,
        corner,
        instance,
    ];
    let doc = document_from_canvas(
        &json!({"nodeChanges": changes}),
        BTreeMap::new(),
        Vec::new(),
    )
    .expect("a missing override target must not reject the file");
    let spec = node(&doc, 1, 5).instance.as_ref().unwrap();
    let frame_fields = spec.overrides.get("fig-1-10").unwrap();
    assert_eq!(frame_fields["layout"]["mode"], "horizontal");
    assert_eq!(frame_fields["layout"]["gap"], json!(12.));
    assert_eq!(frame_fields["layout"]["padding"], json!([3., 9., 3., 6.]));
    assert_eq!(frame_fields["layout"]["justify"], "unsafe-center");
    assert_eq!(frame_fields["sizing"]["width"], "fixed");
    assert_eq!(frame_fields["sizing"]["height"], "fixed");
    assert_eq!(frame_fields["constrainProportions"], json!(true));
    let grown = spec.overrides.get("fig-1-11").unwrap();
    assert_eq!(grown["sizing"]["width"], "fill");
    assert_eq!(grown["sizing"]["height"], "fill");
    assert_eq!(grown["sizing"]["alignSelf"], "stretch");
    let parked = spec.overrides.get("fig-1-12").unwrap();
    assert_eq!(parked["sizing"]["absolute"], json!(true));
    let text_fields = spec.overrides.get("fig-1-4").unwrap();
    let features = text_fields["textStyle"]["features"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    for feature in ["-liga", "-clig", "smcp", "tnum", "kern"] {
        assert!(features.contains(&feature), "{features:?}");
    }
    assert_eq!(text_fields["textStyle"]["letterSpacing"], json!(120.));
    assert_eq!(text_fields["textStyle"]["weight"], json!(700.));
    assert_eq!(text_fields["textStyle"]["variations"][0]["tag"], "wdth");
    assert_eq!(
        text_fields["textStyle"]["variations"][0]["value"],
        json!(75.)
    );
    let missing = spec.overrides.get("fig-44-1").unwrap();
    assert!(missing.get("layout").is_none());
    assert!(missing.get("sizing").is_none());
    assert_eq!(missing["textStyle"]["features"][0], "smcp");
    let retained = doc
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers
        .get("nodeMetadata")
        .unwrap()
        .get("fig-1-5")
        .unwrap()
        .get("bindings")
        .unwrap()
        .get("figOverrideVariableConsumption")
        .and_then(Value::as_str)
        .unwrap();
    assert!(
        retained.contains("RECTANGLE_TOP_LEFT_CORNER_RADIUS"),
        "{retained}"
    );
    assert_eq!(
        spec.overrides["fig-1-13"]["bindings"]["radii.0"],
        "fig-9-3"
    );
    let notes = notes(&doc);
    for name in [
        "stackPaddingRight",
        "fontVariantNumericFraction",
        "fontVersion",
        "detachOpticalSizeFromFontSize",
        "rectangleCornerRadiiIndependent",
    ] {
        assert!(notes.contains(name), "missing {name} in {notes}");
    }
    let reported = notes
        .split("left unchanged: ")
        .nth(1)
        .unwrap_or("")
        .split(", ")
        .collect::<Vec<_>>();
    for executed in [
        "stackSpacing",
        "stackChildAlignSelf",
        "stackChildPrimaryGrow",
        "stackPositioning",
        "stackPrimarySizing",
        "fontVariantCaps",
        "fontVariantCommonLigatures",
        "fontVariations",
        "textTracking",
        "toggledOnOTFeatures",
        "proportionsConstrained",
        "variableConsumptionMap.RECTANGLE_TOP_LEFT_CORNER_RADIUS",
    ] {
        assert!(
            !reported.contains(&executed),
            "{executed} was reported as unchanged: {notes}"
        );
    }
    let mut resolved = doc.clone();
    resolve(&mut resolved).unwrap();
    let frame_node = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == "fig-1-10")
        })
        .unwrap();
    assert_eq!(
        frame_node.layout.as_ref().unwrap().padding,
        [3., 9., 3., 6.]
    );
    let grown_node = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == "fig-1-11")
        })
        .unwrap();
    assert_eq!(
        grown_node.sizing.as_ref().unwrap().align_self,
        Some(futureox_design_kernel::layout::Align::Stretch)
    );
    let text_node = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == "fig-1-4")
        })
        .unwrap();
    assert!(
        text_node
            .text_style
            .as_ref()
            .unwrap()
            .features
            .iter()
            .any(|feature| feature == "smcp")
    );
    let corner_node = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == "fig-1-13")
        })
        .unwrap();
    assert!((corner_node.radii[0] - 40.).abs() < 1e-9);
    assert_eq!(corner_node.radii[1], 0.);
    resolved
        .validate()
        .expect("resolved in-file overrides stay valid");
}

fn guid(session: u64, local: u64) -> Value {
    json!({"sessionID": session, "localID": local})
}

fn placed(kind: &str, session: u64, local: u64, parent: (u64, u64), position: &str) -> Value {
    json!({
        "guid": guid(session, local),
        "type": kind,
        "name": format!("{kind}-{local}"),
        "parentIndex": {"guid": guid(parent.0, parent.1), "position": position},
        "size": {"x": 40., "y": 20.},
    })
}

/// Overrides addressed by `overrideKey` rather than the layer guid, including a
/// nested instance path. This is the gold-preview shape: every override target
/// exists, and none of the guid paths are node ids.
fn override_key_document() -> Document {
    let mut symbol = placed("SYMBOL", 1, 2, (0, 1), "a");
    symbol["overrideKey"] = guid(5, 2);
    symbol["size"] = json!({"x": 220., "y": 160.});
    symbol["stackMode"] = json!("VERTICAL");
    symbol["stackSpacing"] = json!(4.);
    symbol["stackHorizontalPadding"] = json!(2.);
    symbol["stackVerticalPadding"] = json!(2.);
    let mut frame = placed("FRAME", 1, 10, (1, 2), "b");
    frame["overrideKey"] = guid(5, 10);
    frame["stackMode"] = json!("HORIZONTAL");
    frame["stackSpacing"] = json!(4.);
    frame["stackHorizontalPadding"] = json!(1.);
    frame["stackVerticalPadding"] = json!(1.);
    let mut stroked = placed("RECTANGLE", 1, 3, (1, 2), "c");
    stroked["overrideKey"] = guid(5, 3);
    stroked["strokePaints"] = json!([{
        "type": "SOLID",
        "color": {"r": 1., "g": 0., "b": 0., "a": 1.},
        "opacity": 1.,
        "visible": true
    }]);
    stroked["strokeWeight"] = json!(1.);
    stroked["strokeAlign"] = json!("CENTER");
    let mut text = placed("TEXT", 1, 4, (1, 2), "d");
    text["overrideKey"] = guid(5, 4);
    text["textData"] = json!({"characters": "No"});
    text["fontSize"] = json!(16.);
    let mut inner = placed("SYMBOL", 1, 30, (0, 1), "e");
    inner["size"] = json!({"x": 80., "y": 40.});
    let mut inner_rect = placed("RECTANGLE", 1, 31, (1, 30), "f");
    inner_rect["overrideKey"] = guid(5, 31);
    let mut nested = placed("INSTANCE", 1, 20, (1, 2), "g");
    nested["overrideKey"] = guid(5, 20);
    nested["symbolData"] = json!({"symbolID": guid(1, 30)});
    let mut instance = placed("INSTANCE", 1, 5, (0, 1), "h");
    instance["size"] = json!({"x": 220., "y": 160.});
    instance["symbolData"] = json!({
        "symbolID": guid(1, 2),
        "symbolOverrides": [
            {
                "guidPath": {"guids": [guid(5, 3)]},
                "cornerRadius": 8.,
                "rectangleTopLeftCornerRadius": 2.,
                "size": {"x": 50., "y": 30.},
                "strokeAlign": "INSIDE",
                "strokeWeight": 6.,
                "fillPaints": [{
                    "type": "SOLID",
                    "color": {"r": 0., "g": 0., "b": 1., "a": 1.},
                    "opacity": 1.,
                    "visible": true
                }],
                "effects": [{
                    "type": "DROP_SHADOW",
                    "color": {"r": 0., "g": 0., "b": 0., "a": 1.},
                    "radius": 4.,
                    "visible": true
                }],
                "exportSettings": [{
                    "imageType": "PNG",
                    "constraint": {"type": "CONTENT_SCALE", "value": 2.},
                    "suffix": "@2x",
                    "contentsOnly": true
                }],
                "textTracking": "not-pixels"
            },
            {
                "guidPath": {"guids": [guid(5, 4)]},
                "textData": {"characters": "Hi"},
                "textTracking": 4.
            },
            {
                "guidPath": {"guids": [guid(5, 2)]},
                "stackSpacing": 18.
            },
            {
                "guidPath": {"guids": [guid(5, 10)]},
                "stackSpacing": 12.,
                "stackHorizontalPadding": 6.,
                "stackVerticalPadding": 3.,
                "stackPaddingRight": 9.,
                "stackPrimarySizing": "FIXED",
                "stackCounterSizing": "FIXED"
            },
            {
                "guidPath": {"guids": [guid(5, 20), guid(5, 31)]},
                "size": {"x": 64., "y": 28.}
            },
            {
                "guidPath": {"guids": [guid(9, 9)]},
                "stackPaddingRight": 4.,
                "pluginData": [{"key": "k", "value": "v"}]
            }
        ]
    });
    let changes = vec![
        json!({"guid": guid(0, 1), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": guid(0, 0), "position": ""}}),
        json!({"guid": guid(9, 1), "type": "VARIABLE_SET", "name": "Tokens", "key": "tokens", "variableSetModes": [{"id": guid(9, 2), "name": "Light"}]}),
        json!({
            "guid": guid(9, 3),
            "type": "VARIABLE",
            "name": "Width",
            "key": "width-token",
            "variableResolvedType": "FLOAT",
            "variableSetID": {"assetRef": {"key": "tokens"}},
            "variableDataValues": {"entries": [{
                "modeID": guid(9, 2),
                "variableData": {"value": {"floatValue": 40.}}
            }]}
        }),
        symbol,
        frame,
        stroked,
        text,
        inner,
        inner_rect,
        nested,
        instance,
    ];
    document_from_canvas(
        &json!({"nodeChanges": changes}),
        BTreeMap::new(),
        Vec::new(),
    )
    .expect("an overrideKey path must not reject the file")
}

#[test]
fn override_keys_execute_layout_size_text_and_keep_missing_paths() {
    let doc = override_key_document();
    let spec = node(&doc, 1, 5).instance.as_ref().unwrap();
    let shape = spec
        .overrides
        .get("fig-1-3")
        .expect("override key rewrites to the layer id");
    assert!(spec.overrides.get("fig-5-3").is_none());
    assert_eq!(shape["width"], json!(50.));
    assert_eq!(shape["radii"], json!([2., 8., 8., 8.]));
    assert_eq!(shape["strokes"][0]["width"], json!(6.));
    assert_eq!(shape["strokes"][0]["align"], "inside");
    assert_eq!(shape["fills"][0]["color"], "#0000ff");
    assert_eq!(shape["effects"][0]["kind"], "shadow");
    assert_eq!(shape["exportSettings"][0]["format"], "png");
    assert_eq!(shape["exportSettings"][0]["scale"], json!(2.));
    assert_eq!(shape["exportSettings"][0]["suffix"], "@2x");
    let text_fields = spec.overrides.get("fig-1-4").unwrap();
    assert_eq!(text_fields["text"], "Hi");
    assert_eq!(text_fields["textStyle"]["letterSpacing"], json!(4.));
    assert_eq!(spec.overrides["$root"]["layout"]["gap"], json!(18.));
    let frame_fields = spec.overrides.get("fig-1-10").unwrap();
    assert_eq!(frame_fields["layout"]["gap"], json!(12.));
    assert_eq!(frame_fields["layout"]["padding"], json!([3., 9., 3., 6.]));
    assert_eq!(frame_fields["sizing"]["width"], "fixed");
    let nested = spec.overrides.get("fig-1-20/fig-1-31").unwrap();
    assert_eq!(nested["width"], json!(64.));
    assert_eq!(nested["height"], json!(28.));
    assert!(
        spec.overrides
            .get("fig-9-9")
            .unwrap()
            .get("layout")
            .is_none()
    );
    let notes = notes(&doc);
    assert!(notes.contains("stackPaddingRight"), "{notes}");
    assert!(notes.contains("pluginData"), "{notes}");
    assert!(notes.contains("textTracking"), "{notes}");
    for executed in [
        "stackSpacing",
        "strokeWeight",
        "exportSettings",
        "cornerRadius",
    ] {
        assert!(
            !notes.contains(executed),
            "{executed} still reported: {notes}"
        );
    }
    let retained = doc
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers
        .get("nodeMetadata")
        .unwrap()
        .get("fig-1-5")
        .unwrap()
        .get("bindings")
        .unwrap()
        .get("figOverrideVariableConsumption")
        .and_then(Value::as_str)
        .unwrap();
    assert!(retained.contains("exportSettings"), "{retained}");
    assert!(retained.contains("contentsOnly"), "{retained}");
    let mut resolved = doc.clone();
    resolve(&mut resolved).unwrap();
    let shape_node = generated(&resolved, "fig-1-3");
    assert!((shape_node.width - 50.).abs() < 1e-9);
    assert_eq!(shape_node.radii, [2., 8., 8., 8.]);
    assert_eq!(shape_node.fills[0].color, "#0000ff");
    assert_eq!(shape_node.effects[0].kind, "shadow");
    assert!((shape_node.effects[0].radius - 4.).abs() < 1e-9);
    assert_eq!(shape_node.strokes[0].align, "inside");
    assert_eq!(shape_node.export_settings[0].suffix, "@2x");
    let text_node = generated(&resolved, "fig-1-4");
    assert_eq!(text_node.text, "Hi");
    assert!((text_node.text_style.as_ref().unwrap().letter_spacing - 4.).abs() < 1e-9);
    let frame_node = generated(&resolved, "fig-1-10");
    assert_eq!(frame_node.layout.as_ref().unwrap().gap, 12.);
    let nested_node = generated(&resolved, "fig-1-20/fig-1-31");
    assert!((nested_node.width - 64.).abs() < 1e-9);
    assert!((nested_node.height - 28.).abs() < 1e-9);
    resolved.validate().unwrap();
}

#[test]
fn ordinary_opacity_bindings_are_not_treated_as_fig_percentages() {
    let mut doc: Document = serde_json::from_value(json!({
        "schemaVersion": 6,
        "id": "d",
        "name": "opacity",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": ["n", "unit"]}],
        "designSystem": {
            "collections": {"theme": {"name": "Theme", "modes": ["Default"], "defaultMode": "Default"}},
            "variables": {
                "percent": {"name": "Disabled 50%", "collection": "theme", "kind": "number", "values": {"Default": 50}},
                "unit": {"name": "Half", "collection": "theme", "kind": "number", "values": {"Default": 0.25}}
            },
            "activeModes": {"theme": "Default"}
        },
        "nodes": {
            "n": {
                "id": "n",
                "kind": "rectangle",
                "width": 40,
                "height": 20,
                "opacity": 1,
                "fills": [{"kind": "solid", "color": "#000000", "opacity": 1, "visible": true}],
                "bindings": {"opacity": "percent", "width": "percent", "fills.0.opacity": "percent"}
            },
            "unit": {"id": "unit", "kind": "frame", "width": 40, "height": 20, "opacity": 1, "bindings": {"opacity": "unit"}}
        }
    }))
    .unwrap();
    resolve(&mut doc).unwrap();
    assert!(
        (doc.nodes["n"].opacity - 50.).abs() < 1e-9,
        "layer opacity {}",
        doc.nodes["n"].opacity
    );
    assert!((doc.nodes["n"].fills[0].opacity - 50.).abs() < 1e-9);
    assert!(
        (doc.nodes["n"].width - 50.).abs() < 1e-9,
        "width {}",
        doc.nodes["n"].width
    );
    assert!((doc.nodes["unit"].opacity - 0.25).abs() < 1e-9);
    assert!(
        (doc.design_system.as_ref().unwrap().variables["percent"].values["Default"]
            .as_f64()
            .unwrap()
            - 50.)
            .abs()
            < 1e-9
    );
    assert!(doc.validate().is_err());
}

#[test]
fn fig_percent_opacity_is_normalized_only_during_import() {
    let g = |session: u64, local: u64| json!({"sessionID": session, "localID": local});
    let mut shared = placed("RECTANGLE", 1, 8, (0, 1), "a");
    shared["variableConsumptionMap"] = json!({"entries": [
        {"variableField": "WIDTH", "variableData": {"value": {"alias": {"guid": g(9, 4), "assetRef": {"key": "disabled"}}}}},
        {"variableField": "OPACITY", "variableData": {"value": {"alias": {"guid": g(9, 4), "assetRef": {"key": "disabled"}}}}}
    ]});
    let mut unit = placed("RECTANGLE", 1, 9, (0, 1), "b");
    unit["variableConsumptionMap"] = json!({"entries": [
        {"variableField": "OPACITY", "variableData": {"value": {"alias": {"guid": g(9, 6), "assetRef": {"key": "half"}}}}}
    ]});
    let mut solo = placed("RECTANGLE", 1, 13, (0, 1), "i");
    solo["variableConsumptionMap"] = json!({"entries": [
        {"variableField": "OPACITY", "variableData": {"value": {"alias": {"guid": g(9, 10), "assetRef": {"key": "solo"}}}}}
    ]});
    let mut via_alias = placed("RECTANGLE", 1, 10, (0, 1), "c");
    via_alias["variableConsumptionMap"] = json!({"entries": [
        {"variableField": "OPACITY", "variableData": {"value": {"alias": {"guid": g(9, 7), "assetRef": {"key": "disabled-alias"}}}}}
    ]});
    let mut text = placed("TEXT", 1, 11, (0, 1), "d");
    text["textData"] = json!({"characters": "No"});
    text["fontSize"] = json!(16.);
    text["variableConsumptionMap"] = json!({"entries": [
        {"variableField": "FONT_WEIGHT", "variableData": {"value": {"alias": {"guid": g(9, 8), "assetRef": {"key": "weight"}}}}},
        {"variableField": "CHARACTERS", "variableData": {"value": {"alias": {"guid": g(9, 9), "assetRef": {"key": "label"}}}}}
    ]});
    let symbol = placed("SYMBOL", 1, 2, (0, 1), "e");
    let child = placed("RECTANGLE", 1, 3, (1, 2), "f");
    let mut label = placed("TEXT", 1, 12, (1, 2), "h");
    label["textData"] = json!({"characters": "No"});
    label["fontSize"] = json!(16.);
    let mut instance = placed("INSTANCE", 1, 5, (0, 1), "g");
    instance["symbolData"] = json!({
        "symbolID": g(1, 2),
        "symbolOverrides": [
            {
                "guidPath": {"guids": [g(1, 3)]},
                "variableConsumptionMap": {"entries": [{
                    "variableField": "OPACITY",
                    "variableData": {"value": {"alias": {"guid": g(9, 4), "assetRef": {"key": "disabled"}}}}
                }]}
            },
            {
                "guidPath": {"guids": [g(1, 12)]},
                "lineHeight": {"units": "PIXELS", "value": 24.},
                "letterSpacing": {"units": "PERCENT", "value": 10.},
                "fontName": {"family": "Inter", "style": "Bold"},
                "effects": [{
                    "type": "DROP_SHADOW",
                    "color": {"r": 0., "g": 0., "b": 0., "a": 0.5},
                    "radius": 4.,
                    "visible": true
                }]
            }
        ]
    });
    let doc = document_from_canvas(
        &json!({"nodeChanges": [
            json!({"guid": g(0, 1), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": g(0, 0), "position": ""}}),
            json!({"guid": g(9, 1), "type": "VARIABLE_SET", "name": "Tokens", "key": "tokens", "variableSetModes": [
                {"id": g(9, 2), "name": "Light"},
                {"id": g(9, 5), "name": "Dark"}
            ]}),
            json!({
                "guid": g(9, 4), "type": "VARIABLE", "name": "Disabled 50%", "key": "disabled",
                "variableResolvedType": "FLOAT", "variableSetID": {"assetRef": {"key": "tokens"}},
                "variableDataValues": {"entries": [
                    {"modeID": g(9, 2), "variableData": {"value": {"floatValue": 50.}}},
                    {"modeID": g(9, 5), "variableData": {"value": {"floatValue": 20.}}}
                ]}
            }),
            json!({
                "guid": g(9, 10), "type": "VARIABLE", "name": "Solo 50%", "key": "solo",
                "variableResolvedType": "FLOAT", "variableSetID": {"assetRef": {"key": "tokens"}},
                "variableDataValues": {"entries": [
                    {"modeID": g(9, 2), "variableData": {"value": {"floatValue": 50.}}},
                    {"modeID": g(9, 5), "variableData": {"value": {"floatValue": 20.}}}
                ]}
            }),
            json!({
                "guid": g(9, 6), "type": "VARIABLE", "name": "Half", "key": "half",
                "variableResolvedType": "FLOAT", "variableSetID": {"assetRef": {"key": "tokens"}},
                "variableDataValues": {"entries": [
                    {"modeID": g(9, 2), "variableData": {"value": {"floatValue": 0.25}}},
                    {"modeID": g(9, 5), "variableData": {"value": {"floatValue": 0.25}}}
                ]}
            }),
            json!({
                "guid": g(9, 7), "type": "VARIABLE", "name": "Disabled alias", "key": "disabled-alias",
                "variableResolvedType": "FLOAT", "variableSetID": {"assetRef": {"key": "tokens"}},
                "variableDataValues": {"entries": [
                    {"modeID": g(9, 2), "variableData": {"value": {"alias": {"guid": g(9, 4), "assetRef": {"key": "disabled"}}}}},
                    {"modeID": g(9, 5), "variableData": {"value": {"alias": {"guid": g(9, 4), "assetRef": {"key": "disabled"}}}}}
                ]}
            }),
            json!({
                "guid": g(9, 8), "type": "VARIABLE", "name": "Weight", "key": "weight",
                "variableResolvedType": "FLOAT", "variableSetID": {"assetRef": {"key": "tokens"}},
                "variableDataValues": {"entries": [
                    {"modeID": g(9, 2), "variableData": {"value": {"floatValue": 700.}}},
                    {"modeID": g(9, 5), "variableData": {"value": {"floatValue": 400.}}}
                ]}
            }),
            json!({
                "guid": g(9, 9), "type": "VARIABLE", "name": "Label", "key": "label",
                "variableResolvedType": "STRING", "variableSetID": {"assetRef": {"key": "tokens"}},
                "variableDataValues": {"entries": [
                    {"modeID": g(9, 2), "variableData": {"value": {"textValue": {"characters": "Hi"}}}},
                    {"modeID": g(9, 5), "variableData": {"value": {"textValue": {"characters": "Yo"}}}}
                ]}
            }),
            shared, unit, solo, via_alias, text, symbol, child, label, instance
        ]}),
        BTreeMap::new(),
        Vec::new(),
    )
    .expect("percent opacity must not reject the file");
    let system = doc.design_system.as_ref().unwrap();
    assert_eq!(system.variables["fig-9-4"].values["Light"], json!(50.));
    assert_eq!(system.variables["fig-9-4"].values["Dark"], json!(20.));
    assert_eq!(
        system.variables["fig-9-4#fig-opacity"].values["Light"],
        json!(0.5)
    );
    assert_eq!(
        system.variables["fig-9-4#fig-opacity"].values["Dark"],
        json!(0.2)
    );
    assert!(system.variables.get("fig-9-6#fig-opacity").is_none());
    assert!(system.variables.get("fig-9-10#fig-opacity").is_none());
    assert_eq!(system.variables["fig-9-10"].values["Light"], json!(0.5));
    assert_eq!(system.variables["fig-9-10"].values["Dark"], json!(0.2));
    assert_eq!(doc.nodes["fig-1-13"].bindings["opacity"], "fig-9-10");
    assert_eq!(
        system.variables["fig-9-7#fig-opacity"].values["Light"]["alias"],
        json!("fig-9-4#fig-opacity")
    );
    assert_eq!(
        system.variables["fig-9-7"].values["Light"]["alias"],
        json!("fig-9-4")
    );
    assert_eq!(doc.nodes["fig-1-8"].bindings["width"], "fig-9-4");
    assert_eq!(
        doc.nodes["fig-1-8"].bindings["opacity"],
        "fig-9-4#fig-opacity"
    );
    assert_eq!(doc.nodes["fig-1-9"].bindings["opacity"], "fig-9-6");
    assert_eq!(
        doc.nodes["fig-1-10"].bindings["opacity"],
        "fig-9-7#fig-opacity"
    );
    assert_eq!(
        doc.nodes["fig-1-11"].bindings["textStyle.weight"],
        "fig-9-8"
    );
    assert_eq!(doc.nodes["fig-1-11"].bindings["text"], "fig-9-9");
    let override_bindings =
        &doc.nodes["fig-1-5"].instance.as_ref().unwrap().overrides["fig-1-3"]["bindings"];
    assert_eq!(override_bindings["opacity"], "fig-9-4#fig-opacity");
    let text_fields = &doc.nodes["fig-1-5"].instance.as_ref().unwrap().overrides["fig-1-12"];
    let text_style = &text_fields["textStyle"];
    assert!((text_style["lineHeight"].as_f64().unwrap() - 1.5).abs() < 1e-9);
    assert!((text_style["letterSpacing"].as_f64().unwrap() - 1.6).abs() < 1e-9);
    assert!((text_style["weight"].as_f64().unwrap() - 700.).abs() < 1e-9);
    assert_eq!(text_fields["effects"][0]["kind"], "shadow");
    assert!(notes(&doc).contains("fontName.family=Inter"));
    let mut resolved = doc.clone();
    resolve(&mut resolved).unwrap();
    assert!((resolved.nodes["fig-1-8"].width - 50.).abs() < 1e-9);
    assert!((resolved.nodes["fig-1-8"].opacity - 0.5).abs() < 1e-9);
    assert!((resolved.nodes["fig-1-13"].opacity - 0.5).abs() < 1e-9);
    assert!((resolved.nodes["fig-1-9"].opacity - 0.25).abs() < 1e-9);
    assert!((resolved.nodes["fig-1-10"].opacity - 0.5).abs() < 1e-9);
    assert!(
        (resolved.nodes["fig-1-11"]
            .text_style
            .as_ref()
            .unwrap()
            .weight
            - 700.)
            .abs()
            < 1e-9
    );
    assert_eq!(resolved.nodes["fig-1-11"].text, "Hi");
    let generated_child = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == "fig-1-3")
        })
        .unwrap();
    assert!((generated_child.opacity - 0.5).abs() < 1e-9);
    let generated_text = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == "fig-1-12")
        })
        .unwrap();
    assert!((generated_text.text_style.as_ref().unwrap().line_height - 1.5).abs() < 1e-9);
    assert!((generated_text.text_style.as_ref().unwrap().letter_spacing - 1.6).abs() < 1e-9);
    assert_eq!(generated_text.effects[0].kind, "shadow");
    resolved
        .design_system
        .as_mut()
        .unwrap()
        .active_modes
        .insert("tokens".into(), "Dark".into());
    resolve(&mut resolved).unwrap();
    assert!((resolved.nodes["fig-1-8"].width - 20.).abs() < 1e-9);
    assert!((resolved.nodes["fig-1-8"].opacity - 0.2).abs() < 1e-9);
    resolved
        .validate()
        .expect("normalized fig opacity stays valid");
}

#[test]
fn editor_modify_undo_save_reopen_keeps_override_fields() {
    let imported = override_key_document();
    let mut opened = imported.clone();
    resolve(&mut opened).unwrap();
    let mut editor = DocumentEditor::new(opened.clone())
        .expect("resolved override document opens in the editor");
    let mut edited = editor.document().clone();
    edited
        .nodes
        .get_mut("fig-1-5")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .get_mut("fig-1-3")
        .unwrap()
        .insert("width".into(), json!(77.));
    resolve(&mut edited).unwrap();
    let patch = DocumentPatch::between(editor.document(), &edited).unwrap();
    editor.apply(editor.revision(), patch).unwrap();
    assert!((generated(editor.document(), "fig-1-3").width - 77.).abs() < 1e-9);
    editor.undo().unwrap();
    let undone = editor.document();
    assert_eq!(
        undone.nodes["fig-1-5"].instance.as_ref().unwrap().overrides["fig-1-3"]["width"],
        json!(50.)
    );
    assert_eq!(
        undone.nodes["fig-1-5"].instance.as_ref().unwrap().overrides["fig-1-3"]["radii"],
        json!([2., 8., 8., 8.])
    );
    let saved = binfmt::encode(undone);
    let reopened = binfmt::decode(&saved).expect("saved override document reopens");
    reopened.validate().expect("reopened document validates");
    let fields = &reopened.nodes["fig-1-5"]
        .instance
        .as_ref()
        .unwrap()
        .overrides;
    assert_eq!(fields["fig-1-3"]["width"], json!(50.));
    assert_eq!(fields["fig-1-3"]["height"], json!(30.));
    assert_eq!(fields["fig-1-3"]["radii"], json!([2., 8., 8., 8.]));
    assert_eq!(fields["fig-1-3"]["strokes"][0]["width"], json!(6.));
    assert_eq!(fields["fig-1-3"]["strokes"][0]["align"], "inside");
    assert_eq!(fields["fig-1-3"]["fills"][0]["color"], "#0000ff");
    assert_eq!(fields["fig-1-3"]["effects"][0]["kind"], "shadow");
    assert_eq!(fields["fig-1-4"]["text"], "Hi");
    assert_eq!(fields["fig-1-4"]["textStyle"]["letterSpacing"], json!(4.));
    assert_eq!(fields["fig-1-10"]["layout"]["gap"], json!(12.));
    assert_eq!(
        fields["fig-1-10"]["layout"]["padding"],
        json!([3., 9., 3., 6.])
    );
    assert_eq!(fields["fig-1-20/fig-1-31"]["width"], json!(64.));
    let kept = reopened
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers
        .get("nodeMetadata")
        .unwrap()
        .get("fig-1-5")
        .unwrap()
        .get("bindings")
        .unwrap()
        .get("figOverrideVariableConsumption")
        .and_then(Value::as_str)
        .unwrap();
    assert!(kept.contains("contentsOnly"), "{kept}");
    let mut resolved = reopened;
    resolve(&mut resolved).unwrap();
    let shape = generated(&resolved, "fig-1-3");
    assert!((shape.width - 50.).abs() < 1e-9, "{}", shape.width);
    assert!((shape.height - 30.).abs() < 1e-9);
    assert_eq!(shape.radii, [2., 8., 8., 8.]);
    assert_eq!(shape.strokes[0].align, "inside");
    assert!((shape.strokes[0].width - 6.).abs() < 1e-9);
    assert_eq!(shape.fills[0].color, "#0000ff");
    assert_eq!(shape.effects[0].kind, "shadow");
    assert_eq!(generated(&resolved, "fig-1-4").text, "Hi");
    assert_eq!(
        generated(&resolved, "fig-1-10")
            .layout
            .as_ref()
            .unwrap()
            .gap,
        12.
    );
    assert!((generated(&resolved, "fig-1-20/fig-1-31").width - 64.).abs() < 1e-9);
    resolved
        .validate()
        .expect("reopened overrides stay executable");
}

/// Nested symbol overrides carry component property assignments. A resolved
/// literal in `value` or `varValue` writes `propertyValues`. A missing layer,
/// a missing definition, an alias, or a swap whose component is not in the
/// file stays reported and is not stored.
#[test]
fn nested_component_property_assignments_execute_only_with_a_real_target() {
    let mut inner = placed("SYMBOL", 1, 30, (0, 1), "a");
    inner["size"] = json!({"x": 80., "y": 40.});
    inner["componentPropDefs"] = json!([
        {"id": guid(9, 1), "name": "Shown", "type": "BOOL", "initialValue": {"boolValue": true}},
        {"id": guid(9, 2), "name": "Icon", "type": "INSTANCE_SWAP", "initialValue": {"guidValue": guid(1, 50)}},
        {"id": guid(9, 3), "name": "Label", "type": "TEXT", "initialValue": {"textValue": {"characters": "Hi"}}},
        {"id": guid(9, 4), "name": "Missing icon", "type": "INSTANCE_SWAP", "initialValue": {"guidValue": guid(1, 50)}}
    ]);
    let mut shown = placed("RECTANGLE", 1, 31, (1, 30), "b");
    shown["componentPropRefs"] = json!([
        {"defID": guid(9, 1), "componentPropNodeField": "VISIBLE"}
    ]);
    let mut icon = placed("INSTANCE", 1, 40, (1, 30), "c");
    icon["symbolData"] = json!({"symbolID": guid(1, 50)});
    icon["componentPropRefs"] = json!([
        {"defID": guid(9, 2), "componentPropNodeField": "OVERRIDDEN_SYMBOL_ID"}
    ]);
    let leaf = placed("SYMBOL", 1, 50, (0, 1), "d");
    let replacement = placed("SYMBOL", 1, 60, (0, 1), "e");
    let mut outer = placed("SYMBOL", 1, 2, (0, 1), "f");
    outer["size"] = json!({"x": 120., "y": 80.});
    let mut nested = placed("INSTANCE", 1, 20, (1, 2), "g");
    nested["symbolData"] = json!({"symbolID": guid(1, 30)});
    let mut instance = placed("INSTANCE", 1, 5, (0, 1), "h");
    instance["size"] = json!({"x": 120., "y": 80.});
    instance["symbolData"] = json!({
        "symbolID": guid(1, 2),
        "symbolOverrides": [
            {
                "guidPath": {"guids": [guid(1, 20)]},
                "componentPropAssignments": [
                    {"defID": guid(9, 1), "value": {}, "varValue": {"value": {"boolValue": false}, "dataType": "BOOLEAN"}},
                    {"defID": guid(9, 2), "value": {"guidValue": guid(1, 60)}},
                    {"defID": guid(9, 4), "value": {"guidValue": guid(9, 9)}},
                    {"defID": guid(9, 99), "value": {"boolValue": true}},
                    {"defID": guid(9, 3), "value": {}, "varValue": {"value": {"alias": {"guid": guid(8, 1)}}}}
                ]
            },
            {
                "guidPath": {"guids": [guid(44, 1)]},
                "componentPropAssignments": [
                    {"defID": guid(9, 1), "value": {"boolValue": false}}
                ]
            }
        ]
    });
    let doc = document_from_canvas(
        &json!({"nodeChanges": [
            json!({"guid": guid(0, 1), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": guid(0, 0), "position": ""}}),
            inner, shown, icon, leaf, replacement, outer, nested, instance
        ]}),
        BTreeMap::new(),
        Vec::new(),
    )
    .expect("nested property assignments must not reject the file");
    let values = &node(&doc, 1, 5).instance.as_ref().unwrap().overrides["fig-1-20"]["propertyValues"];
    assert_eq!(values["fig-9-1"], json!(false));
    assert_eq!(values["fig-9-2"], json!("fig-1-60"));
    assert!(values.get("fig-9-4").is_none());
    assert!(values.get("fig-9-99").is_none());
    assert!(values.get("fig-9-3").is_none());
    assert!(
        node(&doc, 1, 5)
            .instance
            .as_ref()
            .unwrap()
            .overrides
            .get("fig-44-1")
            .and_then(|fields| fields.get("propertyValues"))
            .is_none()
    );
    let notes = notes(&doc);
    for name in [
        "property assignment fig-9-4",
        "property assignment fig-9-99",
        "property assignment fig-9-3",
        "componentPropAssignments",
    ] {
        assert!(notes.contains(name), "missing {name} in {notes}");
    }
    assert!(
        !notes.contains("property assignment fig-9-1"),
        "executed bool was reported: {notes}"
    );
    assert!(
        !notes.contains("property assignment fig-9-2"),
        "executed swap was reported: {notes}"
    );
    let mut resolved = doc;
    resolve(&mut resolved).unwrap();
    let hidden = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin
                .as_ref()
                .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key.ends_with("fig-1-31"))
        })
        .expect("generated shown layer");
    assert!(!hidden.visible);
    let swapped = resolved
        .nodes
        .values()
        .find(|node| {
            node.instance_origin.as_ref().is_some_and(|origin| {
                origin.owner == "fig-1-5" && origin.key.ends_with("fig-1-40")
            })
        })
        .expect("generated icon instance");
    assert_eq!(
        swapped.instance.as_ref().unwrap().component_id,
        "fig-1-60"
    );
    resolved
        .validate()
        .expect("resolved nested property assignments stay valid");
}

/// Consumption entries that name an existing kernel property become bindings.
/// Per-side borders, font families, and targets the file does not contain stay
/// in the note, and the original maps stay in metadata.
#[test]
fn consumption_maps_bind_kernel_fields_and_keep_the_raw_table() {
    let g = |session: u64, local: u64| json!({"sessionID": session, "localID": local});
    let placed = |kind: &str, session: u64, local: u64, parent: (u64, u64), position: &str| {
        json!({
            "guid": g(session, local),
            "type": kind,
            "name": format!("{kind}-{local}"),
            "parentIndex": {"guid": g(parent.0, parent.1), "position": position},
            "size": {"x": 40., "y": 20.},
        })
    };
    let alias = |local: u64| {
        json!({"alias": {"guid": g(9, local), "assetRef": {"key": if local == 3 { "gap" } else { "corner" }}}})
    };
    let mut symbol = placed("SYMBOL", 1, 2, (0, 1), "a");
    symbol["size"] = json!({"x": 240., "y": 220.});
    symbol["stackMode"] = json!("VERTICAL");
    symbol["stackSpacing"] = json!(4.);
    symbol["stackHorizontalPadding"] = json!(2.);
    symbol["stackVerticalPadding"] = json!(2.);
    let mut stroked = placed("RECTANGLE", 1, 3, (1, 2), "b");
    stroked["strokePaints"] = json!([
        {"type": "SOLID", "color": {"r": 1., "g": 0., "b": 0., "a": 1.}, "opacity": 1., "visible": true},
        {"type": "SOLID", "color": {"r": 0., "g": 0., "b": 1., "a": 1.}, "opacity": 1., "visible": true}
    ]);
    stroked["strokeWeight"] = json!(1.);
    let bare = placed("RECTANGLE", 1, 7, (1, 2), "c");
    let mut text = placed("TEXT", 1, 4, (1, 2), "d");
    text["textData"] = json!({"characters": "Ag"});
    text["fontSize"] = json!(16.);
    let mut star = placed("STAR", 1, 14, (1, 2), "e");
    star["cornerRadius"] = json!(1.);
    star["count"] = json!(5);
    star["starInnerScale"] = json!(0.5);
    let mut polygon = placed("REGULAR_POLYGON", 1, 15, (1, 2), "f");
    polygon["count"] = json!(5);
    let mut corners = placed("RECTANGLE", 1, 16, (1, 2), "g");
    corners["cornerRadius"] = json!(0.);
    let mut sized = placed("RECTANGLE", 1, 17, (1, 2), "h");
    sized["minSize"] = json!({"value": {"x": 10., "y": 10.}});
    let mut literal = placed("RECTANGLE", 1, 18, (1, 2), "i");
    literal["strokePaints"] = json!([
        {"type": "SOLID", "color": {"r": 0., "g": 0., "b": 0., "a": 1.}, "opacity": 1., "visible": true}
    ]);
    literal["strokeWeight"] = json!(1.);
    let mut instance = placed("INSTANCE", 1, 5, (0, 1), "j");
    instance["size"] = json!({"x": 240., "y": 220.});
    let consume = |field: &str, local: u64| {
        json!({"variableField": field, "variableData": {"value": alias(local)}})
    };
    instance["symbolData"] = json!({
        "symbolID": g(1, 2),
        "symbolOverrides": [
            {
                "guidPath": {"guids": [g(1, 3)]},
                "variableConsumptionMap": {"entries": [
                    consume("STROKE_WEIGHT", 3),
                    consume("BORDER_TOP_WEIGHT", 3)
                ]},
                "parameterConsumptionMap": {"entries": [
                    consume("HEIGHT", 3),
                    consume("FONT_FAMILY", 3)
                ]}
            },
            {
                "guidPath": {"guids": [g(1, 7)]},
                "variableConsumptionMap": {"entries": [consume("STROKE_WEIGHT", 3)]}
            },
            {
                "guidPath": {"guids": [g(1, 2)]},
                "variableConsumptionMap": {"entries": [
                    consume("STACK_PADDING_TOP", 3),
                    consume("STACK_PADDING_RIGHT", 3),
                    consume("STACK_PADDING_BOTTOM", 3),
                    consume("STACK_PADDING_LEFT", 3)
                ]}
            },
            {
                "guidPath": {"guids": [g(1, 4)]},
                "variableConsumptionMap": {"entries": [
                    consume("PARAGRAPH_SPACING", 3),
                    consume("PARAGRAPH_INDENT", 3)
                ]}
            },
            {
                "guidPath": {"guids": [g(1, 14)]},
                "variableConsumptionMap": {"entries": [consume("CORNER_RADIUS", 3)]}
            },
            {
                "guidPath": {"guids": [g(1, 15)]},
                "variableConsumptionMap": {"entries": [consume("CORNER_RADIUS", 3)]}
            },
            {
                "guidPath": {"guids": [g(1, 16)]},
                "variableConsumptionMap": {"entries": [
                    consume("RECTANGLE_TOP_LEFT_CORNER_RADIUS", 4),
                    consume("CORNER_RADIUS", 3)
                ]}
            },
            {
                "guidPath": {"guids": [g(1, 17)]},
                "variableConsumptionMap": {"entries": [consume("MIN_WIDTH", 3)]}
            },
            {
                "guidPath": {"guids": [g(1, 18)]},
                "strokeWeight": 6.,
                "variableConsumptionMap": {"entries": [consume("STROKE_WEIGHT", 3)]}
            },
            {
                "guidPath": {"guids": [g(44, 1)]},
                "variableConsumptionMap": {"entries": [consume("STACK_PADDING_LEFT", 3)]}
            }
        ]
    });
    let variable = |local: u64, name: &str, key: &str, value: f64| {
        json!({
            "guid": g(9, local),
            "type": "VARIABLE",
            "name": name,
            "key": key,
            "variableResolvedType": "FLOAT",
            "variableSetID": {"assetRef": {"key": "tokens"}},
            "variableDataValues": {"entries": [{
                "modeID": g(9, 2),
                "variableData": {"value": {"floatValue": value}}
            }]}
        })
    };
    let doc = document_from_canvas(
        &json!({"nodeChanges": [
            {"guid": g(0, 1), "type": "CANVAS", "name": "Page", "parentIndex": {"guid": g(0, 0), "position": ""}},
            {"guid": g(9, 1), "type": "VARIABLE_SET", "name": "Tokens", "key": "tokens", "variableSetModes": [{"id": g(9, 2), "name": "Light"}]},
            variable(3, "Gap", "gap", 5.),
            variable(4, "Corner", "corner", 9.),
            symbol, stroked, bare, text, star, polygon, corners, sized, literal, instance
        ]}),
        BTreeMap::new(),
        Vec::new(),
    )
    .expect("mappable consumption entries must not reject the file");
    let spec = node(&doc, 1, 5).instance.as_ref().unwrap();
    let stroke_fields = &spec.overrides["fig-1-3"]["bindings"];
    assert_eq!(stroke_fields["strokes.0.width"], "fig-9-3");
    assert_eq!(stroke_fields["strokes.1.width"], "fig-9-3");
    assert_eq!(stroke_fields["height"], "fig-9-3");
    assert!(stroke_fields.get("strokes.2.width").is_none());
    assert!(spec.overrides["fig-1-7"].get("bindings").is_none());
    let padding = &spec.overrides["$root"]["bindings"];
    assert_eq!(padding["layout.padding.0"], "fig-9-3");
    assert_eq!(padding["layout.padding.1"], "fig-9-3");
    assert_eq!(padding["layout.padding.2"], "fig-9-3");
    assert_eq!(padding["layout.padding.3"], "fig-9-3");
    let text_fields = &spec.overrides["fig-1-4"]["bindings"];
    assert_eq!(text_fields["textStyle.paragraphSpacing"], "fig-9-3");
    assert_eq!(text_fields["textStyle.paragraphIndent"], "fig-9-3");
    assert_eq!(spec.overrides["fig-1-14"]["bindings"]["cornerRadius"], "fig-9-3");
    assert_eq!(spec.overrides["fig-1-15"]["bindings"]["cornerRadius"], "fig-9-3");
    let radii = &spec.overrides["fig-1-16"]["bindings"];
    assert_eq!(radii["radii.0"], "fig-9-4");
    assert_eq!(radii["radii.1"], "fig-9-3");
    assert_eq!(radii["radii.2"], "fig-9-3");
    assert_eq!(radii["radii.3"], "fig-9-3");
    assert_eq!(spec.overrides["fig-1-17"]["bindings"]["sizing.minWidth"], "fig-9-3");
    assert_eq!(spec.overrides["fig-1-18"]["strokes"][0]["width"], json!(6.));
    assert_eq!(spec.overrides["fig-1-18"]["bindings"]["strokes.0.width"], "fig-9-3");
    let retained = doc
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers["nodeMetadata"]["fig-1-5"]["bindings"]["figOverrideVariableConsumption"]
        .as_str()
        .unwrap();
    for kept in ["STROKE_WEIGHT", "BORDER_TOP_WEIGHT", "parameterConsumptionMap", "FONT_FAMILY", "STACK_PADDING_LEFT"] {
        assert!(retained.contains(kept), "dropped {kept} from {retained}");
    }
    let notes = notes(&doc);
    for name in [
        "variableConsumptionMap.STROKE_WEIGHT",
        "variableConsumptionMap.BORDER_TOP_WEIGHT",
        "parameterConsumptionMap.FONT_FAMILY",
        "variableConsumptionMap.STACK_PADDING_LEFT",
    ] {
        assert!(notes.contains(name), "missing {name} in {notes}");
    }
    let reported = notes
        .split("left unchanged: ")
        .nth(1)
        .unwrap_or("")
        .split(", ")
        .collect::<Vec<_>>();
    for executed in [
        "variableConsumptionMap.HEIGHT",
        "parameterConsumptionMap.HEIGHT",
        "variableConsumptionMap.CORNER_RADIUS",
        "variableConsumptionMap.PARAGRAPH_SPACING",
        "variableConsumptionMap.PARAGRAPH_INDENT",
        "variableConsumptionMap.MIN_WIDTH",
        "variableConsumptionMap.STACK_PADDING_TOP",
        "variableConsumptionMap.RECTANGLE_TOP_LEFT_CORNER_RADIUS",
    ] {
        assert!(!reported.contains(&executed), "{executed} was reported: {notes}");
    }

    let authored = doc.clone();
    let reopened: Document = serde_json::from_str(&serde_json::to_string(&authored).unwrap()).unwrap();
    reopened.validate().expect("saved consumption bindings reopen");
    let mut resolved = reopened.clone();
    resolve(&mut resolved).unwrap();
    fn generated_at<'a>(doc: &'a Document, key: &str) -> &'a Node {
        doc.nodes
            .values()
            .find(|node| {
                node.instance_origin
                    .as_ref()
                    .is_some_and(|origin| origin.owner == "fig-1-5" && origin.key == key)
            })
            .unwrap_or_else(|| panic!("missing generated {key}"))
    }
    let stroke_node = generated_at(&resolved, "fig-1-3");
    assert!((stroke_node.strokes[0].width - 5.).abs() < 1e-9);
    assert!((stroke_node.strokes[1].width - 5.).abs() < 1e-9);
    assert!((stroke_node.height - 5.).abs() < 1e-9);
    assert!((stroke_node.width - 40.).abs() < 1e-9);
    assert_eq!(resolved.nodes["fig-1-5"].layout.as_ref().unwrap().padding, [5., 5., 5., 5.]);
    let text_node = generated_at(&resolved, "fig-1-4");
    let style = text_node.text_style.as_ref().unwrap();
    assert!((style.paragraph_spacing - 5.).abs() < 1e-9);
    assert!((style.paragraph_indent - 5.).abs() < 1e-9);
    assert!((generated_at(&resolved, "fig-1-14").corner_radius - 5.).abs() < 1e-9);
    assert!((generated_at(&resolved, "fig-1-15").corner_radius - 5.).abs() < 1e-9);
    assert_eq!(generated_at(&resolved, "fig-1-16").radii, [9., 5., 5., 5.]);
    assert!((generated_at(&resolved, "fig-1-17").sizing.as_ref().unwrap().min_width - 5.).abs() < 1e-9);
    assert!((generated_at(&resolved, "fig-1-18").strokes[0].width - 6.).abs() < 1e-9);
    resolved.validate().expect("resolved consumption bindings stay valid");

    let mut edited = authored.clone();
    edited
        .design_system
        .as_mut()
        .unwrap()
        .variables
        .get_mut("fig-9-3")
        .unwrap()
        .values
        .get_mut("Light")
        .unwrap()
        .clone_from(&json!(11.));
    resolve(&mut edited).unwrap();
    assert!((generated_at(&edited, "fig-1-3").strokes[0].width - 11.).abs() < 1e-9);
    assert_eq!(edited.nodes["fig-1-5"].layout.as_ref().unwrap().padding, [11., 11., 11., 11.]);
    assert_eq!(generated_at(&edited, "fig-1-16").radii, [9., 11., 11., 11.]);
    let mut undone = authored.clone();
    resolve(&mut undone).unwrap();
    assert!((generated_at(&undone, "fig-1-3").strokes[0].width - 5.).abs() < 1e-9);
    assert_eq!(undone.nodes["fig-1-5"].layout.as_ref().unwrap().padding, [5., 5., 5., 5.]);
    assert_eq!(generated_at(&undone, "fig-1-16").radii, [9., 5., 5., 5.]);
}
