// Budget-derived archive admission, in its own process so the pinned budget
// below wins the capacity OnceLock before any import path initializes it.
use futureox_design_kernel::{capacity, interop, sketch};
use std::io::Write;

fn stored_zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn budget_derived_archive_admission_rejects_and_reports() {
    // Entry 8 MiB, document entry 16 MiB, total 64 MiB at this budget.
    capacity::configure(64 * 1024 * 1024).expect("pins the process budget");

    // A zip-shaped Sketch bundle that exceeds the per-entry budget reports the
    // archive resource limit through import_any instead of a marker miss.
    let oversized = stored_zip(&[
        ("meta.json", br#"{"app":"com.bohemiancoding.sketch3","appVersion":"74.1"}"#.to_vec()),
        ("document.json", br#"{"_class":"document","pages":[]}"#.to_vec()),
        ("pages/toolarge.json", vec![b' '; 17 * 1024 * 1024]),
    ]);
    match interop::import_any(&oversized) {
        Err(interop::Error::Unsupported(message)) => assert!(message.contains("archive resource limit"), "{message}"),
        other => panic!("expected archive resource limit, got {other:?}"),
    }
    // A non-zip payload still falls through to the generic marker message.
    match interop::import_any(b"not a design file") {
        Err(interop::Error::NotAZip(message)) => assert!(message.contains("markers"), "{message}"),
        other => panic!("expected marker miss, got {other:?}"),
    }

    // Per-entry and document-entry caps sit just above their derived limits.
    for (name, size) in [("document.json", 16 * 1024 * 1024 + 1), ("images/oversized", 8 * 1024 * 1024 + 1)] {
        let bytes = stored_zip(&[(name, vec![b' '; size])]);
        assert!(
            interop::import_sketch(&bytes).unwrap_err().to_string().contains("entry bytes"),
            "{name} at {size}"
        );
    }

    // Cumulative inflated bytes can exceed the total budget with a bounded
    // per-entry ratio: xor-pattern 1 MiB entries compress within the ratio
    // guard and cross the 64 MiB total together.
    let mut state = 0x12345678u32;
    let pattern: Vec<u8> = (0..8192)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state & 0xff) as u8
        })
        .collect();
    let mut many: Vec<(&str, Vec<u8>)> = vec![
        ("meta.json", br#"{"version":146}"#.to_vec()),
        ("document.json", br#"{"_class":"document","pages":[{"_ref":"pages/P","_ref_class":"MSImmutablePage"}],"sharedLayerStyles":{"objects":[]}}"#.to_vec()),
        ("pages/P.json", br#"{"_class":"page","do_objectID":"P","layers":[]}"#.to_vec()),
        ("user.json", br#"{ "zoom": 1.25 }"#.to_vec()),
    ];
    let meg = pattern.repeat(128);
    many.extend((0..80).map(|i| (leak_name(i), meg.clone())));
    assert!(matches!(
        sketch::Document::from_sketch(&stored_zip(&many)),
        Err(sketch::Error::Limit(_))
    ));
}

fn leak_name(index: usize) -> &'static str {
    Box::leak(format!("entry-{index}").into_boxed_str())
}
