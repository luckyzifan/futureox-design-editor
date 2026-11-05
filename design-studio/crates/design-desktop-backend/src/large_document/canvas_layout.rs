//! A whole-source canvas catalogue, independent of scene residency.
use super::*;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Box2 {
    #[serde(default)] pub x: f64,
    #[serde(default)] pub y: f64,
    #[serde(default)] pub width: f64,
    #[serde(default)] pub height: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Item {
    pub key: String, pub id: String, pub name: String, pub kind: String,
    pub page_id: String, pub page_name: String,
    pub source: Box2, pub placed: Box2, pub bytes: u64,
}
#[derive(Clone)]
pub(super) struct Layout {
    pub revision: u64, pub items: Vec<Item>, pub bounds: Box2,
}
fn field<T: serde::de::DeserializeOwned>(s: &Session, p: usize, entry: &large_json::Entry, source: &mut File, key: &str, cancel: &AtomicBool) -> Result<Option<T>> {
    let part = &s.parts[p];
    let Some(field) = entry.fields.iter().find(|f| f.key == key) else { return Ok(None); };
    let mut reader = s.state.changes[p].reader(source, part.base_bytes).map_err(issue)?;
    reader.seek(SeekFrom::Start(field.value.start)).map_err(issue)?;
    // Stream unknown frame members instead of applying a fragment-size quota.
    let source = CheckedReader { inner: reader.take(field.value.len()), cancel, progress: None };
    serde_json::from_reader(BufReader::new(source)).map(Some).map_err(issue)
}
fn frame(s: &Session, p: usize, entry: &large_json::Entry, source: &mut File, cancel: &AtomicBool) -> Result<Box2> {
    let value = field::<Box2>(s, p, entry, source, "frame", cancel)?.unwrap_or_default();
    let angle = field::<f64>(s, p, entry, source, "rotation", cancel)?.unwrap_or(0.);
    rotated_bounds(value, angle)
}
pub(super) fn rotated_bounds(value: Box2, angle: f64) -> Result<Box2> {
    if ![value.x, value.y, value.width, value.height, angle].iter().all(|n| n.is_finite()) || value.width < 0. || value.height < 0. {
        return Err(issue("Invalid source canvas geometry"));
    }
    let (sin, cos) = angle.to_radians().sin_cos();
    let width = value.width * cos.abs() + value.height * sin.abs();
    let height = value.width * sin.abs() + value.height * cos.abs();
    let bounds = Box2 { x: value.x + (value.width - width) / 2., y: value.y + (value.height - height) / 2., width, height };
    if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|n| n.is_finite()) {
        return Err(issue("Source canvas geometry is not representable"));
    }
    Ok(bounds)
}
pub(super) fn arrange(items: &mut [Item]) -> Result<Box2> {
    let gap = 128.;
    let mut pages = Vec::new();
    let mut bounds = HashMap::<String, Box2>::new();
    for item in items.iter() {
        let b = item.source;
        let right = b.x + b.width.max(1.);
        let bottom = b.y + b.height.max(1.);
        if ![b.x, b.y, right, bottom].iter().all(|v| v.is_finite()) {
            return Err(issue("Canvas layout coordinates are not representable"));
        }
        let entry = bounds.entry(item.page_id.clone()).or_insert_with(|| {
            pages.push(item.page_id.clone());
            Box2 { width: b.width.max(1.), height: b.height.max(1.), ..b }
        });
        let x = entry.x.min(b.x);
        let y = entry.y.min(b.y);
        entry.width = (entry.x + entry.width).max(right) - x;
        entry.height = (entry.y + entry.height).max(bottom) - y;
        entry.x = x;
        entry.y = y;
    }
    let Some(first) = pages.first().map(|id| bounds[id]) else {
        return Ok(Box2 { width: 1., height: 1., ..Box2::default() });
    };
    // Pack whole pages in their authored order. Every root of one page
    // receives the same translation, including intentional overlaps.
    let widest = pages.iter().map(|id| bounds[id].width + gap).fold(1_f64, f64::max);
    let area: f64 = pages.iter().map(|id| { let b = bounds[id]; (b.width + gap) * (b.height + gap) }).sum();
    let line_width = if area.is_finite() { area.sqrt().max(widest) } else { widest };
    let mut offsets = HashMap::new();
    let (mut x, mut y, mut row_height, mut right) = (first.x, first.y, 0_f64, first.x);
    for page in pages {
        let b = bounds[&page];
        if x > first.x && x + b.width > first.x + line_width {
            x = first.x;
            y += row_height + gap;
            row_height = 0.;
        }
        offsets.insert(page, (x - b.x, y - b.y));
        right = right.max(x + b.width);
        row_height = row_height.max(b.height);
        x += b.width + gap;
    }
    for item in items {
        let (dx, dy) = offsets[&item.page_id];
        item.placed = Box2 { x: item.source.x + dx, y: item.source.y + dy, ..item.source };
    }
    let result = Box2 { x: first.x - gap, y: first.y - gap,
        width: right - first.x + 2. * gap, height: y + row_height - first.y + 2. * gap };
    if ![result.x, result.y, result.width, result.height].iter().all(|v| v.is_finite()) {
        return Err(issue("Canvas layout coordinates are not representable"));
    }
    Ok(result)
}

pub(super) fn page_order(s: &Session) -> Result<Vec<usize>> {
    let available: Vec<_> = s.parts.iter().enumerate().filter(|(_, p)| p.name.starts_with("pages/")
        && p.index.entries.first().is_some_and(|e| e.kind == "page")).map(|(i, _)| i).collect();
    let Some(header) = s.parts.iter().position(|p| p.name == "document.json") else { return Ok(available); };
    let Ok(bytes) = projection::field(s, header, 0, "pages") else { return Ok(available); };
    let refs: Vec<Value> = serde_json::from_slice(&bytes).map_err(issue)?;
    let mut ordered = Vec::new();
    for reference in refs {
        let name = reference["_ref"].as_str().ok_or_else(|| issue("Invalid source page reference"))?;
        let path = format!("{}.json", name.trim_end_matches(".json"));
        let index = available.iter().find(|&&i| s.parts[i].name == path)
            .ok_or_else(|| issue("Source page reference is unavailable"))?;
        if ordered.contains(index) { return Err(issue("Duplicate source page reference")); }
        ordered.push(*index);
    }
    Ok(ordered)
}
pub(super) fn build(s: &Session, cancel: &AtomicBool) -> Result<Layout> {
    if s.format != "sketch" { return Err(issue("This source does not contain Sketch canvas pages")); }
    let mut items = Vec::new();
    for p in page_order(s)? {
        let part = &s.parts[p];
        let Some(page) = part.index.entries.first().filter(|row| row.kind == "page" && part.name.starts_with("pages/")) else { continue; };
        let mut records = part.index.records(&s.directory)?;
        let entry = records.entry(0)?;
        let Some(layers) = entry.fields.iter().find(|f| f.key == "layers").map(|f| f.value) else { continue; };
        let mut source = File::open(s.directory.join(&part.file)).map_err(issue)?;
        for n in part.index.children(Some(0)).iter().map(|n| *n as usize) {
            check_cancel(cancel).map_err(issue)?;
            let row = &part.index.entries[n];
            if row.span.start < layers.start || row.span.end > layers.end { continue; }
            let entry = records.entry(n)?;
            items.try_reserve(1).map_err(issue)?;
            items.push(Item { key: format!("{p}:{n}"), id: row.id.clone(), name: row.name.clone(), kind: row.kind.clone(),
                page_id: page.id.clone(), page_name: page.name.clone(), source: frame(s, p, &entry, &mut source, cancel)?, placed: Box2::default(), bytes: row.span.len() });
        }
    }
    let bounds = arrange(&mut items)?;
    Ok(Layout { revision: s.revision, items, bounds })
}
pub(super) fn list(s: &mut Session, request: Request, cancel: &AtomicBool) -> Result<Value> {
    if s.canvas_layout.as_ref().is_none_or(|layout| layout.revision != s.revision) {
        let next = build(s, cancel)?;
        check_cancel(cancel).map_err(issue)?;
        s.canvas_layout = Some(next);
    }
    let layout = s.canvas_layout.as_ref().unwrap();
    let count = request.limit.unwrap_or(200).clamp(1, 200);
    let end = request.offset.saturating_add(count).min(layout.items.len());
    let items = layout.items.get(request.offset..end).unwrap_or(&[]);
    Ok(json!({"owner":s.owner,"revision":s.revision,"bounds":layout.bounds,"items":items,
        "total":layout.items.len(),"offset":request.offset,"hasMore":end<layout.items.len(),"boundsAreLayoutHints":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_roots_keep_source_order_and_relative_positions_on_one_canvas() {
        let mut items: Vec<_> = (0..10_001).map(|i| Item { key: i.to_string(), id: i.to_string(), name: i.to_string(), kind: "frame".into(),
            page_id: if i < 5000 { "first" } else { "second" }.into(), page_name: "page".into(),
            source: Box2 { x: (i % 5000) as f64 * 240. - 300., y: (i % 3) as f64 * 120. - 700., width: 140., height: 80. },
            placed: Box2::default(), bytes: 1 }).collect();
        let source = items.clone();
        let bounds = arrange(&mut items).unwrap();
        assert_eq!(items.len(), 10_001);
        for (old, new) in source.iter().zip(&items) {
            assert_eq!(old.key, new.key);
            assert_eq!(old.source, new.source);
            if old.page_id == "first" { assert_eq!(old.source, new.placed); }
            assert!(new.placed.x >= bounds.x && new.placed.y >= bounds.y);
            assert!(new.placed.x + new.placed.width <= bounds.x + bounds.width);
            assert!(new.placed.y + new.placed.height <= bounds.y + bounds.height);
        }
        let offset = items[5000].placed.x - items[5000].source.x;
        assert!(offset > 0. || items[5000].placed.y > items[5000].source.y);
        assert!(items[5000..].iter().all(|item| item.placed.x - item.source.x == offset));
    }
}
