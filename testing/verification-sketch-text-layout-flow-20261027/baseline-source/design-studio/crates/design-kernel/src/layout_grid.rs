//! Layout-grid section rendering, decoded from the reference engine's
//! grid shaders (GLSL variants extracted verbatim-semantics):
//!
//! ```glsl
//! a = floor(distance / stride);
//! b = a * stride + 0.5;             // section centre
//! c = b - stride;                   // previous centre
//! lit = [floor(c), floor(c+rounded)+unrounded)   ∪
//!       [floor(b), floor(b+rounded)+unrounded)   ∪
//!       [floor(b+stride), floor(b+stride+rounded)+unrounded)
//! overall = 0 <= distance < cutoff + unrounded
//! ```
//!
//! Sections split into an integral (`rounded`) and fractional
//! (`unrounded`) part so non-integer row/column sizes highlight their
//! sub-pixel remainder correctly.
use serde::{Deserialize, Serialize};

/// Per-axis packed grid metrics (the vec4 attribute payload).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridAxis {
    /// Last lit distance (plus the unrounded remainder).
    pub cutoff: f64,
    /// Section pitch: rounded + unrounded sizes snap to this stride.
    pub stride: f64,
    /// Integral part of a section's size.
    pub rounded_section_size: f64,
    /// Fractional remainder carried past the integral part.
    pub unrounded_section_size: f64,
}

/// One lit span along the axis, in axis coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

fn lit_span(centre: f64, rounded: f64, unrounded: f64) -> Span {
    Span {
        start: centre.floor(),
        end: (centre + rounded).floor() + unrounded,
    }
}

/// Lit spans around `distance`'s section: previous, current, next.
/// Mirrors the shader's three-interval union exactly.
pub fn lit_spans(distance: f64, axis: GridAxis) -> [Span; 3] {
    let a = (distance / axis.stride).floor();
    let b = a * axis.stride + 0.5;
    let c = b - axis.stride;
    [
        lit_span(c, axis.rounded_section_size, axis.unrounded_section_size),
        lit_span(b, axis.rounded_section_size, axis.unrounded_section_size),
        lit_span(
            b + axis.stride,
            axis.rounded_section_size,
            axis.unrounded_section_size,
        ),
    ]
}

/// Whether the grid highlight is on at `distance`.  The shader's
/// `step(edge, x)` family is inclusive (`x >= edge`), so every bound here
/// is closed, matching `0 <= distance <= cutoff + unrounded`.
pub fn section_highlighted(distance: f64, axis: GridAxis) -> bool {
    let inside = distance >= 0. && distance <= axis.cutoff + axis.unrounded_section_size;
    if !inside {
        return false;
    }
    lit_spans(distance, axis)
        .iter()
        .any(|s| s.start <= distance && distance <= s.end)
}

/// Convert solved track sizes (rows or columns, from the grid solver's
/// `getGrid*SizesInOrder`) into alternating lit spans starting at 0.
///
/// Corrected packing (verified against the shader's union predicate):
/// `stride` is the FULL lit+dark period, `rounded` (+ `unrounded`) is the
/// lit track itself - the dark gap is `stride - rounded - unrounded`.  The
/// shader lights `[floor(centre), floor(centre+rounded)+unrounded)` around
/// each 0.5-offset section centre, so a dark track follows every lit one
/// inside the same period.
pub fn tracks_to_spans(tracks: &[f64]) -> (GridAxis, Vec<Span>) {
    // cutoff = end of the last lit track, counting the dark gaps inside:
    // the shader's overall gate must reach the final lit section across
    // its preceding dark tracks (not the mere sum of lit sizes).
    let last_lit_end = {
        let mut end = 0.;
        for (i, &track) in tracks.iter().enumerate() {
            end += track;
            if i % 2 == 0 && i + 1 >= tracks.len() {
                break;
            }
        }
        end
    };
    let lit_track = tracks.first().copied().unwrap_or(0.);
    let dark_track = tracks.get(1).copied().unwrap_or(0.);
    let rounded = lit_track.floor();
    let unrounded = (lit_track - rounded).max(0.);
    let axis = GridAxis {
        cutoff: last_lit_end - unrounded,
        stride: lit_track + dark_track,
        rounded_section_size: rounded,
        unrounded_section_size: unrounded,
    };
    let mut spans = Vec::new();
    let mut cursor = 0.;
    for (i, &track) in tracks.iter().enumerate() {
        if i % 2 == 0 {
            spans.push(Span {
                start: cursor,
                end: cursor + track,
            });
        }
        cursor += track;
    }
    (axis, spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_tracks_light_alternately() {
        // Tracks 80,80,80: lit [0,80) and [160,240), dark [80,160).
        let (axis, spans) = tracks_to_spans(&[80., 80., 80.]);
        assert_eq!(
            spans,
            vec![
                Span {
                    start: 0.,
                    end: 80.
                },
                Span {
                    start: 160.,
                    end: 240.
                }
            ]
        );
        assert!(section_highlighted(0., axis));
        assert!(section_highlighted(79.9, axis));
        // Closed bounds: the lit/dark shared edge lights (step() inclusive).
        assert!(section_highlighted(80., axis), "shared edge lights");
        assert!(!section_highlighted(120., axis), "interior of dark track");
        assert!(section_highlighted(160., axis));
        assert!(!section_highlighted(240.5, axis), "past cutoff");
    }

    #[test]
    fn fractional_tracks_keep_their_remainder_lit() {
        // Track 80.5: rounded 80, unrounded 0.5 - the lit span keeps the
        // sub-pixel remainder (the shader's `+ unrounded` term).
        let (axis, spans) = tracks_to_spans(&[80.5, 80.]);
        assert_eq!(
            spans,
            vec![Span {
                start: 0.,
                end: 80.5
            }]
        );
        assert!(section_highlighted(80.25, axis), "remainder stays lit");
        assert!(!section_highlighted(81., axis), "next (dark) track");
    }

    #[test]
    fn shader_union_matches_span_model() {
        // Cross-check the three-interval union against the span model on a
        // coarse sweep: identical predicate everywhere.
        let (axis, spans) = tracks_to_spans(&[40., 60., 40., 60.]);
        let mut d = 0.;
        while d < 200. {
            let via_shader = section_highlighted(d, axis);
            let via_spans = spans.iter().any(|s| s.start <= d && d <= s.end);
            assert_eq!(via_shader, via_spans, "mismatch at {d}");
            d += 2.5;
        }
    }

    #[test]
    fn negative_distance_is_dark() {
        let (axis, _) = tracks_to_spans(&[50., 50.]);
        assert!(!section_highlighted(-1., axis));
    }
}
