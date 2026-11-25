//! Sketch view state and layer switches that the kernel does not execute.
//! Import keeps them in the document, and export writes the authored values back.
use futureox_design_kernel::{binfmt, interop, scene::Document};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;

const PAGE_A: &str = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";
const PAGE_B: &str = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBB2";

fn archive(document: Value, user: &[u8], pages: &[(&str, Value)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let mut entries = vec![
        ("meta.json".to_string(), serde_json::to_vec(&json!({"appVersion": "2025.1.3", "version": 146})).unwrap()),
        ("document.json".to_string(), serde_json::to_vec(&document).unwrap()),
        ("user.json".to_string(), user.to_vec()),
    ];
    for (id, page) in pages {
        entries.push((format!("pages/{id}.json"), serde_json::to_vec(page).unwrap()));
    }
    for (name, bytes) in entries {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn rect(width: f64, height: f64) -> Value {
    json!({"_class": "rect", "x": 0, "y": 0, "width": width, "height": height})
}

fn persist(document: &Document) -> Document {
    let json = serde_json::to_string(document).unwrap();
    let encoded = binfmt::encode_authored_json(&json).unwrap();
    serde_json::from_str(&binfmt::decode_authored_json(&encoded).unwrap()).unwrap()
}

fn json_files(bytes: &[u8]) -> BTreeMap<String, Value> {
    interop::read_zip_public(bytes)
        .unwrap()
        .into_iter()
        .filter(|(name, _)| name.ends_with(".json"))
        .map(|(name, bytes)| (name, serde_json::from_slice(&bytes).unwrap()))
        .collect()
}

fn export_document(label: &str, document: &Document) -> BTreeMap<String, Value> {
    let exported = interop::export_sketch(document).unwrap_or_else(|error| panic!("{label} export: {error}"));
    json_files(&exported)
}

fn round_trip(label: &str, bytes: &[u8]) -> (Document, BTreeMap<String, Value>) {
    let imported = interop::import_sketch_report(bytes).unwrap_or_else(|error| panic!("{label} import: {error}"));
    let document = persist(&imported.document);
    let files = export_document(label, &document);
    (document, files)
}

fn import_and_export(label: &str, bytes: &[u8]) -> (Document, BTreeMap<String, Value>) {
    let imported = interop::import_sketch_report(bytes).unwrap_or_else(|error| panic!("{label} import: {error}"));
    let files = export_document(label, &imported.document);
    (imported.document, files)
}

fn layer_flags(document: &Document, id: &str) -> Value {
    let raw = document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.pointer(&format!("/{id}/bindings/sketchLayerFlags")))
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{id} has no retained layer flags"));
    serde_json::from_str(raw).unwrap()
}

fn pages(files: &BTreeMap<String, Value>) -> Vec<&Value> {
    let mut pages: Vec<_> = files
        .iter()
        .filter(|(name, _)| name.starts_with("pages/") && name.ends_with(".json"))
        .map(|(_, page)| page)
        .collect();
    pages.sort_by_key(|page| page["name"].as_str().unwrap_or(""));
    pages
}

fn descendants<'a>(layer: &'a Value, out: &mut Vec<&'a Value>) {
    let Some(children) = layer.get("layers").and_then(Value::as_array) else { return };
    for child in children {
        out.push(child);
        descendants(child, out);
    }
}

fn named<'a>(files: &'a BTreeMap<String, Value>, name: &str) -> Vec<&'a Value> {
    let mut found = Vec::new();
    for page in pages(files) {
        if page["name"].as_str() == Some(name) {
            found.push(page);
        }
        let mut layers = Vec::new();
        descendants(page, &mut layers);
        found.extend(layers.into_iter().filter(|layer| layer["name"].as_str() == Some(name)));
    }
    found
}

fn assert_image_references_resolve(files: &BTreeMap<String, Vec<u8>>) -> usize {
    let mut count = 0;
    for (name, bytes) in files.iter().filter(|(name, _)| name.ends_with(".json")) {
        let part: Value = serde_json::from_slice(bytes).unwrap();
        let mut pending = vec![&part];
        while let Some(value) = pending.pop() {
            match value {
                Value::Array(entries) => pending.extend(entries),
                Value::Object(entries) => pending.extend(entries.values()),
                _ => {}
            }
            if value["_ref_class"] == "MSImageData" && let Some(reference) = value["_ref"].as_str() {
                assert!(files.contains_key(reference) || files.contains_key(&format!("images/{reference}")),
                    "{name} has a dangling image reference: {reference}");
                count += 1;
            }
        }
    }
    count
}

#[test]
fn wfp_assets_keep_exact_archive_images_and_old_fd_drops_dangling_refs() {
    let bytes = fixture("../../../testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP Template.sketch");
    let source = interop::read_zip_public(&bytes).unwrap();
    assert_eq!(assert_image_references_resolve(&source), 30);
    let source_document: Value = serde_json::from_slice(&source["document.json"]).unwrap();
    let source_assets = &source_document["assets"]["images"];
    assert_eq!(source_assets.as_array().unwrap().len(), 5);

    let mut doc = interop::import_sketch(&bytes).unwrap();
    let exported = interop::read_zip_public(&interop::export_sketch(&doc).unwrap()).unwrap();
    assert_eq!(assert_image_references_resolve(&exported), 30);
    let export_document: Value = serde_json::from_slice(&exported["document.json"]).unwrap();
    assert_eq!(&export_document["assets"]["images"], source_assets);
    assert!(export_document.get("sketchAssetImageBytes").is_none());
    for image in source_assets.as_array().unwrap() {
        let reference = image["_ref"].as_str().unwrap();
        assert_eq!(exported[reference], source[reference], "{reference}");
    }

    // Reopen the shape of an FD saved before the archive bytes were retained.
    let metadata = &mut doc.design_system.as_mut().unwrap().sketch_containers;
    assert!(metadata.remove("sketchAssetImageBytes").is_some());
    let legacy = interop::read_zip_public(&interop::export_sketch(&doc).unwrap()).unwrap();
    assert_eq!(assert_image_references_resolve(&legacy), 25);
    let legacy_document: Value = serde_json::from_slice(&legacy["document.json"]).unwrap();
    assert_eq!(legacy_document["assets"]["images"], json!([]));
    for (key, source_value) in export_document["assets"].as_object().unwrap() {
        if key != "images" {
            assert_eq!(&legacy_document["assets"][key], source_value);
        }
    }
}

#[test]
fn wfp_page_masters_survive_embedded_library_copy_ids() {
    let bytes = fixture("../../../testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP Template.sketch");
    let source = json_files(&bytes);
    // The WFP corpus uses the archival codec for this round trip. Other
    // advanced overrides in this file are outside editable-session admission.
    let doc = interop::import_sketch(&bytes).unwrap();
    let round_tripped = export_document("WFP Template", &doc);
    let page_masters = |files: &BTreeMap<String, Value>| -> BTreeMap<String, Value> {
        let mut fields = BTreeMap::new();
        for page in pages(files) {
            let mut children = Vec::new();
            descendants(page, &mut children);
            for node in children {
                if node["_class"] == "symbolMaster" && node["resizesContent"] == true {
                    fields.insert(node["do_objectID"].as_str().unwrap().to_owned(),
                        node["symbolID"].clone());
                }
            }
        }
        fields
    };
    let expected = page_masters(&source);
    let actual = page_masters(&round_tripped);
    assert_eq!(expected.len(), 118);
    assert_eq!(actual.len(), 118);
    assert_eq!(actual, expected);

    let foreign = round_tripped["document.json"]["foreignSymbols"].as_array().unwrap();
    assert_eq!(foreign.len(), 2);
    for entry in foreign {
        let mutable = &entry["symbolMaster"];
        let original = &entry["originalMaster"];
        assert_ne!(mutable["do_objectID"], original["do_objectID"]);
        assert_ne!(mutable["symbolID"], original["symbolID"]);
        assert_eq!(mutable["resizesContent"], true);
        let definition = &doc.nodes[mutable["do_objectID"].as_str().unwrap()];
        assert_eq!(definition.bindings.get("symbolID").map(String::as_str),
            mutable["symbolID"].as_str());
        assert!(doc.nodes.values().any(|node| node.instance.as_ref()
            .is_some_and(|instance| Some(instance.component_id.as_str()) == mutable["symbolID"].as_str())));
        for property in mutable["overrideProperties"].as_array().unwrap() {
            let path = property["overrideName"].as_str().unwrap();
            let target = path.split(['/', '_']).next().unwrap();
            assert!(mutable["layers"].as_array().unwrap().iter()
                .any(|child| child["do_objectID"] == target), "{path}");
        }
    }
    let exported = interop::export_sketch(&doc).unwrap();
    let reopened = interop::import_sketch(&exported).unwrap();
    assert_eq!(page_masters(&export_document("reopened WFP Template", &reopened)), expected);
}

#[test]
fn wfp_inferred_layouts_keep_absent_size_fields_out_of_the_archive() {
    let bytes = fixture("../../../testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP Template.sketch");
    let source = json_files(&bytes);
    let inferred_layouts = |files: &BTreeMap<String, Value>| -> BTreeMap<String, Value> {
        let mut layouts = BTreeMap::new();
        for page in pages(files) {
            let mut children = Vec::new();
            descendants(page, &mut children);
            for node in children {
                let layout = &node["groupLayout"];
                if layout["_class"] == "MSImmutableInferredGroupLayout" {
                    layouts.insert(node["do_objectID"].as_str().unwrap().to_owned(), layout.clone());
                }
            }
        }
        layouts
    };
    let expected = inferred_layouts(&source);
    assert_eq!(expected.len(), 21);
    let mut doc = interop::import_sketch(&bytes).unwrap();
    assert_eq!(inferred_layouts(&export_document("WFP inferred groups", &doc)), expected);

    // Existing FD documents can still hold the old null placeholders.
    // Sketch rejects the archive while either placeholder is present.
    for (id, native) in &expected {
        let binding = doc.nodes.get_mut(id).unwrap().bindings.get_mut("sketchInferredGroupLayout").unwrap();
        assert_eq!(&serde_json::from_str::<Value>(binding).unwrap(), native);
        let mut legacy = native.as_object().unwrap().clone();
        for name in ["minSize", "maxSize"] {
            legacy.entry(name).or_insert(Value::Null);
        }
        *binding = serde_json::to_string(&legacy).unwrap();
    }
    assert_eq!(inferred_layouts(&export_document("WFP legacy FD inferred groups", &doc)), expected);
}

fn authored_document() -> Vec<u8> {
    let user = serde_json::to_vec(&json!({
        "document": {
            "pageListHeight": 240,
            "pageListCollapsed": 0,
            "expandedColorPathsInSidebar": ["swatch"]
        },
        PAGE_A: {"scrollOrigin": "{12, 34}", "zoomValue": 2.5},
        PAGE_B: {"zoomValue": 0.5}
    }))
    .unwrap();
    let document = json!({
        "_class": "document",
        "do_objectID": "DOC",
        "colorSpace": 0,
        "currentPageIndex": 1,
        "enableLayerInteraction": false,
        "enableSliceInteraction": false,
        "pages": [
            {"_class": "MSJSONFileReference", "_ref": format!("pages/{PAGE_A}")},
            {"_class": "MSJSONFileReference", "_ref": format!("pages/{PAGE_B}")}
        ]
    });
    let page_a = json!({
        "_class": "page",
        "do_objectID": PAGE_A,
        "name": "Page A",
        "nameIsFixed": true,
        "layerListExpandedType": 2,
        "horizontalSizing": 3,
        "verticalSizing": 3,
        "paddingSelection": 1,
        "prototypeVisibility": 1,
        "prototypeVisibilityTrigger": 2,
        "layers": [
            {
                "_class": "symbolMaster",
                "do_objectID": "MASTER",
                "symbolID": "SYM",
                "name": "Master",
                "nameIsFixed": true,
                "layerListExpandedType": 2,
                "allowsOverrides": false,
                "resizesContent": true,
                "frame": rect(40., 40.),
                "layers": []
            },
            {
                "_class": "artboard",
                "do_objectID": "BOARD",
                "name": "Board",
                "nameIsFixed": true,
                "resizesContent": true,
                "frame": rect(100., 80.),
                "layers": [{
                    "_class": "rectangle",
                    "do_objectID": "RECT",
                    "name": "Rect",
                    "nameIsFixed": true,
                    "layerListExpandedType": 1,
                    "isFixedToViewport": true,
                    "frame": {"_class": "rect", "x": 4, "y": 6, "width": 10, "height": 12}
                }]
            },
            {
                "_class": "group",
                "do_objectID": "GROUP",
                "name": "Group",
                "nameIsFixed": true,
                "layerListExpandedType": 2,
                "isFixedToViewport": true,
                "frame": rect(20., 20.),
                "layers": []
            },
            {
                "_class": "symbolInstance",
                "do_objectID": "INST",
                "name": "Scaled",
                "symbolID": "SYM",
                "scale": 2,
                "horizontalSpacing": 4,
                "verticalSpacing": 6,
                "nameIsFixed": true,
                "frame": {"_class": "rect", "x": 50, "y": 0, "width": 40, "height": 40}
            },
            {
                "_class": "symbolInstance",
                "do_objectID": "INST0",
                "name": "Zero scale",
                "symbolID": "SYM",
                "scale": 0,
                "horizontalSpacing": 0,
                "verticalSpacing": 0,
                "frame": {"_class": "rect", "x": 0, "y": 90, "width": 14, "height": 13}
            },
            {
                "_class": "symbolInstance",
                "do_objectID": "PRECISE",
                "name": "Precise",
                "symbolID": "SYM",
                "scale": 2.71,
                "frame": {"_class": "rect", "x": 0, "y": 120, "width": 10, "height": 10}
            }
        ]
    });
    let page_b = json!({
        "_class": "page",
        "do_objectID": PAGE_B,
        "name": "Page B",
        "paddingSelection": 0,
        "layers": [{
            "_class": "rectangle",
            "do_objectID": "PLAIN",
            "name": "Plain",
            "frame": rect(8., 8.)
        }]
    });
    archive(document, &user, &[(PAGE_A, page_a), (PAGE_B, page_b)])
}

fn default_document() -> Vec<u8> {
    let document = json!({
        "_class": "document",
        "do_objectID": "DOC",
        "colorSpace": 0,
        "currentPageIndex": 0,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/PAGE"}]
    });
    let page = json!({
        "_class": "page",
        "do_objectID": "PAGE",
        "name": "Defaults",
        "horizontalSizing": 0,
        "verticalSizing": 0,
        "prototypeVisibility": 0,
        "layers": [
            {
                "_class": "symbolMaster",
                "do_objectID": "MASTER",
                "symbolID": "SYM",
                "name": "Master",
                "allowsOverrides": true,
                "frame": rect(30., 30.),
                "layers": []
            },
            {
                "_class": "artboard",
                "do_objectID": "BOARD",
                "name": "Board",
                "resizesContent": false,
                "frame": rect(30., 30.),
                "layers": []
            },
            {
                "_class": "symbolInstance",
                "do_objectID": "INST",
                "name": "Instance",
                "symbolID": "SYM",
                "scale": 1,
                "frame": rect(30., 30.)
            },
            {
                "_class": "rectangle",
                "do_objectID": "RECT",
                "name": "Rect",
                "nameIsFixed": false,
                "layerListExpandedType": 0,
                "isFixedToViewport": false,
                "frame": rect(10., 10.)
            }
        ]
    });
    archive(document, b"{}", &[("PAGE", page)])
}

#[test]
fn authored_sketch_metadata_survives_the_document_and_export() {
    let (document, files) = round_trip("authored", &authored_document());
    let containers = &document.design_system.as_ref().expect("design system").sketch_containers;
    assert_eq!(containers["currentPageIndex"], json!(1), "import dropped currentPageIndex");
    assert_eq!(containers["enableLayerInteraction"], json!(false));
    assert_eq!(containers["enableSliceInteraction"], json!(false));
    assert_eq!(containers["sketchUser"]["document"]["pageListHeight"], json!(240));
    assert_eq!(containers["sketchUser"]["document"]["expandedColorPathsInSidebar"][0], "swatch");
    assert_eq!(containers["sketchUser"][PAGE_A]["scrollOrigin"], "{12, 34}");
    assert_eq!(containers["sketchUser"][PAGE_A]["zoomValue"], json!(2.5));
    assert_eq!(containers["sketchUser"][PAGE_B]["zoomValue"], json!(0.5));
    assert_eq!(containers["sketchPageMetadata"][PAGE_A]["horizontalSizing"], json!(3));
    assert_eq!(containers["sketchPageMetadata"][PAGE_A]["verticalSizing"], json!(3));
    assert_eq!(containers["sketchPageMetadata"][PAGE_A]["paddingSelection"], json!(1));
    assert_eq!(containers["sketchPageMetadata"][PAGE_A]["prototypeVisibility"], json!(1));
    assert_eq!(containers["sketchPageMetadata"][PAGE_A]["prototypeVisibilityTrigger"], json!(2));
    assert_eq!(containers["sketchPageMetadata"][PAGE_A]["nameIsFixed"], json!(true));
    assert_eq!(containers["sketchPageMetadata"][PAGE_B]["paddingSelection"], json!(0));
    assert!(containers["sketchPageMetadata"].get(PAGE_B).unwrap().get("horizontalSizing").is_none());

    assert_eq!(document.nodes["INST"].width, 40.);
    assert_eq!(document.nodes["INST"].height, 40.);
    assert_eq!(document.nodes["INST0"].width, 14.);
    assert_eq!(document.nodes["INST0"].height, 13.);
    assert_eq!(document.nodes["PRECISE"].width, 10.);
    assert_eq!((document.nodes["RECT"].transform.0[4], document.nodes["RECT"].transform.0[5]), (4., 6.));
    assert_eq!((document.nodes["RECT"].width, document.nodes["RECT"].height), (10., 12.));
    assert_eq!(layer_flags(&document, "MASTER")["allowsOverrides"], json!(false));
    assert_eq!(layer_flags(&document, "MASTER")["resizesContent"], json!(true));
    assert_eq!(layer_flags(&document, "MASTER")["layerListExpandedType"], json!(2));
    assert_eq!(layer_flags(&document, "BOARD")["resizesContent"], json!(true));
    assert_eq!(layer_flags(&document, "RECT")["layerListExpandedType"], json!(1));
    assert_eq!(layer_flags(&document, "RECT")["isFixedToViewport"], json!(true));
    assert_eq!(layer_flags(&document, "GROUP")["nameIsFixed"], json!(true));
    assert_eq!(layer_flags(&document, "INST")["scale"], json!(2));
    assert_eq!(layer_flags(&document, "INST")["horizontalSpacing"], json!(4));
    assert_eq!(layer_flags(&document, "INST")["verticalSpacing"], json!(6));
    assert_eq!(layer_flags(&document, "INST0")["scale"], json!(0));
    assert_eq!(layer_flags(&document, "INST0")["horizontalSpacing"], json!(0));
    assert_eq!(layer_flags(&document, "PRECISE")["scale"], json!(2.71));
    assert!(layer_flags(&document, "PRECISE").get("horizontalSpacing").is_none());

    let exported = &files["document.json"];
    assert_eq!(exported["currentPageIndex"], json!(1));
    assert_eq!(exported["enableLayerInteraction"], json!(false));
    assert_eq!(exported["enableSliceInteraction"], json!(false));
    assert!(exported.get("sketchUser").is_none());
    assert!(exported.get("sketchPageMetadata").is_none());
    assert_eq!(files["user.json"]["document"]["pageListHeight"], json!(240));
    assert_eq!(files["user.json"]["document"]["pageListCollapsed"], json!(0));
    assert_eq!(files["user.json"][PAGE_A]["scrollOrigin"], "{12, 34}");
    assert_eq!(files["user.json"][PAGE_B]["zoomValue"], json!(0.5));
    assert!(files.contains_key(&format!("pages/{PAGE_A}.json")));

    let page_a = named(&files, "Page A");
    assert_eq!(page_a.len(), 1);
    assert_eq!(page_a[0]["horizontalSizing"], json!(3));
    assert_eq!(page_a[0]["verticalSizing"], json!(3));
    assert_eq!(page_a[0]["paddingSelection"], json!(1));
    assert_eq!(page_a[0]["prototypeVisibility"], json!(1));
    assert_eq!(page_a[0]["prototypeVisibilityTrigger"], json!(2));
    assert_eq!(page_a[0]["nameIsFixed"], json!(true));
    assert_eq!(page_a[0]["layerListExpandedType"], json!(2));
    let page_b = &named(&files, "Page B")[0];
    assert_eq!(page_b["paddingSelection"], json!(0));
    assert_eq!(page_b["horizontalSizing"], json!(0));
    assert_eq!(page_b["prototypeVisibility"], json!(0));

    let master = &named(&files, "Master")[0];
    assert_eq!(master["allowsOverrides"], json!(false));
    assert_eq!(master["resizesContent"], json!(true));
    assert_eq!(master["nameIsFixed"], json!(true));
    assert_eq!(master["layerListExpandedType"], json!(2));
    let board = &named(&files, "Board")[0];
    assert_eq!(board["resizesContent"], json!(true));
    assert_eq!(board["nameIsFixed"], json!(true));
    let rect = &named(&files, "Rect")[0];
    assert_eq!(rect["nameIsFixed"], json!(true));
    assert_eq!(rect["layerListExpandedType"], json!(1));
    assert_eq!(rect["isFixedToViewport"], json!(true));
    assert_eq!(rect["frame"]["x"].as_f64(), Some(4.));
    assert_eq!(rect["frame"]["width"].as_f64(), Some(10.));
    let group = &named(&files, "Group")[0];
    assert_eq!(group["nameIsFixed"], json!(true));
    assert_eq!(group["isFixedToViewport"], json!(true));
    assert_eq!(group["layerListExpandedType"], json!(2));
    let scaled = &named(&files, "Scaled")[0];
    assert_eq!(scaled["scale"], json!(2));
    assert_eq!(scaled["horizontalSpacing"], json!(4));
    assert_eq!(scaled["verticalSpacing"], json!(6));
    assert_eq!(scaled["frame"]["width"].as_f64(), Some(40.));
    let zero = &named(&files, "Zero scale")[0];
    assert_eq!(zero["scale"], json!(0));
    assert_eq!(zero["horizontalSpacing"], json!(0));
    assert_eq!(zero["verticalSpacing"], json!(0));
    assert_eq!(zero["frame"]["width"].as_f64(), Some(14.));
    let precise = &named(&files, "Precise")[0];
    assert_eq!(precise["scale"], json!(2.71));
    assert!(precise.get("horizontalSpacing").is_none());
    assert!(precise.get("verticalSpacing").is_none());

    let again = json_files(&interop::export_sketch(&interop::import_sketch_report(&interop::export_sketch(&document).unwrap()).unwrap().document).unwrap());
    assert_eq!(again["user.json"], files["user.json"]);
    assert_eq!(again["document.json"]["currentPageIndex"], json!(1));
    assert_eq!(again["document.json"]["enableLayerInteraction"], json!(false));
    assert_eq!(named(&again, "Master")[0]["allowsOverrides"], json!(false));
    assert_eq!(named(&again, "Precise")[0]["scale"], json!(2.71));
    assert_eq!(named(&again, "Page A")[0]["paddingSelection"], json!(1));
}

#[test]
fn omitted_sketch_metadata_keeps_the_historical_export_defaults() {
    let (_document, files) = round_trip("defaults", &default_document());
    let exported = &files["document.json"];
    assert_eq!(exported["currentPageIndex"], json!(0));
    assert!(exported.get("enableLayerInteraction").is_none());
    assert!(exported.get("enableSliceInteraction").is_none());
    assert!(exported.get("sketchUser").is_none());
    assert!(exported.get("sketchPageMetadata").is_none());
    assert_eq!(files["user.json"], json!({}));
    let page = &named(&files, "Defaults")[0];
    assert_eq!(page["horizontalSizing"], json!(0));
    assert_eq!(page["verticalSizing"], json!(0));
    assert_eq!(page["prototypeVisibility"], json!(0));
    assert!(page.get("paddingSelection").is_none());
    assert_eq!(page["nameIsFixed"], json!(false));
    assert_eq!(page["layerListExpandedType"], json!(0));
    let master = &named(&files, "Master")[0];
    assert_eq!(master["allowsOverrides"], json!(true));
    assert_eq!(master["resizesContent"], json!(false));
    assert_eq!(master["nameIsFixed"], json!(false));
    let board = &named(&files, "Board")[0];
    assert_eq!(board["resizesContent"], json!(false));
    let instance = &named(&files, "Instance")[0];
    assert_eq!(instance["scale"].as_f64(), Some(1.));
    assert!(instance.get("horizontalSpacing").is_none());
    assert!(instance.get("verticalSpacing").is_none());
    let rect = &named(&files, "Rect")[0];
    assert_eq!(rect["nameIsFixed"], json!(false));
    assert_eq!(rect["layerListExpandedType"], json!(0));
    assert_eq!(rect["isFixedToViewport"], json!(false));
}

#[test]
fn invalid_user_json_does_not_fail_import_and_stays_empty_on_export() {
    let document = json!({
        "_class": "document",
        "do_objectID": "DOC",
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/PAGE"}]
    });
    let page = json!({"_class": "page", "do_objectID": "PAGE", "name": "Page", "layers": []});
    for user in [b"{".as_slice(), b"[1]".as_slice(), b"null".as_slice()] {
        let (_document, files) = round_trip("invalid-user", &archive(document.clone(), user, &[("PAGE", page.clone())]));
        assert_eq!(files["user.json"], json!({}), "user bytes {}", String::from_utf8_lossy(user));
    }
}

#[test]
fn user_json_over_the_view_state_budget_is_not_copied() {
    let document = json!({
        "_class": "document",
        "do_objectID": "DOC",
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/PAGE"}]
    });
    let page = json!({"_class": "page", "do_objectID": "PAGE", "name": "Page", "layers": []});
    let mut user = Vec::from(&b"{\"pad\":\""[..]);
    user.extend(std::iter::repeat(b'a').take(1_048_576));
    user.extend(br#""}"#);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in [
        ("meta.json", serde_json::to_vec(&json!({"version": 146})).unwrap()),
        ("document.json", serde_json::to_vec(&document).unwrap()),
        ("user.json", user),
        ("pages/PAGE.json", serde_json::to_vec(&page).unwrap()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    let (document, files) = round_trip("oversized-user", &zip.finish().unwrap().into_inner());
    assert_eq!(files["user.json"], json!({}));
    assert!(document.design_system.as_ref().is_none_or(|system| !system.sketch_containers.contains_key("sketchUser")));
}

fn fixture(path: &str) -> Vec<u8> {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    std::fs::read(&full).unwrap_or_else(|error| panic!("read {}: {error}", full.display()))
}

fn source_json(bytes: &[u8], name: &str) -> Value {
    let files = interop::read_zip_public(bytes).unwrap();
    serde_json::from_slice(&files[name]).unwrap()
}

#[test]
fn color_library_user_json_round_trips() {
    let bytes = fixture("../../../testing/fixtures/sketch-official/file-format-series/color-library.sketch");
    let source = source_json(&bytes, "user.json");
    let (_document, files) = round_trip("color-library", &bytes);
    assert_eq!(files["user.json"]["document"]["pageListHeight"], json!(284));
    assert_eq!(
        files["user.json"]["document"]["expandedColorPathsInSidebar"],
        source["document"]["expandedColorPathsInSidebar"]
    );
    assert_eq!(
        files["user.json"]["57D56FAF-B884-4AEF-8BA9-4020439D4756"]["zoomValue"],
        json!(1)
    );
    assert_eq!(files["user.json"]["57D56FAF-B884-4AEF-8BA9-4020439D4756"]["scrollOrigin"], "{0, 0}");
}

#[test]
fn spatial_blur_page_fields_round_trip() {
    let bytes = fixture("../../../testing/fixtures/design/sketch-spatial-blur-modern.sketch");
    let (_document, files) = round_trip("spatial-blur", &bytes);
    let page = &named(&files, "Canvas effects oracle")[0];
    assert_eq!(page["horizontalSizing"], json!(3));
    assert_eq!(page["verticalSizing"], json!(3));
    assert_eq!(page["paddingSelection"], json!(1));
    assert_eq!(page["prototypeVisibility"], json!(1));
    assert_eq!(page["prototypeVisibilityTrigger"], json!(2));
}

#[test]
fn wireframe_current_page_and_fixed_page_names_round_trip() {
    let bytes = fixture("../../../testing/fixtures/sketch-public-20261105/Simple-Sketch-Wireframe-Kit/wireframe_kit_chevalier.sketch");
    let (_document, files) = round_trip("wireframe", &bytes);
    assert_eq!(files["document.json"]["currentPageIndex"], json!(1));
    let authored: Vec<_> = pages(&files)
        .into_iter()
        .filter(|page| matches!(page["name"].as_str(), Some("Page" | " Symbols")))
        .collect();
    assert_eq!(authored.len(), 2, "page names {:?}", pages(&files).iter().map(|page| page["name"].as_str()).collect::<Vec<_>>());
    assert!(authored.iter().all(|page| page["nameIsFixed"] == json!(true)));
}

fn two_page_archive(index: i64) -> Vec<u8> {
    let root = json!({
        "_class": "document", "do_objectID": "PAGE-PREFERENCE", "currentPageIndex": index,
        "pages": [{"_ref": format!("pages/{PAGE_A}")}, {"_ref": format!("pages/{PAGE_B}")}]
    });
    let pages = [
        (PAGE_A, json!({"_class": "page", "name": "A", "do_objectID": PAGE_A, "layers": []})),
        (PAGE_B, json!({"_class": "page", "name": "B", "do_objectID": PAGE_B, "layers": [],
            "userInfo": {"com.futureox.design-kernel": {"originalId": "internal-page-b"}}})),
    ];
    archive(root, b"{}", &pages)
}

#[test]
fn sketch_current_page_follows_its_identity_when_pages_reorder() {
    for index in [0, 1] {
        let mut document = interop::import_sketch_report(&two_page_archive(index)).unwrap().document;
        let expected = document.pages[index as usize].id.clone();
        document.pages.swap(0, 1);
        let bytes = interop::export_sketch(&document).unwrap();
        assert_eq!(json_files(&bytes)["document.json"]["currentPageIndex"], json!(1 - index));
        let reopened = interop::import_sketch_report(&bytes).unwrap().document;
        assert_eq!(reopened.pages[(1 - index) as usize].id, expected);
    }
}

#[test]
fn sketch_current_page_falls_back_when_removed_or_invalid() {
    let mut document = interop::import_sketch_report(&two_page_archive(1)).unwrap().document;
    let removed = document.pages.pop().unwrap();
    document.nodes.remove(&removed.id);
    let exported = json_files(&interop::export_sketch(&document).unwrap());
    assert_eq!(exported["document.json"]["currentPageIndex"], json!(0));
    for invalid in [-1, 5] {
        let document = interop::import_sketch_report(&two_page_archive(invalid)).unwrap().document;
        let exported = json_files(&interop::export_sketch(&document).unwrap());
        assert_eq!(exported["document.json"]["currentPageIndex"], json!(0));
    }
}

#[test]
fn projected_sketch_page_lists_resolve_the_original_archive_index_first() {
    let source = two_page_archive(1);
    let root = source_json(&source, "document.json");
    let meta = source_json(&source, "meta.json");
    for file in [PAGE_A, PAGE_B] {
        let pages = BTreeMap::from([(file.to_owned(), source_json(&source, &format!("pages/{file}.json")))]);
        let projection = json!([{"_ref": format!("pages/{file}")}]);
        let report = interop::import_sketch_source_parts_with_pages(&BTreeMap::new(), &meta, &root, &pages, &projection).unwrap();
        let exported = json_files(&interop::export_sketch(&report.document).unwrap());
        assert_eq!(exported["document.json"]["currentPageIndex"], json!(0));
        let selected = report.document.design_system.as_ref()
            .and_then(|system| system.sketch_containers.get("sketchCurrentPageId"));
        assert_eq!(selected.and_then(Value::as_str), (file == PAGE_B).then_some("internal-page-b"));
    }
}

#[test]
fn semantic_interaction_flags_and_zero_instance_scale_round_trip() {
    let bytes = fixture("../../../testing/fixtures/sketch-public-20261105/semantic-ui-kit-for-sketch/semantic-ui-kit.sketch");
    let (document, files) = round_trip("semantic-ui", &bytes);
    assert_eq!(files["document.json"]["enableLayerInteraction"], json!(true));
    assert_eq!(files["document.json"]["enableSliceInteraction"], json!(true));
    let instance = &named(&files, "star60")[0];
    assert_eq!(instance["scale"], json!(0));
    assert_eq!(instance["horizontalSpacing"], json!(0));
    assert_eq!(instance["verticalSpacing"], json!(0));
    assert_eq!(instance["frame"]["width"].as_f64(), Some(14.));
    assert_eq!(instance["frame"]["height"].as_f64(), Some(13.));
    let imported = document.nodes.values().find(|node| node.name == "star60").unwrap();
    assert_eq!((imported.width, imported.height), (14., 13.));
}

#[test]
fn favicon_instance_scales_round_trip_without_changing_frames() {
    let bytes = fixture("../../../testing/fixtures/sketch-public-20261105/ui-design-kit/WFP Favicons.sketch");
    let source_files = json_files(&bytes);
    let mut source_scales = Vec::new();
    for page in pages(&source_files) {
        let mut layers = Vec::new();
        descendants(page, &mut layers);
        for layer in layers {
            if layer["name"] == "WFP-Logo-small" && layer["_class"] == "symbolInstance" && layer["scale"].as_f64() != Some(1.) {
                source_scales.push((layer["scale"].clone(), layer["frame"]["width"].clone(), layer["frame"]["height"].clone()));
            }
        }
    }
    source_scales.sort_by(|a, b| a.0.as_f64().unwrap().total_cmp(&b.0.as_f64().unwrap()));
    assert_eq!(source_scales.len(), 3, "expected the three non-1 favicon scales, got {source_scales:?}");
    let (document, files) = import_and_export("favicons", &bytes);
    let mut exported = Vec::new();
    for page in pages(&files) {
        let mut layers = Vec::new();
        descendants(page, &mut layers);
        for layer in layers {
            if layer["name"] == "WFP-Logo-small" && layer["_class"] == "symbolInstance" && layer["scale"].as_f64() != Some(1.) {
                exported.push((layer["scale"].clone(), layer["frame"]["width"].clone(), layer["frame"]["height"].clone()));
            }
        }
    }
    exported.sort_by(|a, b| a.0.as_f64().unwrap().total_cmp(&b.0.as_f64().unwrap()));
    assert_eq!(exported.len(), source_scales.len(), "exported {exported:?}");
    for (source, output) in source_scales.iter().zip(exported.iter()) {
        assert_eq!(output.0.as_f64(), source.0.as_f64(), "scale changed");
        assert_eq!(output.1.as_f64(), source.1.as_f64(), "frame width changed");
        assert_eq!(output.2.as_f64(), source.2.as_f64(), "frame height changed");
    }
    let frames: Vec<(f64, f64)> = document
        .nodes
        .values()
        .filter(|node| node.name == "WFP-Logo-small" && node.instance.is_some())
        .map(|node| (node.width, node.height))
        .collect();
    assert!(frames.iter().any(|frame| *frame == (56., 19.2)), "{frames:?}");
    assert!(frames.iter().any(|frame| *frame == (42., 14.4)), "{frames:?}");
}
