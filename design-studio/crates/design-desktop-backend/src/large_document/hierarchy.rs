//! One owner/revision transaction for sibling order and reparenting. Copy
//! existing source objects (including unknown fields) by piece-table address.
use super::*;

struct Array {
    span: Span,
    children: Vec<Span>,
}

fn emit(
    span: Span,
    arrays: &BTreeMap<u64, Array>,
    plan: &mut Vec<Option<Span>>,
    used: &mut HashSet<u64>,
    depth: usize,
) -> Result<()> {
    if depth > 256 {
        return Err(issue("Source layer nesting exceeds the index limit"));
    }
    let mut at = span.start;
    while let Some((&start, array)) = arrays.range(at..span.end).next() {
        if array.span.end > span.end || !used.insert(start) {
            return Err(issue("Ambiguous or cyclic source layer move"));
        }
        // Keep the original brackets; only the separator between moved children is new.
        plan.push(Some(Span {
            start: at,
            end: start + 1,
        }));
        for (i, &child) in array.children.iter().enumerate() {
            if i != 0 {
                plan.push(None)
            }
            emit(child, arrays, plan, used, depth + 1)?;
        }
        at = array.span.end - 1;
    }
    if at < span.end {
        plan.push(Some(Span {
            start: at,
            end: span.end,
        }));
    }
    Ok(())
}

pub(super) fn reorder(
    s: &Session,
    p: usize,
    root_id: &str,
    index: &DiskIndex,
    changes: &Changes,
    updates: &BTreeMap<String, (Vec<String>, Vec<String>)>,
    cancel: &AtomicBool,
) -> Result<Changes> {
    let part = &s.parts[p];
    let mut ids = std::collections::HashMap::new();
    let mut ambiguous = HashSet::new();
    for (n, e) in index.entries.iter().enumerate() {
        if !e.id.is_empty() && ids.insert(e.id.to_ascii_lowercase(), n).is_some() {
            ambiguous.insert(e.id.to_ascii_lowercase());
        }
    }
    let locate = |id: &str| {
        let key = id.to_ascii_lowercase();
        ids.get(&key)
            .copied()
            .filter(|_| !ambiguous.contains(&key))
            .ok_or_else(|| issue("Missing or ambiguous source hierarchy identity"))
    };
    let scope = index.entries[locate(root_id)?].span;
    let mut arrays = BTreeMap::new();
    let mut prior = Vec::new();
    let mut next = Vec::new();
    let mut file = File::open(s.directory.join(&part.file)).map_err(issue)?;
    let mut reader = changes.reader(&mut file, part.base_bytes).map_err(issue)?;
    // No unmodeled primitive, metadata or malformed extra element may be
    // discarded when rebuilding an array from its indexed object children.
    let mut syntax = |from: u64, to: u64, want: &[u8]| -> Result<()> {
        if from > to {
            return Err(issue("Invalid source layer span"));
        }
        reader.seek(SeekFrom::Start(from)).map_err(issue)?;
        let mut range = (&mut reader).take(to - from);
        let mut buf = [0; 4096];
        let mut i = 0;
        loop {
            let n = range.read(&mut buf).map_err(issue)?;
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if !b.is_ascii_whitespace() {
                    if want.get(i) != Some(&b) {
                        return Err(issue("Unmodeled source layer array element"));
                    }
                    i += 1;
                }
            }
        }
        if i != want.len() {
            return Err(issue("Invalid source layer array"));
        }
        Ok(())
    };
    for (id, (old, new)) in updates {
        check_cancel(cancel).map_err(issue)?;
        let n = locate(id)?;
        let parent = &index.entries[n];
        if parent.span.start < scope.start || parent.span.end > scope.end {
            return Err(issue("Cannot move source dependencies across working sets"));
        }
        let span = index
            .entry(n, &s.directory)?
            .fields
            .into_iter()
            .find(|f| f.key == "layers")
            .ok_or_else(|| issue("This Sketch object has no source layer array"))?
            .value;
        let mut at = span.start;
        for (i, child_id) in old.iter().enumerate() {
            let child = &index.entries[locate(child_id)?];
            if child.parent != Some(n) || child.span.end > span.end {
                return Err(issue("Source parent or child order changed"));
            }
            syntax(at, child.span.start, if i == 0 { b"[" } else { b"," })?;
            at = child.span.end;
            prior.push(child_id);
        }
        syntax(at, span.end, if old.is_empty() { b"[]" } else { b"]" })?;
        let mut children = Vec::with_capacity(new.len());
        for child_id in new {
            children.push(index.entries[locate(child_id)?].span);
            next.push(child_id);
        }
        arrays.insert(span.start, Array { span, children });
    }
    prior.sort_unstable();
    next.sort_unstable();
    if prior != next || prior.windows(2).any(|a| a[0] == a[1]) {
        return Err(issue("Source moves must preserve every child exactly once"));
    }
    let mut plan = Vec::new();
    let mut used = HashSet::new();
    emit(
        Span {
            start: 0,
            end: index.bytes,
        },
        &arrays,
        &mut plan,
        &mut used,
        0,
    )?;
    if used.len() != arrays.len() {
        return Err(issue("Unreachable source layer array"));
    }
    changes.compose_spans(part.base_bytes, &plan).map_err(issue)
}
