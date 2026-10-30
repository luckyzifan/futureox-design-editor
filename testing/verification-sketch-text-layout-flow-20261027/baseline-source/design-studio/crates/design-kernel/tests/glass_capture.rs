use futureox_design_kernel::{
    glass_capture::{Replay, ReplayPrimitive},
    math::{Rect, Transform},
};

fn replay(world_x: f64) -> Replay {
    Replay {
        parent_matrix: Transform([2., 0., 0., 2., 0., 0.]),
        parent_world_transform: Transform([1., 0., 0., 1., world_x, 96.]),
        camera_matrix: Transform([2., 0., 0., 2., -world_x * 2., -192.]),
        parent_size: [128., 128.],
        lens_bounds: [32., 32., 224., 224.],
        lens_rect: Rect::new(32, 32, 192, 192),
        primitives: vec![
            ReplayPrimitive {
                transform: Transform::default(),
                size: [128., 128.],
                color: [1.; 4],
            },
            ReplayPrimitive {
                transform: Transform([1., 0., 0., 1., 8., 0.]),
                size: [8., 128.],
                color: [0., 1., 0., 1.],
            },
            ReplayPrimitive {
                transform: Transform([1., 0., 0., 1., 16., 0.]),
                size: [8., 128.],
                color: [0., 0., 1., 1.],
            },
        ],
        effective_frost: 1.5,
        support: 1.5,
        side: 512,
    }
}

#[test]
fn world_translation_keeps_capture_raster_phase() {
    // A real-world translation and its camera cancellation cannot be reduced
    // in f64 before the independently verified f32 capture transform. The
    // projected edge lands on opposite sides of a Q8 raster midpoint.
    let world = replay(5704.).tile([0, 0], 3).unwrap();
    let local = replay(0.).tile([0, 0], 3).unwrap();
    assert_eq!(world.density.to_bits(), 0.98828125_f32.to_bits());
    assert_eq!(world.kernel_count.to_bits(), 1.4826255_f32.to_bits());
    assert_eq!(world.primitives[2].rect.x, 35);
    assert_eq!(local.primitives[2].rect.x, 34);
    assert_eq!(
        world.coordinate([32.5, 128.5]),
        local.coordinate([32.5, 128.5])
    );
}

#[test]
fn centered_coordinate_preserves_the_native_fma_boundary() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/centered-capture-coordinate-vectors.json"
    ))
    .unwrap();
    let density = f32::from_bits(data["uniforms"]["densityBits"].as_u64().unwrap() as u32);
    let side = f32::from_bits(data["uniforms"]["sideBits"].as_u64().unwrap() as u32);
    let mut plan = replay(0.).tile([0, 0], 0).unwrap();
    plan.density = density;
    plan.side = side as u32;
    let records = data["records"].as_array().unwrap();
    assert_eq!(records.len(), 384);
    let mut unfused_differences = 0;
    for record in records {
        let uv = std::array::from_fn::<_, 2, _>(|i| {
            f32::from_bits(record["uvBits"][i].as_u64().unwrap() as u32)
        });
        // Multiplication/division by 512 are exact for this fixture's normal
        // values. Exercise the public placement API, not a duplicate FMA helper.
        let actual = plan.coordinate(uv.map(|v| v * 512.));
        for i in 0..2 {
            let expected = record["expectedSamplePositionBits"][i].as_u64().unwrap() as u32;
            assert_eq!(actual[i].to_bits(), expected);
            let unfused = ((uv[i] - 0.5) * (density * 0.5) + 0.5) * side;
            unfused_differences += usize::from(unfused.to_bits() != expected);
        }
    }
    assert_eq!(unfused_differences, 119);
}

#[test]
fn replay_and_tile_wire_contracts_round_trip() {
    let input = replay(5704.);
    let json = serde_json::to_value(&input).unwrap();
    assert!(json.get("parentWorldTransform").is_some());
    assert!(json.get("cameraMatrix").is_some());
    assert_eq!(
        json["lensBounds"],
        serde_json::json!([32., 32., 224., 224.])
    );
    let decoded: Replay = serde_json::from_value(json.clone()).unwrap();
    decoded.validate().unwrap();
    let plan = serde_json::to_value(decoded.tile([0, 0], 3).unwrap()).unwrap();
    assert_eq!(plan["side"], 512);
    assert!(plan.get("kernelCount").is_some());
    assert!(plan["primitives"][0].get("rect").is_some());
    let mut unknown = json;
    unknown["implicitOrigin"] = serde_json::json!([0, 0]);
    assert!(serde_json::from_value::<Replay>(unknown).is_err());
}

#[test]
fn invalid_replay_parameters_are_rejected_before_projection() {
    for side in [0, 256, 2048] {
        let mut value = replay(0.);
        value.side = side;
        assert!(value.validate().is_err());
    }
    for value in [f32::NAN, f32::INFINITY, -1., 0.] {
        let mut input = replay(0.);
        input.effective_frost = value;
        assert!(input.validate().is_err());
    }
    let mut value = replay(0.);
    value.support = 1.;
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.parent_world_transform.0[4] = f64::NAN;
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.camera_matrix.0[0] = -1.;
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.parent_size[0] = 0.;
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.lens_rect.w = u32::MAX;
    assert!(value.validate().is_err());
    for bounds in [
        [f64::NAN, 32., 224., 224.],
        [32., 32., f64::INFINITY, 224.],
        [32., 32., 32., 224.],
        [32.25, 32., 223., 224.],
        [-1., 32., 224., 224.],
    ] {
        let mut value = replay(0.);
        value.lens_bounds = bounds;
        assert!(value.validate().is_err());
    }
    let mut value = replay(0.);
    value.primitives[1].color[3] = 0.5;
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.primitives[1].color[0] = f32::INFINITY;
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.primitives[0].size = [1., 1.];
    assert!(value.validate().is_err());
    let mut value = replay(0.);
    value.primitives.resize(4097, value.primitives[0].clone());
    assert!(value.validate().is_err());
    assert!(replay(0.).tile([1, 0], 0).is_err());
    assert!(replay(0.).tile([0, 0], 4).is_err());
}

#[test]
fn only_tiles_intersecting_the_lens_are_requested() {
    let input = replay(5704.);
    let tiles = input.tiles(Rect::new(-1000, -1000, 2400, 2400));
    assert_eq!(tiles.len(), 1);
    assert_eq!(tiles[0], ([0, 0], input.lens_rect));
    assert!(input.tiles(Rect::new(0, 0, 16, 16)).is_empty());
}

#[test]
fn capture_bounds_preserve_fractional_lens_geometry_without_camera_jitter() {
    let mut input = replay(5704.);
    input.lens_bounds = [32.125, 32.375, 223.875, 223.625];
    input.validate().unwrap();
    let expected = input.tile([0, 0], 0).unwrap().bounds;
    assert_ne!(expected, replay(5704.).tile([0, 0], 0).unwrap().bounds);
    for sample in 1..4 {
        assert_eq!(input.tile([0, 0], sample).unwrap().bounds, expected);
    }
    // Enlarging the parent leaves this interior lens's nominal q unchanged.
    input.parent_size = [256., 128.];
    input.primitives[0].size = input.parent_size;
    assert_eq!(input.tile([0, 0], 0).unwrap().bounds, expected);
}

#[test]
fn finite_filter_plan_matches_independent_binary32_vectors() {
    use futureox_design_kernel::glass_capture::TilePlan;
    // Independently evaluated scalar plan vectors: two calibrated target sizes
    // and asymmetric, non-power-of-two numerical controls. Assert words,
    // not tolerances, so Q8 setup and the RN-area reciprocal remain observable.
    let cases = [
        (
            512,
            [1031620608, 1031620608, 1055086336, 1055086336],
            [144, 144, 98, 98],
            [143, 143, 100, 100],
            [1125111040, 1125111040],
            [998244352, 998244352],
        ),
        (
            1024,
            [1030199296, 1030199296, 1056607488, 1056607488],
            [285, 285, 222, 222],
            [284, 284, 224, 224],
            [1133410688, 1133410688],
            [989855743, 989855743],
        ),
        (
            31,
            [3185657774, 1035489772, 1062165545, 1065604874],
            [6, 9, 14, 15],
            [5, 8, 16, 17],
            [1086423040, 1091719168],
            [1032070713, 1032069198],
        ),
        (
            7,
            [1011129254, 1045958754, 1060538155, 1064229143],
            [2, 2, 2, 3],
            [1, 1, 4, 5],
            [1072005120, 1075789824],
            [1049775838, 1049773068],
        ),
        // Partial target clipping must retain the original quad origin and
        // gradient; deriving them from the clipped downRect moves the source.
        (
            31,
            [3208642560, 1041865114, 1064178811, 1070386381],
            [0, 10, 22, 21],
            [0, 9, 23, 22],
            [3229089792, 1092694016],
            [1032069697, 1032068783],
        ),
    ];
    for (side, bounds, down, blur, origin, gradient) in cases {
        let plan = TilePlan {
            side,
            origin: [0, 0],
            density: 1.,
            kernel_count: 1.5,
            bounds: bounds.map(f32::from_bits),
            primitives: vec![],
        };
        let filter = plan.filter_plan().unwrap();
        assert_eq!(
            filter.down_rect,
            Rect::new(down[0], down[1], down[2] as u32, down[3] as u32)
        );
        assert_eq!(
            filter.blur_rect,
            Rect::new(blur[0], blur[1], blur[2] as u32, blur[3] as u32)
        );
        assert_eq!(filter.origin.map(f32::to_bits), origin);
        assert_eq!(filter.gradient.map(f32::to_bits), gradient);
        assert_eq!(
            filter.source_origin.map(f32::to_bits),
            [bounds[0], bounds[1]]
        );
        let wire = serde_json::to_value(filter).unwrap();
        assert!(wire.get("downRect").is_some());
        assert!(wire.get("blurRect").is_some());
        assert!(wire.get("sourceOrigin").is_some());
    }
}

#[test]
fn empty_finite_quads_are_transparent_but_invalid_bounds_are_errors() {
    use futureox_design_kernel::{
        blend::Surface,
        glass_capture::{ProjectedPrimitive, TilePlan, render},
    };
    let template = Surface::new(Rect::new(0, 0, 1, 1)).unwrap();
    let mut plan = TilePlan {
        side: 1,
        origin: [0, 0],
        density: 1.,
        kernel_count: 1.,
        bounds: [0., 0., 0.001, 0.001],
        primitives: vec![ProjectedPrimitive {
            rect: Rect::new(0, 0, 1, 1),
            color: [1.; 4],
        }],
    };
    for bounds in [[0., 0., 0.001, 0.001], [0., 0., 0., 0.], [4., 4., 5., 5.]] {
        plan.bounds = bounds;
        let filter = plan.filter_plan().unwrap();
        assert!(filter.down_rect.empty() && filter.blur_rect.empty());
        assert!(filter.gradient.iter().all(|v| v.is_finite()));
        assert_eq!(render(&template, &plan).unwrap().pixels[0].0, [0.; 4]);
    }
    for bounds in [
        [f32::NAN, 0., 1., 1.],
        [0., 0., f32::INFINITY, 1.],
        [1., 0., 0., 1.],
        [0., 0., f32::MAX, 1.],
        // The projected upper edge is exactly 2^31, beyond signed pixels.
        [0., 0., 4_294_967_296., 1.],
    ] {
        plan.bounds = bounds;
        assert!(plan.filter_plan().is_err());
        assert!(render(&template, &plan).is_err());
    }
}

// Keep a general four-texel implementation independent of the byte-axis path.
// It recomputes paired coordinates for every pixel, stores float surfaces,
// and uses the full bilinear sampler even when one axis is at a texel centre.
fn generic_capture(
    plan: &futureox_design_kernel::glass_capture::TilePlan,
    software: bool,
) -> futureox_design_kernel::blend::Surface {
    use futureox_design_kernel::{
        blend::{Pixel, Surface},
        figma_sampling::encode_unorm8,
        glass_capture::sample_with_raster,
        software_raster,
    };
    let rect = Rect::new(0, 0, plan.side, plan.side);
    let encoded = |v: [f32; 4]| {
        Pixel(v.map(|c| {
            if software {
                software_raster::normalize_byte(software_raster::encode_unorm8(c.clamp(0., 1.)))
            } else {
                f32::from(encode_unorm8(c.clamp(0., 1.))) / 255.
            }
        }))
    };
    let sample = |surface: &Surface, point| sample_with_raster(surface, point, software);
    let mut source = Surface::new(rect).unwrap();
    for primitive in &plan.primitives {
        for y in primitive.rect.y..primitive.rect.bottom() {
            for x in primitive.rect.x..primitive.rect.right() {
                source.pixels[rect.index(x, y).unwrap()] = encoded(primitive.color);
            }
        }
    }
    let mut down = Surface::new(rect).unwrap();
    let filter = plan.filter_plan().unwrap();
    for y in filter.down_rect.y..filter.down_rect.bottom() {
        for x in filter.down_rect.x..filter.down_rect.right() {
            down.pixels[rect.index(x, y).unwrap()] = encoded(
                sample(
                    &source,
                    [
                        ((x as f32 + 0.5) - filter.origin[0])
                            .mul_add(filter.gradient[0], filter.source_origin[0])
                            * plan.side as f32,
                        ((y as f32 + 0.5) - filter.origin[1])
                            .mul_add(filter.gradient[1], filter.source_origin[1])
                            * plan.side as f32,
                    ],
                )
                .0,
            );
        }
    }
    for axis in 0..2 {
        let mut output = Surface::new(rect).unwrap();
        for y in filter.blur_rect.y..filter.blur_rect.bottom() {
            for x in filter.blur_rect.x..filter.blur_rect.right() {
                let p = [x as f32 + 0.5, y as f32 + 0.5];
                let count = plan.kernel_count;
                let mut sum = sample(&down, p).0.map(|v| v * count);
                let mut weight = count;
                for k in (1..64).step_by(2) {
                    if k as f32 > count {
                        break;
                    }
                    let a = k as f32;
                    let b = ((k + 1) as f32).min(count);
                    let wa = count - a;
                    let wb = count - b;
                    let pair = wa + wb;
                    if pair == 0. {
                        continue;
                    }
                    let mut left = p;
                    let mut right = p;
                    let uv = p[axis] / plan.side as f32;
                    let delta = 1. / plan.side as f32;
                    left[axis] =
                        (((uv - delta * a) * wa + (uv - delta * b) * wb) / pair) * plan.side as f32;
                    right[axis] =
                        (((uv + delta * a) * wa + (uv + delta * b) * wb) / pair) * plan.side as f32;
                    let l = sample(&down, left);
                    let r = sample(&down, right);
                    for (c, value) in sum.iter_mut().enumerate() {
                        *value = pair.mul_add(l.0[c] + r.0[c], *value);
                    }
                    weight += 2. * pair;
                }
                let reciprocal = 1. / weight;
                output.pixels[rect.index(x, y).unwrap()] = encoded(sum.map(|v| v * reciprocal));
            }
        }
        down = output;
    }
    down
}

#[test]
fn byte_capture_matches_general_sampling_for_random_transparency_and_fractional_filters() {
    check_byte_capture(false);
}

#[test]
fn software_byte_capture_matches_general_sampling_for_random_transparency_and_fractional_filters() {
    check_byte_capture(true);
}

fn check_byte_capture(software: bool) {
    use futureox_design_kernel::{
        blend::Surface,
        glass_capture::{ProjectedPrimitive, TilePlan, render_with_raster},
    };
    let mut seed = 0x4293_781bu32;
    let mut byte = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed >> 24) as u8
    };
    for side in [1, 2, 3, 7, 16, 31] {
        let mut primitives = Vec::new();
        for y in 0..side {
            for x in 0..side {
                // Include untouched transparent pixels, unassociated byte colours,
                // premultiplied colours, and explicit zero/one alpha endpoints.
                if (x + y) % 5 == 0 {
                    continue;
                }
                let mut rgba = [byte(), byte(), byte(), byte()];
                if (x + y) % 3 == 0 {
                    for c in 0..3 {
                        rgba[c] = rgba[c].min(rgba[3]);
                    }
                }
                if (x + y) % 7 == 0 {
                    rgba[3] = 0;
                }
                if (x + y) % 11 == 0 {
                    rgba[3] = 255;
                }
                primitives.push(ProjectedPrimitive {
                    rect: Rect::new(x as i32, y as i32, 1, 1),
                    color: rgba.map(|v| f32::from(v) / 255.),
                });
            }
        }
        for count in [
            0.03125, 0.5, 1., 1.4826255, 1.5, 3.99, 7.125, 15.75, 31.999, 32.,
        ] {
            for bounds in [
                [0., 0., 1., 1.],
                [-0.11, 0.09, 0.81, 1.03],
                [-0.75, 0.15, 0.93, 1.6],
            ] {
                let plan = TilePlan {
                    side,
                    origin: [0, 0],
                    density: 1.,
                    kernel_count: count,
                    bounds,
                    primitives: primitives.clone(),
                };
                let expected = generic_capture(&plan, software);
                let actual = render_with_raster(
                    &Surface::new(Rect::new(0, 0, 1, 1)).unwrap(),
                    &plan,
                    software,
                )
                .unwrap();
                assert_eq!(actual.pixels.len(), expected.pixels.len());
                for (i, (a, b)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
                    assert_eq!(
                        a.0.map(f32::to_bits),
                        b.0.map(f32::to_bits),
                        "software={software},side={side},count={count},bounds={bounds:?},pixel={i}"
                    );
                }
            }
        }
    }
}

#[test]
fn capture_raster_choice_changes_pattern_bytes_but_retains_the_legacy_wrapper() {
    use futureox_design_kernel::{
        blend::Surface,
        glass_capture::{ProjectedPrimitive, TilePlan, render, render_with_raster},
    };
    let template = Surface::new(Rect::new(0, 0, 1, 1)).unwrap();
    let plan = TilePlan {
        side: 31,
        origin: [0, 0],
        density: 1.,
        kernel_count: 7.125,
        bounds: [-0.11, 0.09, 0.81, 1.03],
        primitives: (0..31)
            .flat_map(|y| {
                (0..31).map(move |x| ProjectedPrimitive {
                    rect: Rect::new(x, y, 1, 1),
                    color: [
                        ((x * 79 + y * 13) % 256) as f32 / 255.,
                        ((x * 17 + y * 53) % 256) as f32 / 255.,
                        ((x * 3 + y * 97) % 256) as f32 / 255.,
                        1.,
                    ],
                })
            })
            .collect(),
    };
    let legacy = render(&template, &plan).unwrap();
    let explicit_legacy = render_with_raster(&template, &plan, false).unwrap();
    let software = render_with_raster(&template, &plan, true).unwrap();
    for (a, b) in legacy.pixels.iter().zip(&explicit_legacy.pixels) {
        assert_eq!(a.0.map(f32::to_bits), b.0.map(f32::to_bits));
    }
    assert!(legacy.pixels.iter().zip(&software.pixels).any(|(a, b)| {
        a.0.map(|v| (v * 255.).round_ties_even() as u8)
            != b.0.map(|v| (v * 255.).round_ties_even() as u8)
    }));
    for bounds in [[0., 0., 0., 0.], [4., 4., 5., 5.]] {
        let empty = TilePlan {
            bounds,
            primitives: vec![],
            ..plan
        };
        assert!(
            render_with_raster(&template, &empty, true)
                .unwrap()
                .pixels
                .iter()
                .all(|pixel| pixel.0 == [0.; 4])
        );
    }
}

#[test]
fn malformed_public_tile_plans_are_errors_before_allocation_and_sampling() {
    use futureox_design_kernel::{
        blend::Surface,
        glass_capture::{ProjectedPrimitive, TilePlan, render},
    };
    let template = Surface::new(Rect::new(0, 0, 1, 1)).unwrap();
    let valid = || TilePlan {
        side: 16,
        origin: [0, 0],
        density: 1.,
        kernel_count: 1.5,
        bounds: [0., 0., 1., 1.],
        primitives: vec![ProjectedPrimitive {
            rect: Rect::new(0, 0, 16, 16),
            color: [1.; 4],
        }],
    };
    for side in [0, 1025, u32::MAX] {
        let mut plan = valid();
        plan.side = side;
        assert!(render(&template, &plan).is_err());
    }
    for count in [0., -1., 33., f32::NAN, f32::INFINITY, f32::from_bits(1)] {
        let mut plan = valid();
        plan.kernel_count = count;
        assert!(render(&template, &plan).is_err());
    }
    for color in [-0.01, 1.01, f32::NAN, f32::INFINITY] {
        let mut plan = valid();
        plan.primitives[0].color[0] = color;
        assert!(render(&template, &plan).is_err());
    }
    for rect in [
        Rect::new(-1, 0, 1, 1),
        Rect::new(0, -1, 1, 1),
        Rect::new(15, 0, 2, 1),
        Rect::new(0, 15, 1, 2),
        Rect::new(i32::MAX, 0, u32::MAX, 1),
    ] {
        let mut plan = valid();
        plan.primitives[0].rect = rect;
        assert!(render(&template, &plan).is_err());
    }
    let mut plan = valid();
    plan.primitives.resize(4097, plan.primitives[0].clone());
    assert!(render(&template, &plan).is_err());
}
