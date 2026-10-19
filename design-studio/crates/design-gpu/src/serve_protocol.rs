//! Explicit FRB1 response codec. JSON remains the default; rendering is unchanged.
use base64::Engine as _;
use serde_json::{Value, json};
use std::io::Write;
pub const MAX_METADATA_BYTES: usize = 64 * 1024;
pub const MAX_RGBA_BYTES: usize = 48 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol { Json, Frb1 }
impl Protocol {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value { "json" => Ok(Self::Json), "frb1" => Ok(Self::Frb1), _ => Err("Unknown native render protocol".into()) }
    }
}
#[derive(Clone, Debug)]
pub struct Correlation { pub session: String, pub id: u64 }
impl Correlation {
    pub fn read(message: &Value, previous: Option<&Self>) -> Result<Self, String> {
        let session = message.get("session").and_then(Value::as_str).ok_or("Missing render session")?;
        let id = message.get("id").and_then(Value::as_u64).ok_or("Missing render request id")?;
        if session.is_empty() || session.len() > 64 || !session.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || id == 0 || id > MAX_SAFE_ID { return Err("Invalid render request identity".into()); }
        if previous.is_some_and(|last| last.session != session || id <= last.id) { return Err("Native render request sequence mismatch".into()); }
        Ok(Self { session: session.into(), id })
    }
}
pub struct Reply { pub metadata: Value, pub rgba: Option<Vec<u8>> }
impl Reply {
    pub fn control(metadata: Value) -> Self { Self { metadata, rgba: None } }
    pub fn error(message: impl Into<String>) -> Self { Self::control(json!({"type":"error", "message":message.into()})) }
}
/// Validate metadata before writing anything; write the raw pixels directly.
pub fn emit(out: &mut impl Write, protocol: Protocol, mut reply: Reply, correlation: Option<&Correlation>) -> Result<(), String> {
    if protocol == Protocol::Json {
        if let Some(rgba) = reply.rgba { reply.metadata["rgba"] = json!(base64::engine::general_purpose::STANDARD.encode(rgba)); }
        let line = serde_json::to_string(&reply.metadata).map_err(|e| e.to_string())?;
        return out.write_all(line.as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush()).map_err(|e| e.to_string());
    }
    let correlation = correlation.ok_or("Missing render response identity")?;
    reply.metadata["session"] = json!(correlation.session); reply.metadata["id"] = json!(correlation.id);
    let rgba = reply.rgba.as_deref().unwrap_or_default();
    if reply.metadata.get("type").and_then(Value::as_str) == Some("frame") {
        let width = reply.metadata.get("width").and_then(Value::as_u64).ok_or("Invalid frame width")?;
        let height = reply.metadata.get("height").and_then(Value::as_u64).ok_or("Invalid frame height")?;
        if width == 0 || height == 0 || width.checked_mul(height).and_then(|n| n.checked_mul(4)) != Some(rgba.len() as u64) || rgba.len() > MAX_RGBA_BYTES { return Err("Invalid native render pixel size".into()); }
        reply.metadata["encoding"] = json!("rgba8");
    } else if !rgba.is_empty() { return Err("Unexpected native render payload".into()); }
    let metadata = serde_json::to_vec(&reply.metadata).map_err(|e| e.to_string())?;
    if metadata.is_empty() || metadata.len() > MAX_METADATA_BYTES { return Err("Native render metadata exceeds limit".into()); }
    let mut header = [0_u8; 12]; header[..4].copy_from_slice(b"FRB1");
    header[4..8].copy_from_slice(&(metadata.len() as u32).to_le_bytes()); header[8..12].copy_from_slice(&(rgba.len() as u32).to_le_bytes());
    out.write_all(&header).and_then(|()| out.write_all(&metadata)).and_then(|()| out.write_all(rgba)).and_then(|()| out.flush()).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Reply { Reply { metadata: json!({"type":"frame","width":3,"height":2,"stats":{"render_ms":1.25,"label":"中文"}}), rgba: Some((0..24).map(|n| n * 7).collect()) } }
    fn scope() -> Correlation { Correlation { session:"test-session".into(), id:7 } }
    #[test]
    fn legacy_and_binary_preserve_all_pixels_dimensions_and_stats() {
        let mut old=Vec::new(); emit(&mut old,Protocol::Json,fixture(),None).unwrap(); let legacy: Value=serde_json::from_slice(&old).unwrap();
        let mut new=Vec::new(); emit(&mut new,Protocol::Frb1,fixture(),Some(&scope())).unwrap(); assert_eq!(&new[..4],b"FRB1");
        let metadata_len=u32::from_le_bytes(new[4..8].try_into().unwrap()) as usize; let pixel_len=u32::from_le_bytes(new[8..12].try_into().unwrap()) as usize;
        let meta:Value=serde_json::from_slice(&new[12..12+metadata_len]).unwrap(); assert_eq!(pixel_len,24); assert_eq!(new.len(),12+metadata_len+pixel_len);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(legacy["rgba"].as_str().unwrap()).unwrap(),new[12+metadata_len..]);
        for field in ["width","height","stats","type"] { assert_eq!(legacy[field],meta[field]); }
        assert_eq!(meta["session"],"test-session"); assert_eq!(meta["id"],7); assert_eq!(meta["encoding"],"rgba8"); assert!(meta.get("rgba").is_none());
        assert_eq!(old, format!("{}\n",json!({"type":"frame","width":3,"height":2,"rgba":base64::engine::general_purpose::STANDARD.encode(fixture().rgba.unwrap()),"stats":{"render_ms":1.25,"label":"中文"}})).as_bytes());
    }
    #[test]
    fn controls_and_errors_are_correlated_without_pixels() {
        for reply in [Reply::control(json!({"type":"loaded"})),Reply::control(json!({"type":"stats","stats":{"gpu_memory":{"totalBytes":42}}})),Reply::error("invalid options")] {
            let expected=reply.metadata.clone(); let mut wire=Vec::new();emit(&mut wire,Protocol::Frb1,reply,Some(&scope())).unwrap(); assert_eq!(&wire[8..12],&[0;4]); let meta:Value=serde_json::from_slice(&wire[12..]).unwrap();
            for (field,value) in expected.as_object().unwrap() {assert_eq!(&meta[field],value)} assert_eq!(meta["id"],7);assert_eq!(meta["session"],"test-session");
        }
    }
    #[test]
    fn invalid_lengths_and_identity_fail_before_any_write() {
        for (w,h) in [(0_u64,2_u64),(3,3),(u64::MAX,u64::MAX)] {let mut reply=fixture();reply.metadata["width"]=json!(w);reply.metadata["height"]=json!(h);let mut out=Vec::new();assert!(emit(&mut out,Protocol::Frb1,reply,Some(&scope())).is_err());assert!(out.is_empty())}
        let mut out=Vec::new();assert!(emit(&mut out,Protocol::Frb1,fixture(),None).is_err());assert!(out.is_empty());
        assert!(emit(&mut out,Protocol::Frb1,Reply::error("x".repeat(MAX_METADATA_BYTES)),Some(&scope())).is_err());assert!(out.is_empty());
        let mut reply=Reply::control(json!({"type":"stats"}));reply.rgba=Some(vec![1]);assert!(emit(&mut out,Protocol::Frb1,reply,Some(&scope())).is_err());assert!(out.is_empty());
    }
    #[test]
    fn identities_and_versions_fail_closed() {
        assert_eq!(Protocol::parse("json").unwrap(),Protocol::Json); assert_eq!(Protocol::parse("frb1").unwrap(),Protocol::Frb1);assert!(Protocol::parse("frb2").is_err());
        for message in [json!({}),json!({"session":"s","id":0}),json!({"session":"s","id":MAX_SAFE_ID+1}),json!({"session":"bad token","id":1}),json!({"session":"s","id":-1})] {assert!(Correlation::read(&message,None).is_err())}
        let first=Correlation::read(&json!({"session":"test-session","id":7}),None).unwrap();assert!(Correlation::read(&json!({"session":"test-session","id":8}),Some(&first)).is_ok());
        for msg in [json!({"session":"test-session","id":7}),json!({"session":"other-session","id":8})] {assert!(Correlation::read(&msg,Some(&first)).is_err())}
    }
    #[test]
    fn short_writes_complete_and_broken_pipe_propagates() {
        struct Short { bytes:Vec<u8>, fail_at:usize }
        impl Write for Short {fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{if self.bytes.len()>=self.fail_at{return Err(std::io::ErrorKind::BrokenPipe.into())}let n=bytes.len().min(3).min(self.fail_at-self.bytes.len());self.bytes.extend_from_slice(&bytes[..n]);Ok(n)}fn flush(&mut self)->std::io::Result<()>{Ok(())}}
        let mut expected=Vec::new();emit(&mut expected,Protocol::Frb1,fixture(),Some(&scope())).unwrap();let mut out=Short{bytes:Vec::new(),fail_at:usize::MAX};emit(&mut out,Protocol::Frb1,fixture(),Some(&scope())).unwrap();assert_eq!(out.bytes,expected);
        let mut broken=Short{bytes:Vec::new(),fail_at:17};assert!(emit(&mut broken,Protocol::Frb1,fixture(),Some(&scope())).is_err());assert_eq!(broken.bytes.len(),17);
    }
}
