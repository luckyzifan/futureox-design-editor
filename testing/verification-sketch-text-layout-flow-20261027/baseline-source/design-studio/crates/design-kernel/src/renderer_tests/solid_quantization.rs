//! Exercise the production paint loop against its non-solid sampling path.
//! A constant gradient is an independent route through Sampler::at, so these
//! tests do not duplicate the solid-cache or quantization implementation.

use super::*;
use crate::{color::ColorSettings, scene::Stop};
use serde_json::json;
use std::collections::HashMap;

struct Fixture {
    doc: Document,
    images: Images,
    prepared: HashMap<String, Prepared>,
    stats: Stats,
}

impl Fixture {
    fn new(settings: Option<ColorSettings>) -> Self {
        let mut engine = Engine::new();
        engine
            .load_document(
                &json!({
                    "schemaVersion": 4, "id": "d", "name": "Solid quantization",
                    "colorManagement": settings,
                    "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": ["n"]}],
                    "nodes": {"n": {"id": "n", "kind": "rectangle", "width": 8, "height": 4}}
                })
                .to_string(),
            )
            .unwrap();
        Self {
            doc: engine.doc.take().unwrap().into(),
            // Loading the document configures the real Images color settings.
            images: engine.images,
            prepared: HashMap::new(),
            stats: Stats {
                effect_layers: 2,
                backdrop_reads: 3,
                nodes: 5,
                culled: 7,
                path_segments: 11,
                shaded_pixels: 13,
                peak_layer_pixels: 17,
                allocated_layer_pixels: 19,
                peak_compositing_bytes: 23,
            },
        }
    }

    fn painter(&mut self, extent: Rect, compatible: bool, sample: Option<usize>) -> Painter<'_> {
        Painter {
            doc: &self.doc,
            prepared: &self.prepared,
            images: &mut self.images,
            stats: &mut self.stats,
            budget: Budget::new(COMPOSITING_BYTES),
            extent,
            viewport: extent,
            compatible,
            coverage_compatible: true,
            profile: if compatible {
                crate::fidelity::RasterProfile::FigmaSubpixel
            } else {
                crate::fidelity::RasterProfile::Analytic
            },
            interactive_effects: false,
            sample,
        }
    }

    fn draw(
        &mut self,
        paint: &Paint,
        compatible: bool,
        sample: Option<usize>,
        mask: &Mask,
        extra: &[f32],
        layer: &mut Surface,
    ) {
        let node = self.doc.nodes["n"].clone();
        self.painter(layer.rect, compatible, sample)
            .paint(&node, paint, Transform::default(), mask, layer, |x, y| {
                extra[mask.rect.index(x, y).unwrap()]
            })
            .unwrap();
    }
}

fn solid(color: &str, opacity: f64) -> Paint {
    serde_json::from_value(json!({"kind": "solid", "color": color, "opacity": opacity})).unwrap()
}

fn constant_gradient(paint: &Paint) -> Paint {
    let mut gradient = paint.clone();
    gradient.kind = "linear".into();
    gradient.stops = [0., 1.]
        .map(|offset| Stop {
            offset,
            color: paint.color.clone(),
        })
        .to_vec();
    gradient
}

fn backdrop(rect: Rect) -> Surface {
    let mut surface = Surface::new(rect).unwrap();
    for (i, pixel) in surface.pixels.iter_mut().enumerate() {
        *pixel = Pixel::hex(
            ["#234567", "#c57931", "#19afdc"][i % 3],
            [0., 0.375, 0.8, 1.][i % 4],
        )
        .unwrap();
    }
    surface
}

fn assert_same(actual: &Surface, expected: &Surface, a: &Stats, b: &Stats, label: &str) {
    assert_eq!(actual.rect, expected.rect, "{label}: rectangle");
    assert_eq!(actual.pixels.len(), expected.pixels.len(), "{label}: size");
    for (i, (actual, expected)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
        assert_eq!(
            actual.0.map(f32::to_bits),
            expected.0.map(f32::to_bits),
            "{label}: pixel {i}"
        );
    }
    assert_eq!(
        serde_json::to_value(a).unwrap(),
        serde_json::to_value(b).unwrap(),
        "{label}: all stats"
    );
}

#[test]
fn solid_matches_constant_gradient_for_coverage_opacity_blend_and_each_sample() {
    let mask = Mask {
        rect: Rect::new(-2, 3, 6, 2),
        data: vec![-0.5, 0., 0.25, 0.5, 1., 1.5, f32::NAN, 1., 0.5, 2., 1., 1.],
    };
    // Includes 0.5 * 2 and 2 * 0.5: eligibility depends on the product.
    let extras = [
        (vec![1.; 12], 10),
        (
            vec![1., 1., 1., 1., 1., 1., 1., 0., 2., 0.5, 1.25, f32::NAN],
            9,
        ),
    ];
    let initial = backdrop(Rect::new(-3, 2, 8, 4));
    for sample in 0..4 {
        for color in ["#000000", "#397db5", "#ffffff"] {
            for opacity in [0., 0.55, 0.875, 1.] {
                for blend in ["normal", "multiply", "screen"] {
                    let mut paint = solid(color, opacity);
                    paint.blend = blend.into();
                    paint.angle = 37.;
                    paint.transform = Some(Transform([1., 0.25, -0.125, 1., 0.2, -0.3]));
                    for (extra, shaded) in &extras {
                        let mut actual = initial.try_clone().unwrap();
                        let mut expected = initial.try_clone().unwrap();
                        let mut fast = Fixture::new(None);
                        let mut fallback = Fixture::new(None);
                        fast.draw(&paint, true, Some(sample), &mask, extra, &mut actual);
                        fallback.draw(
                            &constant_gradient(&paint),
                            true,
                            Some(sample),
                            &mask,
                            extra,
                            &mut expected,
                        );
                        assert_same(
                            &actual,
                            &expected,
                            &fast.stats,
                            &fallback.stats,
                            &format!(
                                "sample={sample} color={color} opacity={opacity} blend={blend}"
                            ),
                        );
                        assert_eq!(fast.stats.shaded_pixels, 13 + shaded);
                        // The complete surrounding surface is compared above too.
                        assert_eq!(actual.at(-3, 2), initial.at(-3, 2));
                    }
                }
            }
        }
    }
}

#[test]
fn scalar_and_managed_modes_match_fallback_and_preserve_extended_range() {
    let rect = Rect::new(0, 0, 8, 2);
    let mask = Mask {
        rect,
        data: vec![1.; rect.pixels()],
    };
    let extra = vec![1.; rect.pixels()];
    let mut distinguishes_source_quantization = false;
    for settings in [None, Some(ColorSettings::default())] {
        for sample in [None, Some(0), Some(1), Some(2), Some(3)] {
            if settings.is_none() && sample.is_some() {
                continue; // Legacy sample planes are covered by the first test.
            }
            let compatible = settings.is_none();
            let color = if compatible {
                "#397db5"
            } else {
                "color(srgb-linear 8 -2 0.125 / 0.5)"
            };
            for opacity in [0.55, 0.875] {
                let paint = solid(color, opacity);
                let mut fast = Fixture::new(settings);
                let mut fallback = Fixture::new(settings);
                let initial = if compatible {
                    backdrop(rect)
                } else {
                    Surface::new(rect).unwrap()
                };
                let mut actual = initial.try_clone().unwrap();
                let mut expected = actual.try_clone().unwrap();
                fast.draw(&paint, compatible, sample, &mask, &extra, &mut actual);
                fallback.draw(
                    &constant_gradient(&paint),
                    compatible,
                    sample,
                    &mask,
                    &extra,
                    &mut expected,
                );
                assert_same(
                    &actual,
                    &expected,
                    &fast.stats,
                    &fallback.stats,
                    "scalar/managed",
                );
                if settings.is_some() {
                    assert!(actual.pixels.iter().all(|p| p.0[0] > 1. && p.0[1] < 0.));
                    assert!(
                        actual
                            .pixels
                            .iter()
                            .all(|p| p.0.iter().all(|c| c.is_finite()))
                    );
                } else {
                    // A transparent destination would hide an accidentally
                    // prequantized source behind the final quantization.
                    let mut quantized = initial;
                    Fixture::new(None).draw(&paint, true, Some(0), &mask, &extra, &mut quantized);
                    distinguishes_source_quantization |= actual
                        .pixels
                        .iter()
                        .zip(&quantized.pixels)
                        .any(|(a, b)| a.0.map(f32::to_bits) != b.0.map(f32::to_bits));
                }
            }
        }
    }
    assert!(distinguishes_source_quantization);
}

#[test]
fn non_solid_samplers_keep_constant_colors_and_spatial_variation() {
    let rect = Rect::new(0, 0, 8, 1);
    let mask = Mask {
        rect,
        data: vec![1.; rect.pixels()],
    };
    let extra = vec![1.; rect.pixels()];
    for sample in [None, Some(0), Some(1), Some(2), Some(3)] {
        let paint = solid("#d43179", 0.55);
        let mut expected_fixture = Fixture::new(None);
        let mut expected = Surface::new(rect).unwrap();
        expected_fixture.draw(&paint, true, sample, &mask, &extra, &mut expected);
        for kind in ["linear", "radial", "angular", "diamond"] {
            let mut gradient = constant_gradient(&paint);
            gradient.kind = kind.into();
            let mut fixture = Fixture::new(None);
            let node = fixture.doc.nodes["n"].clone();
            assert!(
                Sampler::new(
                    &gradient,
                    &node,
                    Transform::default(),
                    rect,
                    &mut fixture.images
                )
                .unwrap()
                .solid()
                .is_none()
            );
            let mut actual = Surface::new(rect).unwrap();
            fixture.draw(&gradient, true, sample, &mask, &extra, &mut actual);
            assert_same(
                &actual,
                &expected,
                &fixture.stats,
                &expected_fixture.stats,
                kind,
            );
        }
        let blue = solid("#2768cf", 0.55);
        let mut blue_fixture = Fixture::new(None);
        let mut blue_surface = Surface::new(rect).unwrap();
        blue_fixture.draw(&blue, true, sample, &mask, &extra, &mut blue_surface);
        let mut gradient = constant_gradient(&paint);
        gradient.stops[0].offset = 0.25;
        gradient.stops[1] = Stop {
            offset: 0.75,
            color: blue.color.clone(),
        };
        let mut actual = Surface::new(rect).unwrap();
        Fixture::new(None).draw(&gradient, true, sample, &mask, &extra, &mut actual);
        // Endpoint references also come from real paint calls, not a copy of
        // gradient interpolation, source quantization or compositing arithmetic.
        assert_eq!(
            actual.at(0, 0).0.map(f32::to_bits),
            expected.at(0, 0).0.map(f32::to_bits)
        );
        assert_eq!(
            actual.at(7, 0).0.map(f32::to_bits),
            blue_surface.at(7, 0).0.map(f32::to_bits)
        );
        assert_ne!(actual.at(3, 0), actual.at(0, 0));
        assert_ne!(actual.at(3, 0), actual.at(7, 0));
    }
}

#[test]
fn consecutive_paints_recompute_color_opacity_and_paint_properties() {
    let rect = Rect::new(0, 0, 8, 2);
    let mask = Mask {
        rect,
        data: vec![1.; rect.pixels()],
    };
    let mut fast = Fixture::new(None);
    let mut fallback = Fixture::new(None);
    let node = fast.doc.nodes["n"].clone();
    let mut fast = fast.painter(rect, true, Some(0));
    let mut fallback = fallback.painter(rect, true, Some(0));
    let mut actual = backdrop(rect);
    let mut expected = actual.try_clone().unwrap();
    for (index, (color, opacity, blend, visible)) in [
        ("#c7356b", 0.55, "normal", true),
        ("#237dd1", 0.875, "multiply", true),
        ("#ffffff", 0., "screen", true),
        ("#61932f", 1., "normal", false),
        ("#16283a", 0.875, "screen", true),
        ("#ef8b27", 0.55, "normal", true),
    ]
    .into_iter()
    .enumerate()
    {
        let mut paint = solid(color, opacity);
        paint.blend = blend.into();
        paint.visible = visible;
        paint.angle = 13. * index as f64;
        paint.transform = Some(Transform([1., 0., 0., 1., index as f64 * 0.125, 0.]));
        // Interleave a real non-solid call on the same Painter as well.
        if index == 4 {
            paint = constant_gradient(&paint);
            paint.stops[1].color = "#e92751".into();
        }
        let reference = if paint.kind == "solid" {
            constant_gradient(&paint)
        } else {
            paint.clone()
        };
        fast.sample = Some(index % 4);
        fallback.sample = fast.sample;
        let extra = if index == 1 { 0.5 } else { 1. };
        fast.paint(
            &node,
            &paint,
            Transform::default(),
            &mask,
            &mut actual,
            |_, _| extra,
        )
        .unwrap();
        fallback
            .paint(
                &node,
                &reference,
                Transform::default(),
                &mask,
                &mut expected,
                |_, _| extra,
            )
            .unwrap();
        assert_same(
            &actual,
            &expected,
            fast.stats,
            fallback.stats,
            &format!("call {index}"),
        );
    }
    assert_eq!(fast.stats.shaded_pixels, 13 + rect.pixels() * 5);
}

#[test]
fn sampler_validation_precedes_pixels_stats_and_coverage_evaluation() {
    let rect = Rect::new(0, 0, 2, 2);
    let mut cases = Vec::new();
    let mut invalid = solid("not-a-color", 0.55);
    invalid.opacity = f64::NAN;
    cases.push((invalid.clone(), Transform([0.; 6]), "Invalid paint"));
    invalid = solid("#397db5", 0.55);
    invalid.angle = f64::INFINITY;
    cases.push((invalid.clone(), Transform::default(), "Invalid paint"));
    invalid = solid("#397db5", 0.55);
    invalid.transform = Some(Transform([0.; 6]));
    cases.push((invalid, Transform::default(), "Singular transform"));
    cases.push((
        solid("#397db5", 0.55),
        Transform([0.; 6]),
        "Singular transform",
    ));
    cases.push((
        solid("#397db5", 0.55),
        Transform([1., 0., 0., 1., f64::NAN, 0.]),
        "Nonfinite composed transform",
    ));
    for coverage in [0., 1.] {
        let mask = Mask {
            rect,
            data: vec![coverage; rect.pixels()],
        };
        for (paint, matrix, message) in &cases {
            let mut fixture = Fixture::new(None);
            let node = fixture.doc.nodes["n"].clone();
            let before_stats = fixture.stats.clone();
            let mut layer = backdrop(rect);
            let before = layer.try_clone().unwrap();
            let error = fixture
                .painter(rect, true, Some(0))
                .paint(&node, paint, *matrix, &mask, &mut layer, |_, _| {
                    panic!("coverage evaluated before sampler validation")
                })
                .unwrap_err();
            assert_eq!(error.as_str(), *message);
            assert_same(&layer, &before, &fixture.stats, &before_stats, message);
        }
    }
    // This real matrix succeeds for a one-pixel sampling rectangle near zero,
    // but fails the precision budget at a distant one-pixel rectangle. Using a
    // dummy rectangle to construct a cached solid must not suppress the error.
    let matrix = Transform([2.5e-5, 0., 2.5e-5, 2.5e-13, 0., 0.]);
    for (rect, fails) in [
        (Rect::new(0, 0, 1, 1), false),
        (Rect::new(8192, 8192, 1, 1), true),
    ] {
        let mut fixture = Fixture::new(None);
        let node = fixture.doc.nodes["n"].clone();
        let before_stats = fixture.stats.clone();
        let mut layer = backdrop(rect);
        let before = layer.try_clone().unwrap();
        let mask = Mask {
            rect,
            data: vec![1.],
        };
        let called = std::cell::Cell::new(false);
        let result = fixture
            .painter(Rect::new(0, 0, 16384, 16384), true, Some(0))
            .paint(
                &node,
                &solid("#397db5", 0.875),
                matrix,
                &mask,
                &mut layer,
                |_, _| {
                    called.set(true);
                    1.
                },
            );
        if fails {
            assert_eq!(
                result.unwrap_err(),
                "Composed inverse exceeds precision budget"
            );
            assert!(!called.get());
            assert_same(
                &layer,
                &before,
                &fixture.stats,
                &before_stats,
                "sampling rectangle error",
            );
        } else {
            result.unwrap();
            assert!(called.get());
            assert_eq!(fixture.stats.shaded_pixels, before_stats.shaded_pixels + 1);
        }
    }
}
