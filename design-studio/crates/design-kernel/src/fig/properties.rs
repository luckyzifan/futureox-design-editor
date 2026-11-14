use crate::{prototype::Overflow, scene::{ExportSetting, LayoutGrid, MAX_LAYOUT_GRIDS}};
use serde_json::Value;

pub(super) fn export_settings(value: &Value) -> (Vec<ExportSetting>, bool) {
    let Some(items) = value.as_array() else { return (Vec::new(), true); };
    let mut incomplete = items.len() > 16;
    let settings = items.iter().take(16).enumerate().filter_map(|(index, item)| {
        let parsed = (|| {
            let format = match item["imageType"].as_str()? {
                "PNG" => "png",
                "JPG" | "JPEG" => "jpeg",
                "SVG" | "SVG_STRING" => "svg",
                "PDF" => "pdf",
                "WEBP" => "webp",
                "TIFF" => "tiff",
                _ => return None,
            };
            let scale = match item.get("constraint") {
                None => 1.,
                Some(c) if matches!(c["type"].as_str(), Some("CONTENT_SCALE" | "SCALE")) => c["value"].as_f64()?,
                _ => return None,
            };
            let suffix = match item.get("suffix") {
                None => "",
                Some(suffix) => suffix.as_str()?,
            };
            if !(0. ..=128.).contains(&scale) || suffix.encode_utf16().count() > 80 ||
                suffix.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
            {
                return None;
            }
            Some(ExportSetting { id: format!("fig-export-{index}"), format: format.into(), scale, suffix: suffix.into() })
        })();
        incomplete |= parsed.is_none() || item["useAbsoluteBounds"] == true || item["contentsOnly"] == false ||
            item.get("colorProfile").is_some_and(|p| p != "DOCUMENT");
        parsed
    }).collect();
    (settings, incomplete)
}

pub(super) fn layout_grids(value: &Value) -> (Vec<LayoutGrid>, bool) {
    let Some(items) = value.as_array() else { return (Vec::new(), true); };
    let mut incomplete = items.len() > MAX_LAYOUT_GRIDS;
    let grids = items.iter().take(MAX_LAYOUT_GRIDS).filter_map(|item| {
        let parsed = (|| {
            let axis = match (item["pattern"].as_str()?, item["axis"].as_str()) {
                ("GRID", _) => "uniform",
                ("STRIPES", Some("X")) => "column",
                ("STRIPES", Some("Y")) => "row",
                _ => return None,
            };
            let alignment = if axis == "uniform" { "start" } else {
                match item["type"].as_str()? {
                    "MIN" => "start",
                    "MAX" => "end",
                    "CENTER" => "center",
                    "STRETCH" => "stretch",
                    _ => return None,
                }
            };
            let section_size = if alignment == "stretch" { None } else { Some(item["sectionSize"].as_f64()?) };
            let count = if axis == "uniform" { 0 } else {
                match item["numSections"].as_u64()? {
                    0x7fffffff => 0,
                    n @ 0..=64 => n as u32,
                    _ => return None,
                }
            };
            let numeric = |value: &Value, field: &str, default| match value.get(field) {
                None => Some(default), Some(value) => value.as_f64(),
            };
            let gutter = if axis == "uniform" { 0. } else { numeric(item, "gutterSize", 0.)? };
            let margin = if axis == "uniform" || alignment == "center" { 0. } else { numeric(item, "offset", 0.)? };
            let rgba = &item["color"];
            let [r, g, b, opacity] = [numeric(rgba, "r", 1.)?, numeric(rgba, "g", 0.)?,
                numeric(rgba, "b", 0.)?, numeric(rgba, "a", 0.1)?];
            if [r,g,b,opacity].iter().any(|c| !(0. ..=1.).contains(c)) { return None; }
            let byte = |n: f64| (n * 255.).round() as u8;
            let color = format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b));
            let grid = LayoutGrid { axis: axis.into(), count, gutter, margin, color,
                visible: item["visible"] != false, opacity, alignment: Some(alignment.into()), section_size };
            grid.validate(None).ok()?;
            Some(grid)
        })();
        incomplete |= parsed.is_none();
        parsed
    }).collect();
    (grids, incomplete)
}

pub(super) fn prototype_overflow(value: &Value) -> Option<Overflow> {
    match value.as_str()? {
        "NONE" | "NO_SCROLLING" => Some(Overflow::None),
        "HORIZONTAL" | "HORIZONTAL_SCROLLING" => Some(Overflow::Horizontal),
        "VERTICAL" | "VERTICAL_SCROLLING" => Some(Overflow::Vertical),
        "BOTH" | "HORIZONTAL_AND_VERTICAL" | "HORIZONTAL_AND_VERTICAL_SCROLLING" => Some(Overflow::Both),
        _ => None,
    }
}
