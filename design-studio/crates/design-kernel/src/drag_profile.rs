//! Native CPU stage counters for vector-drag measurement. Disabled unless a
//! caller opts in on this thread. Timing never changes geometry, cache keys,
//! or admission. Hardware GPU, Metal, and Electron stay outside this hook.
use serde_json::{Value, json};
use std::{cell::{Cell, RefCell}, time::Instant};

#[derive(Clone, Copy, Default)]
struct Counters {
    fill_flatten_calls: u64,
    fill_flatten_ns: u64,
    fill_points: u64,
    stroke_style_key_calls: u64,
    stroke_style_key_ns: u64,
    stroke_expand_calls: u64,
    stroke_expand_ns: u64,
    stroke_transform_calls: u64,
    stroke_transform_ns: u64,
    stroke_transform_points: u64,
    boolean_key_calls: u64,
    boolean_key_ns: u64,
    boolean_hit_calls: u64,
    boolean_hit_ns: u64,
    boolean_solve_calls: u64,
    boolean_solve_ns: u64,
}

thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static COUNTERS: RefCell<Counters> = const { RefCell::new(Counters {
        fill_flatten_calls: 0, fill_flatten_ns: 0, fill_points: 0,
        stroke_style_key_calls: 0, stroke_style_key_ns: 0,
        stroke_expand_calls: 0, stroke_expand_ns: 0,
        stroke_transform_calls: 0, stroke_transform_ns: 0, stroke_transform_points: 0,
        boolean_key_calls: 0, boolean_key_ns: 0,
        boolean_hit_calls: 0, boolean_hit_ns: 0,
        boolean_solve_calls: 0, boolean_solve_ns: 0,
    }) };
}

#[derive(Clone, Copy)]
enum Kind {
    FillFlatten,
    StrokeStyleKey,
    StrokeExpand,
    StrokeTransform,
    BooleanKey,
    BooleanHit,
    BooleanSolve,
}

pub struct Span {
    kind: Kind,
    start: Option<Instant>,
}

impl Span {
    #[inline]
    pub(crate) fn fill_flatten() -> Self { Self::begin(Kind::FillFlatten) }
    #[inline]
    pub(crate) fn stroke_style_key() -> Self { Self::begin(Kind::StrokeStyleKey) }
    #[inline]
    pub(crate) fn stroke_expand() -> Self { Self::begin(Kind::StrokeExpand) }
    #[inline]
    pub(crate) fn stroke_transform() -> Self { Self::begin(Kind::StrokeTransform) }
    #[inline]
    pub(crate) fn boolean_key() -> Self { Self::begin(Kind::BooleanKey) }
    #[inline]
    pub(crate) fn boolean_hit() -> Self { Self::begin(Kind::BooleanHit) }
    #[inline]
    pub(crate) fn boolean_solve() -> Self { Self::begin(Kind::BooleanSolve) }
    #[inline]
    fn begin(kind: Kind) -> Self {
        Self { kind, start: ENABLED.with(Cell::get).then(Instant::now) }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        let Some(start) = self.start else { return };
        let ns = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
        COUNTERS.with(|slot| {
            let counters = &mut *slot.borrow_mut();
            match self.kind {
                Kind::FillFlatten => { counters.fill_flatten_calls = counters.fill_flatten_calls.saturating_add(1); counters.fill_flatten_ns = counters.fill_flatten_ns.saturating_add(ns); }
                Kind::StrokeStyleKey => { counters.stroke_style_key_calls = counters.stroke_style_key_calls.saturating_add(1); counters.stroke_style_key_ns = counters.stroke_style_key_ns.saturating_add(ns); }
                Kind::StrokeExpand => { counters.stroke_expand_calls = counters.stroke_expand_calls.saturating_add(1); counters.stroke_expand_ns = counters.stroke_expand_ns.saturating_add(ns); }
                Kind::StrokeTransform => { counters.stroke_transform_calls = counters.stroke_transform_calls.saturating_add(1); counters.stroke_transform_ns = counters.stroke_transform_ns.saturating_add(ns); }
                Kind::BooleanKey => { counters.boolean_key_calls = counters.boolean_key_calls.saturating_add(1); counters.boolean_key_ns = counters.boolean_key_ns.saturating_add(ns); }
                Kind::BooleanHit => { counters.boolean_hit_calls = counters.boolean_hit_calls.saturating_add(1); counters.boolean_hit_ns = counters.boolean_hit_ns.saturating_add(ns); }
                Kind::BooleanSolve => { counters.boolean_solve_calls = counters.boolean_solve_calls.saturating_add(1); counters.boolean_solve_ns = counters.boolean_solve_ns.saturating_add(ns); }
            }
        });
    }
}

pub fn set_enabled(enabled: bool) { ENABLED.with(|flag| flag.set(enabled)); }

pub fn reset() {
    COUNTERS.with(|slot| *slot.borrow_mut() = Counters::default());
}

pub(crate) fn add_fill_points(points: usize) {
    if !ENABLED.with(Cell::get) { return; }
    COUNTERS.with(|slot| {
        let mut counters = slot.borrow_mut();
        counters.fill_points = counters.fill_points.saturating_add(points as u64);
    });
}

pub(crate) fn add_stroke_points(points: usize) {
    if !ENABLED.with(Cell::get) { return; }
    COUNTERS.with(|slot| {
        let mut counters = slot.borrow_mut();
        counters.stroke_transform_points = counters.stroke_transform_points.saturating_add(points as u64);
    });
}

fn stage(calls: u64, ns: u64) -> Value {
    json!({"calls": calls, "nanos": ns, "millis": ns as f64 / 1e6})
}

pub fn snapshot() -> Value {
    COUNTERS.with(|slot| {
        let c = *slot.borrow();
        json!({
            "enabled": ENABLED.with(Cell::get),
            "fillFlatten": stage(c.fill_flatten_calls, c.fill_flatten_ns),
            "fillPoints": c.fill_points,
            "strokeStyleKey": stage(c.stroke_style_key_calls, c.stroke_style_key_ns),
            "strokeExpand": stage(c.stroke_expand_calls, c.stroke_expand_ns),
            "strokeTransform": stage(c.stroke_transform_calls, c.stroke_transform_ns),
            "strokeTransformPoints": c.stroke_transform_points,
            "booleanKey": stage(c.boolean_key_calls, c.boolean_key_ns),
            "booleanHit": stage(c.boolean_hit_calls, c.boolean_hit_ns),
            "booleanSolve": stage(c.boolean_solve_calls, c.boolean_solve_ns),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_spans_stay_at_zero_and_one_enabled_span_counts_once() {
        set_enabled(false);
        reset();
        { let _span = Span::fill_flatten(); }
        assert_eq!(snapshot()["fillFlatten"]["calls"], 0);
        set_enabled(true);
        reset();
        { let _span = Span::boolean_solve(); }
        let snap = snapshot();
        assert_eq!(snap["booleanSolve"]["calls"], 1);
        assert!(snap["booleanSolve"]["nanos"].as_u64().is_some());
        set_enabled(false);
    }
}
