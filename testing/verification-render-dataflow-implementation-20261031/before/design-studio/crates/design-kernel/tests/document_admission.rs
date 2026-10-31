use futureox_design_kernel::validate_document_json;
use serde_json::Value;

#[test]
fn shared_authored_admission_matrix_is_stateless() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/document-admission.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut document = fixture["base"].clone();
        for patch in case["patches"].as_array().unwrap() {
            let path = patch["path"].as_str().unwrap();
            let (parent, key) = path.rsplit_once('/').unwrap();
            let target = document.pointer_mut(parent).unwrap();
            if let Some(object) = target.as_object_mut() {
                object.insert(key.to_owned(), patch["value"].clone());
            } else {
                target.as_array_mut().unwrap()[key.parse::<usize>().unwrap()] =
                    patch["value"].clone();
            }
        }
        let json = serde_json::to_string(&document).unwrap();
        let result = validate_document_json(&json);
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        // Repeated admission neither consumes nor rewrites the authored snapshot.
        assert_eq!(result, validate_document_json(&json));
        assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), document);
    }
}

#[test]
fn malformed_and_oversized_admission_fail_without_a_renderer() {
    assert!(validate_document_json("{invalid").is_err());
    assert!(validate_document_json("null").is_err());
    let limit = futureox_design_kernel::capacity::document_byte_limit();
    assert!(futureox_design_kernel::capacity::check_document_bytes(limit).is_ok());
    assert!(futureox_design_kernel::capacity::check_document_bytes(limit + 1).unwrap_err().contains("DOCUMENT_RESOURCE_LIMIT"));
}

#[test]
fn legacy_32mib_threshold_is_not_a_document_business_limit() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/document-admission.json")).unwrap();
    let mut document = fixture["base"].clone();
    document["portableUnknownPayload"] = Value::String("x".repeat(33 * 1024 * 1024));
    let source = serde_json::to_string(&document).unwrap();
    assert!(source.len() > 32 * 1024 * 1024);
    validate_document_json(&source).unwrap();
    let encoded = futureox_design_kernel::binfmt::encode_value(&document);
    assert_eq!(futureox_design_kernel::binfmt::decode_value(&encoded).unwrap(), document);
}
