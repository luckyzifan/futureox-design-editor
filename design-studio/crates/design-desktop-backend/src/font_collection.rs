//! Lossless table relocation from TTC/OTC to a single sfnt face. The only table
//! field rewritten is head.checkSumAdjustment, required by the sfnt container.
//! OpenType directory/checksum rules: https://learn.microsoft.com/en-us/typography/opentype/spec/otff
use crate::{BackendError, Result};
use std::ops::Range;

pub const MAX_COLLECTION_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_FACES: u32 = 64;
const MAX_TABLES: usize = 256;

fn invalid(message: &str) -> BackendError {
    BackendError::new("FONT_INVALID", message)
}
fn unsupported(message: &str) -> BackendError {
    BackendError::new("FONT_COLLECTION_UNSUPPORTED", message)
}
fn range(bytes: &[u8], offset: usize, len: usize) -> Result<Range<usize>> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| invalid("Font offset overflow"))?;
    if end > bytes.len() {
        return Err(invalid("Font table points outside the source file"));
    }
    Ok(offset..end)
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    let r = range(bytes, offset, 2)?;
    Ok(u16::from_be_bytes(bytes[r].try_into().unwrap()))
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    let r = range(bytes, offset, 4)?;
    Ok(u32::from_be_bytes(bytes[r].try_into().unwrap()))
}
pub(crate) fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

pub fn face_count(bytes: &[u8]) -> Result<u32> {
    if !bytes.starts_with(b"ttcf") {
        return Ok(1);
    }
    if bytes.len() > MAX_COLLECTION_BYTES {
        return Err(BackendError::new(
            "FONT_TOO_LARGE",
            "Collection exceeds the 128 MiB source budget",
        ));
    }
    let version = u32_at(bytes, 4)?;
    if ![0x0001_0000, 0x0002_0000].contains(&version) {
        return Err(unsupported("Unsupported font collection version"));
    }
    let count = u32_at(bytes, 8)?;
    if !(1..=MAX_FACES).contains(&count) {
        return Err(unsupported(
            "Collection must contain between 1 and 64 faces",
        ));
    }
    let end = 12 + count as usize * 4;
    range(bytes, 12, count as usize * 4)?;
    if version == 0x0002_0000 {
        range(bytes, end, 12)?;
        if [end, end + 4, end + 8]
            .into_iter()
            .any(|offset| u32_at(bytes, offset).is_ok_and(|value| value != 0))
        {
            return Err(unsupported(
                "Signed font collections cannot be extracted without invalidating their signature",
            ));
        }
    }
    Ok(count)
}
struct Table {
    tag: [u8; 4],
    source: Range<usize>,
}
pub struct Plan {
    version: [u8; 4],
    tables: Vec<Table>,
    length: usize,
}
pub fn plan(bytes: &[u8], index: u32) -> Result<Plan> {
    let count = face_count(bytes)?;
    if !bytes.starts_with(b"ttcf") || index >= count {
        return Err(invalid("A valid source collection face index is required"));
    }
    let offset = u32_at(bytes, 12 + index as usize * 4)? as usize;
    let collection_header = 12
        + count as usize * 4
        + if u32_at(bytes, 4)? == 0x0002_0000 {
            12
        } else {
            0
        };
    if offset < collection_header || !offset.is_multiple_of(4) {
        return Err(invalid("Invalid collection face directory offset"));
    }
    let version = u32_at(bytes, offset)?;
    if ![0x0001_0000, 0x4f54_544f, 0x7472_7565].contains(&version) {
        return Err(unsupported("Unsupported sfnt outline format"));
    }
    let count = u16_at(bytes, offset + 4)? as usize;
    if count == 0 || count > MAX_TABLES {
        return Err(invalid("Font exceeds the 256 table budget"));
    }
    range(bytes, offset, 12 + count * 16)?;
    let mut length = 12 + count * 16;
    let mut tables = Vec::with_capacity(count);
    let mut has_head = false;
    for i in 0..count {
        let record = offset + 12 + i * 16;
        let tag: [u8; 4] = bytes[record..record + 4].try_into().unwrap();
        if tag == *b"DSIG" {
            return Err(unsupported(
                "Signed font faces cannot be extracted without invalidating their signature",
            ));
        }
        let source_offset = u32_at(bytes, record + 8)? as usize;
        let source_length = u32_at(bytes, record + 12)? as usize;
        if !source_offset.is_multiple_of(4) || source_offset < collection_header {
            return Err(invalid("Invalid font table alignment or header overlap"));
        }
        let source = range(bytes, source_offset, source_length)?;
        if source.start < offset + 12 + count * 16 && offset < source.end {
            return Err(invalid("Font table overlaps its face directory"));
        }
        if tag == *b"head" {
            if source_length < 54 {
                return Err(invalid("Font head table is truncated"));
            }
            has_head = true;
        }
        length = length
            .checked_add(
                source_length
                    .checked_add(3)
                    .ok_or_else(|| invalid("Font table length overflow"))?
                    & !3,
            )
            .filter(|length| *length <= super::fonts::MAX_FONT_BYTES)
            .ok_or_else(|| {
                BackendError::new(
                    "FONT_TOO_LARGE",
                    "Extracted font exceeds the 20 MiB resource budget",
                )
            })?;
        tables.push(Table { tag, source });
    }
    tables.sort_by_key(|table| table.tag);
    if !has_head || tables.windows(2).any(|pair| pair[0].tag == pair[1].tag) {
        return Err(invalid("Font requires one head and unique table tags"));
    }
    Ok(Plan {
        version: version.to_be_bytes(),
        tables,
        length,
    })
}
pub fn extract(bytes: &[u8], index: u32) -> Result<Vec<u8>> {
    let plan = plan(bytes, index)?;
    let count = plan.tables.len();
    let mut output = vec![0u8; plan.length];
    output[..4].copy_from_slice(&plan.version);
    output[4..6].copy_from_slice(&(count as u16).to_be_bytes());
    let selector = (usize::BITS - 1 - count.leading_zeros()) as u16;
    let search_range = (1u16 << selector) * 16;
    output[6..8].copy_from_slice(&search_range.to_be_bytes());
    output[8..10].copy_from_slice(&selector.to_be_bytes());
    output[10..12].copy_from_slice(&((count as u16) * 16 - search_range).to_be_bytes());
    let mut destination = 12 + count * 16;
    let mut head = None;
    for (i, table) in plan.tables.iter().enumerate() {
        let len = table.source.len();
        output[destination..destination + len].copy_from_slice(&bytes[table.source.clone()]);
        if table.tag == *b"head" {
            output[destination + 8..destination + 12].fill(0);
            head = Some(destination);
        }
        let sum = checksum(&output[destination..destination + len]);
        let record = 12 + i * 16;
        output[record..record + 4].copy_from_slice(&table.tag);
        output[record + 4..record + 8].copy_from_slice(&sum.to_be_bytes());
        output[record + 8..record + 12].copy_from_slice(&(destination as u32).to_be_bytes());
        output[record + 12..record + 16].copy_from_slice(&(len as u32).to_be_bytes());
        destination += (len + 3) & !3;
    }
    let adjustment = 0xb1b0_afbau32.wrapping_sub(checksum(&output));
    let head = head.ok_or_else(|| invalid("Missing font head"))?;
    output[head + 8..head + 12].copy_from_slice(&adjustment.to_be_bytes());
    ttf_parser::Face::parse(&output, 0).map_err(|_| invalid("Extracted font failed validation"))?;
    Ok(output)
}

#[cfg(test)]
pub(crate) fn two_face_fixture() -> Vec<u8> {
    let source = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
    )
    .unwrap();
    let count = u16_at(&source, 4).unwrap() as usize;
    let directory_length = 12 + count * 16;
    let mut collection = vec![0u8; 20];
    collection[..4].copy_from_slice(b"ttcf");
    collection[4..8].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    collection[8..12].copy_from_slice(&2u32.to_be_bytes());
    collection[12..16].copy_from_slice(&20u32.to_be_bytes());
    collection.extend_from_slice(&source);
    // Collection head adjustment is unused. Zeroing it also makes its existing
    // directory checksum (calculated with zero adjustment) correct in the TTC.
    for i in 0..count {
        let record = 12 + i * 16;
        if &source[record..record + 4] == b"head" {
            let offset = u32_at(&source, record + 8).unwrap() as usize + 20;
            collection[offset + 8..offset + 12].fill(0);
        }
    }
    collection.resize((collection.len() + 3) & !3, 0);
    let second = collection.len();
    collection[16..20].copy_from_slice(&(second as u32).to_be_bytes());
    collection.extend_from_slice(&source[..directory_length]);
    for dir in [20, second] {
        for i in 0..count {
            let source_offset = u32_at(&source, 12 + i * 16 + 8).unwrap() + 20;
            collection[dir + 12 + i * 16 + 8..dir + 12 + i * 16 + 12]
                .copy_from_slice(&source_offset.to_be_bytes());
        }
    }
    // Give face 1 independent naming and horizontal metrics, while sharing the
    // other tables. This catches accidentally importing collection face zero.
    let glyph = ttf_parser::Face::parse(&source, 0)
        .unwrap()
        .glyph_index('A')
        .unwrap()
        .0 as usize;
    for i in 0..count {
        let record = 12 + i * 16;
        let tag = &source[record..record + 4];
        if tag != b"name" && tag != b"hmtx" {
            continue;
        }
        let offset = u32_at(&source, record + 8).unwrap() as usize;
        let len = u32_at(&source, record + 12).unwrap() as usize;
        let mut table = source[offset..offset + len].to_vec();
        if tag == b"name" {
            for n in 0..table.len().saturating_sub(7) {
                if &table[n..n + 8] == b"\0N\0o\0t\0o" {
                    table[n + 1] = b'M';
                }
            }
        } else {
            let advance = u16_at(&table, glyph * 4).unwrap() + 7;
            table[glyph * 4..glyph * 4 + 2].copy_from_slice(&advance.to_be_bytes());
        }
        let offset = collection.len();
        collection.extend_from_slice(&table);
        collection.resize((collection.len() + 3) & !3, 0);
        collection[second + record + 4..second + record + 8]
            .copy_from_slice(&checksum(&table).to_be_bytes());
        collection[second + record + 8..second + record + 12]
            .copy_from_slice(&(offset as u32).to_be_bytes());
    }
    collection
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn two_faces_keep_all_table_data_metrics_and_load_in_existing_kernel() {
        let collection = two_face_fixture();
        let mut widths = Vec::new();
        for index in 0..2 {
            let original = ttf_parser::Face::parse(&collection, index).unwrap();
            let extracted = extract(&collection, index).unwrap();
            assert_eq!(checksum(&extracted), 0xb1b0_afba);
            let face = ttf_parser::Face::parse(&extracted, 0).unwrap();
            assert_eq!(original.number_of_glyphs(), face.number_of_glyphs());
            assert_eq!(original.units_per_em(), face.units_per_em());
            for ch in ['A', '中', '文', 'a'] {
                assert_eq!(original.glyph_index(ch), face.glyph_index(ch));
                let id = face.glyph_index(ch).unwrap();
                assert_eq!(original.glyph_hor_advance(id), face.glyph_hor_advance(id));
                assert_eq!(original.glyph_bounding_box(id), face.glyph_bounding_box(id));
            }
            widths.push(
                face.glyph_hor_advance(face.glyph_index('A').unwrap())
                    .unwrap(),
            );
            for table in plan(&collection, index).unwrap().tables {
                let output = face
                    .raw_face()
                    .table(ttf_parser::Tag::from_bytes(&table.tag))
                    .unwrap();
                let source = &collection[table.source];
                if table.tag == *b"head" {
                    assert_eq!(&source[..8], &output[..8]);
                    assert_eq!(&source[12..], &output[12..]);
                } else {
                    assert_eq!(source, output, "table {:?}", table.tag);
                }
            }
            let mut engine = futureox_design_kernel::renderer::Engine::new();
            engine.load_font(&extracted).unwrap();
        }
        assert_eq!(widths[1], widths[0] + 7);
    }
    #[test]
    fn malformed_offsets_counts_and_signatures_are_rejected() {
        let original = two_face_fixture();
        let mut bad = original.clone();
        bad[12..16].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(extract(&bad, 0).is_err());
        let mut bad = original.clone();
        bad[8..12].copy_from_slice(&65u32.to_be_bytes());
        assert!(extract(&bad, 0).is_err());
        let mut bad = original.clone();
        bad[20 + 12 + 8..20 + 12 + 12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(extract(&bad, 0).is_err());
        let mut bad = original.clone();
        bad[20 + 12..20 + 16].copy_from_slice(b"DSIG");
        assert_eq!(
            extract(&bad, 0).unwrap_err().code,
            "FONT_COLLECTION_UNSUPPORTED"
        );
        let mut bad = original.clone();
        bad[4..8].copy_from_slice(&0x0002_0000u32.to_be_bytes());
        bad[20..24].copy_from_slice(b"DSIG");
        assert_eq!(
            extract(&bad, 0).unwrap_err().code,
            "FONT_COLLECTION_UNSUPPORTED"
        );
        assert!(extract(&original, 2).is_err());
    }
}
