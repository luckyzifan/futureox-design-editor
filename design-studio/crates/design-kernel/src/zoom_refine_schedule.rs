//! One admission for zoom and pan refinement.
//!
//! Task choice and preview cancellation are decided here. Callers pass facts
//! once and do not judge the same gesture again. The packed ABI is integers
//! only: the hot path does not serialize or parse JSON.
//!
//! Ordinary motion stays at two tiles. A settled batch of eight is only the
//! overview mode at `scale <= 1`, or an exact full-source lattice at
//! `scale <= 0.5`. A moving batch, a non-exact lattice, and a mid scale such
//! as 0.75 stay on the ordinary pair. This is not a dense-paint cohort.
//!
//! While exact viewport tiles are still missing, the decision does not ask
//! for a page-overview candidate list. That list is a separate source-range
//! plan and is not required to choose the exact cohort.
//!
//! A decision never releases a texture a presented frame still samples.

const GATE_SCHEDULE: u32 = 0;
const GATE_PAINT: u32 = 1;
const GATE_STOP: u32 = 2;
const GATE_DEFER: u32 = 3;

const COHORT_NONE: u32 = 0;
const COHORT_STRIP: u32 = 1;
const COHORT_EXACT: u32 = 2;
const COHORT_OVERVIEW: u32 = 3;
const COHORT_PREFETCH: u32 = 4;

const ASK_STRIP: u32 = 1;
const ASK_OVERVIEW_COLD: u32 = 2;
const ASK_OVERVIEW_WARM: u32 = 3;
const ASK_PREFETCH: u32 = 4;
const ASK_OUTWARD: u32 = 5;

const TRACE_PAINT_FIRST: u32 = 1;
const TRACE_PAINT_OUTWARD: u32 = 2;
const TRACE_STOP_MATERIAL: u32 = 3;
const TRACE_PAINT_PREFETCH: u32 = 4;
const TRACE_DEFER: u32 = 5;
const TRACE_STRIP_CPU: u32 = 6;
const TRACE_STRIP_TRANSLATED: u32 = 7;
const TRACE_STRIP_QUIET: u32 = 8;
const TRACE_STRIP_BOOTSTRAP: u32 = 9;
const TRACE_STRIP_PAN: u32 = 10;
const TRACE_EXACT: u32 = 11;
const TRACE_OVERVIEW: u32 = 12;
const TRACE_PREFETCH: u32 = 13;
const TRACE_STOP_EMPTY: u32 = 14;

const FLAG_MOVING: u32 = 1 << 0;
const FLAG_CONTINUOUS: u32 = 1 << 1;
const FLAG_ZOOMING_IN: u32 = 1 << 2;
const FLAG_PANNED: u32 = 1 << 3;
const FLAG_TRANSLATED: u32 = 1 << 4;
const FLAG_TRANSLATION_FOLLOW: u32 = 1 << 5;
const FLAG_FIRST_NATIVE: u32 = 1 << 6;
const FLAG_HAS_STRIP: u32 = 1 << 7;
const FLAG_STRIP_CACHED: u32 = 1 << 8;
const FLAG_PASTEBOARD: u32 = 1 << 9;
const FLAG_CPU_ONLY: u32 = 1 << 10;
const FLAG_RESIDENTS_COVER: u32 = 1 << 11;
const FLAG_HAS_BACKING: u32 = 1 << 12;
const FLAG_OUTWARD_COVER: u32 = 1 << 13;
const FLAG_MATERIAL: u32 = 1 << 14;
const FLAG_PREFETCH_NOT_READY: u32 = 1 << 15;
const FLAG_OVERVIEW_MODE: u32 = 1 << 16;
const FLAG_PIPELINE: u32 = 1 << 17;
const FLAG_EXACT_LATTICE: u32 = 1 << 18;
const FLAG_CAN_BUILD_STRIP: u32 = 1 << 19;
const FLAG_STRIP_MEASURED: u32 = 1 << 20;
const FLAG_OVERVIEW_SUPPLIED: u32 = 1 << 21;
const FLAG_PREFETCH_SUPPLIED: u32 = 1 << 22;
const FLAG_OVERVIEW_READY: u32 = 1 << 23;
const FLAG_COSTLY_OVERVIEW: u32 = 1 << 24;
const FLAG_OVERVIEW_IS_COLD: u32 = 1 << 25;
const FLAG_OUTWARD_KNOWN: u32 = 1 << 27;

const NEED_INPUT: u32 = 1 << 31;

#[derive(Clone, Copy)]
enum StripReason {
    Cpu,
    Translated,
    Quiet,
    Bootstrap,
    PanFollow,
}

fn flag(flags: u32, bit: u32) -> bool {
    flags & bit != 0
}

fn missing_count(value: f64) -> Option<u32> {
    if !value.is_finite() || value < 0.0 || value > u32::MAX as f64 || value.fract() != 0.0 {
        return None;
    }
    Some(value as u32)
}

/// Geometry for a coarse page strip is allowed only when a strip can be built
/// and this camera is not spending the raster owner on an inward zoom or on a
/// backed full-source pipeline.
fn strip_geometry_allowed(flags: u32) -> bool {
    flag(flags, FLAG_CAN_BUILD_STRIP)
        && !flag(flags, FLAG_ZOOMING_IN)
        && (!flag(flags, FLAG_PIPELINE) || !flag(flags, FLAG_HAS_BACKING))
}

fn ask(kind: u32) -> u32 {
    NEED_INPUT | (kind << 5)
}

fn pack(
    gate: u32,
    cohort: u32,
    priority: u32,
    batch: u32,
    trace: u32,
    consumes_cold: bool,
    reorder: bool,
    want_strip: bool,
    quiet: bool,
    suppress: bool,
    strip_geometry: bool,
) -> u32 {
    let mut word = gate | (cohort << 2) | (priority << 5) | (batch << 8) | (trace << 16);
    if consumes_cold {
        word |= 1 << 23;
    }
    if reorder {
        word |= 1 << 24;
    }
    if want_strip {
        word |= 1 << 25;
    }
    if quiet {
        word |= 1 << 26;
    }
    if suppress {
        word |= 1 << 27;
    }
    if strip_geometry {
        word |= 1 << 30;
    }
    word
}

fn large_source(flags: u32, nodes: u32, width: f64, height: f64) -> bool {
    flag(flags, FLAG_MATERIAL)
        || nodes >= 3000
        || (width.is_finite() && width >= 8000.0)
        || (height.is_finite() && height >= 8000.0)
}

/// Select the next source-refine task. A word with bit 31 set asks for one
/// missing fact (kind in bits 5–7) and is not a final schedule.
pub fn select_packed(
    flags: u32,
    exact_missing: f64,
    overview_candidates: u32,
    prefetch_missing: u32,
    optional_delay_ms: f64,
    raster_scale: f64,
    shown_count: u32,
    tile_count: u32,
    cold_budget: u32,
    source_nodes: u32,
    source_width: f64,
    source_height: f64,
) -> u32 {
    let moving = flag(flags, FLAG_MOVING);
    let continuous = flag(flags, FLAG_CONTINUOUS);
    let zooming_in = flag(flags, FLAG_ZOOMING_IN);
    let first_native = flag(flags, FLAG_FIRST_NATIVE);
    let has_backing = flag(flags, FLAG_HAS_BACKING);
    let exact = missing_count(exact_missing);
    let exact_known_zero = exact == Some(0);
    let quiet = !moving && !continuous && exact_known_zero;
    let bootstrap = !has_backing && !first_native;
    let quiet_allowed = quiet || bootstrap;
    let strip_geometry = strip_geometry_allowed(flags);
    if strip_geometry && !flag(flags, FLAG_STRIP_MEASURED) {
        return ask(ASK_STRIP);
    }
    let has_strip =
        strip_geometry && flag(flags, FLAG_STRIP_MEASURED) && flag(flags, FLAG_HAS_STRIP);
    let reason = if has_strip && !flag(flags, FLAG_STRIP_CACHED) && !first_native {
        if flag(flags, FLAG_PASTEBOARD) && flag(flags, FLAG_CPU_ONLY) {
            Some(StripReason::Cpu)
        } else if flag(flags, FLAG_PASTEBOARD) && flag(flags, FLAG_TRANSLATED) {
            Some(StripReason::Translated)
        } else if flag(flags, FLAG_PASTEBOARD) && !moving && !continuous && quiet_allowed {
            Some(if !quiet && bootstrap {
                StripReason::Bootstrap
            } else {
                StripReason::Quiet
            })
        } else if flag(flags, FLAG_TRANSLATION_FOLLOW) && !flag(flags, FLAG_RESIDENTS_COVER) {
            Some(StripReason::PanFollow)
        } else {
            None
        }
    } else {
        None
    };
    let want_strip = reason.is_some();
    let optional = exact_known_zero;
    let idle = |gate: u32, trace: u32| {
        pack(
            gate,
            COHORT_NONE,
            0,
            0,
            trace,
            false,
            false,
            want_strip,
            quiet,
            false,
            strip_geometry,
        )
    };
    if first_native && optional {
        return idle(GATE_PAINT, TRACE_PAINT_FIRST);
    }
    if !want_strip && !optional && !flag(flags, FLAG_OUTWARD_KNOWN) {
        return ask(ASK_OUTWARD);
    }
    if !want_strip && !optional && flag(flags, FLAG_OUTWARD_COVER) {
        return idle(GATE_PAINT, TRACE_PAINT_OUTWARD);
    }
    if !want_strip && optional && flag(flags, FLAG_MATERIAL) && moving {
        return idle(GATE_STOP, TRACE_STOP_MATERIAL);
    }
    if !want_strip && optional && moving && flag(flags, FLAG_PREFETCH_NOT_READY) {
        return idle(GATE_PAINT, TRACE_PAINT_PREFETCH);
    }
    if !want_strip && optional && optional_delay_ms.is_finite() && optional_delay_ms > 0.0 {
        return idle(GATE_DEFER, TRACE_DEFER);
    }

    let large = large_source(flags, source_nodes, source_width, source_height);
    let can_overview = flag(flags, FLAG_OVERVIEW_READY) || (shown_count > 0 && (large || optional));
    let cold = can_overview
        && optional
        && !first_native
        && !moving
        && !zooming_in
        && cold_budget > 0
        && large
        && shown_count.saturating_mul(2) >= tile_count.max(1);
    let warm = can_overview && !cold && optional && !flag(flags, FLAG_COSTLY_OVERVIEW) && !moving;
    if !want_strip && !flag(flags, FLAG_OVERVIEW_SUPPLIED) {
        if cold {
            return ask(ASK_OVERVIEW_COLD);
        }
        if warm {
            return ask(ASK_OVERVIEW_WARM);
        }
    }
    let overview_count = if flag(flags, FLAG_OVERVIEW_SUPPLIED) {
        overview_candidates
    } else {
        0
    };
    if !want_strip && optional && overview_count == 0 && !flag(flags, FLAG_PREFETCH_SUPPLIED) {
        return ask(ASK_PREFETCH);
    }
    let prefetch = if flag(flags, FLAG_PREFETCH_SUPPLIED) {
        prefetch_missing
    } else {
        0
    };

    let (cohort, priority, trace) = if let Some(reason) = reason {
        let trace = match reason {
            StripReason::Cpu => TRACE_STRIP_CPU,
            StripReason::Translated => TRACE_STRIP_TRANSLATED,
            StripReason::Quiet => TRACE_STRIP_QUIET,
            StripReason::Bootstrap => TRACE_STRIP_BOOTSTRAP,
            StripReason::PanFollow => TRACE_STRIP_PAN,
        };
        (COHORT_STRIP, 0, trace)
    } else if !optional {
        (COHORT_EXACT, 1, TRACE_EXACT)
    } else if overview_count > 0 {
        (COHORT_OVERVIEW, 2, TRACE_OVERVIEW)
    } else if prefetch > 0 {
        (COHORT_PREFETCH, 3, TRACE_PREFETCH)
    } else {
        return pack(
            GATE_STOP,
            COHORT_NONE,
            0,
            0,
            TRACE_STOP_EMPTY,
            false,
            false,
            false,
            quiet,
            false,
            strip_geometry,
        );
    };

    let settled = !optional
        && !moving
        && ((flag(flags, FLAG_OVERVIEW_MODE) && raster_scale <= 1.0)
            || (flag(flags, FLAG_PIPELINE)
                && flag(flags, FLAG_EXACT_LATTICE)
                && raster_scale <= 0.5));
    let base = if settled { 8 } else { 2 };
    let cover_motion = moving && !zooming_in && (continuous || flag(flags, FLAG_PANNED));
    let inward_single =
        flag(flags, FLAG_MATERIAL) && moving && zooming_in && continuous && has_backing;
    let batch = if want_strip || cover_motion || inward_single {
        1
    } else {
        base
    };
    let reorder = !optional && moving && !zooming_in;
    let suppress = want_strip
        || cohort == COHORT_OVERVIEW
        || optional
        || (flag(flags, FLAG_MATERIAL) && moving && zooming_in && continuous);
    let consumes_cold =
        flag(flags, FLAG_OVERVIEW_IS_COLD) && overview_count > 0 && cohort == COHORT_OVERVIEW;
    pack(
        GATE_SCHEDULE,
        cohort,
        priority,
        batch,
        trace,
        consumes_cold,
        reorder,
        want_strip,
        quiet,
        suppress,
        strip_geometry,
    )
}

/// Preview cancellation. Abort wins, then generation, then a canvas fill
/// fence. One already-prepared tile may cover a visible gap. Bits 4 and 5
/// stay clear so the caller cannot read this as a release.
pub fn admit_packed(flags: u32) -> u32 {
    if flags > 127 {
        // An out-of-range fact word is not a release. Callers reject it.
        return 1 << 4;
    }
    let aborted = flags & 1 != 0;
    let generation_current = flags & 2 != 0;
    let fill_current = flags & 4 != 0;
    let enforce_fill = flags & 8 != 0;
    let channel_is_canvas = flags & 16 != 0;
    let allow_gap = flags & 32 != 0;
    let can_fill = flags & 64 != 0;
    let (action, reason) = if aborted {
        (1, 1)
    } else if !generation_current {
        (1, 2)
    } else if enforce_fill && channel_is_canvas && !fill_current {
        if allow_gap && can_fill {
            (2, 0)
        } else {
            (1, 3)
        }
    } else {
        (0, 0)
    };
    action | (reason << 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_release(word: u32) {
        assert_eq!(word & (1 << 28), 0, "cached release bit");
        assert_eq!(word & (1 << 29), 0, "in-use release bit");
    }

    fn kind(word: u32) -> Option<u32> {
        if word & NEED_INPUT == 0 {
            None
        } else {
            Some((word >> 5) & 7)
        }
    }

    fn gate(word: u32) -> u32 {
        word & 3
    }
    fn cohort(word: u32) -> u32 {
        (word >> 2) & 7
    }
    fn batch(word: u32) -> u32 {
        (word >> 8) & 255
    }
    fn trace(word: u32) -> u32 {
        (word >> 16) & 127
    }
    fn want_strip(word: u32) -> bool {
        word & (1 << 25) != 0
    }

    struct Facts {
        flags: u32,
        exact_missing: f64,
        overview_candidates: u32,
        prefetch_missing: u32,
        optional_delay_ms: f64,
        raster_scale: f64,
        shown_count: u32,
        tile_count: u32,
        cold_budget: u32,
        source_nodes: u32,
        source_width: f64,
        source_height: f64,
    }

    fn facts() -> Facts {
        Facts {
            flags: FLAG_EXACT_LATTICE | FLAG_OUTWARD_KNOWN,
            exact_missing: 0.0,
            overview_candidates: 0,
            prefetch_missing: 0,
            optional_delay_ms: 0.0,
            raster_scale: 1.0,
            shown_count: 0,
            tile_count: 4,
            cold_budget: 1,
            source_nodes: 20,
            source_width: 2000.0,
            source_height: 2000.0,
        }
    }

    fn resolve(
        mut facts: Facts,
        outward: bool,
        strip: Option<(bool, bool, bool)>,
        overview: u32,
        prefetch: u32,
    ) -> u32 {
        for _ in 0..6 {
            let word = select_packed(
                facts.flags,
                facts.exact_missing,
                facts.overview_candidates,
                facts.prefetch_missing,
                facts.optional_delay_ms,
                facts.raster_scale,
                facts.shown_count,
                facts.tile_count,
                facts.cold_budget,
                facts.source_nodes,
                facts.source_width,
                facts.source_height,
            );
            no_release(word);
            match kind(word) {
                None => return word,
                Some(ASK_STRIP) => {
                    let (has, cached, pasteboard) = strip.expect("strip measurement");
                    facts.flags |= FLAG_STRIP_MEASURED;
                    if has {
                        facts.flags |= FLAG_HAS_STRIP;
                    }
                    if cached {
                        facts.flags |= FLAG_STRIP_CACHED;
                    }
                    if pasteboard {
                        facts.flags |= FLAG_PASTEBOARD;
                    }
                }
                Some(ASK_OUTWARD) => {
                    facts.flags |= FLAG_OUTWARD_KNOWN;
                    if outward {
                        facts.flags |= FLAG_OUTWARD_COVER;
                    }
                }
                Some(ASK_OVERVIEW_COLD) => {
                    facts.flags |= FLAG_OVERVIEW_SUPPLIED | FLAG_OVERVIEW_IS_COLD;
                    facts.overview_candidates = overview;
                }
                Some(ASK_OVERVIEW_WARM) => {
                    facts.flags |= FLAG_OVERVIEW_SUPPLIED;
                    facts.overview_candidates = overview;
                }
                Some(ASK_PREFETCH) => {
                    facts.flags |= FLAG_PREFETCH_SUPPLIED;
                    facts.prefetch_missing = prefetch;
                }
                Some(other) => panic!("unexpected ask {other}"),
            }
        }
        panic!("schedule did not finish");
    }

    #[test]
    fn exact_holes_do_not_ask_for_a_page_overview() {
        let mut input = facts();
        input.exact_missing = 4.0;
        input.flags |= FLAG_CAN_BUILD_STRIP;
        input.shown_count = 2;
        input.source_nodes = 4000;
        input.source_width = 12000.0;
        input.tile_count = 6;
        // Zooming in: strip geometry is not eligible, so the page plan is the
        // only extra work the old surface did. It must not be requested.
        input.flags |= FLAG_ZOOMING_IN | FLAG_CONTINUOUS | FLAG_MOVING;
        let mut asked_overview = false;
        let mut hops = 0;
        let mut flags = input.flags;
        let word = loop {
            hops += 1;
            let word = select_packed(
                flags,
                input.exact_missing,
                0,
                0,
                0.0,
                1.0,
                input.shown_count,
                input.tile_count,
                1,
                input.source_nodes,
                input.source_width,
                input.source_height,
            );
            no_release(word);
            match kind(word) {
                None => break word,
                Some(ASK_OUTWARD) => flags |= FLAG_OUTWARD_KNOWN,
                Some(ASK_OVERVIEW_COLD | ASK_OVERVIEW_WARM) => asked_overview = true,
                Some(other) => panic!("exact zoom-in asked for {other}"),
            }
            assert!(hops < 4);
        };
        assert!(!asked_overview);
        assert_eq!(cohort(word), COHORT_EXACT);
        assert_eq!(trace(word), TRACE_EXACT);
        assert_eq!(batch(word), 2);
        assert!(!want_strip(word));
        assert_eq!(gate(word), GATE_SCHEDULE);
    }

    #[test]
    fn one_action_chain_is_traceable_and_keeps_exact_tiles_first() {
        let mut zoom_in = facts();
        zoom_in.flags |=
            FLAG_MOVING | FLAG_CONTINUOUS | FLAG_ZOOMING_IN | FLAG_CAN_BUILD_STRIP | FLAG_MATERIAL;
        zoom_in.exact_missing = 4.0;
        let zoom_in = resolve(zoom_in, false, None, 99, 99);
        assert_eq!(trace(zoom_in), TRACE_EXACT);
        assert_eq!(batch(zoom_in), 2);
        assert!(!want_strip(zoom_in));

        let mut zoom_out = facts();
        zoom_out.flags |= FLAG_MOVING | FLAG_CONTINUOUS | FLAG_CAN_BUILD_STRIP;
        zoom_out.exact_missing = 0.0;
        zoom_out.shown_count = 4;
        zoom_out.source_nodes = 4000;
        let zoom_out = resolve(zoom_out, false, Some((true, false, true)), 4, 0);
        assert_eq!(trace(zoom_out), TRACE_STOP_EMPTY);
        assert!(!want_strip(zoom_out));
        assert_eq!(batch(zoom_out), 0);

        let mut quiet = facts();
        quiet.flags |= FLAG_CAN_BUILD_STRIP | FLAG_HAS_BACKING;
        quiet.exact_missing = 0.0;
        let quiet = resolve(quiet, false, Some((true, false, true)), 0, 0);
        assert_eq!(trace(quiet), TRACE_STRIP_QUIET);
        assert_eq!(batch(quiet), 1);
        assert!(want_strip(quiet));

        let mut holes = facts();
        holes.exact_missing = 3.0;
        holes.shown_count = 1;
        holes.source_nodes = 4000;
        let holes = resolve(holes, false, None, 2, 0);
        assert_eq!(cohort(holes), COHORT_EXACT);
        assert_eq!((holes >> 5) & 7, 1);

        let mut page = facts();
        page.exact_missing = 0.0;
        page.flags |= FLAG_OVERVIEW_READY;
        page.shown_count = 2;
        let page = resolve(page, false, None, 2, 5);
        assert_eq!(cohort(page), COHORT_OVERVIEW);
        assert_eq!((page >> 5) & 7, 2);
        assert_eq!(batch(page), 2);
    }

    #[test]
    fn settled_batch_stays_on_the_existing_pipeline() {
        let mut overview = facts();
        overview.flags |= FLAG_OVERVIEW_MODE;
        overview.exact_missing = 2.0;
        overview.raster_scale = 1.0;
        let overview = resolve(overview, false, None, 0, 0);
        assert_eq!(batch(overview), 8);

        let mut source = facts();
        source.flags |= FLAG_PIPELINE | FLAG_EXACT_LATTICE | FLAG_HAS_BACKING;
        source.exact_missing = 4.0;
        source.raster_scale = 0.125;
        let source = resolve(source, false, None, 0, 0);
        assert_eq!(batch(source), 8);

        let mut not_exact = facts();
        not_exact.flags |= FLAG_PIPELINE | FLAG_HAS_BACKING;
        not_exact.flags &= !FLAG_EXACT_LATTICE;
        not_exact.exact_missing = 4.0;
        not_exact.raster_scale = 0.125;
        assert_eq!(batch(resolve(not_exact, false, None, 0, 0)), 2);

        let mut mid = facts();
        mid.flags |= FLAG_PIPELINE | FLAG_EXACT_LATTICE | FLAG_HAS_BACKING;
        mid.exact_missing = 4.0;
        mid.raster_scale = 0.75;
        assert_eq!(batch(resolve(mid, false, None, 0, 0)), 2);

        let mut moving = facts();
        moving.flags |= FLAG_MOVING | FLAG_CONTINUOUS | FLAG_OVERVIEW_MODE | FLAG_PANNED;
        moving.exact_missing = 4.0;
        moving.raster_scale = 1.0;
        let moving = resolve(moving, false, None, 0, 0);
        assert_eq!(batch(moving), 1);
        assert!(moving & (1 << 24) != 0);
        no_release(moving);
    }

    #[test]
    fn cancellation_never_releases_and_abort_wins() {
        for bits in 0..128 {
            let word = admit_packed(bits);
            assert_eq!(word & !0b1111, 0, "{bits}");
            if bits & 1 != 0 {
                assert_eq!(word & 3, 1);
                assert_eq!((word >> 2) & 3, 1);
            }
        }
        let fill = admit_packed(2 | 8 | 16);
        assert_eq!(fill & 3, 1);
        assert_eq!((fill >> 2) & 3, 3);
        let gap = admit_packed(2 | 8 | 16 | 32 | 64);
        assert_eq!(gap & 3, 2);
        assert_eq!(admit_packed(2 | 16) & 3, 0);
        assert_eq!(admit_packed(2 | 8) & 3, 0);
        assert_ne!(admit_packed(128) & (1 << 4), 0);
    }

    #[test]
    fn quiet_strip_rejects_invalid_counts_and_motion() {
        let mut quiet = facts();
        quiet.flags |= FLAG_CAN_BUILD_STRIP | FLAG_HAS_BACKING;
        quiet.exact_missing = f64::NAN;
        let word = resolve(quiet, false, Some((true, false, true)), 0, 0);
        assert!(!want_strip(word));
        assert_eq!(word & (1 << 26), 0);

        let mut fraction = facts();
        fraction.flags |= FLAG_CAN_BUILD_STRIP | FLAG_HAS_BACKING;
        fraction.exact_missing = 0.5;
        assert!(!want_strip(resolve(
            fraction,
            false,
            Some((true, false, true)),
            0,
            0
        )));

        let mut negative = facts();
        negative.flags |= FLAG_CAN_BUILD_STRIP | FLAG_HAS_BACKING;
        negative.exact_missing = -1.0;
        assert!(!want_strip(resolve(
            negative,
            false,
            Some((true, false, true)),
            0,
            0
        )));

        let mut moving = facts();
        moving.flags |= FLAG_CAN_BUILD_STRIP | FLAG_HAS_BACKING | FLAG_MOVING;
        moving.exact_missing = 0.0;
        assert!(!want_strip(resolve(
            moving,
            false,
            Some((true, false, true)),
            0,
            0
        )));
    }

    #[test]
    fn strip_reasons_match_the_surface_rules() {
        let mut translated = facts();
        translated.flags |= FLAG_CAN_BUILD_STRIP
            | FLAG_MOVING
            | FLAG_CONTINUOUS
            | FLAG_HAS_BACKING
            | FLAG_TRANSLATED;
        translated.exact_missing = 3.0;
        let translated = resolve(translated, false, Some((true, false, true)), 0, 0);
        assert_eq!(trace(translated), TRACE_STRIP_TRANSLATED);

        let mut pan = facts();
        pan.flags |= FLAG_CAN_BUILD_STRIP
            | FLAG_MOVING
            | FLAG_CONTINUOUS
            | FLAG_TRANSLATION_FOLLOW
            | FLAG_HAS_BACKING;
        pan.exact_missing = 0.0;
        let pan = resolve(pan, false, Some((true, false, false)), 0, 0);
        assert_eq!(trace(pan), TRACE_STRIP_PAN);
        let mut covered = facts();
        covered.flags |= FLAG_CAN_BUILD_STRIP
            | FLAG_MOVING
            | FLAG_CONTINUOUS
            | FLAG_TRANSLATION_FOLLOW
            | FLAG_RESIDENTS_COVER
            | FLAG_HAS_BACKING;
        covered.exact_missing = 0.0;
        assert_ne!(
            trace(resolve(covered, false, Some((true, false, false)), 0, 0)),
            TRACE_STRIP_PAN
        );

        let mut bootstrap = facts();
        bootstrap.flags |= FLAG_CAN_BUILD_STRIP;
        bootstrap.exact_missing = 4.0;
        let bootstrap = resolve(bootstrap, false, Some((true, false, true)), 0, 0);
        assert_eq!(trace(bootstrap), TRACE_STRIP_BOOTSTRAP);
        assert_eq!(cohort(bootstrap), COHORT_STRIP);

        let mut first = facts();
        first.flags |= FLAG_CAN_BUILD_STRIP | FLAG_FIRST_NATIVE | FLAG_HAS_BACKING;
        first.exact_missing = 0.0;
        let first = resolve(first, false, Some((true, false, true)), 0, 0);
        assert_eq!(trace(first), TRACE_PAINT_FIRST);
        assert!(!want_strip(first));

        let mut cached = facts();
        cached.flags |= FLAG_CAN_BUILD_STRIP | FLAG_TRANSLATION_FOLLOW | FLAG_HAS_BACKING;
        cached.exact_missing = 2.0;
        assert!(!want_strip(resolve(
            cached,
            false,
            Some((true, true, false)),
            0,
            0
        )));
    }

    #[test]
    fn outward_cover_is_asked_only_when_exact_tiles_are_missing() {
        let mut outward = facts();
        outward.flags &= !FLAG_OUTWARD_KNOWN;
        outward.exact_missing = 2.0;
        let first = select_packed(
            outward.flags,
            2.0,
            0,
            0,
            0.0,
            1.0,
            0,
            4,
            1,
            20,
            2000.0,
            2000.0,
        );
        assert_eq!(kind(first), Some(ASK_OUTWARD));
        assert_eq!(
            trace(resolve(outward, true, None, 0, 0)),
            TRACE_PAINT_OUTWARD
        );

        let mut covered = facts();
        covered.exact_missing = 0.0;
        covered.flags &= !FLAG_OUTWARD_KNOWN;
        let mut hops = 0;
        let mut flags = covered.flags;
        loop {
            hops += 1;
            let word = select_packed(flags, 0.0, 0, 0, 0.0, 1.0, 0, 4, 1, 20, 2000.0, 2000.0);
            match kind(word) {
                Some(ASK_OUTWARD) => panic!("optional frame asked for outward cover"),
                Some(ASK_PREFETCH) => break,
                Some(_) => flags |= FLAG_STRIP_MEASURED,
                None => break,
            }
            assert!(hops < 4);
        }
    }

    #[test]
    fn cold_overview_consumes_one_budget_and_inward_motion_stays_one_tile() {
        let mut cold = facts();
        cold.exact_missing = 0.0;
        cold.shown_count = 4;
        cold.tile_count = 4;
        cold.source_nodes = 4000;
        cold.flags |= FLAG_OVERVIEW_READY;
        let cold = resolve(cold, false, None, 1, 9);
        assert_eq!(cohort(cold), COHORT_OVERVIEW);
        assert!(cold & (1 << 23) != 0);
        assert_eq!(batch(cold), 2);

        let mut inward = facts();
        inward.flags |=
            FLAG_MATERIAL | FLAG_MOVING | FLAG_CONTINUOUS | FLAG_ZOOMING_IN | FLAG_HAS_BACKING;
        inward.exact_missing = 4.0;
        let inward = resolve(inward, false, None, 0, 0);
        assert_eq!(batch(inward), 1);
        assert!(inward & (1 << 27) != 0);
        inward_without_backing();
    }

    fn inward_without_backing() {
        let mut inward = facts();
        inward.flags |= FLAG_MATERIAL | FLAG_MOVING | FLAG_CONTINUOUS | FLAG_ZOOMING_IN;
        inward.exact_missing = 4.0;
        let word = resolve(inward, false, None, 0, 0);
        assert_eq!(batch(word), 2);
        assert!(word & (1 << 27) != 0);
    }
}
