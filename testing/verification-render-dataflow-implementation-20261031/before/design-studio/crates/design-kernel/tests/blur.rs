use futureox_design_kernel::{
    blend::{Pixel, Surface},
    effects::{tent_blur, tent_weight},
    math::Rect,
};

#[test]
fn subpixel_tent_keeps_its_side_lobes_without_cubic_cancellation() {
    // Integrating the triangular kernel against the adjacent pixel overlap
    // gives integral_0^r t*(r-t)/r^2 dt = r/6, for 0 < r <= 1.
    // This independent closed form includes radii whose squared/cubed value
    // underflows, and radii lost by the expression (1+r)-1.
    for radius in [
        f64::MIN_POSITIVE,
        2_f64.powi(-500),
        2_f64.powi(-60),
        0.125,
        0.5,
        1.,
    ] {
        assert_eq!(
            tent_weight(radius, 1).to_bits(),
            (radius / 6.).to_bits(),
            "r={radius}"
        );
        assert_eq!(tent_weight(radius, 2), 0., "r={radius}");
        assert!(tent_weight(radius, 0).is_finite());
    }
}

#[test]
fn tiny_linear_blur_preserves_a_finite_nonzero_neighbor() {
    let radius = 2_f64.powi(-60);
    let mut source = Surface::new(Rect::new(0, 0, 3, 3)).unwrap();
    source.pixels[4] = Pixel([4., 0., 0., 1.]);
    let out = futureox_design_kernel::effects::linear_tent_blur(&source, radius, false).unwrap();
    assert!(out.pixels.iter().flat_map(|p| p.0).all(f32::is_finite));
    assert_eq!(
        out.pixels[5].0[0].to_bits(),
        ((4. * radius / 6.) as f32).to_bits()
    );
}

#[test]
fn portable_fractional_prefix_guard_matches_exact_q24_convolution() {
    use futureox_design_kernel::effects::{
        TENT_WEIGHT_SCALE, portable_tent_blur_edge, quantized_tent_kernel,
    };
    let mut source = Surface::new(Rect::new(-7, 11, 31, 11)).unwrap();
    for (i, p) in source.pixels.iter_mut().enumerate() {
        *p = Pixel::rgba(
            (i % 7) as f32 / 7.,
            0.47,
            0.83,
            (i * 17 % 251) as f32 / 250.,
        );
    }
    for radius in [0.01, 0.5, 1.25, 2.99, 16.1, 64.25, 128.3, 511.125] {
        let weights = quantized_tent_kernel(radius).unwrap();
        assert_eq!(
            weights[0] + 2 * weights[1..].iter().sum::<u32>(),
            TENT_WEIGHT_SCALE
        );
        for clamp in [false, true] {
            let mut src = source.try_clone().unwrap();
            src.quantize_rgba8();
            for horizontal in [true, false] {
                let mut out = Surface::new(src.rect).unwrap();
                for y in src.rect.y..src.rect.bottom() {
                    for x in src.rect.x..src.rect.right() {
                        let mut total = [0_u32; 4];
                        for i in -(weights.len() as i32 - 1)..weights.len() as i32 {
                            let (mut px, mut py) = if horizontal { (x + i, y) } else { (x, y + i) };
                            if clamp {
                                px = px.clamp(src.rect.x, src.rect.right() - 1);
                                py = py.clamp(src.rect.y, src.rect.bottom() - 1);
                            }
                            let p = src.at(px, py);
                            for (c, value) in total.iter_mut().enumerate() {
                                *value += (p.0[c] * 255.).round_ties_even() as u32
                                    * weights[i.unsigned_abs() as usize];
                            }
                        }
                        out.pixels[src.rect.index(x, y).unwrap()] = Pixel(total.map(|v| {
                            let q = v / TENT_WEIGHT_SCALE;
                            let r = v % TENT_WEIGHT_SCALE;
                            (q + u32::from(
                                r * 2 > TENT_WEIGHT_SCALE
                                    || (r * 2 == TENT_WEIGHT_SCALE && q % 2 == 1),
                            )) as f32
                                / 255.
                        }));
                    }
                }
                src = out;
            }
            let actual = portable_tent_blur_edge(&source, radius, clamp).unwrap();
            assert_eq!(actual.pixels.len(), src.pixels.len());
            for (i, (a, b)) in actual.pixels.iter().zip(src.pixels).enumerate() {
                assert_eq!(*a, b, "radius {radius} clamp {clamp} pixel {i}");
            }
        }
    }
}

fn direct_convolution(source: &Surface, radius: f64) -> Surface {
    let mut src = source.try_clone().unwrap();
    src.quantize_rgba8();
    let integer = radius.fract() == 0. && radius <= 512.;
    for horizontal in [true, false] {
        let mut out = Surface::new(src.rect).unwrap();
        for y in src.rect.y..src.rect.bottom() {
            for x in src.rect.x..src.rect.right() {
                let mut total = [0_f64; 4];
                for i in -(radius.ceil() as i32)..=radius.ceil() as i32 {
                    let p = if horizontal {
                        src.at(x + i, y)
                    } else {
                        src.at(x, y + i)
                    };
                    for (c, value) in total.iter_mut().enumerate() {
                        if integer {
                            let d = i.unsigned_abs() as f64;
                            let numerator = if i == 0 {
                                6. * radius - 2.
                            } else if d < radius {
                                6. * (radius - d)
                            } else {
                                1.
                            };
                            *value += f64::from((p.0[c] * 255.).round_ties_even()) * numerator;
                        } else {
                            *value += f64::from(p.0[c]) * tent_weight(radius, i.unsigned_abs());
                        }
                    }
                }
                out.pixels[src.rect.index(x, y).unwrap()] = Pixel(total.map(|v| {
                    let byte = if integer {
                        v / (6. * radius * radius)
                    } else {
                        v * 255.
                    };
                    (byte.clamp(0., 255.).round_ties_even() / 255.) as f32
                }));
            }
        }
        src = out;
    }
    src
}

#[test]
fn prefix_moments_match_direct_convolution_across_transparent_boundaries() {
    let mut source = Surface::new(Rect::new(-17, 29, 67, 13)).unwrap();
    for (i, p) in source.pixels.iter_mut().enumerate() {
        *p = Pixel::rgba(
            (i % 7) as f32 / 7.,
            0.47,
            0.83,
            ((i * 17 % 251) as f32) / 250.,
        );
    }
    for radius in [0.01, 0.5, 1., 1.25, 2.99, 4., 16.1, 64., 128.3] {
        for (i, (a, b)) in tent_blur(&source, radius)
            .unwrap()
            .pixels
            .iter()
            .zip(direct_convolution(&source, radius).pixels)
            .enumerate()
        {
            assert_eq!(*a, b, "radius {radius}, pixel {i}");
        }
    }
}

#[test]
fn integrated_kernel_preserves_mass_at_integer_and_fractional_radii() {
    for r in [0.01_f64, 0.25, 0.99, 1., 1.001, 2.5, 4., 15.9, 64., 511.125] {
        let weights: Vec<_> = (0..=r.ceil() as u32 + 1)
            .map(|i| tent_weight(r, i))
            .collect();
        assert!(weights.iter().all(|w| *w >= 0.));
        assert_eq!(*weights.last().unwrap(), 0.);
        let sum = weights[0] + 2. * weights[1..].iter().sum::<f64>();
        assert!((sum - 1.).abs() < 1e-12, "radius {r}: {sum}");
    }
}

#[test]
fn integrated_weights_match_independent_pixel_area_quadrature() {
    // Integrate the continuous tent across two unit pixel boxes, independently
    // of the closed-form kernel used by the renderer.
    let steps = 240;
    for r in [0.25_f64, 1., 1.25, 4.5] {
        for distance in 0..=r.ceil() as u32 + 1 {
            let mut sum = 0.;
            for a in 0..steps {
                for b in 0..steps {
                    let x = f64::from(distance) + f64::from(a - b) / f64::from(steps);
                    sum += (r - x.abs()).max(0.) / (r * r);
                }
            }
            let oracle = sum / f64::from(steps * steps);
            assert!(
                (tent_weight(r, distance) - oracle).abs() < 3e-5,
                "{r} {distance}"
            );
        }
    }
}

#[test]
fn blur_uses_transparent_edges_and_keeps_premultiplied_color() {
    let mut source = Surface::new(Rect::new(-9, 7, 17, 17)).unwrap();
    source.pixels[0] = Pixel::rgba(0., 1., 0., 1.);
    let result = tent_blur(&source, 2.5).unwrap();
    assert_eq!(tent_blur(&source, 0.).unwrap().pixels, source.pixels);
    for p in &result.pixels {
        assert_eq!(p.0[0], 0.);
        assert_eq!(p.0[2], 0.);
        assert_eq!(p.0[1], p.0[3]);
    }
    assert!(result.pixels.iter().map(|p| p.0[3]).sum::<f32>() < 0.6);
    assert_eq!(result.at(7, 23), Pixel::default());
}

#[test]
fn clamped_backdrop_blur_preserves_uniform_color_even_in_tiny_buffers() {
    use futureox_design_kernel::effects::tent_blur_edge;
    for (w, h) in [(1, 1), (3, 2), (17, 13)] {
        let mut source = Surface::new(Rect::new(0, 0, w, h)).unwrap();
        let color = Pixel::rgba(0.2, 0.4, 0.8, 0.5).rgba8_quantized();
        source.pixels.fill(color);
        for radius in [0.25, 1., 2.5, 8., 32.] {
            assert!(
                tent_blur_edge(&source, radius, true)
                    .unwrap()
                    .pixels
                    .iter()
                    .all(|p| *p == color),
                "{w}x{h} radius {radius}"
            );
        }
    }
}

#[test]
fn rgba8_resampling_rounds_all_half_byte_ties_consistently() {
    let mut source = Surface::new(Rect::new(-3, 2, 2, 1)).unwrap();
    for a in 0..=255_u32 {
        for b in 0..=255_u32 {
            source.pixels[0] = Pixel([a as f32 / 255.; 4]);
            source.pixels[1] = Pixel([b as f32 / 255.; 4]);
            let sum = a + b;
            let even = sum / 2 + u32::from(sum % 2 == 1 && (sum / 2) % 2 == 1);
            assert_eq!(
                source.sample_rgba8(-2., 2.5),
                Pixel([even as f32 / 255.; 4])
            );
            assert_eq!(source.sample_rgba8(-2.5, 2.5), source.pixels[0]);
        }
    }
}

#[test]
fn gaussian_sliding_intervals_match_independent_fraction_images() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/gaussian-vectors.json"
    ))
    .unwrap();
    for (case, row) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let sigma = row["sigma"].as_f64().unwrap();
        let radii = futureox_design_kernel::effects::gaussian_box_radii(sigma).unwrap();
        assert_eq!(serde_json::to_value(radii).unwrap(), row["radii"]);
        for (x, y) in [(0, 0), (-93, 127)] {
            let r = futureox_design_kernel::math::Rect::new(
                x,
                y,
                row["width"].as_u64().unwrap() as u32,
                row["height"].as_u64().unwrap() as u32,
            );
            let mut source = futureox_design_kernel::blend::Surface::new(r).unwrap();
            for (p, values) in source
                .pixels
                .iter_mut()
                .zip(row["input"].as_array().unwrap().chunks_exact(4))
            {
                p.0 = std::array::from_fn(|c| f32::from_bits(values[c].as_u64().unwrap() as u32));
            }
            let output = futureox_design_kernel::effects::blur(&source, sigma).unwrap();
            let actual: Vec<u32> = output
                .pixels
                .iter()
                .flat_map(|p| p.0.map(f32::to_bits))
                .collect();
            let expected: Vec<u32> = row["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u32)
                .collect();
            assert_eq!(actual, expected, "case {case}, origin ({x},{y})");
        }
    }
}
