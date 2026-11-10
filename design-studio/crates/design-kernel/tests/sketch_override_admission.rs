//! Sketch symbol/override admission for shared layer styles and local libraries.
use futureox_design_kernel::{components, interop};
use serde_json::{Value, json};
use std::io::Write;

fn archive(document: Value, layers: Vec<Value>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, value) in [
        ("meta.json", json!({"version": 144, "appVersion": "99"})),
        ("document.json", document),
        ("pages/page.json", json!({"_class": "page", "do_objectID": "page", "name": "Page", "layers": layers})),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn layer(id: &str, class: &str) -> Value {
    json!({
        "_class": class, "do_objectID": id, "name": id,
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
    })
}

fn paint_style(id: &str) -> Value {
    json!({
        "_class": "sharedStyle", "do_objectID": id, "name": "Brand",
        "value": {"_class": "style", "fills": [{
            "_class": "fill", "isEnabled": true, "fillType": 0,
            "color": {"_class": "color", "red": 1.0, "green": 0.0, "blue": 0.0, "alpha": 1.0}
        }], "borders": [{
            "_class": "border", "isEnabled": true, "fillType": 0, "thickness": 2, "position": 1,
            "color": {"_class": "color", "red": 0.0, "green": 0.0, "blue": 1.0, "alpha": 1.0}
        }], "shadows": [{
            "_class": "shadow", "isEnabled": true, "blurRadius": 4, "offsetX": 1, "offsetY": 2, "spread": 0,
            "color": {"_class": "color", "red": 0.0, "green": 0.0, "blue": 0.0, "alpha": 0.5}
        }]}
    })
}

fn styled_symbol(_style_id: &str, override_value: Value) -> Vec<Value> {
    let mut shape = layer("SHAPE", "rectangle");
    shape["style"] = json!({"_class": "style", "fills": [{
        "_class": "fill", "isEnabled": true, "fillType": 0,
        "color": {"_class": "color", "red": 0.5, "green": 0.5, "blue": 0.5, "alpha": 1.0}
    }]});
    let mut master = layer("MASTER", "symbolMaster");
    master["symbolID"] = json!("SYMBOL-1");
    master["frame"]["x"] = json!(100);
    master["layers"] = json!([shape]);
    let mut instance = layer("INSTANCE", "symbolInstance");
    instance["symbolID"] = json!("SYMBOL-1");
    instance["overrideValues"] = json!([{
        "_class": "overrideValue", "overrideName": "SHAPE_layerStyle", "value": override_value
    }]);
    vec![master, instance]
}

fn document_with(extra: Vec<(&str, Value)>) -> Value {
    let mut document = json!({
        "_class": "document", "do_objectID": "DOC-1", "colorSpace": 1,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/page"}]
    });
    for (key, value) in extra {
        document[key] = value;
    }
    document
}

fn resolved_shape(document: &futureox_design_kernel::scene::Document) -> &futureox_design_kernel::scene::Node {
    document.nodes.values().find(|node| {
        node.instance_origin.as_ref().is_some_and(|origin| origin.owner == "INSTANCE") && node.name == "SHAPE"
    }).expect("resolved symbol shape")
}

fn pixel(document: &futureox_design_kernel::scene::Document) -> [u8; 4] {
    let mut engine = futureox_design_kernel::Engine::new();
    engine.load_document(&serde_json::to_string(document).unwrap()).unwrap();
    let bytes = engine.render(&futureox_design_kernel::RenderOptions {
        page_id: document.pages[0].id.clone(),
        width: 16,
        height: 16,
        view: futureox_design_kernel::View { x: 0., y: 0., zoom: 1. },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }).unwrap();
    let index = (8 * 16 + 8) * 4;
    [bytes[index], bytes[index + 1], bytes[index + 2], bytes[index + 3]]
}

#[test]
fn shared_layer_style_override_paints_fill_stroke_and_effect_and_round_trips() {
    let bytes = archive(
        document_with(vec![("layerStyles", json!({"_class": "sharedStyleContainer", "objects": [paint_style("STYLE-1")]}))]),
        styled_symbol("STYLE-1", json!("STYLE-1")),
    );
    let authored = interop::import_sketch_report(&bytes).unwrap().document;
    let style_ref = authored.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["SHAPE"]["styleRefs"]["fills"].as_str().unwrap().to_owned();
    assert_eq!(style_ref, "STYLE-1");
    authored.validate().unwrap();
    let mut resolved = authored.clone();
    components::resolve(&mut resolved).unwrap();
    let shape = resolved_shape(&resolved);
    assert_eq!(shape.fills[0].color, "#ff0000");
    assert_eq!(shape.strokes.len(), 1);
    assert!(shape.strokes[0].width >= 2.);
    assert!(shape.effects.iter().any(|effect| effect.kind == "shadow"));
    assert_eq!(pixel(&resolved)[0], 255, "shared fill reaches the instance pixel");

    let mut edited = authored.clone();
    edited.design_system.as_mut().unwrap().styles.get_mut("STYLE-1").unwrap().value[0]["color"] = json!("#00ff00");
    components::resolve(&mut edited).unwrap();
    assert_eq!(resolved_shape(&edited).fills[0].color, "#00ff00");
    assert_ne!(pixel(&edited)[1], pixel(&resolved)[1]);

    let exported = interop::export_sketch(&authored).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let page: Value = serde_json::from_slice(files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    let instance = page["layers"].as_array().unwrap().iter().find(|layer| layer["name"] == "INSTANCE").unwrap();
    let override_value = instance["overrideValues"].as_array().unwrap().iter().find(|value| value["overrideName"].as_str().unwrap().ends_with("_layerStyle")).unwrap();
    assert_eq!(override_value["value"], "STYLE-1");
    let mut reopened = interop::import_sketch_report(&exported).unwrap().document;
    assert_eq!(reopened.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["SHAPE"]["styleRefs"]["fills"], "STYLE-1");
    components::resolve(&mut reopened).unwrap();
    assert_eq!(resolved_shape(&reopened).fills[0].color, "#ff0000");
    assert_eq!(resolved_shape(&reopened).strokes.len(), 1);
}

#[test]
fn foreign_layer_style_is_addressed_by_remote_id_without_becoming_a_local_duplicate() {
    let foreign = json!([{
        "_class": "MSImmutableForeignLayerStyle",
        "do_objectID": "FOREIGN-ENTRY",
        "libraryID": "LIB-DOC",
        "sourceLibraryName": "Kit",
        "remoteStyleID": "REMOTE-STYLE",
        "localSharedStyle": paint_style("LOCAL-STYLE")
    }]);
    let bytes = archive(document_with(vec![("foreignLayerStyles", foreign.clone())]), styled_symbol("REMOTE-STYLE", json!("REMOTE-STYLE")));
    let document = interop::import_sketch_report(&bytes).unwrap().document;
    assert_eq!(document.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["SHAPE"]["styleRefs"]["fills"], "LOCAL-STYLE");
    assert!(document.design_system.as_ref().unwrap().styles["LOCAL-STYLE"].strokes.len() == 1);
    let exported = interop::export_sketch(&document).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let out: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    assert!(out["layerStyles"]["objects"].as_array().unwrap().iter().all(|style| style["do_objectID"] != "LOCAL-STYLE"));
    assert_eq!(out["foreignLayerStyles"][0]["remoteStyleID"], "REMOTE-STYLE");
    let mut reopened = interop::import_sketch_report(&exported).unwrap().document;
    components::resolve(&mut reopened).unwrap();
    assert_eq!(resolved_shape(&reopened).fills[0].color, "#ff0000");
    assert!(resolved_shape(&reopened).effects.iter().any(|effect| effect.kind == "shadow"));
}

#[test]
fn conflicting_foreign_remote_style_aliases_do_not_select_the_last_library_entry() {
    let mut blue = paint_style("LOCAL-B");
    blue["value"]["fills"][0]["color"]["red"] = json!(0.0);
    blue["value"]["fills"][0]["color"]["blue"] = json!(1.0);
    let bytes = archive(document_with(vec![("foreignLayerStyles", json!([
        {"remoteStyleID":"REMOTE", "localSharedStyle":paint_style("LOCAL-A")},
        {"remoteStyleID":"remote", "localSharedStyle":blue}
    ]))]), styled_symbol("REMOTE", json!("REMOTE")));
    let error = interop::import_sketch_report(&bytes).err().expect("ambiguous remote identity must reject");
    assert!(error.to_string().contains("duplicate shared style alias"), "{error}");
}

#[test]
fn inline_layer_style_dict_becomes_editable_paints_and_exports_as_layer_style() {
    let style = paint_style("INLINE")["value"].clone();
    let bytes = archive(document_with(vec![]), styled_symbol("INLINE", style));
    let document = interop::import_sketch_report(&bytes).unwrap().document;
    let fields = &document.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["SHAPE"];
    assert_eq!(fields["fills"][0]["color"], "#ff0000");
    assert_eq!(fields["strokes"].as_array().unwrap().len(), 1);
    assert!(fields["effects"].as_array().unwrap().iter().any(|effect| effect["kind"] == "shadow"));
    let exported = interop::export_sketch(&document).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let page: Value = serde_json::from_slice(files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    let instance = page["layers"].as_array().unwrap().iter().find(|layer| layer["name"] == "INSTANCE").unwrap();
    let value = instance["overrideValues"].as_array().unwrap().iter().find(|value| value["overrideName"].as_str().unwrap().ends_with("_layerStyle")).unwrap();
    assert_eq!(value["value"]["_class"], "style");
    assert_eq!(value["value"]["fills"][0]["color"]["red"], 1.0);
    let mut reopened = interop::import_sketch_report(&exported).unwrap().document;
    components::resolve(&mut reopened).unwrap();
    assert_eq!(resolved_shape(&reopened).fills[0].color, "#ff0000");
    assert_eq!(resolved_shape(&reopened).strokes[0].paint.color, "#0000ff");
}

#[test]
fn missing_style_master_and_corrupt_target_stay_distinct_and_blocked() {
    let missing_style = archive(document_with(vec![]), styled_symbol("GONE", json!("GONE-STYLE")));
    let style_error = interop::import_sketch_report(&missing_style).err().unwrap().to_string();
    assert!(style_error.contains("GONE-STYLE"), "{style_error}");
    assert!(style_error.contains("缺失的外部库样式"), "{style_error}");
    assert!(style_error.contains("页面「Page」"), "{style_error}");
    assert!(style_error.contains("打开前定位"), "{style_error}");
    assert!(!style_error.contains("no supported editable mapping"), "{style_error}");
    assert!(style_error.contains("不会发明样式"), "{style_error}");

    let mut layers = styled_symbol("STYLE-1", json!("STYLE-1"));
    layers[1]["symbolID"] = json!("MISSING-MASTER");
    let master_error = interop::import_sketch_report(&archive(document_with(vec![]), layers)).err().unwrap().to_string();
    assert!(master_error.contains("embedded symbol master"), "{master_error}");
    assert!(master_error.contains("MISSING-MASTER"), "{master_error}");
    assert!(master_error.contains("缺失的外部库符号"), "{master_error}");
    assert!(master_error.contains("不会发明主组件"), "{master_error}");
    assert!(master_error.contains("页面「Page」"), "{master_error}");
    assert!(master_error.contains("打开前定位"), "{master_error}");

    let mut shape = layer("SHAPE", "rectangle");
    shape["style"] = json!({"fills": []});
    let mut master = layer("MASTER", "symbolMaster");
    master["symbolID"] = json!("SYMBOL-1");
    master["layers"] = json!([shape]);
    let mut instance = layer("INSTANCE", "symbolInstance");
    instance["symbolID"] = json!("SYMBOL-1");
    instance["overrideValues"] = json!([{"overrideName": "DF9F8712-F384-496A-AFFD-EE3744A1A99B_symbolID", "value": "OTHER"}]);
    let corrupt = interop::import_sketch_report(&archive(document_with(vec![]), vec![master, instance])).err().unwrap().to_string();
    assert!(corrupt.contains("could not be resolved"), "{corrupt}");
    assert!(corrupt.contains("损坏的覆盖引用"), "{corrupt}");
    assert!(corrupt.contains("DF9F8712-F384-496A-AFFD-EE3744A1A99B"), "{corrupt}");
    assert!(corrupt.contains("页面「Page」"), "{corrupt}");
    assert!(corrupt.contains("不会发明图层"), "{corrupt}");

    let mut layers = styled_symbol("STYLE-1", json!({}));
    layers[1]["overrideValues"] = json!([{"overrideName": "SHAPE_textStyle", "value": {}}]);
    let unmapped = interop::import_sketch_report(&archive(
        document_with(vec![("layerTextStyles", json!({"objects": []}))]),
        layers,
    )).err().unwrap().to_string();
    assert!(unmapped.contains("no supported editable mapping"), "{unmapped}");
    assert!(unmapped.contains("无法映射的字段"), "{unmapped}");
}

#[test]
fn text_style_override_uses_the_embedded_text_style() {
    let text = json!({
        "_class": "sharedStyle", "do_objectID": "TEXT-1", "name": "Body",
        "value": {"_class": "style", "textStyle": {"_class": "textStyle", "encodedAttributes": {
            "MSAttributedStringFontAttribute": {"_class": "fontDescriptor", "attributes": {"name": "Helvetica", "size": 18}},
            "kerning": 0, "paragraphStyle": {"alignment": 1}
        }}}
    });
    let mut label = layer("LABEL", "text");
    label["attributedString"] = json!({"_class": "attributedString", "string": "Hi", "attributes": []});
    let mut master = layer("MASTER", "symbolMaster");
    master["symbolID"] = json!("SYMBOL-1");
    master["layers"] = json!([label]);
    let mut instance = layer("INSTANCE", "symbolInstance");
    instance["symbolID"] = json!("SYMBOL-1");
    instance["overrideValues"] = json!([{"overrideName": "LABEL_textStyle", "value": "TEXT-1"}]);
    let document = interop::import_sketch_report(&archive(
        document_with(vec![("layerTextStyles", json!({"_class": "sharedTextStyleContainer", "objects": [text]}))]),
        vec![master, instance],
    )).unwrap().document;
    assert_eq!(document.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["styleRefs"]["textStyle"], "TEXT-1");
    let exported = interop::export_sketch(&document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap().document;
    assert_eq!(reopened.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["styleRefs"]["textStyle"], "TEXT-1");
}

#[test]
fn local_library_supplies_a_missing_master_by_symbol_id_and_preserves_export() {
    let mut project_instance = layer("INSTANCE", "symbolInstance");
    project_instance["symbolID"] = json!("LIB-SYMBOL");
    project_instance["overrideValues"] = json!([{"overrideName": "LABEL_stringValue", "value": "From project"}]);
    let project = archive(
        document_with(vec![("perDocumentLibraries", json!([{"_class": "MSImmutableDocumentLibraryInfo", "documentID": "LIB-DOC", "name": "uswds", "libraryType": 0}]))]),
        vec![project_instance],
    );
    let mut label = layer("LABEL", "text");
    label["attributedString"] = json!({"string": "Library", "attributes": []});
    let mut master = layer("LIB-MASTER", "symbolMaster");
    master["symbolID"] = json!("LIB-SYMBOL");
    master["layers"] = json!([label]);
    let mut library_document = document_with(vec![]);
    library_document["do_objectID"] = json!("LIB-DOC");
    let library = archive(library_document, vec![master]);
    let wrong = archive(document_with(vec![]), vec![{
        let mut other = layer("OTHER", "symbolMaster");
        other["symbolID"] = json!("OTHER-SYMBOL");
        other["name"] = json!("border color");
        other
    }]);
    let blocked = interop::import_sketch_report_with_libraries(&project, &[&wrong]).err().unwrap().to_string();
    assert!(blocked.contains("embedded symbol master"), "{blocked}");
    assert!(blocked.contains("LIB-SYMBOL"), "{blocked}");
    assert!(blocked.contains("已核对本地库"), "{blocked}");
    assert!(blocked.contains("不会发明主组件"), "{blocked}");
    assert!(!blocked.contains("border color"), "{blocked}");

    let mut admitted = interop::import_sketch_report_with_libraries(&project, &[&library]).unwrap().document;
    assert_eq!(admitted.nodes["INSTANCE"].instance.as_ref().unwrap().component_id, "LIB-MASTER");
    assert_eq!(admitted.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["text"], "From project");
    let metadata = &admitted.design_system.as_ref().unwrap().sketch_containers["nodeMetadata"];
    assert_eq!(metadata["LIB-MASTER"]["bindings"]["sketchForeignLibraryID"], "LIB-DOC");
    assert_eq!(metadata["LIB-MASTER"]["bindings"]["symbolID"], "LIB-SYMBOL");
    admitted.validate().unwrap();
    components::resolve(&mut admitted).unwrap();
    assert!(admitted.nodes.values().any(|node| node.text == "From project"));
    let exported = interop::export_sketch(&admitted).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    let foreign = document["foreignSymbols"].as_array().unwrap();
    assert_eq!(foreign.len(), 1);
    assert_eq!(foreign[0]["symbolMaster"]["symbolID"], "LIB-SYMBOL");
    assert_eq!(foreign[0]["libraryID"], "LIB-DOC");
    let mut reopened = interop::import_sketch_report(&exported).unwrap().document;
    assert_eq!(reopened.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["text"], "From project");
    components::resolve(&mut reopened).unwrap();
    assert!(reopened.nodes.values().any(|node| node.text == "From project"));
}

#[test]
fn named_page_fills_a_sibling_master_by_id_and_does_not_import_the_other_page() {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let mut label = layer("LABEL", "text");
    label["attributedString"] = json!({"string": "Library", "attributes": []});
    let mut master = layer("LIB-MASTER", "symbolMaster");
    master["symbolID"] = json!("LIB-SYMBOL");
    master["layers"] = json!([label]);
    let mut only = layer("ONLY-ON-B", "rectangle");
    only["name"] = json!("ONLY-ON-B");
    let mut instance = layer("INSTANCE", "symbolInstance");
    instance["symbolID"] = json!("LIB-SYMBOL");
    instance["overrideValues"] = json!([{"overrideName": "LABEL_stringValue", "value": "From page"}]);
    let files = [
        ("meta.json", json!({"version": 144, "pagesAndArtboards": {"PAGE-A": {"name": "Using"}, "PAGE-B": {"name": "Definitions"}}})),
        ("document.json", json!({"_class": "document", "do_objectID": "DOC-1", "colorSpace": 1, "pages": [
            {"_class": "MSJSONFileReference", "_ref": "pages/PAGE-A"},
            {"_class": "MSJSONFileReference", "_ref": "pages/PAGE-B"}
        ]})),
        ("pages/PAGE-A.json", json!({"_class": "page", "do_objectID": "PAGE-A", "name": "Using", "layers": [instance]})),
        ("pages/PAGE-B.json", json!({"_class": "page", "do_objectID": "PAGE-B", "name": "Definitions", "layers": [master, only]})),
    ];
    for (name, value) in files {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let missing = interop::import_sketch_page_report(&bytes, "Missing", &[]).err().unwrap().to_string();
    assert!(missing.contains("was not found"), "{missing}");
    let mut document = interop::import_sketch_page_report(&bytes, "Using", &[]).unwrap().document;
    assert!(document.pages.iter().any(|page| page.name == "Using"));
    assert!(!document.pages.iter().any(|page| page.name == "Definitions"));
    assert!(!document.nodes.values().any(|node| node.name == "ONLY-ON-B"));
    assert_eq!(document.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["text"], "From page");
    components::resolve(&mut document).unwrap();
    assert!(document.nodes.values().any(|node| node.text == "From page"));
}

/// Official archives are not in git. Run with
/// `SKETCH_OFFICIAL_DIR=/path cargo test --test sketch_override_admission -- --ignored official_uswds`.
#[test]
#[ignore = "official USWDS and Carbon .sketch files are external"]
fn official_uswds_and_carbon_override_admission_matches_the_real_archives() {
    let Some(dir) = std::env::var("SKETCH_OFFICIAL_DIR").ok() else { return };
    let read = |name: &str| std::fs::read(std::path::Path::new(&dir).join(name)).unwrap();
    let project = read("uswds-project.sketch");
    let library = read("uswds.sketch");
    let project_error = interop::import_sketch_report(&project).err().unwrap().to_string();
    assert!(project_error.contains("6F0139C2-C417-4447-8E8B-5926F071C14F"), "{project_error}");
    assert!(project_error.contains("缺失的外部库符号"), "{project_error}");
    assert!(project_error.contains("不会发明主组件"), "{project_error}");
    assert!(project_error.contains("打开前定位"), "{project_error}");
    assert!(project_error.contains("border color"), "{project_error}");
    let linked = interop::import_sketch_report_with_libraries(&project, &[&library]).err().unwrap().to_string();
    assert!(linked.contains("6F0139C2-C417-4447-8E8B-5926F071C14F"), "{linked}");
    assert!(linked.contains("已核对本地库"), "{linked}");
    assert!(linked.contains("uswds"), "{linked}");
    assert!(linked.contains("不会发明主组件"), "{linked}");
    assert!(linked.contains("上游定义缺失") || linked.contains("其中没有这个 symbolID"), "{linked}");
    assert!(!linked.contains("Border color"), "{linked}");
    let library_error = interop::import_sketch_report(&library).err().unwrap().to_string();
    assert!(library_error.contains("DF9F8712-F384-496A-AFFD-EE3744A1A99B"), "{library_error}");
    assert!(library_error.contains("could not be resolved"), "{library_error}");
    assert!(library_error.contains("损坏的覆盖引用"), "{library_error}");
    assert!(library_error.contains("位置："), "{library_error}");

    let carbon = read("Carbon_DataViz_Master_v2.sketch");
    let report = interop::import_sketch_page_report(&carbon, "Color", &[]).expect("Color page layerStyle overrides admit");
    assert!(report.document.pages.iter().any(|page| page.name == "Color"));
    assert!(!report.document.pages.iter().any(|page| matches!(page.name.as_str(), "Legend" | "About" | "Layout" | "Axis")));
    let style_id = report.document.nodes.values().find_map(|node| {
        node.instance.as_ref().and_then(|instance| {
            instance.overrides.values().find_map(|fields| {
                fields.get("styleRefs").and_then(|refs| refs.get("fills")).and_then(|id| id.as_str()).map(str::to_owned)
            })
        })
    }).expect("Color page keeps a shared layerStyle on the instance");
    let mut admitted = report.document.clone();
    components::resolve(&mut admitted).unwrap();
    let painted = admitted.nodes.values().any(|node| node.instance_origin.is_some() && node.fills.iter().any(|paint| paint.visible && !paint.color.is_empty()));
    assert!(painted, "a resolved instance layer keeps the shared layer style fill");
    let before = pixel_of_styled_instance(&admitted, &style_id);
    let mut editor = futureox_design_kernel::editing::DocumentEditor::new(report.document).unwrap();
    let original = editor.document().clone();
    let mut edited = original.clone();
    edited.design_system.as_mut().unwrap().styles.get_mut(&style_id).unwrap().value[0]["color"] = json!("#00ff00");
    editor.apply(editor.revision(), futureox_design_kernel::editing::DocumentPatch::between(&original, &edited).unwrap()).unwrap();
    let mut resolved = editor.document().clone();
    components::resolve(&mut resolved).unwrap();
    assert_ne!(pixel_of_styled_instance(&resolved, &style_id), before, "editing the shared layer style changes the Color page pixel");
    editor.undo().unwrap();
    assert_eq!(editor.document().design_system.as_ref().unwrap().styles[&style_id].value[0]["color"], original.design_system.as_ref().unwrap().styles[&style_id].value[0]["color"]);
    editor.redo().unwrap();
    let exported = interop::export_sketch(editor.document()).unwrap();
    let mut reopened = interop::import_sketch_report(&exported).unwrap().document;
    assert!(reopened.nodes.values().any(|node| node.instance.as_ref().is_some_and(|instance| {
        instance.overrides.values().any(|fields| fields.get("styleRefs").and_then(|refs| refs.get("fills")).and_then(|id| id.as_str()) == Some(style_id.as_str()))
    })));
    components::resolve(&mut reopened).unwrap();
    assert_eq!(pixel_of_styled_instance(&reopened, &style_id), pixel_of_styled_instance(&resolved, &style_id));
}

fn pixel_of_styled_instance(document: &futureox_design_kernel::scene::Document, style_id: &str) -> u64 {
    let page = document.pages.iter().find(|page| page.name == "Color").expect("Color page");
    let mut parent = std::collections::BTreeMap::new();
    for node in document.nodes.values() {
        for child in &node.children { parent.insert(child.clone(), node.id.clone()); }
    }
    let mut on_page = std::collections::BTreeSet::new();
    let mut stack = page.children.clone();
    while let Some(id) = stack.pop() {
        if !on_page.insert(id.clone()) { continue; }
        if let Some(node) = document.nodes.get(&id) { stack.extend(node.children.iter().cloned()); }
    }
    let instance_id = document.nodes.values().find(|node| {
        on_page.contains(&node.id) && node.instance.as_ref().is_some_and(|instance| {
            instance.overrides.values().any(|fields| fields.get("styleRefs").and_then(|refs| refs.get("fills")).and_then(|id| id.as_str()) == Some(style_id))
        })
    }).map(|node| node.id.clone()).expect("instance with the shared layer style");
    let mut owned = std::collections::BTreeSet::new();
    let mut stack = vec![instance_id];
    while let Some(id) = stack.pop() {
        if !owned.insert(id.clone()) { continue; }
        if let Some(node) = document.nodes.get(&id) { stack.extend(node.children.iter().cloned()); }
    }
    let node = document.nodes.values().find(|node| {
        owned.contains(&node.id) && node.width >= 4. && node.height >= 4.
            && node.fills.iter().any(|paint| paint.visible && paint.color.starts_with('#'))
    }).expect("resolved layer painted by the shared layer style");
    let mut x = 0.;
    let mut y = 0.;
    let mut cursor = Some(node.id.clone());
    for _ in 0..32 {
        let Some(id) = cursor else { break };
        let Some(current) = document.nodes.get(&id) else { break };
        x += current.transform.0[4];
        y += current.transform.0[5];
        cursor = parent.get(&id).cloned();
    }
    let mut engine = futureox_design_kernel::Engine::new();
    engine.load_font(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    engine.load_document(&serde_json::to_string(document).unwrap()).unwrap();
    let side_w = node.width.clamp(1., 48.).round() as u32;
    let side_h = node.height.clamp(1., 48.).round() as u32;
    let bytes = engine.render(&futureox_design_kernel::RenderOptions {
        page_id: page.id.clone(),
        width: side_w,
        height: side_h,
        view: futureox_design_kernel::View { x: -x, y: -y, zoom: 1. },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }).unwrap();
    bytes.iter().fold(0u64, |hash, byte| hash.wrapping_mul(16777619).wrapping_add(*byte as u64))
}

