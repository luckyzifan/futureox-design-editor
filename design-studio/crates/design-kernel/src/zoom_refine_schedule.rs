//! One admission for zoom and pan refinement.
//!
//! Task choice and preview cancellation are decided here. Callers pass the
//! gesture, density, preview and source-range facts once. They do not decide
//! the same question again. Ordinary motion stays at two tiles. The settled
//! eight-tile batch is only the overview or exact low-scale pipeline already
//! on main. This is not the rejected dense-paint eight-tile cohort.
//!
//! A decision never releases a texture a presented frame still samples.
//! Cancelling drops only work that has not been delivered.

use serde::{Deserialize, Serialize};

const ORDINARY_BATCH: u8 = 2;
const SETTLED_BATCH: u8 = 8;
const POLICY_JSON_LIMIT: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefineGate {
    Schedule,
    Paint,
    Stop,
    Defer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefineCohort {
    None,
    Strip,
    Exact,
    Overview,
    Prefetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedTileInput {
    pub aborted: bool,
    pub generation_current: bool,
    pub fill_current: bool,
    pub enforce_fill: bool,
    pub channel_is_canvas: bool,
    pub allow_gap_fill: bool,
    pub can_fill_gap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedTileChoice {
    Continue,
    Cancel { reason: CancelReason },
    CoverGap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    Aborted,
    Generation,
    Fill,
}

impl PreparedTileChoice {
    pub const fn release_in_use(self) -> bool {
        false
    }
    pub const fn release_cached_tiles(self) -> bool {
        false
    }
    pub const fn action(self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::Cancel { .. } => "cancel",
            Self::CoverGap => "cover-gap",
        }
    }
    pub const fn reason(self) -> Option<&'static str> {
        match self {
            Self::Cancel {
                reason: CancelReason::Aborted,
            } => Some("aborted"),
            Self::Cancel {
                reason: CancelReason::Generation,
            } => Some("generation"),
            Self::Cancel {
                reason: CancelReason::Fill,
            } => Some("fill"),
            _ => None,
        }
    }
}

/// Preview cancellation. Abort wins, then the generation, then a canvas fill
/// fence. One already-prepared tile may cover a visible gap. Nothing here
/// releases a resource the presenter still samples.
pub fn admit_prepared_tile(input: PreparedTileInput) -> PreparedTileChoice {
    if input.aborted {
        return PreparedTileChoice::Cancel {
            reason: CancelReason::Aborted,
        };
    }
    if !input.generation_current {
        return PreparedTileChoice::Cancel {
            reason: CancelReason::Generation,
        };
    }
    if input.enforce_fill && input.channel_is_canvas && !input.fill_current {
        if input.allow_gap_fill && input.can_fill_gap {
            return PreparedTileChoice::CoverGap;
        }
        return PreparedTileChoice::Cancel {
            reason: CancelReason::Fill,
        };
    }
    PreparedTileChoice::Continue
}

/// Quiet pasteboard admission. Invalid and non-zero counts refuse the strip.
/// Gesture flags are read only here.
pub fn quiet_paste_strip_allowed(moving: bool, continuous_zoom: bool, exact_missing: f64) -> bool {
    if moving || continuous_zoom {
        return false;
    }
    exact_missing.is_finite() && exact_missing == 0.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoarsePanInput {
    pub first_native: bool,
    pub has_strip: bool,
    pub strip_cached: bool,
    pub pasteboard: bool,
    pub cpu_only: bool,
    pub translated: bool,
    pub moving: bool,
    pub continuous_zoom: bool,
    pub translation_follow: bool,
    pub residents_cover: bool,
    pub quiet_strip_allowed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StripReason {
    Cpu,
    Translated,
    Quiet,
    PanFollow,
}

/// Whether the coarse page strip may take the only raster owner.
/// Continuous zoom-out does not, even when exact tiles are already cached.
/// A same-zoom pan that has left its resident pictures still does.
pub fn coarse_pan_cover(input: CoarsePanInput) -> Option<StripReason> {
    if input.first_native || !input.has_strip || input.strip_cached {
        return None;
    }
    if input.pasteboard && input.cpu_only {
        return Some(StripReason::Cpu);
    }
    if input.pasteboard && input.translated {
        return Some(StripReason::Translated);
    }
    if input.pasteboard && !input.moving && !input.continuous_zoom && input.quiet_strip_allowed {
        return Some(StripReason::Quiet);
    }
    if input.translation_follow && !input.residents_cover {
        return Some(StripReason::PanFollow);
    }
    None
}

#[derive(Debug, Clone, Copy)]
pub struct ScheduleInput {
    pub moving: bool,
    pub continuous_zoom: bool,
    pub zooming_in: bool,
    pub panned: bool,
    pub translated: bool,
    pub translation_follow: bool,
    pub first_native: bool,
    pub has_strip: bool,
    pub strip_cached: bool,
    pub pasteboard: bool,
    pub cpu_only: bool,
    pub residents_cover: bool,
    pub has_backing: bool,
    pub exact_missing: u32,
    pub overview_candidates: u32,
    pub prefetch_missing: u32,
    pub outward_cover: bool,
    pub material_keys: bool,
    pub prefetch_not_ready: bool,
    pub optional_delay_ms: f64,
    pub overview_mode: bool,
    pub pipeline_full_source: bool,
    pub exact_lattice: bool,
    pub raster_scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduleDecision {
    pub gate: RefineGate,
    pub cohort: RefineCohort,
    pub priority: u8,
    pub batch_limit: u8,
    pub trace: &'static str,
    pub trace_code: u8,
    pub cohort_code: u8,
    pub reorder_holes: bool,
    pub want_strip: bool,
    pub quiet_strip: bool,
    pub suppress_prepare: bool,
    pub release_cached_tiles: bool,
    pub release_in_use_resources: bool,
}

fn trace(name: &'static str, code: u8) -> (&'static str, u8) {
    (name, code)
}

fn cohort_code(cohort: RefineCohort) -> u8 {
    match cohort {
        RefineCohort::None => 0,
        RefineCohort::Strip => 1,
        RefineCohort::Exact => 2,
        RefineCohort::Overview => 3,
        RefineCohort::Prefetch => 4,
    }
}

fn finish(
    gate: RefineGate,
    cohort: RefineCohort,
    priority: u8,
    batch_limit: u8,
    trace_name: &'static str,
    trace_code: u8,
    reorder_holes: bool,
    want_strip: bool,
    quiet_strip: bool,
    suppress_prepare: bool,
) -> ScheduleDecision {
    ScheduleDecision {
        gate,
        cohort,
        priority,
        batch_limit,
        trace: trace_name,
        trace_code,
        cohort_code: cohort_code(cohort),
        reorder_holes,
        want_strip,
        quiet_strip,
        suppress_prepare,
        release_cached_tiles: false,
        release_in_use_resources: false,
    }
}

/// Select the next source-refine task. Early gates run before a batch exists.
/// Exact viewport tiles outrank a page overview. Prefetch is last.
pub fn select_refine_task(input: &ScheduleInput) -> ScheduleDecision {
    let optional = input.exact_missing == 0;
    let quiet_strip = quiet_paste_strip_allowed(
        input.moving,
        input.continuous_zoom,
        f64::from(input.exact_missing),
    );
    let bootstrap = !input.has_backing && !input.first_native;
    // The opening zoom-in and a backed full-source pipeline do not spend the
    // raster owner on a coarse page, even if a strip rectangle was built.
    let strip_available =
        input.has_strip && !input.zooming_in && !(input.pipeline_full_source && input.has_backing);
    let strip = coarse_pan_cover(CoarsePanInput {
        first_native: input.first_native,
        has_strip: strip_available,
        strip_cached: input.strip_cached,
        pasteboard: input.pasteboard,
        cpu_only: input.cpu_only,
        translated: input.translated,
        moving: input.moving,
        continuous_zoom: input.continuous_zoom,
        translation_follow: input.translation_follow,
        residents_cover: input.residents_cover,
        quiet_strip_allowed: quiet_strip || bootstrap,
    });
    let want_strip = strip.is_some();
    let idle = |name: &'static str, code: u8, gate: RefineGate| {
        finish(
            gate,
            RefineCohort::None,
            0,
            0,
            name,
            code,
            false,
            want_strip,
            quiet_strip,
            false,
        )
    };
    if input.first_native && optional {
        return idle("paint-first-native", 1, RefineGate::Paint);
    }
    if !want_strip && !optional && input.outward_cover {
        return idle("paint-outward-cover", 2, RefineGate::Paint);
    }
    if !want_strip && optional && input.material_keys && input.moving {
        return idle("stop-material-moving", 3, RefineGate::Stop);
    }
    if !want_strip && optional && input.moving && input.prefetch_not_ready {
        return idle("paint-moving-prefetch", 4, RefineGate::Paint);
    }
    if !want_strip
        && optional
        && input.optional_delay_ms.is_finite()
        && input.optional_delay_ms > 0.0
    {
        return idle("defer-optional", 5, RefineGate::Defer);
    }

    let (cohort, priority, trace_name, trace_code) = if let Some(reason) = strip {
        let (name, code) = match reason {
            StripReason::Cpu => trace("strip-cpu", 6),
            StripReason::Translated => trace("strip-translated", 7),
            StripReason::Quiet if !quiet_strip && bootstrap => trace("strip-bootstrap", 9),
            StripReason::Quiet => trace("strip-quiet", 8),
            StripReason::PanFollow => trace("strip-pan-follow", 10),
        };
        (RefineCohort::Strip, 0, name, code)
    } else if input.exact_missing > 0 {
        (RefineCohort::Exact, 1, "exact-viewport", 11)
    } else if input.overview_candidates > 0 {
        (RefineCohort::Overview, 2, "overview", 12)
    } else if optional && input.prefetch_missing > 0 {
        (RefineCohort::Prefetch, 3, "prefetch", 13)
    } else {
        return finish(
            RefineGate::Stop,
            RefineCohort::None,
            0,
            0,
            "stop-empty",
            14,
            false,
            false,
            quiet_strip,
            false,
        );
    };

    let settled = !optional
        && !input.moving
        && ((input.overview_mode && input.raster_scale <= 1.0)
            || (input.pipeline_full_source && input.exact_lattice && input.raster_scale <= 0.5));
    let base = if settled {
        SETTLED_BATCH
    } else {
        ORDINARY_BATCH
    };
    let cover_motion = input.moving && !input.zooming_in && (input.continuous_zoom || input.panned);
    let inward_single = input.material_keys
        && input.moving
        && input.zooming_in
        && input.continuous_zoom
        && input.has_backing;
    let batch_limit = if want_strip || cover_motion || inward_single {
        1
    } else {
        base
    };
    let suppress_prepare = want_strip
        || cohort == RefineCohort::Overview
        || optional
        || (input.material_keys && input.moving && input.zooming_in && input.continuous_zoom);
    finish(
        RefineGate::Schedule,
        cohort,
        priority,
        batch_limit,
        trace_name,
        trace_code,
        input.exact_missing > 0 && input.moving && !input.zooming_in,
        want_strip,
        quiet_strip,
        suppress_prepare,
    )
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum PolicyRequest {
    Schedule(ScheduleBody),
    Quiet(QuietBody),
    Coarse(CoarseBody),
    Admit(AdmitBody),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleBody {
    moving: bool,
    continuous_zoom: bool,
    zooming_in: bool,
    panned: bool,
    translated: bool,
    translation_follow: bool,
    first_native: bool,
    has_strip: bool,
    strip_cached: bool,
    pasteboard: bool,
    cpu_only: bool,
    residents_cover: bool,
    has_backing: bool,
    exact_missing: u32,
    overview_candidates: u32,
    prefetch_missing: u32,
    outward_cover: bool,
    material_keys: bool,
    prefetch_not_ready: bool,
    optional_delay_ms: f64,
    overview_mode: bool,
    pipeline_full_source: bool,
    exact_lattice: bool,
    raster_scale: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuietBody {
    moving: bool,
    continuous_zoom: bool,
    exact_missing: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoarseBody {
    first_native: bool,
    has_strip: bool,
    strip_cached: bool,
    pasteboard: bool,
    cpu_only: bool,
    translated: bool,
    moving: bool,
    continuous_zoom: bool,
    translation_follow: bool,
    residents_cover: bool,
    quiet_strip_allowed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmitBody {
    aborted: bool,
    generation_current: bool,
    fill_current: bool,
    enforce_fill: bool,
    channel_is_canvas: bool,
    allow_gap_fill: bool,
    can_fill_gap: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleJson {
    gate: &'static str,
    cohort: &'static str,
    priority: u8,
    batch_limit: u8,
    trace: &'static str,
    trace_code: u8,
    cohort_code: u8,
    reorder_holes: bool,
    want_strip: bool,
    quiet_strip: bool,
    suppress_prepare: bool,
    release_cached_tiles: bool,
    release_in_use_resources: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdmitJson {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    release_in_use: bool,
    release_cached_tiles: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlagJson {
    #[serde(skip_serializing_if = "Option::is_none")]
    quiet_strip: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    want_strip: Option<bool>,
    release_in_use_resources: bool,
    release_cached_tiles: bool,
}

impl From<&ScheduleBody> for ScheduleInput {
    fn from(input: &ScheduleBody) -> Self {
        Self {
            moving: input.moving,
            continuous_zoom: input.continuous_zoom,
            zooming_in: input.zooming_in,
            panned: input.panned,
            translated: input.translated,
            translation_follow: input.translation_follow,
            first_native: input.first_native,
            has_strip: input.has_strip,
            strip_cached: input.strip_cached,
            pasteboard: input.pasteboard,
            cpu_only: input.cpu_only,
            residents_cover: input.residents_cover,
            has_backing: input.has_backing,
            exact_missing: input.exact_missing,
            overview_candidates: input.overview_candidates,
            prefetch_missing: input.prefetch_missing,
            outward_cover: input.outward_cover,
            material_keys: input.material_keys,
            prefetch_not_ready: input.prefetch_not_ready,
            optional_delay_ms: input.optional_delay_ms,
            overview_mode: input.overview_mode,
            pipeline_full_source: input.pipeline_full_source,
            exact_lattice: input.exact_lattice,
            raster_scale: input.raster_scale,
        }
    }
}

fn gate_name(gate: RefineGate) -> &'static str {
    match gate {
        RefineGate::Schedule => "schedule",
        RefineGate::Paint => "paint",
        RefineGate::Stop => "stop",
        RefineGate::Defer => "defer",
    }
}

fn cohort_name(cohort: RefineCohort) -> &'static str {
    match cohort {
        RefineCohort::None => "none",
        RefineCohort::Strip => "strip",
        RefineCohort::Exact => "exact",
        RefineCohort::Overview => "overview",
        RefineCohort::Prefetch => "prefetch",
    }
}

pub fn policy_json(json: &str) -> Result<String, String> {
    if json.len() > POLICY_JSON_LIMIT {
        return Err("Invalid zoom refine policy".into());
    }
    let request: PolicyRequest =
        serde_json::from_str(json).map_err(|_| "Invalid zoom refine policy".to_string())?;
    let value = match request {
        PolicyRequest::Schedule(body) => {
            let decision = select_refine_task(&ScheduleInput::from(&body));
            serde_json::to_value(ScheduleJson {
                gate: gate_name(decision.gate),
                cohort: cohort_name(decision.cohort),
                priority: decision.priority,
                batch_limit: decision.batch_limit,
                trace: decision.trace,
                trace_code: decision.trace_code,
                cohort_code: decision.cohort_code,
                reorder_holes: decision.reorder_holes,
                want_strip: decision.want_strip,
                quiet_strip: decision.quiet_strip,
                suppress_prepare: decision.suppress_prepare,
                release_cached_tiles: decision.release_cached_tiles,
                release_in_use_resources: decision.release_in_use_resources,
            })
        }
        PolicyRequest::Quiet(body) => serde_json::to_value(FlagJson {
            quiet_strip: Some(quiet_paste_strip_allowed(
                body.moving,
                body.continuous_zoom,
                body.exact_missing,
            )),
            want_strip: None,
            release_in_use_resources: false,
            release_cached_tiles: false,
        }),
        PolicyRequest::Coarse(body) => serde_json::to_value(FlagJson {
            quiet_strip: None,
            want_strip: Some(
                coarse_pan_cover(CoarsePanInput {
                    first_native: body.first_native,
                    has_strip: body.has_strip,
                    strip_cached: body.strip_cached,
                    pasteboard: body.pasteboard,
                    cpu_only: body.cpu_only,
                    translated: body.translated,
                    moving: body.moving,
                    continuous_zoom: body.continuous_zoom,
                    translation_follow: body.translation_follow,
                    residents_cover: body.residents_cover,
                    quiet_strip_allowed: body.quiet_strip_allowed,
                })
                .is_some(),
            ),
            release_in_use_resources: false,
            release_cached_tiles: false,
        }),
        PolicyRequest::Admit(body) => {
            let choice = admit_prepared_tile(PreparedTileInput {
                aborted: body.aborted,
                generation_current: body.generation_current,
                fill_current: body.fill_current,
                enforce_fill: body.enforce_fill,
                channel_is_canvas: body.channel_is_canvas,
                allow_gap_fill: body.allow_gap_fill,
                can_fill_gap: body.can_fill_gap,
            });
            serde_json::to_value(AdmitJson {
                action: choice.action(),
                reason: choice.reason(),
                release_in_use: choice.release_in_use(),
                release_cached_tiles: choice.release_cached_tiles(),
            })
        }
    }
    .map_err(|_| "Invalid zoom refine policy".to_string())?;
    serde_json::to_string(&value).map_err(|_| "Invalid zoom refine policy".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ScheduleInput {
        ScheduleInput {
            moving: false,
            continuous_zoom: false,
            zooming_in: false,
            panned: false,
            translated: false,
            translation_follow: false,
            first_native: false,
            has_strip: true,
            strip_cached: false,
            pasteboard: true,
            cpu_only: false,
            residents_cover: false,
            has_backing: true,
            exact_missing: 0,
            overview_candidates: 0,
            prefetch_missing: 0,
            outward_cover: false,
            material_keys: false,
            prefetch_not_ready: false,
            optional_delay_ms: 0.0,
            overview_mode: false,
            pipeline_full_source: false,
            exact_lattice: true,
            raster_scale: 1.0,
        }
    }

    fn admit(bits: u8) -> PreparedTileChoice {
        admit_prepared_tile(PreparedTileInput {
            aborted: bits & 1 != 0,
            generation_current: bits & 2 != 0,
            fill_current: bits & 4 != 0,
            enforce_fill: bits & 8 != 0,
            channel_is_canvas: bits & 16 != 0,
            allow_gap_fill: bits & 32 != 0,
            can_fill_gap: bits & 64 != 0,
        })
    }

    #[test]
    fn cancellation_never_releases_resources_and_abort_wins() {
        for bits in 0..128 {
            let choice = admit(bits);
            assert!(!choice.release_in_use());
            assert!(!choice.release_cached_tiles());
            if bits & 1 != 0 {
                assert_eq!(
                    choice,
                    PreparedTileChoice::Cancel {
                        reason: CancelReason::Aborted
                    }
                );
            }
        }
        let fill_cancel = PreparedTileInput {
            aborted: false,
            generation_current: true,
            fill_current: false,
            enforce_fill: true,
            channel_is_canvas: true,
            allow_gap_fill: false,
            can_fill_gap: false,
        };
        assert_eq!(
            admit_prepared_tile(fill_cancel),
            PreparedTileChoice::Cancel {
                reason: CancelReason::Fill
            }
        );
        assert_eq!(
            admit_prepared_tile(PreparedTileInput {
                allow_gap_fill: true,
                can_fill_gap: true,
                ..fill_cancel
            }),
            PreparedTileChoice::CoverGap
        );
        assert_eq!(
            admit_prepared_tile(PreparedTileInput {
                enforce_fill: false,
                ..fill_cancel
            }),
            PreparedTileChoice::Continue
        );
        assert_eq!(
            admit_prepared_tile(PreparedTileInput {
                channel_is_canvas: false,
                ..fill_cancel
            }),
            PreparedTileChoice::Continue
        );
    }

    #[test]
    fn quiet_strip_accepts_only_a_stopped_cached_lattice() {
        assert!(quiet_paste_strip_allowed(false, false, 0.0));
        assert!(!quiet_paste_strip_allowed(false, false, 4.0));
        assert!(!quiet_paste_strip_allowed(true, false, 0.0));
        assert!(!quiet_paste_strip_allowed(false, true, 0.0));
        assert!(!quiet_paste_strip_allowed(false, false, -1.0));
        assert!(!quiet_paste_strip_allowed(false, false, f64::NAN));
        assert!(!quiet_paste_strip_allowed(false, false, 0.5));
    }

    #[test]
    fn coarse_cover_keeps_zoom_out_off_the_raster_owner() {
        let base = CoarsePanInput {
            first_native: false,
            has_strip: true,
            strip_cached: false,
            pasteboard: false,
            cpu_only: false,
            translated: false,
            moving: true,
            continuous_zoom: true,
            translation_follow: false,
            residents_cover: false,
            quiet_strip_allowed: false,
        };
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                pasteboard: true,
                moving: false,
                continuous_zoom: false,
                quiet_strip_allowed: true,
                ..base
            }),
            Some(StripReason::Quiet)
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                pasteboard: true,
                ..base
            }),
            None
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                pasteboard: true,
                translated: true,
                ..base
            }),
            Some(StripReason::Translated)
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                pasteboard: true,
                quiet_strip_allowed: true,
                residents_cover: true,
                ..base
            }),
            None
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                pasteboard: true,
                moving: false,
                continuous_zoom: false,
                quiet_strip_allowed: false,
                ..base
            }),
            None
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                translation_follow: true,
                ..base
            }),
            Some(StripReason::PanFollow)
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                translation_follow: true,
                residents_cover: true,
                ..base
            }),
            None
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                translation_follow: true,
                first_native: true,
                ..base
            }),
            None
        );
        assert_eq!(
            coarse_pan_cover(CoarsePanInput {
                translation_follow: true,
                strip_cached: true,
                ..base
            }),
            None
        );
    }

    #[test]
    fn one_action_chain_is_traceable_and_keeps_exact_tiles_first() {
        let zoom_in = select_refine_task(&ScheduleInput {
            moving: true,
            continuous_zoom: true,
            zooming_in: true,
            exact_missing: 4,
            has_strip: true,
            pasteboard: true,
            ..sample()
        });
        assert_eq!(zoom_in.trace, "exact-viewport");
        assert_eq!(zoom_in.batch_limit, ORDINARY_BATCH);
        assert!(!zoom_in.want_strip);
        assert!(!zoom_in.release_in_use_resources);

        let zoom_out = select_refine_task(&ScheduleInput {
            moving: true,
            continuous_zoom: true,
            zooming_in: false,
            exact_missing: 0,
            has_strip: true,
            pasteboard: true,
            has_backing: true,
            ..sample()
        });
        assert_ne!(zoom_out.cohort, RefineCohort::Strip);
        assert!(!zoom_out.want_strip);
        assert_eq!(zoom_out.gate, RefineGate::Stop);

        let quiet = select_refine_task(&ScheduleInput {
            exact_missing: 0,
            has_strip: true,
            pasteboard: true,
            has_backing: true,
            ..sample()
        });
        assert_eq!(quiet.trace, "strip-quiet");
        assert_eq!(quiet.batch_limit, 1);
        assert_eq!(quiet.priority, 0);

        let holes = select_refine_task(&ScheduleInput {
            moving: false,
            exact_missing: 3,
            overview_candidates: 2,
            ..sample()
        });
        assert_eq!(holes.cohort, RefineCohort::Exact);
        assert_eq!(holes.priority, 1);
        let page = select_refine_task(&ScheduleInput {
            exact_missing: 0,
            overview_candidates: 2,
            has_strip: false,
            ..sample()
        });
        assert_eq!(page.cohort, RefineCohort::Overview);
        assert_eq!(page.priority, 2);
        let none = select_refine_task(&ScheduleInput {
            exact_missing: 0,
            has_strip: false,
            ..sample()
        });
        assert_eq!(none.trace, "stop-empty");
    }

    #[test]
    fn settled_batch_stays_on_the_existing_pipeline_and_not_the_rejected_cohort() {
        let settled_overview = select_refine_task(&ScheduleInput {
            exact_missing: 2,
            overview_mode: true,
            raster_scale: 1.0,
            has_strip: false,
            ..sample()
        });
        assert_eq!(settled_overview.batch_limit, SETTLED_BATCH);
        let settled_source = select_refine_task(&ScheduleInput {
            exact_missing: 4,
            pipeline_full_source: true,
            exact_lattice: true,
            raster_scale: 0.125,
            has_strip: false,
            ..sample()
        });
        assert_eq!(settled_source.batch_limit, SETTLED_BATCH);
        // The rejected path widened every quiet scale<=1 full source, including
        // a non-exact lattice and 0.75. Those stay on the ordinary pair.
        let not_exact = select_refine_task(&ScheduleInput {
            exact_missing: 4,
            pipeline_full_source: true,
            exact_lattice: false,
            raster_scale: 0.125,
            has_strip: false,
            ..sample()
        });
        assert_eq!(not_exact.batch_limit, ORDINARY_BATCH);
        let mid = select_refine_task(&ScheduleInput {
            exact_missing: 4,
            pipeline_full_source: true,
            exact_lattice: true,
            raster_scale: 0.75,
            has_strip: false,
            ..sample()
        });
        assert_eq!(mid.batch_limit, ORDINARY_BATCH);
        let moving = select_refine_task(&ScheduleInput {
            moving: true,
            zooming_in: false,
            continuous_zoom: true,
            exact_missing: 4,
            overview_mode: true,
            raster_scale: 1.0,
            has_strip: false,
            ..sample()
        });
        assert_eq!(moving.batch_limit, 1);
        assert!(moving.reorder_holes);
        assert!(!moving.release_cached_tiles);
    }

    #[test]
    fn json_policy_rejects_unknown_fields_and_preserves_release_flags() {
        let raw = policy_json(r#"{"op":"admit","aborted":false,"generationCurrent":false,"fillCurrent":true,"enforceFill":true,"channelIsCanvas":true,"allowGapFill":false,"canFillGap":false}"#).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["action"], "cancel");
        assert_eq!(parsed["reason"], "generation");
        assert_eq!(parsed["releaseInUse"], false);
        assert_eq!(parsed["releaseCachedTiles"], false);
        assert!(policy_json(r#"{"op":"schedule","moving":true,"extra":1}"#).is_err());
        assert!(policy_json(&format!(
            r#"{{"op":"quiet","moving":false,"continuousZoom":false,"exactMissing":0,{}:"x"}}"#,
            "a".repeat(POLICY_JSON_LIMIT)
        ))
        .is_err());
    }
}
