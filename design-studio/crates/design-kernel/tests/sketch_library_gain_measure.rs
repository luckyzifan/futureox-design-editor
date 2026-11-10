//! Same-input measurement for Sketch library admission.
//! The reference is the authored symbol ID and override string, not a later
//! screenshot. Pin `CORE_DOCUMENT_MEMORY_BYTES=33554432` to measure a sibling
//! page that exceeds the existing entry ceiling without raising that ceiling.
use futureox_design_kernel::{components, interop};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::time::Instant;

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn entry_ceiling() -> u64 {
    // Mirrors `sketch::archive::max_entry_bytes`. This test does not change it.
    (futureox_design_kernel::capacity::memory_budget_bytes() / 8).clamp(4 * 1024 * 1024, 1024 * 1024 * 1024)
}

fn zip_stored(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn project(symbol: &str) -> Vec<u8> {
    let document = json!({
        "_class": "document", "do_objectID": "DOC-1", "colorSpace": 1,
        "perDocumentLibraries": [{"_class": "MSImmutableDocumentLibraryInfo", "documentID": "LIB-DOC", "name": "uswds", "libraryType": 0}],
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/page"}]
    });
    let page = json!({
        "_class": "page", "do_objectID": "page", "name": "Page",
        "layers": [{
            "_class": "symbolInstance", "do_objectID": "INSTANCE", "name": "INSTANCE", "symbolID": symbol,
            "overrideValues": [{"_class": "overrideValue", "overrideName": "LABEL_stringValue", "value": "From project"}],
            "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
        }]
    });
    let document_bytes = serde_json::to_vec(&document).unwrap();
    let page_bytes = serde_json::to_vec(&page).unwrap();
    zip_stored(&[
        ("meta.json", br#"{"version":144,"appVersion":"99"}"#),
        ("document.json", &document_bytes),
        ("pages/page.json", &page_bytes),
    ])
}

fn library(symbol: &str, huge: Option<&[u8]>) -> Vec<u8> {
    let label = json!({
        "_class": "text", "do_objectID": "LABEL", "name": "LABEL",
        "attributedString": {"_class": "attributedString", "string": "Library", "attributes": []},
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
    });
    let master = json!({
        "_class": "symbolMaster", "do_objectID": "LIB-MASTER", "name": "Button", "symbolID": symbol,
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16},
        "layers": [label]
    });
    let document = json!({
        "_class": "document", "do_objectID": "LIB-DOC", "colorSpace": 1,
        "pages": [
            {"_class": "MSJSONFileReference", "_ref": "pages/small"},
            {"_class": "MSJSONFileReference", "_ref": "pages/huge"}
        ]
    });
    let page = json!({"_class": "page", "do_objectID": "small", "name": "Symbols", "layers": [master]});
    let document_bytes = serde_json::to_vec(&document).unwrap();
    let page_bytes = serde_json::to_vec(&page).unwrap();
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("meta.json", br#"{"version":144,"appVersion":"99"}"#),
        ("document.json", &document_bytes),
        ("pages/small.json", &page_bytes),
    ];
    if let Some(huge) = huge {
        entries.push(("pages/huge.json", huge));
    }
    zip_stored(&entries)
}

fn corrupt_archive() -> Vec<u8> {
    let shape = json!({
        "_class": "rectangle", "do_objectID": "SHAPE", "name": "SHAPE",
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16},
        "style": {"_class": "style", "fills": []}
    });
    let master = json!({
        "_class": "symbolMaster", "do_objectID": "MASTER", "name": "MASTER", "symbolID": "SYMBOL-1",
        "frame": {"_class": "rect", "x": 100, "y": 0, "width": 16, "height": 16},
        "layers": [shape]
    });
    let instance = json!({
        "_class": "symbolInstance", "do_objectID": "INSTANCE", "name": "INSTANCE", "symbolID": "SYMBOL-1",
        "overrideValues": [{"overrideName": "DF9F8712-F384-496A-AFFD-EE3744A1A99B_symbolID", "value": "OTHER"}],
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
    });
    let document = json!({
        "_class": "document", "do_objectID": "DOC-1", "colorSpace": 1,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/page"}]
    });
    let page = json!({"_class": "page", "do_objectID": "page", "name": "Page", "layers": [master, instance]});
    let document_bytes = serde_json::to_vec(&document).unwrap();
    let page_bytes = serde_json::to_vec(&page).unwrap();
    zip_stored(&[
        ("meta.json", br#"{"version":144,"appVersion":"99"}"#),
        ("document.json", &document_bytes),
        ("pages/page.json", &page_bytes),
    ])
}

fn unmapped_archive() -> Vec<u8> {
    let label = json!({
        "_class": "text", "do_objectID": "LABEL", "name": "LABEL",
        "attributedString": {"string": "Hi", "attributes": []},
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
    });
    let master = json!({
        "_class": "symbolMaster", "do_objectID": "MASTER", "name": "MASTER", "symbolID": "SYMBOL-1",
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16},
        "layers": [label]
    });
    let instance = json!({
        "_class": "symbolInstance", "do_objectID": "INSTANCE", "name": "INSTANCE", "symbolID": "SYMBOL-1",
        "overrideValues": [{"overrideName": "LABEL_textStyle", "value": {}}],
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
    });
    let document = json!({
        "_class": "document", "do_objectID": "DOC-1", "colorSpace": 1,
        "layerTextStyles": {"objects": []},
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/page"}]
    });
    let page = json!({"_class": "page", "do_objectID": "page", "name": "Page", "layers": [master, instance]});
    let document_bytes = serde_json::to_vec(&document).unwrap();
    let page_bytes = serde_json::to_vec(&page).unwrap();
    zip_stored(&[
        ("meta.json", br#"{"version":144,"appVersion":"99"}"#),
        ("document.json", &document_bytes),
        ("pages/page.json", &page_bytes),
    ])
}

fn affirms(text: &str, phrase: &str) -> bool {
    let mut from = 0;
    while let Some(at) = text[from..].find(phrase) {
        let abs = from + at;
        let negated = text.get(..abs).is_some_and(|prefix| prefix.ends_with("不是"));
        if !negated {
            return true;
        }
        from = abs + phrase.len();
    }
    false
}

fn classify(bytes: &[u8], libraries: &[&[u8]]) -> Value {
    let before = sha256(bytes);
    let library_before: Vec<String> = libraries.iter().map(|library| sha256(library)).collect();
    let started = Instant::now();
    let outcome = interop::import_sketch_report_with_libraries(bytes, libraries);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let after = sha256(bytes);
    let library_after: Vec<String> = libraries.iter().map(|library| sha256(library)).collect();
    let mut report = json!({
        "elapsedMs": elapsed_ms,
        "sourceUnchanged": before == after && library_before == library_after,
        "sourceSha256": before,
        "admitted": false,
    });
    match outcome {
        Err(error) => {
            let text = error.to_string();
            report["error"] = json!(text);
            report["missingSymbol"] = json!(affirms(&text, "缺失的外部库符号"));
            report["missingStyle"] = json!(affirms(&text, "缺失的外部库样式"));
            report["corrupt"] = json!(affirms(&text, "损坏的覆盖引用"));
            report["unmapped"] = json!(affirms(&text, "无法映射的字段"));
            report["checkedLibrary"] = json!(text.contains("已核对本地库"));
            report["confirmedAbsent"] = json!(text.contains("上游定义缺失"));
            report["unread"] = json!(text.contains("未展开"));
            report["archiveLimit"] = json!(text.contains("archive resource limit"));
            report["inventsMaster"] = json!(text.contains("发明主组件") && !text.contains("不会发明主组件"));
        }
        Ok(imported) => {
            let mut document = imported.document.clone();
            let override_text = document.nodes.get("INSTANCE").and_then(|node| node.instance.as_ref()).and_then(|instance| instance.overrides.get("LABEL")).and_then(|fields| fields.get("text")).and_then(Value::as_str).unwrap_or("").to_owned();
            let symbol_id = document.nodes.get("LIB-MASTER").and_then(|node| node.bindings.get("symbolID")).cloned().unwrap_or_default();
            let valid = document.validate().is_ok();
            components::resolve(&mut document).ok();
            let resolved_text = document.nodes.values().any(|node| node.text == "From project");
            let exported = interop::export_sketch(&imported.document);
            let (export_bytes, reopened_text, export_symbol) = match exported {
                Ok(bytes) => {
                    let files = interop::read_zip_public(&bytes).ok();
                    let symbol = files.as_ref().and_then(|files| files.get("document.json")).and_then(|raw| serde_json::from_slice::<Value>(raw).ok()).and_then(|document| document["foreignSymbols"][0]["symbolMaster"]["symbolID"].as_str().map(str::to_owned)).unwrap_or_default();
                    let reopened = interop::import_sketch_report(&bytes).ok().and_then(|report| {
                        report.document.nodes.get("INSTANCE").and_then(|node| node.instance.as_ref()).and_then(|instance| instance.overrides.get("LABEL")).and_then(|fields| fields.get("text")).and_then(Value::as_str).map(str::to_owned)
                    }).unwrap_or_default();
                    (bytes.len(), reopened, symbol)
                }
                Err(error) => (0, String::new(), error.to_string()),
            };
            report["admitted"] = json!(true);
            report["valid"] = json!(valid);
            report["overrideText"] = json!(override_text);
            report["resolvedText"] = json!(resolved_text);
            report["masterSymbolId"] = json!(symbol_id);
            report["exportBytes"] = json!(export_bytes);
            report["reopenedOverride"] = json!(reopened_text);
            report["exportedSymbolId"] = json!(export_symbol);
        }
    }
    report
}

fn official(dir: &str) -> Value {
    let read = |name: &str| std::fs::read(std::path::Path::new(dir).join(name));
    let Ok(project) = read("uswds-project.sketch") else {
        return json!({"status": "NOT_RUN", "reason": "uswds-project.sketch missing"});
    };
    let Ok(library) = read("uswds.sketch") else {
        return json!({"status": "NOT_RUN", "reason": "uswds.sketch missing"});
    };
    let project_sha = sha256(&project);
    let library_sha = sha256(&library);
    let expected_project = "acb8020dc583df2ce458c829f28cf6103f8f088be5665052ed2464e7ad25eb38";
    let expected_library = "e0d8642c959245b013d7dcc44ec61b461ae5de6a277aad328eb4c305d22ab33f";
    if project_sha != expected_project || library_sha != expected_library {
        return json!({
            "status": "HASH_MISMATCH",
            "projectSha256": project_sha,
            "librarySha256": library_sha,
            "projectBytes": project.len(),
            "libraryBytes": library.len(),
        });
    }
    let alone = classify(&project, &[]);
    let linked = classify(&project, &[&library]);
    let library_open = classify(&library, &[]);
    json!({
        "status": "MEASURED",
        "projectBytes": project.len(),
        "libraryBytes": library.len(),
        "projectSha256": project_sha,
        "librarySha256": library_sha,
        "projectAlone": alone,
        "projectWithLibrary": linked,
        "libraryAlone": library_open,
    })
}

#[test]
fn measure_sketch_library_admission_against_authored_ids() {
    // Same existing 64 MiB trusted pin on every machine. Entry ceiling stays
    // memory/8 (8 MiB here). This does not raise the product default.
    futureox_design_kernel::capacity::configure(67_108_864).expect("measurement budget");
    let budget = futureox_design_kernel::capacity::memory_budget_bytes();
    assert_eq!(budget, 67_108_864, "entry-ceiling measurement must use the pinned 64 MiB budget");
    let entry = entry_ceiling();
    let reference = "From project";
    let no_library = classify(&project("LIB-SYMBOL"), &[]);
    let wrong = library("OTHER-SYMBOL", None);
    let wrong_result = classify(&project("LIB-SYMBOL"), &[&wrong]);
    let matching = library("LIB-SYMBOL", None);
    let within = classify(&project("LIB-SYMBOL"), &[&matching]);
    let over = if entry > 8 * 1024 * 1024 {
        json!({"status": "NOT_RUN", "reason": "entry ceiling is above 8 MiB; pin CORE_DOCUMENT_MEMORY_BYTES=33554432", "entryCeiling": entry})
    } else {
        let huge = vec![0u8; (entry as usize).saturating_add(1)];
        let linked = library("LIB-SYMBOL", Some(&huge));
        let mut result = classify(&project("LIB-SYMBOL"), &[&linked]);
        result["hugeUncompressedBytes"] = json!(huge.len());
        result["status"] = json!("MEASURED");
        result
    };
    let corrupt = classify(&corrupt_archive(), &[]);
    let unmapped = classify(&unmapped_archive(), &[]);
    let official = std::env::var("SKETCH_OFFICIAL_DIR").map(|dir| official(&dir)).unwrap_or_else(|_| json!({"status": "NOT_RUN", "reason": "SKETCH_OFFICIAL_DIR unset"}));
    let report = json!({
        "memoryBudget": budget,
        "entryCeiling": entry,
        "referenceOverride": reference,
        "noLibrary": no_library,
        "wrongLibrary": wrong_result,
        "withinBudget": within,
        "overEntrySibling": over,
        "corruptOverride": corrupt,
        "unmappedField": unmapped,
        "official": official,
    });
    let encoded = serde_json::to_string_pretty(&report).unwrap();
    eprintln!("{encoded}");
    if let Ok(path) = std::env::var("SKETCH_LIBRARY_MEASURE_OUT") {
        std::fs::write(path, &encoded).unwrap();
    }
    assert!(report["noLibrary"]["admitted"] == false, "missing symbol opened");
    assert!(report["noLibrary"]["missingSymbol"] == true, "{encoded}");
    assert!(report["noLibrary"]["sourceUnchanged"] == true);
    assert!(report["wrongLibrary"]["admitted"] == false, "wrong library opened");
    assert!(report["wrongLibrary"]["checkedLibrary"] == true, "{encoded}");
    assert!(report["wrongLibrary"]["confirmedAbsent"] == true, "{encoded}");
    assert!(report["wrongLibrary"]["inventsMaster"] == false);
    assert!(report["withinBudget"]["admitted"] == true, "{encoded}");
    assert!(report["withinBudget"]["overrideText"] == reference);
    assert!(report["withinBudget"]["reopenedOverride"] == reference);
    assert!(report["withinBudget"]["resolvedText"] == true);
    assert!(report["withinBudget"]["exportedSymbolId"] == "LIB-SYMBOL");
    assert!(report["withinBudget"]["sourceUnchanged"] == true);
    assert!(report["corruptOverride"]["admitted"] == false);
    assert!(report["corruptOverride"]["corrupt"] == true, "{encoded}");
    assert!(report["corruptOverride"]["missingSymbol"] == false, "{encoded}");
    assert!(report["corruptOverride"]["unmapped"] == false, "{encoded}");
    assert!(report["unmappedField"]["admitted"] == false);
    assert!(report["unmappedField"]["unmapped"] == true, "{encoded}");
    assert!(report["unmappedField"]["missingSymbol"] == false, "{encoded}");
    assert!(report["unmappedField"]["corrupt"] == false, "{encoded}");
    if report["overEntrySibling"]["status"] == "NOT_RUN" {
        assert!(std::env::var_os("SKETCH_LIBRARY_REQUIRE_OVER_ENTRY").is_none(), "{encoded}");
    } else {
        assert!(report["overEntrySibling"]["admitted"] == true, "{encoded}");
        assert!(report["overEntrySibling"]["overrideText"] == reference, "{encoded}");
        assert!(report["overEntrySibling"]["reopenedOverride"] == reference, "{encoded}");
        assert!(report["overEntrySibling"]["exportedSymbolId"] == "LIB-SYMBOL", "{encoded}");
        assert!(report["overEntrySibling"]["sourceUnchanged"] == true, "{encoded}");
        assert!(report["overEntrySibling"]["confirmedAbsent"] != true);
    }
    if report["official"]["status"] == "MEASURED" {
        assert!(report["official"]["projectAlone"]["admitted"] == false);
        assert!(report["official"]["projectAlone"]["error"].as_str().unwrap().contains("6F0139C2-C417-4447-8E8B-5926F071C14F"));
        assert!(report["official"]["projectWithLibrary"]["admitted"] == false, "real USWDS must stay blocked when the symbol is absent");
        assert!(report["official"]["projectWithLibrary"]["error"].as_str().unwrap().contains("6F0139C2-C417-4447-8E8B-5926F071C14F"));
        assert!(report["official"]["libraryAlone"]["admitted"] == false);
        assert!(report["official"]["libraryAlone"]["error"].as_str().unwrap().contains("DF9F8712-F384-496A-AFFD-EE3744A1A99B"));
        assert!(report["official"]["projectAlone"]["sourceUnchanged"] == true);
        assert!(report["official"]["projectWithLibrary"]["sourceUnchanged"] == true);
    }
}
