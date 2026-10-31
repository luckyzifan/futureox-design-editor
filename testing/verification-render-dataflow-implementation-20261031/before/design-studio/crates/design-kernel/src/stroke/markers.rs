#![allow(clippy::cloned_ref_to_slice_refs)]
use super::{Contour, Point, disk, outline_geometry, polygon};
use crate::scene::{Document, Stroke};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Marker {
    #[default]
    None,
    Arrow,
    Triangle,
    Circle,
    Diamond,
    Square,
    Bar,
}
impl Marker {
    pub fn is_none(&self) -> bool {
        *self == Self::None
    }
}

pub fn has_markers(d: &Document) -> bool {
    let marked = |s: &Stroke| !s.start_marker.is_none() || !s.end_marker.is_none();
    let values = |v: &serde_json::Value| {
        v.as_array().is_some_and(|v| {
            v.iter().any(|s| {
                ["startMarker", "endMarker"].iter().any(|key| {
                    s.get(key)
                        .is_some_and(|v| !v.is_null() && v.as_str() != Some("none"))
                })
            })
        })
    };
    d.nodes.values().any(|n| {
        n.strokes.iter().any(marked)
            || n.instance.as_ref().is_some_and(|i| {
                i.overrides
                    .values()
                    .any(|o| o.get("strokes").is_some_and(values))
            })
    }) || d
        .animations
        .iter()
        .flat_map(|c| &c.tracks)
        .flat_map(|t| &t.keyframes)
        .flat_map(|k| &k.value.strokes)
        .any(marked)
}

/// Endpoints belong to the original open contour, not each dashed fragment.
/// Return the same positive-winding primitives to picking, CPU, GPU and SVG.
pub(super) fn expand(
    cs: &[Contour],
    s: &Stroke,
    tolerance: f64,
    dilation: f64,
    count: &mut usize,
) -> Result<Vec<Contour>, String> {
    if s.width == 0. || (s.start_marker.is_none() && s.end_marker.is_none()) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for c in cs.iter().filter(|c| !c.closed && c.points.len() >= 2) {
        for (start, marker) in [(true, s.start_marker), (false, s.end_marker)] {
            if marker.is_none() {
                continue;
            }
            let tip = if start {
                c.points[0]
            } else {
                *c.points.last().unwrap()
            };
            let next = if start {
                c.points.iter().copied().find(|p| *p != tip)
            } else {
                c.points.iter().rev().copied().find(|p| *p != tip)
            };
            let Some(next) = next else {
                continue;
            };
            let size = (tip - next).length();
            if !size.is_finite() || size == 0. {
                continue;
            }
            let direction = (tip - next) * (1. / size);
            let normal = Point::new(-direction.y, direction.x);
            let profile = if start {
                s.width_profile.first()
            } else {
                s.width_profile.last()
            };
            let width = s.width * profile.map_or(1., |p| p.left.max(p.right));
            if width == 0. {
                continue;
            }
            let length = width * 3.;
            let p = |x: f64, y: f64| tip + direction * (x * length) + normal * (y * length);
            let shape = match marker {
                Marker::None => continue,
                Marker::Circle => disk(tip, length / 2., tolerance)?,
                // ARROW_EQUILATERAL: apex angle 60°; base half-width tan(30°).
                Marker::Triangle => polygon(vec![
                    tip,
                    p(-1., 0.577_350_269_189_625_8),
                    p(-1., -0.577_350_269_189_625_8),
                ]),
                Marker::Diamond => polygon(vec![p(0.5, 0.), p(0., 0.5), p(-0.5, 0.), p(0., -0.5)]),
                Marker::Square => {
                    polygon(vec![p(0.5, 0.5), p(-0.5, 0.5), p(-0.5, -0.5), p(0.5, -0.5)])
                }
                Marker::Arrow | Marker::Bar => {
                    let points = if marker == Marker::Arrow {
                        // ARROW_LINES: two cap lines at 45° to the path direction.
                        vec![p(-1., 1.), tip, p(-1., -1.)]
                    } else {
                        vec![p(0., 0.5), p(0., -0.5)]
                    };
                    out.extend(outline_geometry(
                        &[Contour {
                            points,
                            closed: false,
                        }],
                        width + dilation * 2.,
                        "butt",
                        "miter",
                        tolerance,
                        count,
                    )?);
                    continue;
                }
            };
            if dilation > 0. {
                out.extend(outline_geometry(
                    &[shape.clone()],
                    dilation * 2.,
                    "round",
                    "round",
                    tolerance,
                    count,
                )?);
            }
            *count += shape.points.len();
            if *count > 2_000_000 {
                return Err("Stroke output budget exceeded".into());
            }
            out.push(shape);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Point;

    fn stroke(marker: Marker) -> Stroke {
        let mut s: Stroke = serde_json::from_value(serde_json::json!(
            {"paint":{"kind":"solid","color":"#000000"},"width":4,"cap":"butt","join":"miter"}
        ))
        .unwrap();
        s.end_marker = marker;
        s
    }
    fn line() -> Contour {
        Contour {
            points: vec![Point::new(0., 0.), Point::new(100., 0.)],
            closed: false,
        }
    }

    #[test]
    fn arrow_arms_make_the_documented_45_degree_angle() {
        let s = stroke(Marker::Arrow);
        let out = expand(&[line()], &s, 0.01, 0., &mut 0).unwrap();
        let points: Vec<Point> = out.iter().flat_map(|c| c.points.iter().copied()).collect();
        let axial = points.iter().map(|p| 100. - p.x).fold(0_f64, f64::max);
        let lateral = points.iter().map(|p| p.y.abs()).fold(0_f64, f64::max);
        // Equal axial and lateral reach is unique to a 45° chevron; the exact
        // value adds the butt-cap corner radius of the 4-unit arm stroke.
        assert!((axial - lateral).abs() < 1e-9, "{axial} vs {lateral}");
        assert!((axial - (12. + 2_f64.sqrt())).abs() < 1e-9, "{axial}");
    }

    #[test]
    fn triangle_is_equilateral_with_a_60_degree_apex() {
        let s = stroke(Marker::Triangle);
        let out = expand(&[line()], &s, 0.01, 0., &mut 0).unwrap();
        assert_eq!(out.len(), 1);
        let p = &out[0].points;
        assert_eq!(p.len(), 3);
        let tip = p
            .iter()
            .copied()
            .reduce(|a, b| if a.x > b.x { a } else { b })
            .unwrap();
        assert_eq!(tip, Point::new(100., 0.));
        let sides: Vec<f64> = (0..3).map(|i| (p[i] - p[(i + 1) % 3]).length()).collect();
        assert!(
            (sides[0] - sides[1]).abs() < 1e-12 && (sides[1] - sides[2]).abs() < 1e-12,
            "{sides:?}"
        );
        let height = p.iter().map(|q| tip.x - q.x).fold(0_f64, f64::max);
        assert!((sides[0] - height / 0.866_025_403_784_438_6).abs() < 1e-9);
    }
}
