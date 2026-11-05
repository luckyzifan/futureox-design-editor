//! Exact integer scanline spans at the existing four eighth-pixel samples.
//! A span is still geometric coverage. No paint or per-pixel bitmap is stored.
use super::{GpuPath, GpuScene, source_filter::SourceFilter};
use crate::fidelity::SAMPLE_OFFSETS;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};

fn address(f: f32) -> Option<usize> {
    (f.is_finite() && f >= 0. && f <= 16_777_216. && f.fract() == 0.).then_some(f as usize)
}
fn remainder(v: &[f32]) -> Option<f64> {
    let mut bits = 0u64;
    for (i, &limb) in v.iter().enumerate() {
        let n = address(limb)?;
        if n > 65535 {
            return None;
        }
        bits |= (n as u64) << (16 * i);
    }
    let value = f64::from_bits(bits);
    value.is_finite().then_some(value)
}
fn compact(words: &[f32]) -> Option<Vec<f32>> {
    if words.len() < 4 || words[0] != 3. {
        return None;
    }
    let rows = address(words[1])?.checked_mul(4)?;
    let width = address(words[2])?;
    let height = address(words[3])?;
    if width == 0
        || width > 2047
        || height == 0
        || height > 16384
        || rows + 16 * height > words.len()
    {
        return None;
    }
    let mut out = vec![0.; 4 + 4 * height];
    out[..4].copy_from_slice(&[5., 1., width as f32, height as f32]);
    let mut intervals = Vec::<(usize, usize)>::new();
    for row in 0..4 * height {
        if row % 128 == 0 && crate::render_cancellation::checkpoint().is_err() {
            return None;
        }
        intervals.clear();
        let index = rows + 4 * row;
        let start = address(words[index])?.checked_mul(4)?;
        let count = address(words[index + 1])?;
        let offset = SAMPLE_OFFSETS[row % 4].0;
        if count > 0 && start < rows + 16 * height {
            return None;
        }
        let spans = words.get(start..start.checked_add(count.checked_mul(12)?)?)?;
        for span in spans.chunks_exact(12) {
            if ![span[0], span[1]]
                .iter()
                .all(|v| v.is_finite() && v.fract() == 0. && v.abs() < 16_777_216.)
                || ![span[2], span[3]].iter().all(|v| *v == 0. || *v == 1.)
            {
                return None;
            }
            let edge = |floor: f32, upper: f32, delta: f64| {
                ((floor as i64) + i64::from(offset - f64::from(upper) < delta))
                    .clamp(0, width as i64) as usize
            };
            let l = edge(span[0], span[2], remainder(&span[4..8])?);
            let r = edge(span[1], span[3], remainder(&span[8..12])?);
            if r <= l {
                continue;
            }
            if let Some(last) = intervals.last_mut()
                && l <= last.1
            {
                last.1 = last.1.max(r);
            } else {
                intervals.push((l, r));
            }
        }
        let pair = |(l, r): (usize, usize)| (l * (width + 1) + r) as f32;
        out[4 + row] = match intervals.as_slice() {
            [] => 0.,
            [(0, r)] if *r == width => -1.,
            [span] => -(pair(*span) + 2.),
            _ => {
                if out.len() + 1 + intervals.len() >= words.len() || out.len() > 16_777_215 {
                    return None;
                }
                let first = out.len() as f32;
                out.push(intervals.len() as f32);
                out.extend(intervals.iter().copied().map(pair));
                first
            }
        }
    }
    out.resize(out.len().next_multiple_of(4), 0.);
    (out.len() < words.len()).then_some(out)
}
#[derive(Clone, Copy)]
struct Location {
    first: u32,
    count: u32,
    hash: Option<[u32; 2]>,
}
type Locations = BTreeMap<(u32, u32), Location>;
fn remap(path: &mut GpuPath, locations: &Locations) {
    if let Some(a) = path.area.as_mut() {
        let entry = locations[&(a.first, a.count)];
        a.first = entry.first;
        a.count = entry.count;
        if let Some(hash) = entry.hash {
            a.fingerprint = Some(hash);
        }
    }
}
fn remap_filter(field: &mut SourceFilter, locations: &Locations) {
    for channel in &mut field.masks {
        remap(&mut channel.path, locations);
    }
    for child in &mut field.additional {
        remap_filter(child, locations);
    }
}
pub(super) fn pack(scene: &mut GpuScene) -> Result<(), String> {
    if !scene.coherent_samples
        || scene.software_raster
        || scene.output.is_none()
        || scene.curves.len() > 16 * 1024 * 1024
        || scene.curves.len() as u64 * 4 > crate::capacity::memory_budget_bytes() / 8
    {
        return Ok(());
    }
    let mut ranges = BTreeSet::new();
    for n in scene.nodes.values() {
        // Current fields contain one level of additional channels. A future
        // nested descriptor keeps all its original program addresses.
        if n.source_filter_field.as_ref().is_some_and(|f| {
            f.additional
                .iter()
                .any(|other| !other.additional.is_empty())
        }) {
            return Ok(());
        }
        for p in std::iter::once(&n.fill)
            .chain(n.strokes.iter().map(|s| &s.path))
            .chain(
                n.source_filter_field
                    .iter()
                    .flat_map(|f| f.channels().map(|c| &c.path)),
            )
        {
            if p.analytic.is_some() {
                return Ok(());
            }
            if let Some(a) = &p.area {
                ranges.insert((a.first, a.count));
            }
        }
    }
    let mut packed: Vec<f32> = Vec::new();
    let mut locations = Locations::new();
    let mut buckets: HashMap<u64, Vec<Location>> = HashMap::new();
    let mut any = false;
    for (first, count) in ranges {
        crate::render_cancellation::checkpoint()?;
        let start = first as usize * 4;
        let Some(original) = scene.curves.get(start..start + count as usize * 4) else {
            return Ok(());
        };
        let replacement = compact(original);
        any |= replacement.is_some();
        let words = replacement.as_deref().unwrap_or(original);
        let hash = replacement.as_ref().map(|_| {
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            words.len().hash(&mut hash);
            for word in words {
                word.to_bits().hash(&mut hash);
            }
            hash.finish()
        });
        if let Some(previous) = hash.and_then(|h| buckets.get(&h)).and_then(|entries| {
            entries.iter().find(|p| {
                let start = p.first as usize * 4;
                p.count as usize * 4 == words.len()
                    && packed[start..start + words.len()]
                        .iter()
                        .zip(words)
                        .all(|(a, b)| a.to_bits() == b.to_bits())
            })
        }) {
            locations.insert((first, count), *previous);
            continue;
        }
        let loc = Location {
            first: (packed.len() / 4) as u32,
            count: (words.len() / 4) as u32,
            hash: hash.map(|h| [h as u32, (h >> 32) as u32]),
        };
        if let Some(hash) = hash {
            buckets.entry(hash).or_default().push(loc);
        }
        locations.insert((first, count), loc);
        packed.extend_from_slice(words);
    }
    if !any {
        return Ok(());
    }
    for n in scene.nodes.values_mut() {
        remap(&mut n.fill, &locations);
        for stroke in &mut n.strokes {
            remap(&mut stroke.path, &locations);
        }
        if let Some(field) = &mut n.source_filter_field {
            remap_filter(field, &locations);
        }
    }
    scene.curves = packed;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        area_program::AreaProgram,
        math::{Point, Rect},
        path::Contour,
        raster,
    };
    fn hit(words: &[f32], x: usize, y: usize, phase: usize) -> bool {
        let width = words[2] as usize;
        let inside = |v: f32| {
            let p = v as usize;
            x >= p / (width + 1) && x < p % (width + 1)
        };
        let row = words[4 + 4 * y + phase] as i32;
        match row {
            0 => false,
            -1 => true,
            n if n < 0 => inside((-n - 2) as f32),
            n => words[n as usize + 1..n as usize + 1 + words[n as usize] as usize]
                .iter()
                .any(|&v| inside(v)),
        }
    }
    #[test]
    fn compact_rows_match_every_original_sample_including_edges_and_holes() {
        for offset in [
            -33.375_f64,
            -2.125,
            f64::from_bits(3.375_f64.to_bits() + 1),
            5.875,
        ] {
            let polygon = |points: &[(f64, f64)]| Contour {
                points: points
                    .iter()
                    .map(|&(x, y)| Point::new(x + offset, y - 0.125))
                    .collect(),
                closed: true,
            };
            let contours = [
                polygon(&[(0., 0.), (41.5, 1.), (38., 24.), (1.25, 21.)]),
                polygon(&[(9., 4.), (12.5, 19.), (32., 13.), (27., 6.)]),
            ];
            for even_odd in [false, true] {
                let p = AreaProgram::compile_samples(
                    &contours,
                    Rect::new(-100, -20, 200, 60),
                    even_odd,
                )
                .unwrap();
                let packed = compact(&p.data).unwrap();
                let mut expected = vec![false; p.rect.pixels() * 4];
                assert!(
                    raster::visit_sample_spans(&contours, p.rect, even_odd, None, |row, l, r| {
                        let phase = row as usize % 4;
                        let y = row as usize / 4;
                        for x in 0..p.rect.w as usize {
                            let sample = f64::from(p.rect.x) + x as f64 + SAMPLE_OFFSETS[phase].0;
                            expected[(y * p.rect.w as usize + x) * 4 + phase] |=
                                l <= sample && sample < r;
                        }
                        true
                    })
                    .unwrap()
                );
                for y in 0..p.rect.h as usize {
                    for x in 0..p.rect.w as usize {
                        for phase in 0..4 {
                            assert_eq!(
                                hit(&packed, x, y, phase),
                                expected[(y * p.rect.w as usize + x) * 4 + phase]
                            );
                        }
                    }
                }
            }
        }
    }
}
