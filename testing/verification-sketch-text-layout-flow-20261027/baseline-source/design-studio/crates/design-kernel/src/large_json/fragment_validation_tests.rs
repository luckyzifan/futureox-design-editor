//! Authored source regressions only. All tests in this file are NOT_RUN.
use super::*;
use std::io::Cursor;

fn assert_duplicate(bytes: &[u8]) {
    let error = validate_fragment(bytes).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(error.to_string(), "Duplicate JSON object key in edit fragment");
}

fn export(changes: &Changes, source: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    changes
        .export(&mut Cursor::new(source), &mut out, source.len() as u64)
        .unwrap();
    out
}

#[test]
fn fragment_rejects_unindexed_duplicate_without_changing_source_index_admission() {
    let source = br#"{"outer":{"inner":{"x":1,"\u0078":2}}}"#;
    // This is intentionally a legacy whole-source control, not new admission.
    assert!(index(source.as_slice(), MAX_SOURCE_OFFSET).is_ok());
    assert_duplicate(source);
}

#[test]
fn duplicates_reject_at_every_admitted_object_depth() {
    for depth in 0..MAX_DEPTH {
        let text = format!(
            "{}{{\"x\":1,\"\\u0078\":2}}{}",
            "{\"outer\":".repeat(depth),
            "}".repeat(depth)
        );
        assert_duplicate(text.as_bytes());
    }
}

#[test]
fn nested_arrays_do_not_disable_duplicate_key_validation() {
    for text in [
        r#"[{"x":1,"x":2}]"#,
        r#"{"a":[[{"b":[{"x":1,"\u0078":2}]}]]}"#,
        r#"{"nodes":{"a":{"payload":[{"x":1,"x":2}]}}}"#,
        r#"{"layers":[{"layers":[{"payload":{"x":1,"x":2}}]}]}"#,
    ] {
        assert_duplicate(text.as_bytes());
    }
}

#[test]
fn decoded_escape_identity_is_exact_and_not_hash_only() {
    for text in [
        r#"{"x":1,"\u0078":2}"#,
        r#"{"/":1,"\/":2}"#,
        r#"{"\"":1,"\u0022":2}"#,
        r#"{"\\":1,"\u005c":2}"#,
        r#"{"\n":1,"\u000a":2}"#,
        r#"{"😀":1,"\uD83D\uDE00":2}"#,
        r#"{"雪":1,"\u96ea":2}"#,
        r#"{"":1,"":2}"#,
    ] {
        assert_duplicate(text.as_bytes());
    }
}

#[test]
fn separate_objects_case_and_non_normalized_unicode_keys_remain_distinct() {
    for text in [
        r#"{"a":{"x":1},"b":{"\u0078":2}}"#,
        r#"[{"x":1},{"x":2},{"x":{"x":3}}]"#,
        r#"{"x":1,"X":2}"#,
        r#"{"é":1,"e\u0301":2}"#,
        r#"{"😀":1,"😃":2}"#,
        r#"{"\u0000":1,"":2}"#,
    ] {
        validate_fragment(text.as_bytes()).unwrap();
    }
}

#[test]
fn arbitrary_numeric_lexemes_are_validated_without_numeric_conversion() {
    let mut tokens = vec![
        "0".to_owned(), "-0".to_owned(), "-0.0".to_owned(),
        "1".to_owned(), "1.0".to_owned(), "1e0".to_owned(), "1E+00".to_owned(),
        "9007199254740993".to_owned(), "18446744073709551616".to_owned(),
        "-9223372036854775809".to_owned(), "1e999999".to_owned(),
        "1e-999999".to_owned(), "4.9406564584124654e-324".to_owned(),
        "1.7976931348623157e308".to_owned(),
    ];
    tokens.push("9".repeat(64 * 1024 + 1));
    tokens.push(format!("1e+{}", "9".repeat(64 * 1024 + 1)));
    tokens.push(format!("0.{}1", "0".repeat(64 * 1024 + 1)));
    for token in tokens {
        assert!(index(token.as_bytes(), MAX_FRAGMENT_BYTES).is_ok());
        let mut changes = Changes::default();
        changes
            .replace(Span { start: 1, end: 2 }, token.as_bytes().to_vec(), 3)
            .unwrap();
        assert_eq!(export(&changes, b"[0]"), format!("[{token}]").as_bytes());
    }
}

#[test]
fn replacement_retains_raw_keys_strings_numbers_and_outside_bytes() {
    let source = br#"{ "left" : -0.0, "target":0, "cold":1844674407370955161600000 }"#;
    let span = index(source.as_slice(), MAX_SOURCE_OFFSET).unwrap().entries[0]
        .fields.iter().find(|field| field.key == "target").unwrap().value;
    let text = " {\"\\u0078\": [1E+00,-0,1e-999999],\"雪\":\"\\u96ea\\/😀\"} ";
    let mut changes = Changes::default();
    changes.replace(span, text.as_bytes().to_vec(), source.len() as u64).unwrap();
    let mut expected = source[..span.start as usize].to_vec();
    expected.extend_from_slice(text.as_bytes());
    expected.extend_from_slice(&source[span.end as usize..]);
    assert_eq!(export(&changes, source), expected);
}

#[test]
fn malformed_grammar_and_surrogate_policy_remain_unchanged() {
    for text in [
        b"[01]".as_slice(), b"[-01]", b"[1.]", b"[1e]", b"[+1]", b"[.1]",
        b"[NaN]", b"[Infinity]", b"[true,]", b"{\"a\":1,}", b"true false",
        br#""\uD800""#, br#""\uDC00""#, br#""\uD800\u0041""#,
        br#""\uD800\uD800""#, br#""\x41""#, b"\"\xff\"", b"\"\xc0\x80\"",
        b"\"\xed\xa0\x80\"", b"\"\xf4\x90\x80\x80\"", b"\"\x00\"", b"",
    ] {
        assert!(index(text, MAX_FRAGMENT_BYTES).is_err(), "{text:?}");
        assert!(validate_fragment(text).is_err(), "{text:?}");
    }
    for text in [r#""\uD83D\uDE00""#, "\"😀\"", r#""\u0000""#, "[]", "{}"] {
        validate_fragment(text.as_bytes()).unwrap();
    }
}

#[test]
fn utf8_and_escaped_keys_cross_internal_buffer_boundaries() {
    // Place the raw supplementary key across each split of a 64 KiB refill.
    for tail in 0..8 {
        let prefix = format!("{{\"pad\":\"{}\",\"", "a".repeat(64 * 1024 - 11 - tail));
        let text = format!("{prefix}😀\":0,\"\\uD83D\\uDE00\":1}}");
        assert_duplicate(text.as_bytes());
    }
    let text = r#"{"outer":{"😀":1,"\uD83D\uDE00":2}}"#.as_bytes();
    for capacity in 1..=16 {
        let mut scanner = Scanner {
            input: BufReader::with_capacity(capacity, text),
            at: 0,
            limit: MAX_FRAGMENT_BYTES,
            sink: |_, _| panic!("fragment validation emitted a navigation row"),
            entries: 0,
            fragment_keys: Some(FragmentKeyBudget { limit: text.len(), bytes: 0, keys: 0 }),
        };
        assert_eq!(
            scanner.value(0, None, true, "JSON", true, None).unwrap_err().to_string(),
            "Duplicate JSON object key in edit fragment"
        );
    }
}

#[test]
fn exact_depth_limit_and_first_overflow_match_existing_scanner() {
    for depth in [MAX_DEPTH, MAX_DEPTH + 1] {
        let text = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        assert_eq!(index(text.as_bytes(), MAX_FRAGMENT_BYTES).is_ok(), depth == MAX_DEPTH);
        assert_eq!(validate_fragment(text.as_bytes()).is_ok(), depth == MAX_DEPTH);
    }
}

#[test]
fn key_and_selected_metadata_limits_are_preserved() {
    for length in [MAX_KEY_BYTES, MAX_KEY_BYTES + 1] {
        let key = format!("{{\"{}\":0}}", "k".repeat(length));
        let metadata = format!("{{\"name\":\"{}\"}}", "m".repeat(length));
        for text in [key, metadata] {
            assert_eq!(index(text.as_bytes(), MAX_FRAGMENT_BYTES).is_ok(), length == MAX_KEY_BYTES);
            assert_eq!(validate_fragment(text.as_bytes()).is_ok(), length == MAX_KEY_BYTES);
        }
    }
    // Non-selected metadata and ordinary string values retain their old policy.
    let text = format!("{{\"outer\":{{\"inner\":{{\"name\":\"{}\"}}}}}}", "v".repeat(MAX_KEY_BYTES + 1));
    assert!(index(text.as_bytes(), MAX_FRAGMENT_BYTES).is_ok());
    validate_fragment(text.as_bytes()).unwrap();
}

#[test]
fn exact_four_mib_fragment_admits_and_next_byte_rejects() {
    let limit = MAX_FRAGMENT_BYTES as usize;
    let mut text = format!("\"{}\"", "a".repeat(limit - 2)).into_bytes();
    validate_fragment(&text).unwrap();
    text.push(b' ');
    assert_eq!(validate_fragment(&text).unwrap_err().to_string(), "JSON replacement fragment exceeds 4 MiB");
    let mut changes = Changes::default();
    assert!(changes.replace(Span { start: 0, end: 1 }, text, 1).is_err());
    assert_eq!(export(&changes, b"0"), b"0");
}

#[test]
fn active_key_sets_release_after_children_and_do_not_emit_index_rows() {
    let text = format!("[{}]", (0..2000).map(|_| r#"{"x":{"x":1},"y":2}"#).collect::<Vec<_>>().join(","));
    let mut scanner = Scanner {
        input: BufReader::with_capacity(64 * 1024, text.as_bytes()),
        at: 0,
        limit: MAX_FRAGMENT_BYTES,
        sink: |_, _| panic!("fragment validation emitted a navigation row"),
        entries: 0,
        fragment_keys: Some(FragmentKeyBudget { limit: text.len(), bytes: 0, keys: 0 }),
    };
    scanner.value(0, None, true, "JSON", true, None).unwrap();
    let budget = scanner.fragment_keys.as_ref().unwrap();
    assert_eq!((budget.bytes, budget.keys), (0, 0));
    assert!(scanner.entries > 0, "legacy selection counting was accidentally disabled");
}

#[test]
fn key_bookkeeping_is_checked_and_never_wraps() {
    let mut budget = FragmentKeyBudget { limit: 7, bytes: 0, keys: 0 };
    budget.retain(3).unwrap();
    budget.retain(0).unwrap();
    assert_eq!((budget.bytes, budget.keys), (3, 2));
    assert!(budget.retain(0).is_err());
    assert_eq!((budget.bytes, budget.keys), (3, 2));
    budget.release(3, 2).unwrap();
    assert_eq!((budget.bytes, budget.keys), (0, 0));
    let mut overflow = FragmentKeyBudget { limit: usize::MAX, bytes: usize::MAX, keys: 0 };
    assert!(overflow.retain(1).is_err());
    let mut overflow = FragmentKeyBudget { limit: usize::MAX, bytes: 0, keys: usize::MAX };
    assert!(overflow.retain(0).is_err());
}

#[test]
fn rejected_duplicate_replacement_preserves_existing_pieces_and_exact_output() {
    let source = br#"{"edit":0,"untouched":1E+00}"#;
    let span = Span { start: 8, end: 9 };
    let mut changes = Changes::default();
    changes.replace(span, b"-0".to_vec(), source.len() as u64).unwrap();
    let previous_state = serde_json::to_vec(&changes).unwrap();
    let previous_output = export(&changes, source);
    let duplicate = br#"{"outer":{"inner":{"x":1,"\u0078":2}}}"#.to_vec();
    let error = changes.replace(Span { start: 8, end: 10 }, duplicate, source.len() as u64).unwrap_err();
    assert_eq!(error.to_string(), "Duplicate JSON object key in edit fragment");
    assert_eq!(serde_json::to_vec(&changes).unwrap(), previous_state);
    assert_eq!(export(&changes, source), previous_output);
    assert_eq!(source, br#"{"edit":0,"untouched":1E+00}"#);
}

#[test]
fn wide_objects_and_escaped_decoded_key_limit_do_not_require_field_tables() {
    let text = format!("{{{}}}", (0..20_000).map(|n| format!("\"k{n}\":0")).collect::<Vec<_>>().join(","));
    validate_fragment(text.as_bytes()).unwrap();
    let text = format!("{{\"{}\":0}}", "\\u006b".repeat(MAX_KEY_BYTES));
    assert!(text.len() > MAX_KEY_BYTES);
    validate_fragment(text.as_bytes()).unwrap();
    let over = format!("{{\"{}\":0}}", "\\u006b".repeat(MAX_KEY_BYTES + 1));
    assert!(validate_fragment(over.as_bytes()).is_err());
}

#[test]
fn fragment_mode_keeps_the_existing_selected_entry_count_guard() {
    let text = b"{}".as_slice();
    let mut scanner = Scanner {
        input: BufReader::with_capacity(64 * 1024, text),
        at: 0,
        limit: MAX_FRAGMENT_BYTES,
        sink: |_, _| panic!("fragment validation emitted a navigation row"),
        entries: MAX_INDEX_VALUES,
        fragment_keys: Some(FragmentKeyBudget { limit: text.len(), bytes: 0, keys: 0 }),
    };
    assert_eq!(
        scanner.value(0, None, true, "JSON", true, None).unwrap_err().to_string(),
        "JSON index working-set limit exceeded"
    );
}

#[test]
fn legacy_index_keeps_selected_rows_parents_metadata_and_field_ranges() {
    let source = br#"{"outer":{"name":"child","inner":{"x":1}},"layers":[{"id":"layer","name":"Layer"}]}"#;
    let indexed = index(source.as_slice(), MAX_SOURCE_OFFSET).unwrap();
    assert_eq!(indexed.bytes, source.len() as u64);
    assert_eq!(indexed.entries.len(), 3);
    assert_eq!(indexed.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["json:0", "json:9", "layer"]);
    assert_eq!(indexed.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["JSON", "child", "Layer"]);
    assert_eq!(indexed.entries.iter().map(|e| e.parent).collect::<Vec<_>>(), vec![None, Some(0), Some(0)]);
    assert_eq!(indexed.entries.iter().map(|e| e.depth).collect::<Vec<_>>(), vec![0, 1, 2]);
    assert_eq!(indexed.entries[0].span, Span { start: 0, end: source.len() as u64 });
    assert_eq!(indexed.entries[0].fields.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), vec!["outer", "layers"]);
    assert_eq!(indexed.entries[1].fields.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), vec!["name", "inner"]);
    let inner = indexed.entries[1].fields.iter().find(|f| f.key == "inner").unwrap();
    assert_eq!(&source[inner.value.start as usize..inner.value.end as usize], br#"{"x":1}"#);
    assert_eq!(&source[inner.member.start as usize..inner.member.end as usize], br#""inner":{"x":1}"#);
    let layer = &indexed.entries[2];
    assert_eq!(&source[layer.span.start as usize..layer.span.end as usize], br#"{"id":"layer","name":"Layer"}"#);
}
