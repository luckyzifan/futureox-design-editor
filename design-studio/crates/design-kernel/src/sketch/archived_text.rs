//! Project old Sketch keyed text archives onto the same attributes as modern
//! Sketch JSON. Resolve known data fields without instantiating archive classes.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use plist::{
    Dictionary, Value as Plist,
    stream::{BinaryReader, Event},
};
use serde_json::{Map, Value, json};
use std::io::Cursor;

const MAX_BYTES: usize = 1024 * 1024;
const MAX_EVENTS: usize = 32_768;
const MAX_DEPTH: usize = 32;
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
        if keys.len() != values.len() {
            return None;
        }
        keys.iter()
            .zip(values)
            .map(|(key, value)| Some((self.get(key)?.as_string()?, self.get(value)?)))
            .collect()
    }

    fn font(&self, value: &'a Plist) -> Option<Value> {
        let descriptor = value.as_dictionary()?;
        if self.class(descriptor)? != "NSFontDescriptor" {
            return None;
        }
        let fields = self.entries(descriptor.get("NSFontDescriptorAttributes")?)?;
        let find = |name| {
            fields
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| *value)
        };
        let name = find("NSFontNameAttribute")?.as_string()?;
        let size = number(find("NSFontSizeAttribute")?)?;
        ((1. ..=4096.).contains(&size) && !name.is_empty())
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
        let (components, gray) = match (color.get("NSRGB"), color.get("NSWhite")) {
            (Some(rgb), _) => (rgb, false),
            (None, Some(white)) => (white, true),
            _ => return None,
        };
        let raw = self.get(components)?.as_data()?;
        let raw = std::str::from_utf8(raw).ok()?.trim_end_matches('\0');
        let mut parts = raw.split_ascii_whitespace();
        let channel = |s: &str| s.parse::<f64>().ok().filter(|v| (0. ..=1.).contains(v));
        let red = channel(parts.next()?)?;
        let (green, blue) = if gray {
            (red, red)
        } else {
            (channel(parts.next()?)?, channel(parts.next()?)?)
        };
        // Older NSColor omits alpha when opaque.
        let alpha = match parts.next() {
            Some(value) => channel(value)?,
            None => 1.,
        };
        if parts.next().is_some() {
            return None;
        }
        Some(json!({"red":red,"green":green,"blue":blue,"alpha":alpha}))
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
}

fn number(value: &Plist) -> Option<f64> {
    value
        .as_real()
        .or_else(|| value.as_signed_integer().map(|v| v as f64))
        .filter(|v| v.is_finite())
}

/// Return modern-shaped attributes for the legacy, uniform attributed text
/// archived by older Sketch releases. Unknown layouts are diagnosed by callers.
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
    let text = root
        .get("NSString")
        .and_then(|value| archive.get(value))
        .and_then(Plist::as_string)
        .ok_or(INVALID)?;
    let mut attributes = Map::new();
    if root.contains_key("NSAttributeInfo") {
        return Ok(json!({"string":text,"attributes":[],"unsupportedArchiveAttributes":true}));
    }
    if let Some(raw) = root.get("NSAttributes") {
        let Some(entries) = archive.entries(raw) else {
            // The string is still usable if a newer keyed layout carries
            // non-uniform ranges that this legacy adapter cannot map.
            return Ok(json!({"string":text,"attributes":[],"unsupportedArchiveAttributes":true}));
        };
        let mut unsupported = false;
        for (name, value) in entries {
            let converted = match name {
                "MSAttributedStringFontAttribute" | "NSFont" => archive
                    .font(value)
                    .map(|v| ("MSAttributedStringFontAttribute", v)),
                "NSColor" | "MSAttributedStringColorDictionaryAttribute" => archive
                    .color(value, name != "NSColor")
                    .map(|v| ("MSAttributedStringColorAttribute", v)),
                "NSParagraphStyle" => archive.paragraph(value).map(|v| ("paragraphStyle", v)),
                "NSKern" => number(value).map(|v| ("kerning", json!(v))),
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
        if !text.is_empty() && !attributes.is_empty() {
            return Ok(json!({"string":text,"attributes":[{
                "location":0,"length":text.encode_utf16().count(),"attributes":attributes
            }],"unsupportedArchiveAttributes":unsupported}));
        }
        return Ok(
            json!({"string":text,"attributes":[],"unsupportedArchiveAttributes":unsupported}),
        );
    }
    Ok(json!({"string":text,"attributes":[]}))
}
