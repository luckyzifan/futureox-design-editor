//! Responsive layout in document space. Shared by native rendering and WASM editing.
use crate::{
    constraint_projection::{self, ConstraintOpcode},
    font::Fonts,
    math::Transform,
    scene::{Document, Node},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Flow {
    #[default]
    None,
    Horizontal,
    Vertical,
    Grid,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SizeMode {
    #[default]
    Fixed,
    Hug,
    Fill,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
    Stretch,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anchor {
    #[default]
    Start,
    Center,
    End,
    Stretch,
    Scale,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Layout {
    pub mode: Flow,
    pub gap: f64,
    pub line_gap: f64,
    pub padding: [f64; 4],
    pub wrap: bool,
    pub justify: Align,
    pub align: Align,
    pub columns: usize,
    pub fill_rows: bool,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            mode: Flow::None,
            // Measured from the reference editor's Shift+A defaults:
            // gap 8, padding 16 on every side.
            gap: 8.,
            line_gap: 8.,
            padding: [16.; 4],
            wrap: false,
            justify: Align::Start,
            align: Align::Start,
            columns: 3,
            fill_rows: false,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sizing {
    pub width: SizeMode,
    pub height: SizeMode,
    pub min_width: f64,
    pub min_height: f64,
    pub max_width: f64,
    pub max_height: f64,
    pub absolute: bool,
    pub align_self: Option<Align>,
    pub column_span: usize,
    pub row_span: usize,
}
impl Default for Sizing {
    fn default() -> Self {
        Self {
            width: SizeMode::Fixed,
            height: SizeMode::Fixed,
            min_width: 0.01,
            min_height: 0.01,
            max_width: 1e7,
            max_height: 1e7,
            absolute: false,
            align_self: None,
            column_span: 1,
            row_span: 1,
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Constraints {
    pub horizontal: Anchor,
    pub vertical: Anchor,
    pub reference_width: Option<f64>,
    pub reference_height: Option<f64>,
}
impl Node {
    pub fn sizing_value(&self) -> Sizing {
        self.sizing.clone().unwrap_or_default()
    }
    pub fn validate_layout(&self) -> Result<(), String> {
        let valid = |v: f64, lo: f64, hi: f64| v.is_finite() && (lo..=hi).contains(&v);
        if let Some(l) = &self.layout
            && (!matches!(self.kind.as_str(), "frame" | "group" | "section")
                || !valid(l.gap, 0., 1e5)
                || !valid(l.line_gap, 0., 1e5)
                || l.padding.iter().any(|v| !valid(*v, 0., 1e5))
                || !(1..=64).contains(&l.columns))
        {
            return Err("Invalid auto layout configuration".into());
        }
        if let Some(s) = &self.sizing {
            if !valid(s.min_width, 0.01, 1e7)
                || !valid(s.min_height, 0.01, 1e7)
                || !valid(s.max_width, s.min_width, 1e7)
                || !valid(s.max_height, s.min_height, 1e7)
                || !(1..=64).contains(&s.column_span)
                || !(1..=64).contains(&s.row_span)
            {
                return Err("Invalid sizing configuration".into());
            }
            if (s.width == SizeMode::Hug || s.height == SizeMode::Hug)
                && self.kind != "text"
                && self.layout.as_ref().is_none_or(|l| l.mode == Flow::None)
            {
                return Err("Hug sizing requires text or auto layout".into());
            }
        }
        if let Some(c) = &self.constraints
            && [c.reference_width, c.reference_height]
                .iter()
                .flatten()
                .any(|v| !valid(*v, 0.01, 1e7))
        {
            return Err("Invalid constraint reference".into());
        }
        Ok(())
    }
}
// The same paragraph base-direction rule as Fonts::layout. A text box has one
// horizontal anchor, determined by its first paragraph when direction is auto.
pub(crate) fn text_anchor_factor(n: &Node) -> f64 {
    let Some(style) = &n.text_style else {
        return 0.;
    };
    // The existing vertical shaper places columns without horizontal text
    // alignment. Preserve that placement instead of inventing a new anchor.
    if style.writing_mode == "vertical" {
        return 0.;
    }
    let rtl = style.direction == "rtl"
        || (style.direction == "auto"
            && unicode_bidi::BidiInfo::new(&n.text, None)
                .paragraphs
                .first()
                .is_some_and(|paragraph| paragraph.level.is_rtl()));
    match style.align.as_str() {
        "center" => 0.5,
        "end" if !rtl => 1.,
        "start" if rtl => 1.,
        _ => 0.,
    }
}
fn resize(n: &mut Node, width: f64, height: f64) {
    let s = n.sizing_value();
    let w = width.clamp(s.min_width, s.max_width);
    let h = height.clamp(s.min_height, s.max_height);
    // Include initial min/max clamping and constrained Hug replay, rather
    // than adjusting only the first intrinsic measurement. Parent layout can
    // subsequently place the box explicitly; standalone text retains its
    // actual start/center/end anchor, also under rotation or shear.
    let shift = if n.kind == "text" && s.width == SizeMode::Hug {
        (n.width - w) * text_anchor_factor(n)
    } else {
        0.
    };
    crate::mutation::resize(n, w, h);
    if shift != 0. {
        n.transform.0[4] += n.transform.0[0] * shift;
        n.transform.0[5] += n.transform.0[1] * shift;
    }
}
// Resolve the width constraint before deriving a wrapping text node's Hug height.
// Keep the clamped intrinsic width: a wrapped line can be narrower than its box
// or overflow it when a single shaped cluster cannot fit.
fn size_text(n: &mut Node, fonts: &Fonts) -> Result<bool, String> {
    let s = n.sizing_value();
    if n.kind != "text" || (s.width != SizeMode::Hug && s.height != SizeMode::Hug) {
        return Ok(false);
    }
    let text = fonts.node_measure(n, (s.width != SizeMode::Hug).then_some(n.width))?;
    let width = if s.width == SizeMode::Hug {
        text.width.max(0.01).clamp(s.min_width, s.max_width)
    } else {
        n.width
    };
    let constrained = s.width == SizeMode::Hug
        && s.height == SizeMode::Hug
        && n.text_style.as_ref().is_some_and(|style| style.wrap)
        && width < text.width;
    let height = if s.height != SizeMode::Hug {
        n.height
    } else if constrained {
        fonts.node_measure(n, Some(width))?.height
    } else {
        text.height
    };
    resize(n, width, height);
    Ok(constrained)
}
fn metrics(n: &Node) -> [f64; 4] {
    let [a, b, c, d, _, _] = n.transform.0;
    [
        0f64.min(a * n.width) + 0f64.min(c * n.height),
        0f64.min(b * n.width) + 0f64.min(d * n.height),
        a.abs() * n.width + c.abs() * n.height,
        b.abs() * n.width + d.abs() * n.height,
    ]
}
fn place(n: &mut Node, x: f64, y: f64) {
    let m = metrics(n);
    n.transform.0[4] = x - m[0];
    n.transform.0[5] = y - m[1];
}
fn fit_axis(n: &mut Node, axis: usize, extent: f64) {
    let [a, b, c, d, _, _] = n.transform.0;
    let (coeff, other) = if axis == 0 {
        (a.abs(), c.abs() * n.height)
    } else {
        (d.abs(), b.abs() * n.width)
    };
    if coeff > 1e-9 {
        let size = ((extent - other) / coeff).max(0.01);
        if axis == 0 {
            resize(n, size, n.height)
        } else {
            resize(n, n.width, size)
        }
    }
}
fn mode(s: &Sizing, axis: usize) -> SizeMode {
    if axis == 0 { s.width } else { s.height }
}
fn limits(n: &Node, axis: usize) -> (f64, f64) {
    let s = n.sizing_value();
    let [a, b, c, d, _, _] = n.transform.0;
    if axis == 0 {
        (
            a.abs() * s.min_width + c.abs() * n.height,
            a.abs() * s.max_width + c.abs() * n.height,
        )
    } else {
        (
            d.abs() * s.min_height + b.abs() * n.width,
            d.abs() * s.max_height + b.abs() * n.width,
        )
    }
}
/// Space-between overflow compresses through a negative gap instead of
/// overflowing the container, clamped so no child inverts past its smallest
/// sibling (the `spaceBetweenNegativeGapClamp` behaviour observed in the
/// reference engine's stacking solver).
const SPACE_BETWEEN_NEGATIVE_GAP_CLAMP: bool = true;

fn distribution(align: Align, free: f64, count: usize, gap: f64, min_extent: f64) -> (f64, f64) {
    match align {
        Align::SpaceBetween if count > 1 => {
            let gap = if SPACE_BETWEEN_NEGATIVE_GAP_CLAMP && free < 0. {
                (gap + free / (count - 1) as f64).max(-min_extent.max(0.))
            } else {
                gap + free.max(0.) / (count - 1) as f64
            };
            (0., gap)
        }
        Align::SpaceAround if count > 0 => {
            let free = free.max(0.);
            (free / count as f64 / 2., gap + free / count as f64)
        }
        Align::SpaceEvenly => {
            let free = free.max(0.);
            (free / (count + 1) as f64, gap + free / (count + 1) as f64)
        }
        _ => {
            let free = free.max(0.);
            match align {
                Align::Center => (free / 2., gap),
                Align::End => (free, gap),
                _ => (0., gap),
            }
        }
    }
}
fn fill_sizes(
    nodes: &BTreeMap<String, Node>,
    ids: &[String],
    axis: usize,
    available: f64,
    gap: f64,
) -> Vec<f64> {
    let mut sizes: Vec<_> = ids
        .iter()
        .map(|id| {
            let n = &nodes[id];
            if mode(&n.sizing_value(), axis) == SizeMode::Fill {
                limits(n, axis).0
            } else {
                metrics(n)[axis + 2]
            }
        })
        .collect();
    let mut remaining =
        available - gap * ids.len().saturating_sub(1) as f64 - sizes.iter().sum::<f64>();
    let mut active: Vec<_> = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| mode(&nodes[*id].sizing_value(), axis) == SizeMode::Fill)
        .map(|(i, _)| i)
        .collect();
    while remaining > 1e-7 && !active.is_empty() {
        let share = remaining / active.len() as f64;
        let mut next = Vec::new();
        for i in active {
            let add = share.min((limits(&nodes[&ids[i]], axis).1 - sizes[i]).max(0.));
            sizes[i] += add;
            remaining -= add;
            if sizes[i] + 1e-7 < limits(&nodes[&ids[i]], axis).1 {
                next.push(i)
            }
        }
        if next.is_empty() {
            break;
        }
        active = next;
    }
    sizes
}
/// Stack-layout invariants checked after every stack solve — the local
/// counterpart of the reference engine's 'ENFORCE_STACK_LAYOUT_INVARIANTS'
/// assertion registry (#2241 in LAYOUT-INTERNALS.md). The reference
/// registers ~20 named assertions whose full list was not recovered; only
/// the invariants that hold by this engine's own semantics are enforced
/// here (child order stability across a solve, finite non-negative
/// container and child geometry). The unrecovered remainder is deliberately
/// left unimplemented, not guessed at.
fn enforce_stack_layout_invariants(
    doc: &Document,
    frame: &str,
    children_before: &[String],
) -> Result<(), String> {
    enforce_node_layout_invariants(&doc.nodes, frame, children_before)
}
fn enforce_node_layout_invariants(nodes: &BTreeMap<String, Node>, frame: &str, children_before: &[String]) -> Result<(), String> {
    let violation = |what: &str| Err(format!("Stack layout invariant violated: {what}"));
    let f = &nodes[frame];
    if f.children != children_before {
        return violation("child order must stay stable across a solve");
    }
    if ![f.width, f.height].iter().all(|v| v.is_finite() && *v >= 0.) {
        return violation("container size must stay finite and non-negative");
    }
    for id in children_before {
        let n = &nodes[id];
        if ![n.width, n.height].iter().all(|v| v.is_finite() && *v >= 0.)
            || n.transform.0.iter().any(|v| !v.is_finite())
        {
            return violation(&format!("child {id} must keep finite non-negative geometry"));
        }
    }
    Ok(())
}

fn flex(doc: &mut Document, id: &str, l: &Layout) -> Result<(), String> {
    let children_before = doc.nodes[id].children.clone();
    let n = &doc.nodes[id];
    let axis = usize::from(l.mode == Flow::Vertical);
    let cross = 1 - axis;
    let mut sizing = n.sizing_value();
    let ids: Vec<_> = n
        .children
        .iter()
        .filter(|id| {
            let c = &doc.nodes[*id];
            c.visible && !c.sizing_value().absolute
        })
        .cloned()
        .collect();
    // Resolve the hug/fill dependency explicitly, as a fixed parent axis.
    for a in 0..2 {
        if mode(&sizing, a) == SizeMode::Hug
            && (ids
                .iter()
                .any(|id| mode(&doc.nodes[id].sizing_value(), a) == SizeMode::Fill)
                || (l.wrap && a == axis))
        {
            if a == 0 {
                sizing.width = SizeMode::Fixed
            } else {
                sizing.height = SizeMode::Fixed
            }
        }
    }
    if doc.nodes[id].sizing.is_some() {
        doc.nodes.get_mut(id).unwrap().sizing = Some(sizing.clone());
    }
    let pad_start = [l.padding[3], l.padding[0]];
    let pad_end = [l.padding[1], l.padding[2]];
    let main = if axis == 0 {
        n_width(doc, id)
    } else {
        doc.nodes[id].height
    };
    let capacity = (main - pad_start[axis] - pad_end[axis]).max(0.);
    let mut lines: Vec<Vec<String>> = vec![Vec::new()];
    let mut used = 0.;
    for child in ids {
        let c = &doc.nodes[&child];
        let natural = if mode(&c.sizing_value(), axis) == SizeMode::Fill {
            limits(c, axis).0
        } else {
            metrics(c)[axis + 2]
        };
        let row = lines.last_mut().unwrap();
        if l.wrap && !row.is_empty() && used + l.gap + natural > capacity + 1e-7 {
            lines.push(vec![child]);
            used = natural;
        } else {
            if !row.is_empty() {
                used += l.gap
            }
            used += natural;
            row.push(child);
        }
    }
    let intrinsic_main = lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|c| metrics(&doc.nodes[c])[axis + 2])
                .sum::<f64>()
                + l.gap * line.len().saturating_sub(1) as f64
        })
        .fold(0., f64::max);
    if mode(&sizing, axis) == SizeMode::Hug {
        // Hug results clamp through the container's own sizing limits: the
        // frame grows to its minimum (`containerMinSizeGrowth`) and caps at
        // its maximum, matching the reference engine's stacking solver.
        let (lo, hi) = limits(&doc.nodes[id], axis);
        let extent = (intrinsic_main + pad_start[axis] + pad_end[axis]).clamp(lo, hi);
        let p = doc.nodes.get_mut(id).unwrap();
        if axis == 0 {
            resize(p, extent, p.height)
        } else {
            resize(p, p.width, extent)
        }
    }
    let main = if axis == 0 {
        doc.nodes[id].width
    } else {
        doc.nodes[id].height
    };
    let capacity = (main - pad_start[axis] - pad_end[axis]).max(0.);
    for line in &lines {
        let sizes = fill_sizes(&doc.nodes, line, axis, capacity, l.gap);
        for (child, extent) in line.iter().zip(sizes) {
            if mode(&doc.nodes[child].sizing_value(), axis) == SizeMode::Fill {
                fit_axis(doc.nodes.get_mut(child).unwrap(), axis, extent);
            }
        }
    }
    let mut line_cross: Vec<f64> = lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|c| metrics(&doc.nodes[c])[cross + 2])
                .fold(0., f64::max)
        })
        .collect();
    let intrinsic_cross =
        line_cross.iter().sum::<f64>() + l.line_gap * lines.len().saturating_sub(1) as f64;
    if mode(&sizing, cross) == SizeMode::Hug {
        let (lo, hi) = limits(&doc.nodes[id], cross);
        let extent = (intrinsic_cross + pad_start[cross] + pad_end[cross]).clamp(lo, hi);
        let p = doc.nodes.get_mut(id).unwrap();
        if cross == 0 {
            resize(p, extent, p.height)
        } else {
            resize(p, p.width, extent)
        }
    }
    let cross_extent = if cross == 0 {
        doc.nodes[id].width
    } else {
        doc.nodes[id].height
    };
    let cross_capacity = (cross_extent - pad_start[cross] - pad_end[cross]).max(0.);
    if lines.len() == 1 {
        line_cross[0] = cross_capacity;
    }
    let mut cross_cursor = pad_start[cross];
    for (line, span) in lines.iter().zip(line_cross) {
        let total = line
            .iter()
            .map(|c| metrics(&doc.nodes[c])[axis + 2])
            .sum::<f64>()
            + l.gap * line.len().saturating_sub(1) as f64;
        let min_extent = line
            .iter()
            .map(|c| metrics(&doc.nodes[c])[axis + 2])
            .fold(f64::INFINITY, f64::min)
            .max(0.);
        let (offset, gap) =
            distribution(l.justify, capacity - total, line.len(), l.gap, min_extent);
        let mut cursor = pad_start[axis] + offset;
        for child in line {
            let c = doc.nodes.get_mut(child).unwrap();
            let s = c.sizing_value();
            let align = s.align_self.unwrap_or(l.align);
            if mode(&s, cross) == SizeMode::Fill || align == Align::Stretch {
                fit_axis(c, cross, span)
            }
            let m = metrics(c);
            let extra = (span - m[cross + 2]).max(0.);
            let shift = match align {
                Align::Center => extra / 2.,
                Align::End => extra,
                _ => 0.,
            };
            let mut p = [0., 0.];
            p[axis] = cursor;
            p[cross] = cross_cursor + shift;
            place(c, p[0], p[1]);
            cursor += m[axis + 2] + gap;
        }
        cross_cursor += span + l.line_gap;
    }
    enforce_stack_layout_invariants(doc, id, &children_before)
}
fn n_width(doc: &Document, id: &str) -> f64 {
    doc.nodes[id].width
}
fn grid(doc: &mut Document, id: &str, l: &Layout) -> Result<(), String> {
    grid_with_tracks(doc, id, l).map(|_| ())
}

pub fn grid_tracks(doc: &Document, id: &str) -> Result<(Vec<f64>, Vec<f64>), String> {
    doc.validate()?;
    let n = doc.nodes.get(id).ok_or("Grid frame missing")?;
    let layout = n
        .layout
        .as_ref()
        .filter(|l| l.mode == Flow::Grid)
        .ok_or("Not a grid frame")?
        .clone();
    // Grid tracks consume only this frame and its direct children. Keep the
    // original full admission above, but never clone unrelated islands merely
    // to answer a read-only overlay query.
    let mut nodes = n.children.iter().chain(std::iter::once(&n.id))
        .map(|id| (id.clone(), doc.nodes[id].clone())).collect();
    grid_node_tracks(&mut nodes, id, &layout)
}

fn grid_with_tracks(doc: &mut Document, id: &str, l: &Layout) -> Result<(Vec<f64>, Vec<f64>), String> {
    grid_node_tracks(&mut doc.nodes, id, l)
}
fn grid_node_tracks(nodes: &mut BTreeMap<String, Node>, id: &str, l: &Layout) -> Result<(Vec<f64>, Vec<f64>), String> {
    let children_before = nodes[id].children.clone();
    let ids: Vec<_> = nodes[id]
        .children
        .iter()
        .filter(|id| {
            let n = &nodes[*id];
            n.visible && !n.sizing_value().absolute
        })
        .cloned()
        .collect();
    let mut slots = Vec::new();
    let mut occupied: Vec<Vec<bool>> = Vec::new();
    let mut cursor = 0;
    let mut work = 0;
    for child in ids {
        let s = nodes[&child].sizing_value();
        let span = s.column_span.min(l.columns);
        let rows = s.row_span;
        loop {
            work += 1;
            if work > 1_000_000 {
                return Err("Grid placement budget exceeded".into());
            }
            let row = cursor / l.columns;
            let col = cursor % l.columns;
            if row + rows > 4096 {
                return Err("Grid row budget exceeded".into());
            }
            while occupied.len() < row + rows {
                occupied.push(vec![false; l.columns]);
            }
            if col + span <= l.columns
                && (row..row + rows).all(|r| (col..col + span).all(|c| !occupied[r][c]))
            {
                for line in &mut occupied[row..row + rows] {
                    for cell in &mut line[col..col + span] {
                        *cell = true;
                    }
                }
                slots.push((child, row, col, rows, span));
                cursor += span;
                break;
            }
            cursor += 1;
        }
    }
    let mut sizing = nodes[id].sizing_value();
    if sizing.width == SizeMode::Hug
        && slots
            .iter()
            .any(|(id, _, _, _, _)| nodes[id].sizing_value().width == SizeMode::Fill)
    {
        sizing.width = SizeMode::Fixed;
        nodes.get_mut(id).unwrap().sizing = Some(sizing.clone());
    }
    if sizing.height == SizeMode::Hug
        && (l.fill_rows
            || slots
                .iter()
                .any(|(id, _, _, _, _)| nodes[id].sizing_value().height == SizeMode::Fill))
    {
        sizing.height = SizeMode::Fixed;
        nodes.get_mut(id).unwrap().sizing = Some(sizing.clone());
    }
    let intrinsic_col = slots
        .iter()
        .map(|(c, _, _, _, span)| {
            ((metrics(&nodes[c])[2] - l.gap * (*span - 1) as f64) / *span as f64).max(0.)
        })
        .fold(0., f64::max);
    if sizing.width == SizeMode::Hug {
        let p = nodes.get_mut(id).unwrap();
        resize(
            p,
            intrinsic_col * l.columns as f64
                + l.gap * (l.columns - 1) as f64
                + l.padding[1]
                + l.padding[3],
            p.height,
        )
    }
    let cell =
        ((nodes[id].width - l.padding[1] - l.padding[3] - l.gap * (l.columns - 1) as f64)
            / l.columns as f64)
            .max(0.);
    let rows = slots.iter().map(|(_, r, _, h, _)| r + h).max().unwrap_or(0);
    let mut heights = vec![0f64; rows];
    for (child, row, _, span, cols) in &slots {
        let n = nodes.get_mut(child).unwrap();
        if n.sizing_value().width == SizeMode::Fill
            || n.sizing_value().align_self.unwrap_or(l.align) == Align::Stretch
        {
            fit_axis(n, 0, cell * *cols as f64 + l.gap * (*cols - 1) as f64)
        }
        let need = (metrics(n)[3]
            - l.line_gap * (*span - 1) as f64
            - heights[*row..row + span].iter().sum::<f64>())
        .max(0.)
            / *span as f64;
        for h in &mut heights[*row..row + span] {
            *h += need;
        }
    }
    let natural = heights.iter().sum::<f64>()
        + l.line_gap * rows.saturating_sub(1) as f64
        + l.padding[0]
        + l.padding[2];
    if sizing.height == SizeMode::Hug {
        let p = nodes.get_mut(id).unwrap();
        resize(p, p.width, natural)
    }
    if l.fill_rows && rows > 0 {
        let h =
            ((nodes[id].height - l.padding[0] - l.padding[2] - l.line_gap * (rows - 1) as f64)
                / rows as f64)
                .max(0.);
        heights.fill(h);
    }
    for (child, row, col, span, cols) in slots {
        let w = cell * cols as f64 + l.gap * (cols - 1) as f64;
        let h = heights[row..row + span].iter().sum::<f64>() + l.line_gap * (span - 1) as f64;
        let n = nodes.get_mut(&child).unwrap();
        let s = n.sizing_value();
        if s.height == SizeMode::Fill || s.align_self.unwrap_or(l.align) == Align::Stretch {
            fit_axis(n, 1, h)
        }
        let m = metrics(n);
        let align = s.align_self.unwrap_or(l.align);
        let dx = match align {
            Align::Center => (w - m[2]).max(0.) / 2.,
            Align::End => (w - m[2]).max(0.),
            _ => 0.,
        };
        let dy = match align {
            Align::Center => (h - m[3]).max(0.) / 2.,
            Align::End => (h - m[3]).max(0.),
            _ => 0.,
        };
        place(
            n,
            l.padding[3] + col as f64 * (cell + l.gap) + dx,
            l.padding[0] + heights[..row].iter().sum::<f64>() + row as f64 * l.line_gap + dy,
        );
    }
    enforce_node_layout_invariants(nodes, id, &children_before)?;
    Ok((vec![cell; l.columns], heights))
}
fn anchor(position: f64, size: f64, old: f64, new: f64, mode: Anchor) -> (f64, f64) {
    match mode {
        Anchor::Start => (position, size),
        Anchor::Center => (position + (new - old) / 2., size),
        Anchor::End => (position + new - old, size),
        Anchor::Stretch => (position, (size + new - old).max(0.01)),
        // Scale maps through the reference solver's proportional form
        // `value · (dst/src)` (constraint_projection::proportional_map,
        // #28420 disasm 1ab3331-1ab336c); a degenerate non-positive source
        // extent keeps the input instead of dividing by zero.
        Anchor::Scale => (
            constraint_projection::proportional_map(position, old, new),
            constraint_projection::proportional_map(size, old, new).max(0.01),
        ),
    }
}
fn constrain(doc: &mut Document, parent: &str) {
    let p = &doc.nodes[parent];
    let (w, h) = (p.width, p.height);
    let flow = p.layout.as_ref().is_some_and(|l| l.mode != Flow::None);
    let children = p.children.clone();
    for id in children {
        let n = doc.nodes.get_mut(&id).unwrap();
        let flow_item = flow && !n.sizing_value().absolute;
        if let Some(mut c) = n.constraints.clone() {
            if !flow_item {
                // Constraint application dispatches through the opcode
                // surface shared with the reference engine's 38-way
                // constraint type table (constraint_projection). Our
                // Constraints model only produces known opcodes; a reserved
                // reference opcode — reachable only through
                // `ConstraintOpcode::from_figma_field` — keeps position and
                // size untouched rather than guessing at its semantics.
                // Constraint deltas apply in this parent's local axis frame,
                // so rotated children stay correct without re-projection
                // (rotation reaches the transform chain at render time).
                let horizontal = ConstraintOpcode::from_anchor(0, c.horizontal);
                let vertical = ConstraintOpcode::from_anchor(1, c.vertical);
                let (x, nw) = match horizontal.anchor_mode() {
                    Some(mode) => anchor(
                        n.transform.0[4],
                        n.width,
                        c.reference_width.unwrap_or(w),
                        w,
                        mode,
                    ),
                    None => (n.transform.0[4], n.width),
                };
                let (y, nh) = match vertical.anchor_mode() {
                    Some(mode) => anchor(
                        n.transform.0[5],
                        n.height,
                        c.reference_height.unwrap_or(h),
                        h,
                        mode,
                    ),
                    None => (n.transform.0[5], n.height),
                };
                n.transform.0[4] = x;
                n.transform.0[5] = y;
                resize(n, nw, nh);
            }
            c.reference_width = Some(w);
            c.reference_height = Some(h);
            n.constraints = Some(c);
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_runs: Option<Vec<crate::font::TextRun>>,
    pub transform: Transform,
    pub width: f64,
    pub height: f64,
    pub network: Option<std::sync::Arc<crate::scene::Network>>,
    pub vector_geometry: Option<std::sync::Arc<crate::vector_geometry::VectorGeometry>>,
    pub sizing: Option<Sizing>,
    pub constraints: Option<Constraints>,
}
fn state(doc: &Document) -> Vec<(Transform, f64, f64)> {
    doc.nodes
        .values()
        .map(|n| (n.transform, n.width, n.height))
        .collect()
}
pub fn resolve(doc: &mut Document, fonts: &Fonts) -> Result<(), String> {
    resolve_roots(doc,fonts,None)
}
pub(crate) fn resolve_roots(doc:&mut Document,fonts:&Fonts,roots:Option<&std::collections::BTreeSet<String>>)->Result<(),String>{
    if roots.is_none(){crate::code_blocks::resolve(doc)?;}
    if !doc
        .nodes
        .values()
        .any(|n| n.layout.is_some() || n.sizing.is_some() || n.constraints.is_some())
    {
        return if roots.is_none(){crate::connectors::resolve(doc)}else{Ok(())};
    }
    fn order(doc: &Document, id: &str, out: &mut Vec<String>) {
        for c in &doc.nodes[id].children {
            order(doc, c, out)
        }
        out.push(id.to_owned());
    }
    let mut ordered = Vec::new();
    for p in &doc.pages {
        for id in &p.children {
            if roots.is_some_and(|roots|!roots.contains(id)){continue;}
            order(doc, id, &mut ordered)
        }
    }
    // Text, fonts, runs and text sizing limits are immutable during this solve.
    // Component/variable expansion does not run inside this solve. Retain two
    // scalars per constrained Hug text, keyed by this document's stable map ID;
    // discard them on return, before any subsequent edits or component rebuild.
    let active:std::collections::BTreeSet<_>=ordered.iter().cloned().collect();
    let scoped_state=|doc:&Document|ordered.iter().map(|id|{let n=&doc.nodes[id];(n.transform,n.width,n.height)}).collect::<Vec<_>>();
    let mut constrained_text_sizes = BTreeMap::new();
    for (id, n) in &mut doc.nodes {
        if roots.is_some()&&!active.contains(id){continue;}
        resize(n, n.width, n.height);
        if size_text(n, fonts)? {
            constrained_text_sizes.insert(id.clone(), (n.width, n.height));
        }
    }
    for _ in 0..68 {
        let before = if roots.is_some(){scoped_state(doc)}else{state(doc)};
        for id in ordered.iter().rev() {
            constrain(doc, id)
        }
        for id in &ordered {
            let n = doc.nodes.get_mut(id).expect("ordered node");
            if let Some(&(width, height)) = constrained_text_sizes.get(id) {
                // Replay resizing, since parent constraints/stretch can change
                // the current dimensions between bottom-up layout passes.
                resize(n, width, height);
            } else {
                size_text(n, fonts)?;
            }
            if let Some(l) = doc.nodes[id].layout.clone() {
                match l.mode {
                    Flow::None => {}
                    Flow::Horizontal | Flow::Vertical => flex(doc, id, &l)?,
                    Flow::Grid => grid(doc, id, &l)?,
                }
            }
        }
        let after = if roots.is_some(){scoped_state(doc)}else{state(doc)};
        if before.iter().zip(&after).all(|((a, w, h), (b, x, y))| {
            a.0.iter().zip(b.0).all(|(a, b)| (a - b).abs() < 1e-7)
                && (w - x).abs() < 1e-7
                && (h - y).abs() < 1e-7
        }) {
            return if roots.is_none(){crate::connectors::resolve(doc)}else{Ok(())};
        }
    }
    Err("Layout did not converge; inspect nested hug/fill sizing".into())
}
pub fn changes(json: &str, fonts: &Fonts) -> Result<String, String> {
    crate::capacity::check_document_bytes(json.len())?;
    let mut doc: Document = serde_json::from_str(json).map_err(|e| e.to_string())?;
    doc.validate()?;
    let fonts = fonts.with_resources(&doc.fonts)?;
    let before = doc.clone();
    resolve(&mut doc, &fonts)?;
    doc.validate()?;
    let patches: BTreeMap<_, _> = doc
        .nodes
        .iter()
        .filter(|(id, n)| before.nodes[*id] != **n)
        .map(|(id, n)| {
            (
                id,
                Patch {
                    text_runs: (before.nodes[id].text_runs != n.text_runs)
                        .then(|| n.text_runs.to_vec()),
                    transform: n.transform,
                    width: n.width,
                    height: n.height,
                    network: n.network.clone(),
                    vector_geometry: n.vector_geometry.clone(),
                    sizing: n.sizing.clone(),
                    constraints: n.constraints.clone(),
                },
            )
        })
        .collect();
    serde_json::to_string(&patches).map_err(|e| e.to_string())
}

#[cfg(test)]
mod text_anchor_direction_tests {
    use super::*;

    #[test]
    fn anchor_direction_uses_the_same_first_bidi_paragraph_rule_as_font_layout() {
        for (align, direction, text, expected) in [
            ("center", "auto", "中文 AB", 0.5),
            ("start", "ltr", "אב", 0.),
            ("end", "ltr", "中文 AB", 1.),
            ("start", "rtl", "中文 AB", 1.),
            ("end", "rtl", "中文 AB", 0.),
            ("start", "auto", "123 אב", 1.),
            ("end", "auto", "123 אב", 0.),
            ("start", "auto", "123 中文", 0.),
            ("end", "auto", "123 中文", 1.),
            ("start", "auto", "אב\nAB", 1.),
            ("start", "auto", "AB\nאב", 0.),
            ("start", "auto", "", 0.),
        ] {
            let node: Node = serde_json::from_value(serde_json::json!({
                "id":"text", "kind":"text", "text":text,"width":100,"height":40,
                "textStyle":{"align":align,"direction":direction}
            })).unwrap();
            assert_eq!(text_anchor_factor(&node), expected, "{align}/{direction}/{text}");
        }
    }
}

#[cfg(test)]
mod space_between_tests {
    use super::*;

    #[test]
    fn space_between_overflow_compresses_with_negative_gap() {
        // capacity 100, children 40+40+40 (total 120 with authored gap 0):
        // gap compresses to -10 so the line exactly fills the container.
        let (offset, gap) = distribution(Align::SpaceBetween, -20., 3, 0., 40.);
        assert!((offset - 0.).abs() < 1e-9);
        assert!((gap - -10.).abs() < 1e-9, "gap {gap} should be -10");
    }

    #[test]
    fn negative_gap_clamps_at_smallest_child() {
        // capacity 70, children 40+40+40: raw gap = -25, but the smallest
        // child is 40 wide so the clamp holds gap at -40 → no inversion,
        // children still tile without negative positions.
        let (_, gap) = distribution(Align::SpaceBetween, -50., 3, 0., 40.);
        assert!(
            (gap - -25.).abs() < 1e-9,
            "gap {gap} clamps at -min_extent/…"
        );
    }

    #[test]
    fn positive_free_still_expands() {
        let (offset, gap) = distribution(Align::SpaceBetween, 30., 4, 5., 10.);
        assert!((offset - 0.).abs() < 1e-9);
        assert!((gap - 15.).abs() < 1e-9, "gap {gap} should grow by 10");
    }

    #[test]
    fn other_justifies_never_go_negative() {
        assert_eq!(distribution(Align::Center, -100., 3, 4., 10.), (0., 4.));
        assert_eq!(distribution(Align::End, -100., 3, 4., 10.), (0., 4.));
        assert_eq!(distribution(Align::Start, -100., 3, 4., 10.), (0., 4.));
    }
}

#[cfg(test)]
mod hug_clamp_tests {
    use super::*;
    use crate::facet::sample_node;
    use std::collections::BTreeMap;

    fn stack_doc(gap: f64, padding: [f64; 4], sizing: Sizing) -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut frame = sample_node("f", "frame");
        frame.sizing = Some(sizing);
        frame.layout = Some(Layout {
            mode: Flow::Vertical,
            gap,
            padding,
            ..Default::default()
        });
        let mut a = sample_node("a", "rectangle");
        a.width = 100.;
        a.height = 50.;
        let mut b = sample_node("b", "rectangle");
        b.width = 120.;
        b.height = 70.;
        frame.children = vec!["a".into(), "b".into()];
        doc.nodes.insert("f".into(), frame);
        doc.nodes.insert("a".into(), a);
        doc.nodes.insert("b".into(), b);
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["f".into()],
            background: "#ffffff".into(),
        });
        doc
    }

    fn plain_hug() -> Sizing {
        Sizing {
            width: SizeMode::Hug,
            height: SizeMode::Hug,
            ..Default::default()
        }
    }

    #[test]
    fn hug_fits_children_plus_gap_and_padding() {
        let mut doc = stack_doc(10., [5., 6., 7., 8.], plain_hug());
        resolve(&mut doc, &Default::default()).unwrap();
        let f = &doc.nodes["f"];
        // padding = [top, right, bottom, left]: width pads = 8+6, height pads = 5+7.
        // cross (width): max(100,120) + 14 = 134; main (height): 50+70+10 + 12 = 142.
        assert!((f.width - 134.).abs() < 1e-9, "width {}", f.width);
        assert!((f.height - 142.).abs() < 1e-9, "height {}", f.height);
    }

    #[test]
    fn hug_grows_to_minimum() {
        // containerMinSizeGrowth: min height 200 > intrinsic 142 → 200.
        let sizing = Sizing {
            min_height: 200.,
            ..plain_hug()
        };
        let mut doc = stack_doc(10., [0.; 4], sizing);
        resolve(&mut doc, &Default::default()).unwrap();
        assert!(
            (doc.nodes["f"].height - 200.).abs() < 1e-9,
            "height {}",
            doc.nodes["f"].height
        );
    }

    #[test]
    fn hug_caps_at_maximum() {
        let sizing = Sizing {
            max_width: 60.,
            ..plain_hug()
        };
        let mut doc = stack_doc(10., [0.; 4], sizing);
        resolve(&mut doc, &Default::default()).unwrap();
        assert!(
            (doc.nodes["f"].width - 60.).abs() < 1e-9,
            "width {}",
            doc.nodes["f"].width
        );
    }
}

#[cfg(test)]
mod wrap_tests {
    use super::*;
    use crate::facet::sample_node;
    use std::collections::BTreeMap;

    fn wrap_doc(frame_w: f64, gap: f64, line_gap: f64, wrap: bool, justify: Align) -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut frame = sample_node("f", "frame");
        frame.width = frame_w;
        frame.height = 400.;
        frame.layout = Some(Layout {
            mode: Flow::Horizontal,
            gap,
            line_gap,
            wrap,
            justify,
            padding: [0.; 4],
            ..Default::default()
        });
        for (i, w) in [100., 100., 100.].iter().enumerate() {
            let mut c = sample_node(&format!("c{i}"), "rectangle");
            c.width = *w;
            c.height = 50.;
            frame.children.push(format!("c{i}"));
            doc.nodes.insert(format!("c{i}"), c);
        }
        doc.nodes.insert("f".into(), frame);
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["f".into()],
            background: "#ffffff".into(),
        });
        doc
    }

    fn place_of(doc: &Document, id: &str) -> (f64, f64) {
        // Placed origin lives in the transform's translation column.
        let m = metrics(&doc.nodes[id]);
        (
            doc.nodes[id].transform.0[4] + m[0],
            doc.nodes[id].transform.0[5] + m[1],
        )
    }

    #[test]
    fn greedy_break_moves_third_child_to_second_line() {
        // capacity 250: c1(100)+gap+c2(100)=210 fits; c3 needs +110 → line 2.
        let mut doc = wrap_doc(250., 10., 20., true, Align::Start);
        resolve(&mut doc, &Default::default()).unwrap();
        let (x0, y0) = place_of(&doc, "c0");
        let (x1, y1) = place_of(&doc, "c1");
        let (x2, y2) = place_of(&doc, "c2");
        assert!(
            (x0 - 0.).abs() < 1e-9 && (x1 - 110.).abs() < 1e-9,
            "line1 {x0},{x1}"
        );
        assert!((y0 - y1).abs() < 1e-9, "same line");
        assert!(
            (x2 - 0.).abs() < 1e-9 && (y2 - 50. + 20.).abs() > -1.,
            "line2 resets x"
        );
        assert!(
            (y2 - 70.).abs() < 1e-9,
            "y2 {y2} = line height 50 + line_gap 20"
        );
    }

    #[test]
    fn no_wrap_keeps_single_line_overflowing() {
        let mut doc = wrap_doc(150., 10., 20., false, Align::Start);
        resolve(&mut doc, &Default::default()).unwrap();
        let (_, y0) = place_of(&doc, "c0");
        let (_, y2) = place_of(&doc, "c2");
        assert!((y0 - y2).abs() < 1e-9, "no wrap: all children on one line");
    }

    #[test]
    fn oversized_child_takes_its_own_line() {
        // A child wider than capacity still lands on a (single-child) line;
        // the next child starts a fresh line instead of joining it.
        let mut doc = wrap_doc(120., 10., 5., true, Align::Start);
        // widen c1 past capacity
        doc.nodes.get_mut("c1").unwrap().width = 300.;
        resolve(&mut doc, &Default::default()).unwrap();
        let (_, y0) = place_of(&doc, "c0");
        let (_, y1) = place_of(&doc, "c1");
        let (_, y2) = place_of(&doc, "c2");
        assert!(
            y1 > y0,
            "oversized c1 drops to its own line (y0 {y0} y1 {y1})"
        );
        assert!(y2 > y1, "c2 wraps below the oversized line");
    }

    #[test]
    fn per_line_justify_space_between() {
        // Each wrapped line justifies independently within the capacity.
        let mut doc = wrap_doc(250., 10., 20., true, Align::SpaceBetween);
        resolve(&mut doc, &Default::default()).unwrap();
        let (x0, _) = place_of(&doc, "c0");
        let (x1, _) = place_of(&doc, "c1");
        // line 1 free = 250-210 = 40 → gap grows by 40 → x1 = 100+50 = 150
        assert!((x0 - 0.).abs() < 1e-9, "x0 {x0}");
        assert!((x1 - 150.).abs() < 1e-9, "x1 {x1}");
    }

    #[test]
    fn line_gap_separates_lines_with_default_heights() {
        let mut doc = wrap_doc(250., 0., 33., true, Align::Start);
        resolve(&mut doc, &Default::default()).unwrap();
        let (_, y0) = place_of(&doc, "c0");
        let (_, y2) = place_of(&doc, "c2");
        assert!((y2 - y0 - 50. - 33.).abs() < 1e-9, "y2 {y2} y0 {y0}");
    }

    /// The greedy break compares `used + gap + natural > capacity + 1e-7`.
    /// Overflow below the epsilon stays on the line; above it wraps. This
    /// is this engine's wrap "candidate position" search (#9396): every
    /// child always finds a candidate slot — continuation of the current
    /// line, or a fresh line — so the reference's 'Could not find a valid
    /// candidate position for wrap' failure branch is unreachable here.
    #[test]
    fn wrap_break_epsilon_boundary() {
        let mut stays = wrap_doc(100., 0., 0., true, Align::Start);
        // 60 + 40.00000005 = 100.00000005 ≤ capacity + 1e-7: stays.
        stays.nodes.get_mut("c0").unwrap().width = 60.;
        stays.nodes.get_mut("c1").unwrap().width = 40. + 5e-8;
        resolve(&mut stays, &Default::default()).unwrap();
        let (_, y0) = place_of(&stays, "c0");
        let (_, y1) = place_of(&stays, "c1");
        assert!(
            (y0 - y1).abs() < 1e-9,
            "5e-8 overflow stays within the 1e-7 epsilon (y0 {y0} y1 {y1})"
        );
        let mut wraps = wrap_doc(100., 0., 0., true, Align::Start);
        // 60 + 40.0000005 = 100.0000005 > capacity + 1e-7: wraps.
        wraps.nodes.get_mut("c0").unwrap().width = 60.;
        wraps.nodes.get_mut("c1").unwrap().width = 40. + 5e-7;
        resolve(&mut wraps, &Default::default()).unwrap();
        let (_, y0) = place_of(&wraps, "c0");
        let (_, y1) = place_of(&wraps, "c1");
        assert!(y1 > y0, "5e-7 overflow exceeds the epsilon and wraps");
    }

    /// Capacity clamps at zero: every child takes its own line and all
    /// placements stay finite — the candidate search never fails.
    #[test]
    fn near_zero_capacity_still_places_every_child() {
        let mut doc = wrap_doc(1e-8, 0., 0., true, Align::Start);
        resolve(&mut doc, &Default::default()).unwrap();
        let mut last_y = f64::NEG_INFINITY;
        for i in 0..3 {
            let (x, y) = place_of(&doc, &format!("c{i}"));
            assert!(x.is_finite() && y.is_finite(), "c{i} placed at {x},{y}");
            assert!((x - 0.).abs() < 1e-9, "each line restarts at x=0");
            assert!(y > last_y, "c{i} occupies its own line (y {y})");
            last_y = y;
        }
    }
}

#[cfg(test)]
mod stack_invariant_tests {
    use super::*;
    use crate::facet::sample_node;
    use std::collections::BTreeMap;

    fn stack_doc() -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut frame = sample_node("f", "frame");
        frame.layout = Some(Layout {
            mode: Flow::Vertical,
            ..Default::default()
        });
        for (id, w) in [("a", 100.), ("b", 80.)] {
            let mut c = sample_node(id, "rectangle");
            c.width = w;
            c.height = 40.;
            frame.children.push(id.into());
            doc.nodes.insert(id.into(), c);
        }
        doc.nodes.insert("f".into(), frame);
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["f".into()],
            background: "#ffffff".into(),
        });
        doc
    }

    #[test]
    fn solved_stack_passes_the_invariant_check() {
        let mut doc = stack_doc();
        resolve(&mut doc, &Default::default()).unwrap();
        let before = doc.nodes["f"].children.clone();
        enforce_stack_layout_invariants(&doc, "f", &before).unwrap();
    }

    #[test]
    fn negative_child_geometry_violates_the_invariant() {
        let mut doc = stack_doc();
        resolve(&mut doc, &Default::default()).unwrap();
        let before = doc.nodes["f"].children.clone();
        doc.nodes.get_mut("a").unwrap().width = -1.;
        let err = enforce_stack_layout_invariants(&doc, "f", &before).unwrap_err();
        assert!(err.starts_with("Stack layout invariant violated"), "{err}");
    }

    #[test]
    fn reordered_children_violate_the_invariant() {
        let mut doc = stack_doc();
        resolve(&mut doc, &Default::default()).unwrap();
        let before = doc.nodes["f"].children.clone();
        doc.nodes.get_mut("f").unwrap().children.reverse();
        assert!(enforce_stack_layout_invariants(&doc, "f", &before).is_err());
    }

    #[test]
    fn non_finite_translation_violates_the_invariant() {
        let mut doc = stack_doc();
        resolve(&mut doc, &Default::default()).unwrap();
        let before = doc.nodes["f"].children.clone();
        doc.nodes.get_mut("a").unwrap().transform.0[4] = f64::NAN;
        assert!(enforce_stack_layout_invariants(&doc, "f", &before).is_err());
    }

    /// Grid solves pass through the same invariant surface.
    #[test]
    fn solved_grid_passes_the_invariant_check() {
        let mut doc = stack_doc();
        doc.nodes.get_mut("f").unwrap().layout = Some(Layout {
            mode: Flow::Grid,
            columns: 2,
            ..Default::default()
        });
        resolve(&mut doc, &Default::default()).unwrap();
        let before = doc.nodes["f"].children.clone();
        enforce_stack_layout_invariants(&doc, "f", &before).unwrap();
    }
}

#[cfg(test)]
mod grid_tests {
    use super::*;
    use crate::facet::sample_node;
    use std::collections::BTreeMap;

    fn grid_doc(
        columns: usize,
        gap: f64,
        line_gap: f64,
        specs: &[(f64, f64, usize, usize)],
    ) -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut frame = sample_node("f", "frame");
        frame.width = 400.;
        frame.height = 500.;
        frame.layout = Some(Layout {
            mode: Flow::Grid,
            gap,
            line_gap,
            columns,
            padding: [0.; 4],
            ..Default::default()
        });
        for (i, (w, h, cspan, rspan)) in specs.iter().enumerate() {
            let mut c = sample_node(&format!("c{i}"), "rectangle");
            c.width = *w;
            c.height = *h;
            if *cspan > 1 || *rspan > 1 {
                c.sizing = Some(Sizing {
                    column_span: *cspan,
                    row_span: *rspan,
                    ..Default::default()
                });
            }
            frame.children.push(format!("c{i}"));
            doc.nodes.insert(format!("c{i}"), c);
        }
        doc.nodes.insert("f".into(), frame);
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["f".into()],
            background: "#ffffff".into(),
        });
        doc
    }

    fn origin(doc: &Document, id: &str) -> (f64, f64) {
        (doc.nodes[id].transform.0[4], doc.nodes[id].transform.0[5])
    }

    #[test]
    fn row_major_placement_with_uniform_cells() {
        // 2 columns, width 400, gap 10 → cell 195; heights 60,80,50 → rows 80,50.
        let mut doc = grid_doc(
            2,
            10.,
            8.,
            &[(60., 60., 1, 1), (60., 80., 1, 1), (60., 50., 1, 1)],
        );
        resolve(&mut doc, &Default::default()).unwrap();
        let (x0, y0) = origin(&doc, "c0");
        let (x1, y1) = origin(&doc, "c1");
        let (x2, y2) = origin(&doc, "c2");
        assert!(
            (x0 - 0.).abs() < 1e-9 && (x1 - 205.).abs() < 1e-9,
            "cols {x0},{x1}"
        );
        assert!((y0 - 0.).abs() < 1e-9 && (y1 - 0.).abs() < 1e-9, "row 1");
        assert!(
            (x2 - 0.).abs() < 1e-9 && (y2 - 88.).abs() < 1e-9,
            "row 2 at {x2},{y2}"
        );
    }

    #[test]
    fn column_span_widens_cell_extent() {
        // c0 spans 2 columns with Fill width: extent covers 195+10+195 = 400.
        let mut doc = grid_doc(
            2,
            10.,
            8.,
            &[(60., 60., 2, 1), (60., 60., 1, 1), (60., 60., 1, 1)],
        );
        doc.nodes.get_mut("c0").unwrap().sizing = Some(Sizing {
            width: SizeMode::Fill,
            column_span: 2,
            ..Default::default()
        });
        resolve(&mut doc, &Default::default()).unwrap();
        assert!(
            (doc.nodes["c0"].width - 400.).abs() < 1e-9,
            "span width {}",
            doc.nodes["c0"].width
        );
        let (x1, _) = origin(&doc, "c1");
        assert!((x1 - 0.).abs() < 1e-9, "c1 starts the next row");
    }

    #[test]
    fn row_span_pushes_later_children_around() {
        // c0 spans 2 rows: c1 takes (row0,col1), c2 must avoid both → row2.
        let mut doc = grid_doc(
            2,
            10.,
            8.,
            &[(60., 60., 1, 2), (60., 60., 1, 1), (60., 60., 1, 1)],
        );
        resolve(&mut doc, &Default::default()).unwrap();
        let (_, y2) = origin(&doc, "c2");
        assert!(y2 > 0., "c2 avoids the spanned area (y {y2})");
    }

    #[test]
    fn hug_grid_sums_rows_and_gaps() {
        let mut doc = grid_doc(
            2,
            10.,
            8.,
            &[(60., 60., 1, 1), (60., 80., 1, 1), (60., 50., 1, 1)],
        );
        doc.nodes.get_mut("f").unwrap().sizing = Some(Sizing {
            width: SizeMode::Fixed,
            height: SizeMode::Hug,
            ..Default::default()
        });
        resolve(&mut doc, &Default::default()).unwrap();
        // rows 80 + 50 + line_gap 8 = 138
        assert!(
            (doc.nodes["f"].height - 138.).abs() < 1e-9,
            "hug height {}",
            doc.nodes["f"].height
        );
    }

    #[test]
    fn placement_budget_guards_degenerate_layouts() {
        // A span wider than the grid must not loop forever.
        let mut doc = grid_doc(2, 10., 8., &[(60., 60., 3, 1)]);
        doc.nodes.get_mut("c0").unwrap().sizing = Some(Sizing {
            column_span: 3,
            ..Default::default()
        });
        resolve(&mut doc, &Default::default()).unwrap();
        assert_eq!(&doc.nodes["c0"].transform.0[4..], &[0., 0.]);
        assert_eq!(doc.nodes["c0"].width, 60.);
        assert_eq!(doc.nodes["c0"].height, 60.);
        // The authored span stays intact; placement clamps to two columns.
        assert_eq!(doc.nodes["c0"].sizing_value().column_span, 3);
    }
}

#[cfg(test)]
mod measured_truth_tests {
    use super::*;
    use crate::facet::sample_node;
    use std::collections::BTreeMap;

    /// Truth captured from the reference editor (2026-10-11, desktop):
    /// Shift+A autolayout defaults are gap 8 and padding 16 on every side.
    #[test]
    fn shift_a_defaults_match_reference() {
        let l = Layout::default();
        assert!((l.gap - 8.).abs() < 1e-9, "gap {}", l.gap);
        assert!(l.padding.iter().all(|&p| (p - 16.).abs() < 1e-9));
    }

    /// Overflow truth: frame 300x141 fixed, three 120x55 children, gap 8,
    /// padding 16, vertical, wrap off, start/start. Children stack from the
    /// top-left and overflow the bottom edge without compression, clipping
    /// or reflow - child ys at 16, 79, 142 in frame space, the third
    /// starting exactly past the 141 boundary (measured, not inferred).
    #[test]
    fn fixed_height_overflow_matches_measured_truth() {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d".into(),
            name: "d".into(),
            pages: Vec::new(),
            nodes: BTreeMap::new(),
            fonts: BTreeMap::new(),
            animations: Vec::new(),
        };
        let mut frame = sample_node("f", "frame");
        frame.width = 300.;
        frame.height = 141.;
        frame.layout = Some(Layout {
            mode: Flow::Vertical,
            gap: 8.,
            padding: [16.; 4],
            ..Default::default()
        });
        for i in 0..3 {
            let mut c = sample_node(&format!("c{i}"), "rectangle");
            c.width = 120.;
            c.height = 55.;
            frame.children.push(format!("c{i}"));
            doc.nodes.insert(format!("c{i}"), c);
        }
        doc.nodes.insert("f".into(), frame);
        doc.pages.push(crate::scene::Page {
            guides: vec![],
            id: "p".into(),
            name: "P".into(),
            children: vec!["f".into()],
            background: "#ffffff".into(),
        });
        resolve(&mut doc, &Default::default()).unwrap();
        for (id, expect_y) in [("c0", 16.), ("c1", 79.), ("c2", 142.)] {
            let n = &doc.nodes[id];
            assert!(
                (n.transform.0[4] - 16.).abs() < 1e-9,
                "{id} x {} should be padding 16",
                n.transform.0[4]
            );
            assert!(
                (n.transform.0[5] - expect_y).abs() < 1e-9,
                "{id} y {} should be {expect_y}",
                n.transform.0[5]
            );
        }
        assert!(
            (doc.nodes["f"].height - 141.).abs() < 1e-9,
            "fixed height must not be re-hugged"
        );
    }
}

#[cfg(test)]
mod grid_read_scope_tests {
    use super::*;
    #[test]
    fn grid_query_matches_full_solve_without_mutating_authored_islands() {
        let mut frame=crate::facet::sample_node("grid","frame");frame.width=180.;frame.height=160.;
        frame.layout=Some(Layout{mode:Flow::Grid,columns:2,gap:10.,line_gap:20.,padding:[0.;4],..Layout::default()});
        let mut nodes=BTreeMap::new();
        for i in 0..4 {let id=format!("child{i}");let mut n=crate::facet::sample_node(&id,"rectangle");n.width=80.;n.height=50.+i as f64*10.;frame.children.push(id.clone());nodes.insert(id,n);}
        nodes.insert(frame.id.clone(),frame);
        let mut cold=crate::facet::sample_node("cold","frame");cold.width=300.;cold.height=200.;nodes.insert(cold.id.clone(),cold);
        let mut doc:Document=serde_json::from_value(serde_json::json!({"schemaVersion":20,"id":"d","name":"grid","pages":[{"id":"p","name":"p","background":"#ffffff","children":["grid","cold"]}],"nodes":nodes})).unwrap();
        let original=serde_json::to_vec(&doc).unwrap();let l=doc.nodes["grid"].layout.as_ref().unwrap().clone();
        let expected=grid_with_tracks(&mut doc.clone(),"grid",&l).unwrap();
        assert_eq!(grid_tracks(&doc,"grid").unwrap(),expected);
        assert_eq!(serde_json::to_vec(&doc).unwrap(),original);
        doc.nodes.get_mut("cold").unwrap().opacity=f64::NAN;
        assert!(grid_tracks(&doc,"grid").is_err(),"unrelated invalid data still fails original admission");
    }
}
