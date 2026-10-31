//! Preserve archive JSON number lexemes without changing shared serde_json
//! numeric decoding. Only source-format save/inspection uses these fragments.
use super::{Error, Result};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;

pub(super) fn fields(source: &str) -> Result<BTreeMap<String, Box<RawValue>>> {
    serde_json::from_str(source).map_err(|e| Error::Invalid(e.to_string()))
}

/// Reuse unchanged source values exactly, recursively preserving unknown
/// siblings when a supported native command modifies an object or array.
pub(super) fn merge(value: &Value, original: Option<&str>) -> Result<Box<RawValue>> {
    if let Some(original) = original {
        let old: Value =
            serde_json::from_str(original).map_err(|e| Error::Invalid(e.to_string()))?;
        if value == &old {
            return RawValue::from_string(original.to_owned())
                .map_err(|e| Error::Invalid(e.to_string()));
        }
        match value {
            Value::Object(current) if old.is_object() => {
                let source = fields(original)?;
                let merged = current
                    .iter()
                    .map(|(key, value)| Ok((key, merge(value, source.get(key).map(|v| v.get()))?)))
                    .collect::<Result<BTreeMap<_, _>>>()?;
                return raw(&merged);
            }
            Value::Array(current) if old.is_array() => {
                let source: Vec<Box<RawValue>> =
                    serde_json::from_str(original).map_err(|e| Error::Invalid(e.to_string()))?;
                let merged = current
                    .iter()
                    .enumerate()
                    .map(|(index, value)| merge(value, source.get(index).map(|v| v.get())))
                    .collect::<Result<Vec<_>>>()?;
                return raw(&merged);
            }
            _ => {}
        }
    }
    raw(value)
}

pub(super) fn raw(value: &impl serde::Serialize) -> Result<Box<RawValue>> {
    let text = serde_json::to_string(value).map_err(|e| Error::Invalid(e.to_string()))?;
    RawValue::from_string(text).map_err(|e| Error::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editing_known_numbers_keeps_unknown_nested_number_lexemes() {
        let source = r#"{"width":10,"future":{"integer":18446744073709551617,"fraction":0.12345678901234567890123456789},"array":[1.0000000000000000000000001,2]}"#;
        let mut value: Value = serde_json::from_str(source).unwrap();
        value["width"] = serde_json::json!(20.5);
        value["array"][1] = serde_json::json!(3.25);
        let output = merge(&value, Some(source)).unwrap();
        assert!(output.get().contains("18446744073709551617"));
        assert!(output.get().contains("0.12345678901234567890123456789"));
        assert!(output.get().contains("1.0000000000000000000000001"));
        let parsed: Value = serde_json::from_str(output.get()).unwrap();
        assert_eq!(parsed["width"], 20.5);
        assert_eq!(parsed["array"][1], 3.25);
    }
}
