use futureox_design_kernel::interop;
use serde_json::Value;
use std::{collections::BTreeMap, io::Write, path::Path};

fn official_archive(feature: &Path) -> Vec<u8> {
    let mut entries = BTreeMap::new();
    for name in ["meta.json", "document.json", "user.json"] {
        entries.insert(name.to_owned(), std::fs::read(feature.join(name)).unwrap());
    }
    for page in std::fs::read_dir(feature.join("pages")).unwrap() {
        let page = page.unwrap();
        entries.insert(format!("pages/{}", page.file_name().to_string_lossy()), std::fs::read(page.path()).unwrap());
    }
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn collect_export_formats(value: &Value, output: &mut Vec<(String, Vec<Value>)>) {
    match value {
        Value::Object(object) => {
            if let Some(id) = object.get("do_objectID").and_then(Value::as_str)
                && let Some(formats) = object.get("exportOptions").and_then(|options|options.get("exportFormats")).and_then(Value::as_array)
                && !formats.is_empty()
            {
                output.push((id.to_owned(), formats.clone()));
            }
            for child in object.values() { collect_export_formats(child, output); }
        }
        Value::Array(children) => for child in children { collect_export_formats(child, output); },
        _ => {}
    }
}

fn assert_export_formats_preserved(input: &[u8], exported: &[u8]) {
    let input_files = interop::read_zip_public(input).unwrap();
    let exported_files = interop::read_zip_public(exported).unwrap();
    for (name, bytes) in input_files.iter().filter(|(name,_)| name.starts_with("pages/") && name.ends_with(".json")) {
        let source: Value = serde_json::from_slice(bytes).unwrap();
        let output: Value = serde_json::from_slice(&exported_files[name]).unwrap();
        let mut before = Vec::new(); collect_export_formats(&source, &mut before);
        let mut after = Vec::new(); collect_export_formats(&output, &mut after);
        assert_eq!(before.len(), after.len(), "export setting owner count changed in {name}");
        for ((_, source), (_, output)) in before.iter().zip(after.iter()) {
            assert_eq!(source.len(), output.len(), "export setting count changed in {name}");
            for (source, output) in source.iter().zip(output.iter()) {
                for key in ["_class", "absoluteSize", "fileFormat", "name", "namingScheme", "visibleScaleType"] {
                    assert_eq!(source[key], output[key], "export setting field {key} changed in {name}");
                }
                assert_eq!(source["scale"].as_f64(), output["scale"].as_f64(), "export scale changed in {name}");
                if source.get("relativeAvailabilityMethod").is_some() {
                    assert_eq!(source["relativeAvailabilityMethod"], output["relativeAvailabilityMethod"], "relative availability changed in {name}");
                }
            }
        }
    }
}

#[test]
fn official_reference_json_round_trips_through_the_production_codec() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../testing/fixtures/sketch-official/reference-files/files");
    let mut checked = 0;
    let mut failures = Vec::new();
    for version in std::fs::read_dir(&root).unwrap() {
        let version = version.unwrap();
        for feature in std::fs::read_dir(version.path()).unwrap() {
            let feature = feature.unwrap();
            let id = format!("{}/{}", version.file_name().to_string_lossy(), feature.file_name().to_string_lossy());
            let export_settings = feature.file_name() == "export-formats";
            let result = std::panic::catch_unwind(|| {
                let input = official_archive(&feature.path());
                let document = interop::import_sketch_report(&input)?;
                let exported = interop::export_sketch(&document.document)?;
                if export_settings { assert_export_formats_preserved(&input, &exported); }
                interop::import_sketch_report(&exported)?;
                Ok::<(), futureox_design_kernel::interop::Error>(())
            });
            checked += 1;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(format!("{id}: {error}")),
                Err(_) => failures.push(format!("{id}: codec panicked")),
            }
        }
    }
    assert!(failures.is_empty(), "{} of {checked} official reference cases failed:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(checked, 74);
}

#[test]
fn official_complete_archive_round_trips_through_the_production_codec() {
    let bytes = include_bytes!("../../../../testing/fixtures/sketch-official/file-format-series/color-library.sketch");
    let document = interop::import_sketch_report(bytes).unwrap();
    let exported = interop::export_sketch(&document.document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    assert!(!reopened.document.pages.is_empty());
    let source: Value = serde_json::from_slice(&interop::read_zip_public(bytes).unwrap()["document.json"]).unwrap();
    let output: Value = serde_json::from_slice(&interop::read_zip_public(&exported).unwrap()["document.json"]).unwrap();
    assert_eq!(source["sharedSwatches"], output["sharedSwatches"], "official color swatches changed");
    let _: Value = serde_json::to_value(&reopened.document).unwrap();
}
