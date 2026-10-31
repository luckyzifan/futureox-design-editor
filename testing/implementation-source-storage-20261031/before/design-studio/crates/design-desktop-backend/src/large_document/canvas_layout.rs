//! A whole-source canvas catalogue, independent of scene residency.
use super::*;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Box2 {
    #[serde(default)] pub x: f64,
    #[serde(default)] pub y: f64,
    #[serde(default)] pub width: f64,
    #[serde(default)] pub height: f64,
}
#[derive(Clone, Debug, Serialize)]
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
fn arrange(items: &mut [Item]) -> Result<Box2> {
    // Spacing is a layout choice, never a content admission quota.
    let gap = 128.;
    let largest = items.iter().map(|i| i.source.width.max(1.) + gap).fold(1., f64::max);
    let area: f64 = items.iter().map(|i| (i.source.width.max(1.) + gap) * (i.source.height.max(1.) + gap)).sum();
    let target = if area.is_finite() { area.sqrt().max(largest) } else { largest };
    let (mut x, mut y, mut row_height, mut right) = (gap, gap, 0_f64, gap);
    for item in items {
        let width = item.source.width.max(1.); let height = item.source.height.max(1.);
        if x > gap && x + width + gap > target { x = gap; y += row_height + gap; row_height = 0.; }
        item.placed = Box2 { x, y, width, height };
        x += width + gap; right = right.max(x); row_height = row_height.max(height);
        if ![x, y, right, row_height].iter().all(|n| n.is_finite()) { return Err(issue("Canvas layout coordinates are not representable")); }
    }
    let height = y + row_height + gap;
    if !height.is_finite() { return Err(issue("Canvas layout coordinates are not representable")); }
    Ok(Box2 { x: 0., y: 0., width: right.max(1.), height: height.max(1.) })
}
pub(super) fn build(s: &Session, cancel: &AtomicBool) -> Result<Layout> {
    if s.format != "sketch" { return Err(issue("This source does not contain Sketch canvas pages")); }
    let mut items = Vec::new();
    for (p, part) in s.parts.iter().enumerate() {
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
    fn all_source_roots_are_placed_without_overlap_or_count_cutoff() {
        let mut items: Vec<_> = (0..10_001).map(|i| Item { key: i.to_string(), id: i.to_string(), name: i.to_string(), kind: "frame".into(),
            page_id: "p".into(), page_name: "page".into(), source: Box2 { x: -300., y: 700., width: 140., height: 80. }, placed: Box2::default(), bytes: 1 }).collect();
        let bounds = arrange(&mut items).unwrap();
        assert_eq!(items.len(), 10_001);
        for pair in items.windows(2) {
            let (a,b) = (pair[0].placed,pair[1].placed);
            assert!(b.x >= a.x+a.width || b.y >= a.y+a.height);
        }
        assert!(items.iter().all(|item| item.placed.x >= 0. && item.placed.y >= 0. && item.placed.x+item.placed.width <= bounds.width && item.placed.y+item.placed.height <= bounds.height));
        assert!(items.iter().all(|item| item.source.x == -300. && item.source.y == 700.));
    }
}
