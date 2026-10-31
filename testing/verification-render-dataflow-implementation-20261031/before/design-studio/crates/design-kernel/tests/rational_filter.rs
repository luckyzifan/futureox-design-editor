use futureox_design_kernel::rational_filter::RationalKernel;

#[test]
fn exact_filter_matches_independent_piecewise_integration_and_rational_rounding() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/filter-vectors.json"
    ))
    .unwrap();
    for (index, row) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let radius =
            f64::from_bits(u64::from_str_radix(row["radiusBits"].as_str().unwrap(), 16).unwrap());
        let kernel = if row["kind"] == "box" {
            RationalKernel::uniform_box(radius as u32)
        } else {
            RationalKernel::tent(radius)
        }
        .unwrap();
        let values: Vec<_> = row["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| f32::from_bits(v.as_u64().unwrap() as u32))
            .collect();
        let actual = kernel.convolve(&values).unwrap();
        assert_eq!(
            actual.to_bits(),
            row["expected"].as_u64().unwrap() as u32,
            "vector {index}, radius {radius}"
        );
        assert!(kernel.encoded().len() <= 4096 * 4);
    }
}

#[test]
fn exact_filter_rejects_invalid_domain_without_faking_pixels() {
    for radius in [0., -1., 2048.0001, f64::NAN, f64::INFINITY] {
        assert!(RationalKernel::tent(radius).is_err());
    }
    let kernel = RationalKernel::tent(0.5).unwrap();
    assert!(kernel.convolve(&[0., f32::NAN, 0.]).is_err());
    assert!(kernel.convolve(&[0.]).is_err());
}

#[test]
fn certified_prefix_matches_direct_rational_filter_including_cancellation_and_clamp() {
    use futureox_design_kernel::{
        blend::{Pixel, Surface},
        effects,
        math::Rect,
    };
    for (w, h, extreme) in [(17, 9, false), (257, 1, false), (9, 3, true)] {
        let mut source = Surface::new(Rect::new(-31, 17, w, h)).unwrap();
        let mut seed = 0x93e71a05_u32;
        for (i, p) in source.pixels.iter_mut().enumerate() {
            for (c, v) in p.0.iter_mut().enumerate() {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                *v = if extreme {
                    let anchors = [
                        0x7f7fffff, 0xff7fffff, 1, 0x80000001, 0x3f800000, 0xbf800000, 0,
                    ];
                    f32::from_bits(anchors[(i + c) % anchors.len()])
                } else {
                    f32::from_bits(0x3f800000 | (seed & 0x7fffff)) * if c == 1 { -3.7 } else { 8.3 }
                };
            }
        }
        for radius in [8., 8.125, 16.125, 64.125] {
            for clamp in [false, true] {
                let actual = effects::linear_tent_blur(&source, radius, clamp).unwrap();
                let kernel = RationalKernel::tent(radius).unwrap();
                let reach = kernel.reach() as i32;
                let mut expected = source.try_clone().unwrap();
                let mut taps = vec![0.; kernel.reach() * 2 + 1];
                for horizontal in [true, false] {
                    let r = source.rect;
                    let mut out = Surface::new(r).unwrap();
                    for y in r.y..r.bottom() {
                        for x in r.x..r.right() {
                            let mut value = [0.; 4];
                            for (c, channel) in value.iter_mut().enumerate() {
                                for (i, v) in taps.iter_mut().enumerate() {
                                    let delta = i as i32 - reach;
                                    let (mut sx, mut sy) = if horizontal {
                                        (x + delta, y)
                                    } else {
                                        (x, y + delta)
                                    };
                                    if clamp {
                                        sx = sx.clamp(r.x, r.right() - 1);
                                        sy = sy.clamp(r.y, r.bottom() - 1);
                                    }
                                    *v = expected.at(sx, sy).0[c];
                                }
                                *channel = kernel.convolve(&taps).unwrap();
                            }
                            out.pixels[r.index(x, y).unwrap()] = Pixel(value);
                        }
                    }
                    expected = out;
                }
                for (i, (a, e)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
                    assert_eq!(
                        a.0.map(f32::to_bits),
                        e.0.map(f32::to_bits),
                        "{w}x{h} extreme={extreme} radius={radius} clamp={clamp} pixel={i}"
                    );
                }
            }
        }
    }
}
