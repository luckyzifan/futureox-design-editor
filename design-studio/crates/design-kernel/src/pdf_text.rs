//! PDF text decoding for the vector importer.
//!
//! In-scope text becomes an editable text node. Standard 14 fonts are not
//! embedded: the decoded Unicode is stored and the host font draws it. A
//! missing encoding or a composite font without ToUnicode is an error, not a
//! dropped run.

use crate::math::{Point, Transform};
use crate::pdf_glyphs;
use std::collections::HashMap;

const SCENE_LIMIT: f64 = 1e7;

#[derive(Clone, Debug)]
pub struct ShowGlyph {
    pub text: String,
    pub width: f64,
    pub space: bool,
}

#[derive(Clone)]
struct ByteMap {
    unicode: [u32; 256],
    names: [&'static str; 256],
}

#[derive(Clone)]
pub struct FontInfo {
    pub base_name: String,
    pub ascent: f64,
    pub weight: f32,
    bytes: Option<ByteMap>,
    cmap: Option<HashMap<Vec<u8>, String>>,
    first_char: i64,
    widths: Option<Vec<f64>>,
    missing_width: f64,
}

pub fn standard_base(name: &str) -> &str {
    match name.rsplit_once('+') {
        Some((prefix, rest))
            if prefix.len() == 6
                && !rest.is_empty()
                && prefix.bytes().all(|b| b.is_ascii_uppercase()) =>
        {
            rest
        }
        _ => name,
    }
}

pub fn font_metrics(base: &str) -> (f64, f32) {
    let weight = if base.contains("Bold") { 700. } else { 400. };
    let ascent = pdf_glyphs::font_metric(base)
        .map(|metric| metric.ascent)
        .filter(|ascent| *ascent > 0)
        .map(|ascent| f64::from(ascent) / 1000.)
        .unwrap_or(0.8);
    (ascent, weight)
}

impl FontInfo {
    pub fn fallback_helvetica() -> Self {
        let (ascent, weight) = font_metrics("Helvetica");
        let encoding = pdf_glyphs::encoding("WinAnsiEncoding").expect("winansi table");
        Self {
            base_name: "Helvetica".into(),
            ascent,
            weight,
            bytes: Some(ByteMap {
                unicode: *encoding.unicode,
                names: *encoding.names,
            }),
            cmap: None,
            first_char: 0,
            widths: None,
            missing_width: 0.,
        }
    }

    pub fn simple(
        base_name: String,
        unicode: [u32; 256],
        names: [&'static str; 256],
        first_char: i64,
        widths: Option<Vec<f64>>,
        missing_width: f64,
    ) -> Self {
        let (ascent, weight) = font_metrics(&base_name);
        Self {
            base_name,
            ascent,
            weight,
            bytes: Some(ByteMap { unicode, names }),
            cmap: None,
            first_char,
            widths,
            missing_width,
        }
    }

    pub fn mapped(base_name: String, cmap: HashMap<Vec<u8>, String>) -> Self {
        let (ascent, weight) = font_metrics(&base_name);
        Self {
            base_name,
            ascent,
            weight,
            bytes: None,
            cmap: Some(cmap),
            first_char: 0,
            widths: None,
            missing_width: 1000.,
        }
    }

    fn width_of(&self, code: Option<u8>, name: &str) -> f64 {
        if let (Some(code), Some(widths)) = (code, &self.widths) {
            let index = i64::from(code) - self.first_char;
            if index >= 0 && (index as usize) < widths.len() && widths[index as usize].is_finite() {
                return widths[index as usize];
            }
        }
        pdf_glyphs::standard_width(&self.base_name, name)
            .map(f64::from)
            .unwrap_or(self.missing_width)
    }

    pub fn decode(&self, bytes: &[u8]) -> Result<Vec<ShowGlyph>, String> {
        if let Some(cmap) = &self.cmap {
            return decode_cmap(cmap, bytes, self.missing_width, &self.base_name);
        }
        let map = self
            .bytes
            .as_ref()
            .ok_or_else(|| format!("pdf font {} has no encoding", self.base_name))?;
        let mut glyphs = Vec::with_capacity(bytes.len());
        for &byte in bytes {
            let unicode = map.unicode[byte as usize];
            let scalar = char::from_u32(unicode)
                .filter(|_| unicode != 0)
                .ok_or_else(|| {
                    format!(
                        "pdf text byte {byte:#04x} is not defined in font {}",
                        self.base_name
                    )
                })?;
            let name = map.names[byte as usize];
            glyphs.push(ShowGlyph {
                text: scalar.to_string(),
                width: self.width_of(Some(byte), name),
                space: scalar == ' ',
            });
        }
        Ok(glyphs)
    }
}

fn decode_cmap(
    cmap: &HashMap<Vec<u8>, String>,
    bytes: &[u8],
    missing_width: f64,
    font: &str,
) -> Result<Vec<ShowGlyph>, String> {
    let mut glyphs = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let mut matched = None;
        let max = (bytes.len() - index).min(4);
        for len in (1..=max).rev() {
            if let Some(text) = cmap.get(&bytes[index..index + len]) {
                matched = Some((len, text.clone()));
                break;
            }
        }
        let Some((len, text)) = matched else {
            return Err(format!(
                "pdf text bytes at {index} are not in the ToUnicode map of font {font}"
            ));
        };
        index += len;
        if text.is_empty() {
            continue;
        }
        glyphs.push(ShowGlyph {
            space: text == " ",
            text,
            width: missing_width,
        });
    }
    Ok(glyphs)
}

pub fn text_transform(
    flip: Transform,
    ctm: Transform,
    text_matrix: Transform,
    rise: f64,
    font_size: f64,
    horiz_scale: f64,
    ascent_ratio: f64,
) -> Result<Transform, String> {
    let placed = flip.concat(ctm).concat(text_matrix);
    let origin = placed.point(Point::new(0., rise));
    let right = placed.point(Point::new(1., 0.)) - placed.point(Point::default());
    let up = placed.point(Point::new(0., 1.)) - placed.point(Point::default());
    let sign = if font_size < 0. { -1. } else { 1. };
    let ascent = ascent_ratio * font_size.abs();
    let x_basis = right * (horiz_scale * sign);
    let y_basis = Point::new(-up.x, -up.y) * sign;
    let translation = origin + up * (ascent * sign);
    let transform = Transform([
        x_basis.x,
        x_basis.y,
        y_basis.x,
        y_basis.y,
        translation.x,
        translation.y,
    ]);
    if transform.0.iter().any(|value| !value.is_finite()) || !ascent.is_finite() {
        return Err("non-finite pdf text transform".into());
    }
    if transform.0.iter().any(|value| value.abs() > SCENE_LIMIT) {
        return Err("pdf text transform exceeds scene limits".into());
    }
    if transform.inverse().is_err() {
        return Err("singular pdf text transform".into());
    }
    Ok(transform)
}

pub fn parse_tounicode(data: &[u8]) -> Result<HashMap<Vec<u8>, String>, String> {
    let text = String::from_utf8_lossy(data);
    let tokens = cmap_tokens(&text);
    let mut map = HashMap::new();
    let mut index = 0;
    while index < tokens.len() {
        match tokens[index].as_str() {
            "beginbfchar" => {
                index += 1;
                while index < tokens.len() && tokens[index] != "endbfchar" {
                    let src = hex_bytes(&tokens[index])?;
                    let dst = tokens
                        .get(index + 1)
                        .ok_or("truncated pdf ToUnicode bfchar")?;
                    if dst == "endbfchar" {
                        return Err("truncated pdf ToUnicode bfchar".into());
                    }
                    map.insert(src, utf16_token(dst)?);
                    index += 2;
                }
                if index >= tokens.len() || tokens[index] != "endbfchar" {
                    return Err("unterminated pdf ToUnicode bfchar".into());
                }
                index += 1;
            }
            "beginbfrange" => {
                index += 1;
                while index < tokens.len() && tokens[index] != "endbfrange" {
                    let start = hex_bytes(&tokens[index])?;
                    let end = hex_bytes(
                        tokens
                            .get(index + 1)
                            .ok_or("truncated pdf ToUnicode bfrange")?,
                    )?;
                    let dest = tokens
                        .get(index + 2)
                        .ok_or("truncated pdf ToUnicode bfrange")?;
                    if dest == "[" {
                        index += 3;
                        expand_array(&mut map, &start, &end, &tokens, &mut index)?;
                    } else {
                        let units = utf16_units(dest)?;
                        expand_scalar(&mut map, &start, &end, &units)?;
                        index += 3;
                    }
                }
                if index >= tokens.len() || tokens[index] != "endbfrange" {
                    return Err("unterminated pdf ToUnicode bfrange".into());
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    if map.is_empty() {
        return Err("pdf ToUnicode cmap is empty".into());
    }
    if map.len() > 65_536 {
        return Err("pdf ToUnicode cmap is too large".into());
    }
    Ok(map)
}

fn expand_scalar(
    map: &mut HashMap<Vec<u8>, String>,
    start: &[u8],
    end: &[u8],
    units: &[u16],
) -> Result<(), String> {
    if start.len() != end.len() || start.is_empty() || start.len() > 4 || units.is_empty() {
        return Err("invalid pdf ToUnicode range".into());
    }
    let from = be_int(start);
    let to = be_int(end);
    if to < from || to - from > 65_536 {
        return Err("invalid pdf ToUnicode range".into());
    }
    let mut units = units.to_vec();
    for code in from..=to {
        let text = String::from_utf16(&units).map_err(|_| "invalid pdf ToUnicode utf-16")?;
        map.insert(be_bytes(code, start.len()), text);
        let last = units.last_mut().unwrap();
        *last = last.checked_add(1).ok_or("pdf ToUnicode range overflow")?;
    }
    Ok(())
}

fn expand_array(
    map: &mut HashMap<Vec<u8>, String>,
    start: &[u8],
    end: &[u8],
    tokens: &[String],
    index: &mut usize,
) -> Result<(), String> {
    if start.len() != end.len() || start.is_empty() || start.len() > 4 {
        return Err("invalid pdf ToUnicode range".into());
    }
    let from = be_int(start);
    let to = be_int(end);
    if to < from || to - from > 65_536 {
        return Err("invalid pdf ToUnicode range".into());
    }
    for code in from..=to {
        let token = tokens
            .get(*index)
            .ok_or("truncated pdf ToUnicode bfrange")?;
        if token == "]" {
            return Err("pdf ToUnicode bfrange array is short".into());
        }
        map.insert(be_bytes(code, start.len()), utf16_token(token)?);
        *index += 1;
    }
    let close = tokens
        .get(*index)
        .ok_or("truncated pdf ToUnicode bfrange")?;
    if close != "]" {
        return Err("pdf ToUnicode bfrange array is not closed".into());
    }
    *index += 1;
    Ok(())
}

fn be_int(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
}

fn be_bytes(value: u64, len: usize) -> Vec<u8> {
    (0..len)
        .rev()
        .map(|shift| ((value >> (shift * 8)) & 0xff) as u8)
        .collect()
}

fn hex_bytes(token: &str) -> Result<Vec<u8>, String> {
    let inner = token
        .strip_prefix('<')
        .and_then(|rest| rest.strip_suffix('>'))
        .ok_or("pdf ToUnicode source is not a hex string")?;
    if inner.is_empty() || inner.len() % 2 != 0 || inner.len() > 8 {
        return Err("pdf ToUnicode source hex is invalid".into());
    }
    (0..inner.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&inner[index..index + 2], 16)
                .map_err(|_| "pdf ToUnicode source hex is invalid".to_string())
        })
        .collect()
}

fn utf16_units(token: &str) -> Result<Vec<u16>, String> {
    let inner = token
        .strip_prefix('<')
        .and_then(|rest| rest.strip_suffix('>'))
        .ok_or("pdf ToUnicode destination is not a hex string")?;
    if inner.is_empty() || inner.len() % 4 != 0 || inner.len() > 64 {
        return Err("pdf ToUnicode destination hex is invalid".into());
    }
    (0..inner.len())
        .step_by(4)
        .map(|index| {
            u16::from_str_radix(&inner[index..index + 4], 16)
                .map_err(|_| "pdf ToUnicode destination hex is invalid".to_string())
        })
        .collect()
}

fn utf16_token(token: &str) -> Result<String, String> {
    let units = utf16_units(token)?;
    String::from_utf16(&units).map_err(|_| "invalid pdf ToUnicode utf-16".into())
}

fn cmap_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }
        if ch == '%' {
            while let Some(next) = chars.peek() {
                if *next == '\n' || *next == '\r' {
                    break;
                }
                chars.next();
            }
            continue;
        }
        if ch == '<' {
            let mut token = String::from("<");
            for next in chars.by_ref() {
                token.push(next);
                if next == '>' {
                    break;
                }
            }
            tokens.push(token);
            continue;
        }
        if ch == '[' || ch == ']' {
            tokens.push(ch.to_string());
            continue;
        }
        let mut token = String::from(ch);
        while let Some(next) = chars.peek() {
            if next.is_whitespace() || matches!(next, '<' | '[' | ']' | '%') {
                break;
            }
            token.push(chars.next().unwrap());
        }
        tokens.push(token);
    }
    tokens
}
