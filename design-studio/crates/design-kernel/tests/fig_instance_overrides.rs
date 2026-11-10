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
use serde_json::{json, Value};
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
                    {"variableField": "WIDTH", "variableData": {"value": {"alias": {"guid": g(9, 3)}}}}
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
        "parameterConsumptionMap",
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
    assert!(spec.overrides["fig-1-13"].get("bindings").is_none());
    let notes = notes(&doc);
    for name in [
        "stackPaddingRight",
        "fontVariantNumericFraction",
        "fontVersion",
        "detachOpticalSizeFromFontSize",
        "rectangleCornerRadiiIndependent",
        "variableConsumptionMap.RECTANGLE_TOP_LEFT_CORNER_RADIUS",
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
    assert!(text_node
        .text_style
        .as_ref()
        .unwrap()
        .features
        .iter()
        .any(|feature| feature == "smcp"));
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
    assert!(spec
        .overrides
        .get("fig-9-9")
        .unwrap()
        .get("layout")
        .is_none());
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
fn percent_opacity_variables_resolve_inside_the_unit_interval() {
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
            "n": {"id": "n", "kind": "frame", "width": 40, "height": 20, "opacity": 0.5, "bindings": {"opacity": "percent"}},
            "unit": {"id": "unit", "kind": "frame", "width": 40, "height": 20, "opacity": 1, "bindings": {"opacity": "unit"}}
        }
    }))
    .unwrap();
    resolve(&mut doc).unwrap();
    assert!((doc.nodes["n"].opacity - 0.5).abs() < 1e-9);
    assert!((doc.nodes["unit"].opacity - 0.25).abs() < 1e-9);
    doc.validate().unwrap();
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
