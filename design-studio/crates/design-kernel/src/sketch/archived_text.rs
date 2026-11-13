//! Project old Sketch keyed text archives onto the same attributes as modern
//! Sketch JSON. Resolve known data fields without instantiating archive classes.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use plist::{
    Dictionary, Value as Plist,
    stream::{BinaryReader, Event},
};
use serde_json::{Map, Value, json};
use std::io::Cursor;
use unicode_segmentation::UnicodeSegmentation;

const MAX_BYTES: usize = 1024 * 1024;
const MAX_EVENTS: usize = 32_768;
const MAX_DEPTH: usize = 32;
const MAX_RUNS: usize = 4_096;
const INVALID: &str = "invalid archived Sketch attributed string";

pub(crate) fn legacy_archive(value: &Value) -> Option<Result<&str, &'static str>> {
    if value.get("string").and_then(Value::as_str).is_some() {
        return None;
    }
    value.get("archivedAttributedString").map(|archive| {
        archive
            .get("_archive")
            .and_then(Value::as_str)
            .ok_or("missing archived Sketch text data")
    })
}

fn read_archive(encoded: &str) -> Result<Plist, &'static str> {
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("archived Sketch attributed string exceeds its byte limit");
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| INVALID)?;
    if bytes.len() > MAX_BYTES || !bytes.starts_with(b"bplist00") {
        return Err(INVALID);
    }
    // The same binary object may be referenced many times. Count expanded
    // events and scalar bytes before constructing the owned plist tree.
    let mut events = Vec::new();
    let mut depth = 0_usize;
    let mut scalar_bytes = 0_usize;
    for item in BinaryReader::new(Cursor::new(bytes)) {
        let event = item.map_err(|_| INVALID)?;
        match &event {
            Event::StartArray(_) | Event::StartDictionary(_) => depth += 1,
            Event::EndCollection => depth = depth.checked_sub(1).ok_or(INVALID)?,
            Event::String(value) => scalar_bytes += value.len(),
            Event::Data(value) => scalar_bytes += value.len(),
            _ => {}
        }
        if depth > MAX_DEPTH || events.len() >= MAX_EVENTS || scalar_bytes > MAX_BYTES {
            return Err("archived Sketch attributed string exceeds its expansion limit");
        }
        events.push(Ok(event));
    }
    Plist::from_events(events).map_err(|_| INVALID)
}

struct Archive<'a> {
    objects: &'a [Plist],
}

impl<'a> Archive<'a> {
    fn get(&self, value: &'a Plist) -> Option<&'a Plist> {
        match value {
            Plist::Uid(uid) => {
                let index = usize::try_from(uid.get()).ok()?;
                (index > 0).then(|| self.objects.get(index)).flatten()
            }
            _ => Some(value),
        }
    }

    fn class(&self, dictionary: &'a Dictionary) -> Option<&'a str> {
        self.get(dictionary.get("$class")?)?
            .as_dictionary()?
            .get("$classname")?
            .as_string()
    }

    fn string(&self, value: &'a Plist) -> Option<&'a str> {
        let value = self.get(value)?;
        if let Some(text) = value.as_string() {
            return Some(text);
        }
        let object = value.as_dictionary()?;
        if matches!(self.class(object)?, "NSString" | "NSMutableString") {
            return self.get(object.get("NS.string")?)?.as_string();
        }
        None
    }

    fn data(&self, value: &'a Plist) -> Option<&'a [u8]> {
        let value = self.get(value)?;
        if let Some(data) = value.as_data() {
            return Some(data);
        }
        let object = value.as_dictionary()?;
        if matches!(self.class(object)?, "NSData" | "NSMutableData") {
            return self.get(object.get("NS.data")?)?.as_data();
        }
        None
    }

    fn entries(&self, value: &'a Plist) -> Option<Vec<(&'a str, &'a Plist)>> {
        let dictionary = self.get(value)?.as_dictionary()?;
        if !matches!(
            self.class(dictionary)?,
            "NSDictionary" | "NSMutableDictionary"
        ) {
            return None;
        }
        let keys = dictionary.get("NS.keys")?.as_array()?;
        let values = dictionary.get("NS.objects")?.as_array()?;
        if keys.len() != values.len() || keys.len() > 256 {
            return None;
        }
        keys.iter()
            .zip(values)
            .map(|(key, value)| Some((self.string(key)?, self.get(value)?)))
            .collect()
    }

    fn font(&self, value: &'a Plist) -> Option<Value> {
        let descriptor = value.as_dictionary()?;
        let (name, size) = match self.class(descriptor)? {
            "NSFont" => (
                self.string(descriptor.get("NSName")?)?,
                number(self.get(descriptor.get("NSSize")?)?)?,
            ),
            "NSFontDescriptor" => {
                let fields = self.entries(descriptor.get("NSFontDescriptorAttributes")?)?;
                let find = |name| {
                    fields
                        .iter()
                        .find(|(key, _)| *key == name)
                        .map(|(_, value)| *value)
                };
                (
                    self.string(find("NSFontNameAttribute")?)?,
                    number(find("NSFontSizeAttribute")?)?,
                )
            }
            _ => return None,
        };
        ((1. ..=4096.).contains(&size) && !name.is_empty() && name.len() <= 128)
            .then(|| json!({"attributes":{"name":name,"size":size}}))
    }

    fn color(&self, value: &'a Plist, keyed: bool) -> Option<Value> {
        if keyed {
            let fields = self.entries(value)?;
            let channel = |name| {
                let value = fields.iter().find(|(key, _)| *key == name)?.1;
                number(value).filter(|v| (0. ..=1.).contains(v))
            };
            return Some(json!({"red":channel("red")?,"green":channel("green")?,
                "blue":channel("blue")?,"alpha":channel("alpha")?}));
        }
        let color = value.as_dictionary()?;
        if self.class(color)? != "NSColor" {
            return None;
        }
        let (components, gray, srgb) = if let Some(raw) = color.get("NSComponents") {
            let space = self
                .get(color.get("NSCustomColorSpace")?)?
                .as_dictionary()?;
            // AppKit's sRGB archive provides exact straight components and a
            // second, converted NSRGB fallback for older readers.
            if self.class(space)? != "NSColorSpace" || space.get("NSID")?.as_signed_integer()? != 7
            {
                return None;
            }
            (raw, false, true)
        } else {
            match (color.get("NSRGB"), color.get("NSWhite")) {
                (Some(rgb), _) => (rgb, false, false),
                (None, Some(white)) => (white, true, false),
                _ => return None,
            }
        };
        let raw = self.data(components)?;
        if raw.len() > 256 {
            return None;
        }
        let raw = std::str::from_utf8(raw).ok()?.trim_end_matches('\0');
        let mut parts = raw.split_ascii_whitespace();
        let channel = |s: &str| {
            s.parse::<f64>().ok().filter(|v| {
                if srgb {
                    v.is_finite()
                } else {
                    (0. ..=1.).contains(v)
                }
            })
        };
        let red = channel(parts.next()?)?;
        let (green, blue) = if gray {
            (red, red)
        } else {
            (channel(parts.next()?)?, channel(parts.next()?)?)
        };
        // Older NSColor omits alpha when opaque.
        let alpha = match parts.next() {
            Some(value) => value
                .parse::<f64>()
                .ok()
                .filter(|v| (0. ..=1.).contains(v))?,
            None => 1.,
        };
        if parts.next().is_some() {
            return None;
        }
        let mut rgba = json!({"red":red,"green":green,"blue":blue,"alpha":alpha});
        if srgb {
            let value = format!("color(srgb {red} {green} {blue} / {alpha})");
            crate::color::parse(&value, Default::default()).ok()?;
            rgba["archiveSrgb"] = json!(value);
        }
        Some(rgba)
    }

    fn paragraph(&self, value: &'a Plist) -> Option<Value> {
        let paragraph = value.as_dictionary()?;
        if !matches!(
            self.class(paragraph)?,
            "NSParagraphStyle" | "NSMutableParagraphStyle"
        ) {
            return None;
        }
        let mut modern = Map::new();
        if let Some(alignment) = paragraph.get("NSAlignment") {
            let raw = self.get(alignment)?.as_signed_integer()?;
            // NSTextAlignment's natural (4) follows the default flow.
            modern.insert(
                "alignment".into(),
                json!(if (0..=3).contains(&raw) { raw } else { 0 }),
            );
        }
        for (source, target) in [
            ("NSMinLineHeight", "minimumLineHeight"),
            ("NSMaxLineHeight", "maximumLineHeight"),
            ("NSParagraphSpacing", "paragraphSpacing"),
            ("NSFirstLineHeadIndent", "firstLineHeadIndent"),
        ] {
            if let Some(raw) = paragraph.get(source) {
                modern.insert(target.into(), json!(number(self.get(raw)?)?));
            }
        }
        Some(Value::Object(modern))
    }

    fn attributes(&self, value: &'a Plist) -> Option<(Map<String, Value>, bool)> {
        let mut attributes = Map::new();
        let mut unsupported = false;
        for (name, value) in self.entries(value)? {
            let converted = match name {
                "MSAttributedStringFontAttribute" | "NSFont" => self
                    .font(value)
                    .map(|v| ("MSAttributedStringFontAttribute", v)),
                "NSColor" | "MSAttributedStringColorDictionaryAttribute" => self
                    .color(value, name != "NSColor")
                    .map(|v| ("MSAttributedStringColorAttribute", v)),
                "NSParagraphStyle" => self.paragraph(value).map(|v| ("paragraphStyle", v)),
                "NSKern" => number(value)
                    .filter(|v| v.abs() <= 1_000.)
                    .map(|v| ("kerning", json!(v))),
                "NSUnderline" => value
                    .as_signed_integer()
                    .map(|v| ("underlineStyle", json!(v))),
                "NSStrikethrough" => value
                    .as_signed_integer()
                    .map(|v| ("strikethroughStyle", json!(v))),
                _ => None,
            };
            if let Some((key, value)) = converted {
                attributes.insert(key.into(), value);
            } else {
                unsupported = true;
            }
        }
        Some((attributes, unsupported))
    }

    fn ranges(&self, text: &str, sets: &'a Plist, info: &'a Plist) -> Option<(Vec<Value>, bool)> {
        let sets = self.get(sets)?.as_dictionary()?;
        if !matches!(self.class(sets)?, "NSArray" | "NSMutableArray") {
            return None;
        }
        let sets = sets.get("NS.objects")?.as_array()?;
        if sets.len() > MAX_RUNS {
            return None;
        }
        let mut cached = vec![None; sets.len()];
        let mut bytes = self.data(info)?;
        let mut start = 0_usize;
        let mut ranges = Vec::new();
        let mut unsupported = false;
        let mut boundaries = text.graphemes(true).scan(0, |offset, grapheme| {
            *offset += grapheme.encode_utf16().count();
            Some(*offset)
        });
        while !bytes.is_empty() {
            if ranges.len() >= MAX_RUNS {
                return None;
            }
            let length = archive_index(&mut bytes)?;
            let index = archive_index(&mut bytes)?;
            let end = start.checked_add(length)?;
            if length == 0 || boundaries.by_ref().find(|offset| *offset >= end) != Some(end) {
                return None;
            }
            let slot = cached.get_mut(index)?;
            if slot.is_none() {
                *slot = Some(self.attributes(sets.get(index)?)?);
            }
            let (attributes, partial) = slot.as_ref()?;
            unsupported |= partial;
            ranges.push(json!({"location":start,"length":length,"attributes":attributes}));
            start = end;
        }
        boundaries.next().is_none().then_some((ranges, unsupported))
    }
}

// NSAttributeInfo holds unsigned base-128 (length, attribute index) pairs.
// Four groups cover every position in the bounded plist.
fn archive_index(bytes: &mut &[u8]) -> Option<usize> {
    let mut value = 0;
    for shift in [0, 7, 14, 21] {
        let (&byte, remaining) = bytes.split_first()?;
        *bytes = remaining;
        value |= usize::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn number(value: &Plist) -> Option<f64> {
    value
        .as_real()
        .or_else(|| value.as_signed_integer().map(|v| v as f64))
        .filter(|v| v.is_finite())
}

/// Return modern-shaped attributes for keyed text archives. Unknown layouts
/// preserve the string and are diagnosed by callers.
pub(crate) fn decode(encoded: &str) -> Result<Value, &'static str> {
    let plist = read_archive(encoded)?;
    let dictionary = plist.as_dictionary().ok_or(INVALID)?;
    if dictionary.get("$archiver").and_then(Plist::as_string) != Some("NSKeyedArchiver") {
        return Err(INVALID);
    }
    let archive = Archive {
        objects: dictionary
            .get("$objects")
            .and_then(Plist::as_array)
            .ok_or(INVALID)?,
    };
    let top = dictionary
        .get("$top")
        .and_then(Plist::as_dictionary)
        .ok_or(INVALID)?;
    let root = archive
        .get(top.get("root").ok_or(INVALID)?)
        .and_then(Plist::as_dictionary)
        .ok_or(INVALID)?;
    if !matches!(
        archive.class(root),
        Some("NSAttributedString" | "NSMutableAttributedString")
    ) {
        return Err(INVALID);
    }
    let text = archive
        .string(root.get("NSString").ok_or(INVALID)?)
        .ok_or(INVALID)?;
    let (attributes, unsupported) = match (root.get("NSAttributes"), root.get("NSAttributeInfo")) {
        (Some(sets), Some(info)) => archive.ranges(text, sets, info).unwrap_or((vec![], true)),
        (Some(value), None) => {
            let Some((attributes, partial)) = archive.attributes(value) else {
                return Ok(
                    json!({"string":text,"attributes":[],"unsupportedArchiveAttributes":true}),
                );
            };
            let ranges = if text.is_empty() || attributes.is_empty() {
                vec![]
            } else {
                vec![
                    json!({"location":0,"length":text.encode_utf16().count(),"attributes":attributes}),
                ]
            };
            (ranges, partial)
        }
        (None, info) => (vec![], info.is_some()),
    };
    Ok(json!({"string":text,"attributes":attributes,"unsupportedArchiveAttributes":unsupported}))
}
