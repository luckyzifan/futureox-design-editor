//! Render-only face for missing Sketch fonts.
//!
//! Sketch asks CoreText for the system UI font and then
//! `CTFontCreateForString`. `CTFontCreateWithName` on the missing PostScript
//! name returns Times, which has no Chinese glyphs. This module never embeds
//! the resolved face: document bytes, FD, and Sketch font references keep the
//! source name. Linux and the web leave the resolver unset and keep the
//! packaged Noto metric fallback.

use crate::font::{TextRun, TextStyle};
use crate::scene::{Document, Node};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const TEXT_FACE: &str = "system-cascade-text";
pub(crate) const DISPLAY_FACE: &str = "system-cascade-display";
pub const MAX_CASCADE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CHARS: usize = 4096;

pub fn is_render_only_face(id: &str) -> bool {
    id == TEXT_FACE || id == DISPLAY_FACE
}

/// Host callback. `text` is the unique characters that need a face at `size`
/// (points). `Ok(None)` keeps the packaged fallback for that optical class.
pub type SystemCascadeResolver = fn(&str, f64) -> Result<Option<Vec<u8>>, String>;

static PRESENT: AtomicBool = AtomicBool::new(false);
static RESOLVER: Mutex<Option<SystemCascadeResolver>> = Mutex::new(None);

pub fn set_system_cascade_resolver(resolver: SystemCascadeResolver) {
    *RESOLVER.lock().expect("system cascade resolver") = Some(resolver);
    PRESENT.store(true, Ordering::Release);
}

pub(crate) fn current_resolver() -> Option<SystemCascadeResolver> {
    if !PRESENT.load(Ordering::Acquire) {
        return None;
    }
    *RESOLVER.lock().expect("system cascade resolver")
}

/// macOS registers CoreText. Every other target keeps the packaged fallback.
pub fn register_host_system_cascade() {
    #[cfg(all(target_os = "macos", not(target_arch = "wasm32")))]
    set_system_cascade_resolver(|text, size| {
        let Some(located) = futureox_coretext_fallback::locate(text, size)
            .ok()
            .flatten()
        else {
            return Ok(None);
        };
        if futureox_coretext_fallback::is_coretext_name_lookup_fallback(&located.postscript) {
            return Ok(None);
        }
        match prepare_system_cascade_face(&located.bytes, located.index, text) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(_) => Ok(None),
        }
    });
}

pub(crate) struct CascadeRequest {
    pub text: String,
    pub text_size: f64,
    pub display: String,
    pub display_size: f64,
    pub signature: [u8; 32],
}

pub(crate) fn request_for(doc: &Document) -> CascadeRequest {
    let mut text_chars = BTreeSet::new();
    let mut display_chars = BTreeSet::new();
    let mut text_size = 0f64;
    let mut display_size = 0f64;
    for node in doc.nodes.values() {
        collect_node(
            node,
            &mut text_chars,
            &mut text_size,
            &mut display_chars,
            &mut display_size,
        );
    }
    let text = chars_to_string(&text_chars);
    let display = chars_to_string(&display_chars);
    let mut hasher = Sha256::new();
    hasher.update(b"v1");
    hasher.update(&text_size.to_le_bytes());
    hasher.update(text.as_bytes());
    hasher.update(&[0]);
    hasher.update(&display_size.to_le_bytes());
    hasher.update(display.as_bytes());
    CascadeRequest {
        text,
        text_size,
        display,
        display_size,
        signature: hasher.finalize().into(),
    }
}

fn chars_to_string(chars: &BTreeSet<char>) -> String {
    chars.iter().collect()
}

fn sketch_metric_face(style: &TextStyle) -> bool {
    style.writing_mode != "vertical"
        && matches!(
            style.line_box_baseline.as_str(),
            "sketch-font-leading" | "sketch-fixed-advance"
        )
}

fn collect_node(
    node: &Node,
    text_chars: &mut BTreeSet<char>,
    text_size: &mut f64,
    display_chars: &mut BTreeSet<char>,
    display_size: &mut f64,
) {
    if node.kind != "text" || node.text.is_empty() {
        return;
    }
    let Some(style) = node.text_style.as_ref() else {
        return;
    };
    if !sketch_metric_face(style) {
        return;
    }
    let mut utf16 = 0usize;
    for ch in node.text.chars() {
        let run = covering(&node.text_runs, utf16);
        utf16 += ch.len_utf16();
        if ch.is_control() {
            continue;
        }
        let font = run
            .and_then(|run| run.font_id.as_deref())
            .unwrap_or(style.font_id.as_str());
        if font != "default" {
            continue;
        }
        let size = run.and_then(|run| run.font_size).unwrap_or(node.font_size);
        if !size.is_finite() || size <= 0. {
            continue;
        }
        if size >= 20. {
            if display_chars.len() < MAX_CHARS {
                display_chars.insert(ch);
            }
            if size > *display_size {
                *display_size = size;
            }
        } else {
            if text_chars.len() < MAX_CHARS {
                text_chars.insert(ch);
            }
            if size > *text_size {
                *text_size = size;
            }
        }
    }
}

fn covering(runs: &[TextRun], utf16: usize) -> Option<&TextRun> {
    runs.get(
        runs.partition_point(|run| run.start <= utf16)
            .saturating_sub(1),
    )
    .filter(|run| run.start <= utf16 && utf16 < run.end)
}

/// One sfnt face that covers `text`. Collections and faces over 8 MiB are
/// reduced to the requested characters. The result is render-only.
pub fn prepare_system_cascade_face(
    bytes: &[u8],
    index: u32,
    text: &str,
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_SOURCE_BYTES || index > 64 {
        return Err("System cascade source is too large".into());
    }
    let face =
        ttf_parser::Face::parse(bytes, index).map_err(|_| "System cascade face is unreadable")?;
    let chars = cascade_chars(text);
    if chars.is_empty() {
        return Err("System cascade text is empty".into());
    }
    if chars.iter().any(|ch| face.glyph_index(*ch).is_none()) {
        return Err("System cascade face does not cover the text".into());
    }
    let collection = ttf_parser::fonts_in_collection(bytes).is_some();
    if !collection && index == 0 && bytes.len() <= MAX_CASCADE_BYTES {
        return Ok(bytes.to_vec());
    }
    subset_face(bytes, index, &chars)
}

fn cascade_chars(text: &str) -> Vec<char> {
    let mut chars = BTreeSet::new();
    for ch in text.chars() {
        if ch.is_control() {
            continue;
        }
        if chars.len() >= MAX_CHARS {
            break;
        }
        chars.insert(ch);
    }
    chars.into_iter().collect()
}

fn subset_face(bytes: &[u8], index: u32, chars: &[char]) -> Result<Vec<u8>, String> {
    let face =
        ttf_parser::Face::parse(bytes, index).map_err(|_| "System cascade face is unreadable")?;
    let directory = face_directory_offset(bytes, index)?;
    let glyf =
        raw_table(bytes, directory, b"glyf").ok_or("System cascade face has no glyf table")?;
    let loca =
        raw_table(bytes, directory, b"loca").ok_or("System cascade face has no loca table")?;
    let head =
        raw_table(bytes, directory, b"head").ok_or("System cascade face has no head table")?;
    if head.len() < 54 {
        return Err("System cascade head table is truncated".into());
    }
    let loca_format = u16::from_be_bytes([head[50], head[51]]);
    let glyph_count = loca_glyph_count(loca, loca_format)?;
    let mut needed = BTreeSet::new();
    needed.insert(0u16);
    for ch in chars {
        let id = face.glyph_index(*ch).ok_or("Missing cascade glyph")?.0;
        if usize::from(id) >= glyph_count {
            return Err("Cascade glyph id is outside loca".into());
        }
        needed.insert(id);
    }
    let mut pending: Vec<u16> = needed.iter().copied().collect();
    while let Some(id) = pending.pop() {
        let data = glyph_slice(glyf, loca, loca_format, id, glyph_count)?;
        for component in composite_components(data)? {
            if usize::from(component) >= glyph_count {
                return Err("Composite glyph points outside the face".into());
            }
            if needed.insert(component) {
                pending.push(component);
            }
        }
    }
    let order: Vec<u16> = needed.into_iter().collect();
    let mut map = BTreeMap::new();
    for (new_id, old_id) in order.iter().enumerate() {
        map.insert(
            *old_id,
            u16::try_from(new_id).map_err(|_| "Too many cascade glyphs")?,
        );
    }
    let mut glyf_out = Vec::new();
    let mut offsets = Vec::with_capacity(order.len() + 1);
    let mut x_min = i16::MAX;
    let mut y_min = i16::MAX;
    let mut x_max = i16::MIN;
    let mut y_max = i16::MIN;
    let mut advance_max = 0u16;
    let mut min_lsb = i16::MAX;
    let mut min_rsb = i16::MAX;
    let mut max_extent = i16::MIN;
    let mut hmtx = Vec::with_capacity(order.len() * 4);
    for old_id in &order {
        offsets.push(u32::try_from(glyf_out.len()).map_err(|_| "Cascade glyf is too large")?);
        let mut data = glyph_slice(glyf, loca, loca_format, *old_id, glyph_count)?.to_vec();
        if !data.is_empty() {
            rewrite_components(&mut data, &map)?;
            glyf_out.extend_from_slice(&data);
            if glyf_out.len() % 2 == 1 {
                glyf_out.push(0);
            }
        }
        let id = ttf_parser::GlyphId(*old_id);
        let advance = face.glyph_hor_advance(id).unwrap_or(0);
        let lsb = face.glyph_hor_side_bearing(id).unwrap_or(0);
        advance_max = advance_max.max(advance);
        min_lsb = min_lsb.min(lsb);
        hmtx.extend_from_slice(&advance.to_be_bytes());
        hmtx.extend_from_slice(&lsb.to_be_bytes());
        if let Some(bounds) = face.glyph_bounding_box(id) {
            x_min = x_min.min(bounds.x_min);
            y_min = y_min.min(bounds.y_min);
            x_max = x_max.max(bounds.x_max);
            y_max = y_max.max(bounds.y_max);
            let extent = bounds.x_max.saturating_add(lsb);
            max_extent = max_extent.max(extent);
            let rsb = i32::from(advance) - i32::from(lsb) - i32::from(bounds.width());
            min_rsb = min_rsb.min(i16::try_from(rsb).unwrap_or(i16::MIN));
        }
    }
    offsets.push(u32::try_from(glyf_out.len()).map_err(|_| "Cascade glyf is too large")?);
    if x_min == i16::MAX {
        x_min = 0;
        y_min = 0;
        x_max = 0;
        y_max = 0;
        min_lsb = 0;
        min_rsb = 0;
        max_extent = 0;
    }
    let upem = face.units_per_em();
    let loca_out = {
        let mut out = Vec::with_capacity(offsets.len() * 4);
        for offset in &offsets {
            out.extend_from_slice(&offset.to_be_bytes());
        }
        out
    };
    let cmap = cmap_format12(chars, &face, &map)?;
    let name = name_table(&face)?;
    let head = head_table(upem, x_min, y_min, x_max, y_max);
    let hhea = hhea_table(
        face.ascender(),
        face.descender(),
        face.line_gap(),
        advance_max,
        min_lsb,
        min_rsb,
        max_extent,
        u16::try_from(order.len()).unwrap(),
    );
    let maxp = maxp_table(u16::try_from(order.len()).unwrap());
    let post = post_table();
    let mut tables = vec![
        table(b"cmap", cmap),
        table(b"glyf", glyf_out),
        table(b"head", head),
        table(b"hhea", hhea),
        table(b"hmtx", hmtx),
        table(b"loca", loca_out),
        table(b"maxp", maxp),
        table(b"name", name),
        table(b"post", post),
    ];
    if let Some(os2) = raw_table(bytes, directory, b"OS/2") {
        if os2.len() <= 256 {
            tables.push(table(b"OS/2", os2.to_vec()));
        }
    }
    let bytes = assemble(tables)?;
    if bytes.len() > MAX_CASCADE_BYTES {
        return Err("System cascade subset exceeds 8 MiB".into());
    }
    ttf_parser::Face::parse(&bytes, 0).map_err(|_| "System cascade subset is unreadable")?;
    Ok(bytes)
}

struct BuiltTable {
    tag: [u8; 4],
    data: Vec<u8>,
}

fn table(tag: &[u8; 4], data: Vec<u8>) -> BuiltTable {
    BuiltTable { tag: *tag, data }
}

fn assemble(mut tables: Vec<BuiltTable>) -> Result<Vec<u8>, String> {
    tables.sort_by_key(|table| table.tag);
    let mut stored = Vec::with_capacity(tables.len());
    for table in &mut tables {
        let length = table.data.len();
        while table.data.len() % 4 != 0 {
            table.data.push(0);
        }
        stored.push((
            table.tag,
            checksum(&table.data),
            length,
            std::mem::take(&mut table.data),
        ));
    }
    let count = u16::try_from(stored.len()).map_err(|_| "Too many cascade tables")?;
    let (search, entry, shift) = directory_selector(count);
    let mut offset = 12 + stored.len() * 16;
    let mut font = Vec::new();
    font.extend_from_slice(&0x00010000u32.to_be_bytes());
    font.extend_from_slice(&count.to_be_bytes());
    font.extend_from_slice(&search.to_be_bytes());
    font.extend_from_slice(&entry.to_be_bytes());
    font.extend_from_slice(&shift.to_be_bytes());
    for (tag, sum, length, _) in &stored {
        font.extend_from_slice(tag);
        font.extend_from_slice(&sum.to_be_bytes());
        font.extend_from_slice(&u32::try_from(offset).unwrap().to_be_bytes());
        font.extend_from_slice(&u32::try_from(*length).unwrap().to_be_bytes());
        offset += length + (4 - length % 4) % 4;
    }
    for (_, _, _, data) in &stored {
        font.extend_from_slice(data);
    }
    let head_at = font_table_offset(&font, b"head").ok_or("Cascade head table missing")?;
    if head_at + 12 > font.len() {
        return Err("Cascade head checksum field is missing".into());
    }
    // Directory checksum already covers checkSumAdjustment == 0. The file
    // checksum below is the only field that changes.
    font[head_at + 8..head_at + 12].fill(0);
    let adjustment = 0xB1B0_AFBAu32.wrapping_sub(checksum(&font));
    font[head_at + 8..head_at + 12].copy_from_slice(&adjustment.to_be_bytes());
    Ok(font)
}

fn font_table_offset(font: &[u8], tag: &[u8; 4]) -> Option<usize> {
    let count = u16::from_be_bytes([font[4], font[5]]) as usize;
    for index in 0..count {
        let record = 12 + index * 16;
        if &font[record..record + 4] == tag {
            return Some(
                u32::from_be_bytes(font[record + 8..record + 12].try_into().unwrap()) as usize,
            );
        }
    }
    None
}

fn directory_selector(count: u16) -> (u16, u16, u16) {
    let mut search = 1u16;
    let mut entry = 0u16;
    while search.saturating_mul(2) <= count {
        search = search.saturating_mul(2);
        entry += 1;
    }
    (
        search.saturating_mul(16),
        entry,
        count
            .saturating_mul(16)
            .saturating_sub(search.saturating_mul(16)),
    )
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn face_directory_offset(bytes: &[u8], index: u32) -> Result<usize, String> {
    if bytes.starts_with(b"ttcf") {
        if bytes.len() < 12 {
            return Err("Truncated font collection".into());
        }
        let count = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
        if count == 0 || count > 64 || index >= count {
            return Err("Font collection face index is outside the cascade budget".into());
        }
        let at = 12 + index as usize * 4;
        if at + 4 > bytes.len() {
            return Err("Truncated font collection".into());
        }
        let offset = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        if offset >= bytes.len() {
            return Err("Font collection face offset is outside the file".into());
        }
        Ok(offset)
    } else if index == 0 {
        Ok(0)
    } else {
        Err("Font face index requires a collection".into())
    }
}

fn raw_table<'a>(bytes: &'a [u8], directory: usize, tag: &[u8; 4]) -> Option<&'a [u8]> {
    if directory + 12 > bytes.len() {
        return None;
    }
    let count =
        u16::from_be_bytes(bytes.get(directory + 4..directory + 6)?.try_into().ok()?) as usize;
    for index in 0..count {
        let record = directory + 12 + index * 16;
        let bytes_at = bytes.get(record..record + 16)?;
        if &bytes_at[0..4] != tag {
            continue;
        }
        let offset = u32::from_be_bytes(bytes_at[8..12].try_into().ok()?) as usize;
        let length = u32::from_be_bytes(bytes_at[12..16].try_into().ok()?) as usize;
        return bytes.get(offset..offset.checked_add(length)?);
    }
    None
}

fn loca_glyph_count(loca: &[u8], format: u16) -> Result<usize, String> {
    let width = if format == 0 {
        2
    } else if format == 1 {
        4
    } else {
        return Err("Unknown loca format".into());
    };
    if loca.len() < width * 2 || loca.len() % width != 0 {
        return Err("Truncated loca table".into());
    }
    Ok(loca.len() / width - 1)
}

fn loca_offset(loca: &[u8], format: u16, index: usize) -> Result<usize, String> {
    if format == 0 {
        let at = index * 2;
        let raw = u16::from_be_bytes(loca.get(at..at + 2).ok_or("loca")?.try_into().unwrap());
        Ok(usize::from(raw) * 2)
    } else {
        let at = index * 4;
        Ok(u32::from_be_bytes(loca.get(at..at + 4).ok_or("loca")?.try_into().unwrap()) as usize)
    }
}

fn glyph_slice<'a>(
    glyf: &'a [u8],
    loca: &[u8],
    format: u16,
    id: u16,
    count: usize,
) -> Result<&'a [u8], String> {
    let index = usize::from(id);
    if index >= count {
        return Err("Glyph id outside loca".into());
    }
    let start = loca_offset(loca, format, index)?;
    let end = loca_offset(loca, format, index + 1)?;
    if end < start || end > glyf.len() {
        return Err("glyf range is outside the table".into());
    }
    Ok(&glyf[start..end])
}

fn composite_components(glyph: &[u8]) -> Result<Vec<u16>, String> {
    if glyph.len() < 10 {
        return Ok(Vec::new());
    }
    let contours = i16::from_be_bytes([glyph[0], glyph[1]]);
    if contours >= 0 {
        return Ok(Vec::new());
    }
    let mut index = 10usize;
    let mut ids = Vec::new();
    loop {
        if index + 4 > glyph.len() {
            return Err("Truncated composite glyph".into());
        }
        let flags = u16::from_be_bytes([glyph[index], glyph[index + 1]]);
        ids.push(u16::from_be_bytes([glyph[index + 2], glyph[index + 3]]));
        index += 4;
        index += if flags & 0x0001 != 0 { 4 } else { 2 };
        if flags & 0x0080 != 0 {
            index += 8;
        } else if flags & 0x0040 != 0 {
            index += 4;
        } else if flags & 0x0008 != 0 {
            index += 2;
        }
        if flags & 0x0020 == 0 {
            break;
        }
    }
    Ok(ids)
}

fn rewrite_components(glyph: &mut [u8], map: &BTreeMap<u16, u16>) -> Result<(), String> {
    if glyph.len() < 10 {
        return Ok(());
    }
    let contours = i16::from_be_bytes([glyph[0], glyph[1]]);
    if contours >= 0 {
        return Ok(());
    }
    let mut index = 10usize;
    loop {
        if index + 4 > glyph.len() {
            return Err("Truncated composite glyph".into());
        }
        let flags = u16::from_be_bytes([glyph[index], glyph[index + 1]]);
        let old = u16::from_be_bytes([glyph[index + 2], glyph[index + 3]]);
        let new = *map
            .get(&old)
            .ok_or("Composite component was not included in the cascade subset")?;
        glyph[index + 2..index + 4].copy_from_slice(&new.to_be_bytes());
        index += 4;
        index += if flags & 0x0001 != 0 { 4 } else { 2 };
        if flags & 0x0080 != 0 {
            index += 8;
        } else if flags & 0x0040 != 0 {
            index += 4;
        } else if flags & 0x0008 != 0 {
            index += 2;
        }
        if flags & 0x0020 == 0 {
            break;
        }
    }
    Ok(())
}

fn cmap_format12(
    chars: &[char],
    face: &ttf_parser::Face<'_>,
    map: &BTreeMap<u16, u16>,
) -> Result<Vec<u8>, String> {
    let mut groups = Vec::new();
    for ch in chars {
        let old = face.glyph_index(*ch).ok_or("Missing cascade glyph")?.0;
        let new = *map.get(&old).ok_or("Cascade cmap glyph was dropped")?;
        groups.push((*ch as u32, new));
    }
    let num = u32::try_from(groups.len()).unwrap();
    let length = 16 + groups.len() * 12;
    let mut sub = Vec::with_capacity(length);
    sub.extend_from_slice(&12u16.to_be_bytes());
    sub.extend_from_slice(&0u16.to_be_bytes());
    sub.extend_from_slice(&u32::try_from(length).unwrap().to_be_bytes());
    sub.extend_from_slice(&0u32.to_be_bytes());
    sub.extend_from_slice(&num.to_be_bytes());
    for (code, glyph) in groups {
        sub.extend_from_slice(&code.to_be_bytes());
        sub.extend_from_slice(&code.to_be_bytes());
        sub.extend_from_slice(&u32::from(glyph).to_be_bytes());
    }
    let mut cmap = Vec::new();
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&2u16.to_be_bytes());
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&4u16.to_be_bytes());
    cmap.extend_from_slice(&20u32.to_be_bytes());
    cmap.extend_from_slice(&3u16.to_be_bytes());
    cmap.extend_from_slice(&10u16.to_be_bytes());
    cmap.extend_from_slice(&20u32.to_be_bytes());
    cmap.extend_from_slice(&sub);
    Ok(cmap)
}

fn name_table(face: &ttf_parser::Face<'_>) -> Result<Vec<u8>, String> {
    let postscript = face_name(face, ttf_parser::name_id::POST_SCRIPT_NAME)
        .unwrap_or_else(|| "SystemCascade".into());
    let family = face_name(face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
        .or_else(|| face_name(face, ttf_parser::name_id::FAMILY))
        .unwrap_or_else(|| "System Cascade".into());
    let records = [
        (1u16, family.as_str()),
        (2, "Regular"),
        (4, &format!("{family} Regular")),
        (6, postscript.as_str()),
    ];
    let mut strings = Vec::new();
    let mut encoded = Vec::new();
    for (id, value) in records {
        let utf16: Vec<u8> = value
            .encode_utf16()
            .flat_map(|unit| unit.to_be_bytes())
            .collect();
        encoded.push((id, strings.len(), utf16.len()));
        strings.extend_from_slice(&utf16);
    }
    let count = u16::try_from(encoded.len()).unwrap();
    let storage = 6 + usize::from(count) * 12;
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&count.to_be_bytes());
    out.extend_from_slice(&u16::try_from(storage).unwrap().to_be_bytes());
    for (id, start, len) in encoded {
        out.extend_from_slice(&3u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&0x0409u16.to_be_bytes());
        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&u16::try_from(len).unwrap().to_be_bytes());
        out.extend_from_slice(&u16::try_from(start).unwrap().to_be_bytes());
    }
    out.extend_from_slice(&strings);
    Ok(out)
}

fn face_name(face: &ttf_parser::Face<'_>, id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .find(|name| name.name_id == id)
        .and_then(|name| name.to_string())
        .filter(|name| !name.is_empty() && name.len() <= 127)
}

fn head_table(upem: u16, x_min: i16, y_min: i16, x_max: i16, y_max: i16) -> Vec<u8> {
    let mut out = vec![0u8; 54];
    out[0..2].copy_from_slice(&1u16.to_be_bytes());
    out[4..8].copy_from_slice(&0x00010000u32.to_be_bytes());
    out[12..16].copy_from_slice(&0x5F0F3CF5u32.to_be_bytes());
    out[16..18].copy_from_slice(&0x000Bu16.to_be_bytes());
    out[18..20].copy_from_slice(&upem.to_be_bytes());
    put_i16(&mut out, 36, x_min);
    put_i16(&mut out, 38, y_min);
    put_i16(&mut out, 40, x_max);
    put_i16(&mut out, 42, y_max);
    out[46..48].copy_from_slice(&8u16.to_be_bytes());
    put_i16(&mut out, 48, 2);
    put_i16(&mut out, 50, 1);
    out
}

fn hhea_table(
    ascender: i16,
    descender: i16,
    line_gap: i16,
    advance_max: u16,
    min_lsb: i16,
    min_rsb: i16,
    max_extent: i16,
    glyphs: u16,
) -> Vec<u8> {
    let mut out = vec![0u8; 36];
    out[0..2].copy_from_slice(&1u16.to_be_bytes());
    put_i16(&mut out, 4, ascender);
    put_i16(&mut out, 6, descender);
    put_i16(&mut out, 8, line_gap);
    out[10..12].copy_from_slice(&advance_max.to_be_bytes());
    put_i16(&mut out, 12, min_lsb);
    put_i16(&mut out, 14, min_rsb);
    put_i16(&mut out, 16, max_extent);
    put_i16(&mut out, 18, 1);
    out[34..36].copy_from_slice(&glyphs.to_be_bytes());
    out
}

fn maxp_table(glyphs: u16) -> Vec<u8> {
    let mut out = vec![0u8; 32];
    out[0..4].copy_from_slice(&0x00010000u32.to_be_bytes());
    out[4..6].copy_from_slice(&glyphs.to_be_bytes());
    out[6..8].copy_from_slice(&64u16.to_be_bytes());
    out[8..10].copy_from_slice(&8u16.to_be_bytes());
    out[10..12].copy_from_slice(&64u16.to_be_bytes());
    out[12..14].copy_from_slice(&8u16.to_be_bytes());
    out[14..16].copy_from_slice(&2u16.to_be_bytes());
    out[26..28].copy_from_slice(&8u16.to_be_bytes());
    out[30..32].copy_from_slice(&1u16.to_be_bytes());
    out
}

fn post_table() -> Vec<u8> {
    let mut out = vec![0u8; 32];
    out[0..4].copy_from_slice(&0x00030000u32.to_be_bytes());
    put_i16(&mut out, 8, -100);
    put_i16(&mut out, 10, 50);
    out
}

fn put_i16(bytes: &mut [u8], at: usize, value: i16) {
    bytes[at..at + 2].copy_from_slice(&value.to_be_bytes());
}
