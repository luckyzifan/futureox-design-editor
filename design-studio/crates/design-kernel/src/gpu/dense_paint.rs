//! A bounded, pointwise painter program for dense source display. The native
//! compiler supplies exact path programs, colours and stop weights. The GPU
//! still evaluates all four coverage samples and every compositing operation.
use super::{GpuNode, GpuPaint, GpuPath, GpuScene};
use crate::{
    fidelity::SAMPLE_OFFSETS,
    math::{Point, Rect},
    paint::GradientCoordinates,
    render_cancellation,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

const MAX_TEXELS: usize = 768 * 1024;
const MAX_LAYERS: usize = 192;
const MAX_DEPTH: usize = 16;
const MAX_GRID_PIXELS: usize = 32 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DensePaint {
    pub vertex_floats: usize,
    pub width: usize,
    pub height: usize,
    pub nodes: BTreeMap<String, u32>,
    pub sources: BTreeMap<String, u32>,
    /// Component offset of an original interval-program address in the atlas.
    pub relocations: Vec<usize>,
}

type Word = [f32; 4];
#[derive(Default)]
struct Atlas {
    limit: usize,
    words: Vec<Word>,
    relocations: Vec<usize>,
}
impl Atlas {
    fn push(&mut self, word: Word) -> Option<usize> {
        if self.words.len() >= self.limit {
            return None;
        }
        let i = self.words.len();
        self.words.push(word);
        Some(i)
    }
    fn mask(&mut self, path: &GpuPath, word: usize, component: usize) -> Option<()> {
        self.words[word][component] = if path.count == 0 {
            -1.
        } else if path
            .opaque_rect
            .is_some_and(|r| r.intersect(path.rect) == path.rect)
        {
            -2.
        } else {
            let area = path.area.as_ref()?;
            if path.sample_count != Some(4) || area.first > 16_777_216 {
                return None;
            }
            self.relocations.push(word * 4 + component);
            area.first as f32
        };
        Some(())
    }
}

fn rect_word(r: Rect) -> Word {
    [r.x as f32, r.y as f32, r.w as f32, r.h as f32]
}
fn exact_rect(r: Rect) -> bool {
    !r.empty()
        && [r.x, r.y, r.right(), r.bottom()]
            .iter()
            .all(|v| v.unsigned_abs() < 4_000_000)
}
fn colour(scene: &GpuScene, key: &str) -> Option<Word> {
    let [r, g, b, a] = *scene.colors.get(key)?;
    if ![r, g, b, a]
        .iter()
        .all(|v| v.is_finite() && (0.0..=1.0).contains(v) && !v.is_sign_negative())
    {
        return None;
    }
    Some([r * a, g * a, b * a, a])
}
fn brush(
    atlas: &mut Atlas,
    scene: &GpuScene,
    node: &GpuNode,
    path: &GpuPath,
    paint: &GpuPaint,
    align: i32,
) -> Option<()> {
    if !paint.visible || paint.opacity == 0. || path.count == 0 {
        return Some(());
    }
    if paint.blend != "normal" || !(0.0..=1.0).contains(&paint.opacity) || !exact_rect(path.rect) {
        return None;
    }
    let header = atlas.push([0., align as f32, 0., paint.opacity as f32])?;
    atlas.mask(path, header, 2)?;
    atlas.push(rect_word(path.rect))?;
    let mode = atlas.push([0.; 4])?;
    if paint.kind == "solid" {
        atlas.push(colour(scene, &paint.color)?)?;
    } else {
        if !matches!(
            paint.kind.as_str(),
            "linear" | "radial" | "angular" | "diamond"
        ) || paint.stops.is_empty()
            || paint.stops.len() > 32
        {
            return None;
        }
        let mut stops: Vec<_> = paint.stops.iter().collect();
        stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
        if stops.iter().any(|s| !s.offset.is_finite()) {
            return None;
        }
        for stop in &stops {
            atlas.push(colour(scene, &stop.color)?)?;
        }
        let field = atlas.words.len();
        if let Some(fixed) = paint
            .fixed_gradient
            .as_ref()
            .filter(|_| stops.len() == 2 && stops[0].offset == 0. && stops[1].offset == 1.)
        {
            for row in &fixed.words {
                atlas.push(row.map(f32::from))?;
            }
            atlas.words[mode] = [1., 2., field as f32, fixed.bits as f32];
        } else {
            let mut bounds = node.rect.intersect(path.rect);
            if bounds.empty() {
                return None;
            }
            // A zero 64-bit coefficient proves all four stop tuples are
            // constant along that device axis, even for binary64 stop offsets.
            if let Some(fixed) = &paint.fixed_gradient {
                if fixed.words[0].iter().all(|v| *v == 0) {
                    bounds.w = 1;
                }
                if fixed.words[1].iter().all(|v| *v == 0) {
                    bounds.h = 1;
                }
            }
            if bounds.pixels() > MAX_GRID_PIXELS
                || atlas.words.len() + 2 + 2 * bounds.pixels() > atlas.limit
            {
                return None;
            }
            let coord =
                GradientCoordinates::new(&paint.paint, node.size, node.matrix, node.rect).ok()?;
            atlas.push(rect_word(bounds))?;
            for y in bounds.y..bounds.bottom() {
                if y % 16 == 0 && render_cancellation::checkpoint().is_err() {
                    return None;
                }
                for x in bounds.x..bounds.right() {
                    let mut weights = [0.; 4];
                    let mut pairs = [0.; 4];
                    for (i, (dx, dy)) in SAMPLE_OFFSETS.iter().enumerate() {
                        let (a, b, w) =
                            coord.locate(Point::new(f64::from(x) + dx, f64::from(y) + dy))?;
                        if a >= stops.len() || b >= stops.len() || !w.is_finite() {
                            return None;
                        }
                        weights[i] = w;
                        pairs[i] = (a + 64 * b) as f32;
                    }
                    atlas.words.push(weights);
                    atlas.words.push(pairs);
                }
            }
            atlas.words[mode] = [2., stops.len() as f32, field as f32, 0.];
        }
    }
    atlas.words[header][0] = atlas.words.len() as f32;
    Some(())
}
// Each isolation is explicit. A non-normal blend, mask, effect, or
// backdrop-dependent group ends the span and keeps its ordinary renderer.
fn supported(n: &GpuNode, pre_effect: bool) -> bool {
    exact_rect(n.rect)
        && (0.0..=1.0).contains(&n.opacity)
        && !n.mask
        && n.mask_id.is_none()
        && !n.clip
        && n.blend == "normal"
        && !n.passthrough
        && n.capture_replay.is_none()
        && n.texture_replay.is_none()
        && n.source_filter_field.is_none()
        && n.gaussian_region.is_none()
        && n.effects.iter().filter(|e| e.visible).all(|e| {
            pre_effect
                && matches!(
                    e.kind.as_str(),
                    "shadow" | "inner-shadow" | "blur" | "gaussian-blur" | "color-controls"
                )
        })
        && (n.children.is_empty()
            || !n
                .strokes
                .iter()
                .any(|s| s.paint.visible && s.paint.opacity != 0.))
        && n.fills
            .iter()
            .chain(n.strokes.iter().map(|s| &s.paint))
            .filter(|p| p.visible && p.opacity > 0.)
            .all(|p| {
                p.blend == "normal"
                    && matches!(
                        p.kind.as_str(),
                        "solid" | "linear" | "radial" | "diamond" | "angular"
                    )
            })
}
fn count(
    scene: &GpuScene,
    n: &GpuNode,
    depth: usize,
    root_effect: bool,
    memo: &mut HashMap<String, Option<usize>>,
) -> Option<usize> {
    if depth >= MAX_DEPTH {
        return None;
    }
    if !root_effect && let Some(known) = memo.get(&n.id) {
        return *known;
    }
    let value = (|| {
        if n.opacity == 0. || n.rect.empty() {
            return Some(0);
        }
        if !supported(n, root_effect) {
            return None;
        }
        let mut size = 1;
        for id in &n.children {
            if let Some(child) = scene.nodes.get(id) {
                size += count(scene, child, depth + 1, false, memo)?;
            }
            if size > MAX_LAYERS {
                return None;
            }
        }
        Some(size)
    })();
    if !root_effect {
        memo.insert(n.id.clone(), value);
    }
    value
}
fn encode_node(
    a: &mut Atlas,
    scene: &GpuScene,
    n: &GpuNode,
    depth: usize,
    pre_effect: bool,
) -> Option<()> {
    if n.opacity == 0. || n.rect.empty() {
        return Some(());
    }
    if depth >= MAX_DEPTH || !supported(n, pre_effect) {
        return None;
    }
    let start = a.push([0., 0., 0., if pre_effect { 1. } else { n.opacity as f32 }])?;
    a.push(rect_word(n.rect))?;
    let fill = a.push([0.; 4])?;
    a.mask(&n.fill, fill, 0)?;
    a.push(rect_word(n.fill.rect))?;
    for p in &n.fills {
        brush(a, scene, n, &n.fill, p, 0)?;
    }
    for s in &n.strokes {
        let align = match s.align.as_str() {
            "inside" => 1,
            "outside" => -1,
            "center" => 0,
            _ => return None,
        };
        brush(a, scene, n, &s.path, &s.paint, align)?;
    }
    a.words[start][1] = a.words.len() as f32;
    for id in &n.children {
        if let Some(child) = scene.nodes.get(id) {
            encode_node(a, scene, child, depth + 1, false)?;
        }
    }
    a.words[start][0] = a.words.len() as f32;
    Some(())
}
pub(super) fn compile(scene: &mut GpuScene) -> Result<(), String> {
    if !scene.coherent_samples
        || scene.software_raster
        || scene.output.is_none()
        || scene.resolve.is_some()
        || scene.presentation.is_some()
        || scene
            .color_management
            .is_none_or(|c| c.document_space != crate::color::ColorSpace::Srgb)
        || scene.nodes.len() < 16
    {
        return Ok(());
    }
    // Optional parameter data shares the host budget with the ordinary
    // geometry. A small session simply compiles more ordinary draw nodes.
    let limit =
        MAX_TEXELS.min((crate::capacity::memory_budget_bytes() / 512) as usize) / 1024 * 1024;
    if limit == 0 {
        return Ok(());
    }
    let mut atlas = Atlas {
        limit,
        ..Default::default()
    };
    let mut nodes = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut memo = HashMap::new();
    let mut pending = scene.roots.clone();
    pending.reverse();
    let mut seen = HashMap::new();
    while let Some(id) = pending.pop() {
        render_cancellation::checkpoint()?;
        if seen.insert(id.clone(), ()).is_some() {
            continue;
        }
        let Some(n) = scene.nodes.get(&id) else {
            continue;
        };
        let start = atlas.words.len();
        let rel = atlas.relocations.len();
        let effects = n.effects.iter().any(|e| e.visible);
        // Large sparse parents can span several boards. Test their children
        // instead of running the whole instruction tree for each output pixel.
        if !n.rect.empty()
            && n.rect.pixels() <= 65536
            && count(scene, n, 0, effects, &mut memo).is_some()
            && encode_node(&mut atlas, scene, n, 0, effects).is_some()
            && atlas.words.len() > start
        {
            if effects {
                sources.insert(id, start as u32);
            } else {
                nodes.insert(id, start as u32);
            }
        } else {
            atlas.words.truncate(start);
            atlas.relocations.truncate(rel);
            pending.extend(n.children.iter().rev().cloned());
        }
    }
    if nodes.is_empty() && sources.is_empty() {
        return Ok(());
    }
    let width = atlas.words.len().min(1024);
    let height = atlas.words.len().div_ceil(width);
    let vertex_floats = scene.vertices.len();
    atlas.words.resize(width * height, [0.; 4]);
    scene.vertices.extend(atlas.words.into_iter().flatten());
    scene.dense_paint = Some(DensePaint {
        width,
        height,
        vertex_floats,
        nodes,
        sources,
        relocations: atlas.relocations,
    });
    Ok(())
}
