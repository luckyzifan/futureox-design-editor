//! Versioned native archive envelope. The exact authenticated FXSCENE payload
//! is a prefix, so builds without rkyv can still read every authored record.
use super::*;
pub(super) const MAGIC: &[u8; 8] = b"FXMAP001";
pub(super) const FOOTER: u64 = 176;
pub(super) const CONTRACT:&[u8]=b"futureox-source-index/1;rkyv=0.8;little-endian;unaligned;relative-pointers=64;policy=2;support=world-support-bits-v1";
#[derive(Clone)]
pub(super) struct Envelope {
    pub base: Descriptor,
    pub offset: u64,
    pub bytes: u64,
    pub hash: [u8; 32],
    pub compatible: bool,
}
pub(super) fn open(
    file: &File,
    expected: &Descriptor,
    cancel: &AtomicBool,
) -> io::Result<Option<Envelope>> {
    check(cancel)?;
    if expected.bytes < FOOTER {
        return Ok(None);
    }
    let mut tail = [0u8; 8];
    RangeReader {
        file,
        position: expected.bytes - 8,
        end: expected.bytes,
    }
    .read_exact(&mut tail)?;
    if &tail != MAGIC {
        return Ok(None);
    }
    let mut bytes = [0u8; FOOTER as usize];
    RangeReader {
        file,
        position: expected.bytes - FOOTER,
        end: expected.bytes,
    }
    .read_exact(&mut bytes)?;
    if &bytes[..8] != MAGIC
        || sha(&bytes) != expected.footer_hash
        || word(&bytes, 96) != expected.nodes
        || bytes[104..136] != identity_hash(&expected.generation, &expected.document_id)
    {
        return Err(invalid("Mapped source envelope identity changed"));
    }
    let base_bytes = word(&bytes, 8);
    let offset = word(&bytes, 48);
    let length = word(&bytes, 56);
    if base_bytes < 8 + FOOTER_BYTES
        || offset < base_bytes
        || sum(sum(offset, length)?, FOOTER)? != expected.bytes
    {
        return Err(invalid("Invalid mapped source envelope ranges"));
    }
    Ok(Some(Envelope {
        base: Descriptor {
            generation: expected.generation.clone(),
            document_id: expected.document_id.clone(),
            nodes: expected.nodes,
            bytes: base_bytes,
            footer_hash: bytes[16..48].try_into().unwrap(),
        },
        offset,
        bytes: length,
        hash: bytes[64..96].try_into().unwrap(),
        compatible: bytes[136..168] == sha(CONTRACT),
    }))
}
#[cfg(feature = "mapped-source-snapshot")]
pub(super) fn footer(
    base: &Descriptor,
    offset: u64,
    bytes: u64,
    hash: [u8; 32],
) -> [u8; FOOTER as usize] {
    let mut out = [0u8; FOOTER as usize];
    out[..8].copy_from_slice(MAGIC);
    for (at, value) in [(8, base.bytes), (48, offset), (56, bytes), (96, base.nodes)] {
        out[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }
    out[16..48].copy_from_slice(&base.footer_hash);
    out[64..96].copy_from_slice(&hash);
    out[104..136].copy_from_slice(&identity_hash(&base.generation, &base.document_id));
    out[136..168].copy_from_slice(&sha(CONTRACT));
    out[168..].copy_from_slice(MAGIC);
    out
}
