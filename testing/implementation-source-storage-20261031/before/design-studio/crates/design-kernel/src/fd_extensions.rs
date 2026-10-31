//! Opaque, inert FD metadata. No payload is executable or grants permissions.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FdCompatibility {
    pub contract_version: u32,
    pub required_capabilities: Vec<String>,
    pub extensions: BTreeMap<String, Value>,
}

fn namespace(name: &str) -> bool {
    if name.len() > 128 { return false; }
    let Some((domain, local)) = name.split_once('/') else { return false; };
    let segment = |s: &str| s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    domain.contains('.') && domain.split('.').all(segment)
        && local.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && local.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
impl FdCompatibility {
    pub fn validate(&self) -> Result<(), String> {
        let invalid = |reason: &str| format!("Invalid FD compatibility: {reason}");
        if self.contract_version != 1 { return Err(invalid("unsupported contract version")); }
        if self.required_capabilities.len() > 64 || self.extensions.len() > 64 {
            return Err(invalid("namespace count exceeded"));
        }
        if self.required_capabilities.iter().chain(self.extensions.keys()).any(|s| !namespace(s)) {
            return Err(invalid("invalid namespace"));
        }
        // There are no implemented required extension semantics in contract 1 yet.
        if let Some(name) = self.required_capabilities.first() {
            return Err(invalid(&format!("unsupported required capability: {name}")));
        }
        let mut pending: Vec<(&Value, usize)> = self.extensions.values().map(|v| (v, 1)).collect();
        let mut cost = 128 + 32 + self.extensions.keys().map(|key| key.len()).sum::<usize>();
        let mut count = 1usize; // Includes the extensions map itself, matching JS.
        while let Some((value, depth)) = pending.pop() {
            count += 1;
            if depth > 32 || count > 100_000 { return Err(invalid("structural budget exceeded")); }
            cost += 32 + if let Value::String(s) = value { s.len() } else { 0 };
            if cost > 1024 * 1024 { return Err(invalid("byte budget exceeded")); }
            match value {
                Value::Array(values) => pending.extend(values.iter().map(|v| (v, depth + 1))),
                Value::Object(values) => {
                    if values.keys().any(|k| matches!(k.as_str(), "__proto__" | "constructor" | "prototype")) {
                        return Err(invalid("unsafe object key"));
                    }
                    cost += values.keys().map(|key| key.len()).sum::<usize>();
                    if cost > 1024 * 1024 { return Err(invalid("byte budget exceeded")); }
                    pending.extend(values.values().map(|v| (v, depth + 1)));
                }
                _ => {}
            }
            if pending.len() + count > 100_000 { return Err(invalid("structural budget exceeded")); }
        }
        // Portable resource cost, independent of JSON number spelling.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn envelope(payload: Value) -> FdCompatibility {
        serde_json::from_value(json!({"contractVersion":1,"requiredCapabilities":[],"extensions":{"org.example/metadata":payload}})).unwrap()
    }
    #[test]
    fn optional_payload_roundtrips_without_interpretation() {
        let original = envelope(json!({"array":[null,true,1.25,"文字"],"url":"file:///inert","permission":"never grants access"}));
        original.validate().unwrap();
        let value = serde_json::to_value(&original).unwrap();
        let bytes = crate::binfmt::encode_value(&value);
        let restored: FdCompatibility = serde_json::from_value(crate::binfmt::decode_value(&bytes).unwrap()).unwrap();
        assert_eq!(original, restored);
    }
    #[test]
    fn rejects_unknown_required_and_contract() {
        let mut value = envelope(json!({}));
        value.required_capabilities.push("org.example/render".into());
        assert!(value.validate().unwrap_err().contains("unsupported required"));
        value.required_capabilities.clear(); value.contract_version = 2;
        assert!(value.validate().is_err());
    }
    #[test]
    fn portable_cost_boundary_is_exact() {
        let length = 1024 * 1024 - 128 - 64 - "org.example/metadata".len();
        assert!(envelope(json!("x".repeat(length))).validate().is_ok());
        assert!(envelope(json!("x".repeat(length + 1))).validate().is_err());
        assert!(envelope(json!([1,1.0,1e-7,1e21,"🌈"])).validate().is_ok());
    }
    #[test]
    fn rejects_resource_bombs_and_unsafe_keys() {
        assert!(envelope(json!({"__proto__":{}})).validate().is_err());
        assert!(envelope(json!("x".repeat(1024 * 1024))).validate().is_err());
        assert!(envelope(json!(vec![0;100_000])).validate().is_err());
        let mut deep = Value::Null;
        for _ in 0..32 { deep = json!([deep]); }
        assert!(envelope(deep).validate().is_err());
        let mut bad = envelope(json!({})); bad.extensions.insert("plain".into(), Value::Null);
        assert!(bad.validate().is_err());
        let mut many = envelope(json!({}));
        for i in 0..64 { many.extensions.insert(format!("org.example/item{i}"), Value::Null); }
        assert!(many.validate().is_err());
    }
}
