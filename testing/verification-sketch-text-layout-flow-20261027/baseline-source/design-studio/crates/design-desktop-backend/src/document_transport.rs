//! Private desktop multipart framing. Aggregate admission is independent of the
//! fixed per-frame limit; assembly owns one resource-bounded request at a time.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::io;
pub const CHUNK_BYTES: usize = 1024 * 1024;
pub fn transfer_byte_limit() -> usize {
    crate::document_byte_limit()
        .saturating_mul(2)
        .saturating_add(64 * 1024)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    version: u8,
    id: String,
    total: usize,
    offset: usize,
    data: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    desktop_chunk: Chunk,
}
#[derive(Default)]
pub struct Assembler {
    active: Option<(String, usize, Vec<u8>)>,
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid desktop document transfer",
    )
}
impl Assembler {
    pub fn incomplete(&self) -> bool {
        self.active.is_some()
    }
    pub fn accept(&mut self, frame: Vec<u8>, limit: usize) -> io::Result<Option<Vec<u8>>> {
        if !frame.starts_with(b"{\"desktopChunk\":") {
            if self.active.is_some() {
                return Err(invalid());
            }
            return Ok(Some(frame));
        }
        let envelope: Envelope = serde_json::from_slice(&frame).map_err(|_| invalid())?;
        let c = envelope.desktop_chunk;
        if c.version != 1
            || c.id.is_empty()
            || c.id.len() > 128
            || c.total == 0
            || c.total > limit
            || c.data.len() > CHUNK_BYTES.div_ceil(3) * 4
        {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(&c.data).map_err(|_| invalid())?;
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES || STANDARD.encode(&bytes) != c.data {
            return Err(invalid());
        }
        if self.active.is_none() {
            if c.offset != 0 {
                return Err(invalid());
            }
            self.active = Some((c.id.clone(), c.total, Vec::new()));
        }
        let (id, total, assembled) = self.active.as_mut().unwrap();
        if id != &c.id
            || *total != c.total
            || c.offset != assembled.len()
            || bytes.len() > total.saturating_sub(assembled.len())
        {
            return Err(invalid());
        }
        // Reserve only arriving, admitted bytes. A claimed total alone does not
        // allocate memory; allocation failure leaves the old durable head intact.
        assembled
            .try_reserve(bytes.len())
            .map_err(|_| io::Error::other("Document transfer allocation failed"))?;
        assembled.extend_from_slice(&bytes);
        if assembled.len() != *total {
            return Ok(None);
        }
        Ok(self.active.take().map(|(_, _, bytes)| bytes))
    }
}
pub fn chunk(bytes: &[u8], offset: usize, id: &str) -> io::Result<Vec<u8>> {
    let end = offset.saturating_add(CHUNK_BYTES).min(bytes.len());
    let mut frame = serde_json::to_vec(&Envelope {
        desktop_chunk: Chunk {
            version: 1,
            id: id.into(),
            total: bytes.len(),
            offset,
            data: STANDARD.encode(&bytes[offset..end]),
        },
    })?;
    frame.push(b'\n');
    Ok(frame)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_sequences_and_limits_never_complete() {
        let bytes = vec![b'x'; CHUNK_BYTES + 17];
        for mode in ["duplicate", "interleave", "changed-total", "overflow"] {
            let mut a = Assembler::default();
            assert!(
                a.accept(chunk(&bytes, 0, "one").unwrap(), bytes.len())
                    .unwrap()
                    .is_none()
            );
            let next = match mode {
                "duplicate" => chunk(&bytes, 0, "one").unwrap(),
                "interleave" => chunk(&bytes, CHUNK_BYTES, "two").unwrap(),
                _ => {
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&chunk(&bytes, CHUNK_BYTES, "one").unwrap())
                            .unwrap();
                    value["desktopChunk"][if mode == "overflow" {
                        "offset"
                    } else {
                        "total"
                    }] = serde_json::json!(usize::MAX);
                    serde_json::to_vec(&value).unwrap()
                }
            };
            assert!(a.accept(next, bytes.len()).is_err(), "{mode}");
        }
        let mut a = Assembler::default();
        assert!(
            a.accept(chunk(&bytes, 0, "one").unwrap(), bytes.len())
                .unwrap()
                .is_none()
        );
        assert!(a.accept(b"{\"id\":1}".to_vec(), bytes.len()).is_err());
    }
    #[test]
    fn chunks_roundtrip_and_reject_out_of_order() {
        let bytes = vec![b'x'; CHUNK_BYTES + 17];
        let mut a = Assembler::default();
        assert!(
            a.accept(chunk(&bytes, 0, "one").unwrap(), bytes.len())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            a.accept(chunk(&bytes, CHUNK_BYTES, "one").unwrap(), bytes.len())
                .unwrap(),
            Some(bytes.clone())
        );
        assert!(
            a.accept(chunk(&bytes, 1, "one").unwrap(), bytes.len())
                .is_err()
        );
        let mut a = Assembler::default();
        assert!(
            a.accept(chunk(&bytes, 0, "one").unwrap(), bytes.len() - 1)
                .is_err()
        );
        assert!(!a.incomplete());
    }
}
