use futureox_design_kernel::{
    glass_capture::{Replay, ReplayPrimitive},
    math::{Rect, Transform},
};

#[test]
fn cropped_view_keeps_the_root_frames_capture_tiles_and_sampling_phase() {
    let full = Replay {
        parent_matrix: Transform([8., 0., 0., 8., 0., 0.]),
        parent_world_transform: Transform([1., 0., 0., 1., 5704., 96.]),
        camera_matrix: Transform([8., 0., 0., 8., -45632., -768.]),
        parent_size: [128., 128.],
        lens_bounds: [128.125, 128.375, 895.875, 895.625],
        lens_rect: Rect::new(128, 128, 768, 768),
        primitives: vec![
            ReplayPrimitive {
                transform: Transform::default(),
                size: [128., 128.],
                color: [1.; 4],
            },
            ReplayPrimitive {
                transform: Transform([1., 0., 0., 1., 16., 0.]),
                size: [8., 128.],
                color: [0., 0., 1., 1.],
            },
        ],
        effective_frost: 4.,
        support: 4.,
        side: 512,
    };
    let mut crop = full.clone();
    for axis in 0..2 {
        crop.parent_matrix.0[4 + axis] -= 480.;
        crop.camera_matrix.0[4 + axis] -= 480.;
    }
    crop.lens_rect.x -= 480;
    crop.lens_rect.y -= 480;
    crop.lens_bounds = crop.lens_bounds.map(|v| v - 480.);
    let a = full.tiles(Rect::new(480, 480, 128, 128));
    let b = crop.tiles(Rect::new(0, 0, 128, 128));
    assert_eq!(a.len(), 4);
    assert_eq!(b.len(), 4);
    assert_eq!(
        b.iter().map(|(origin, _)| *origin).collect::<Vec<_>>(),
        vec![[-480, -480], [32, -480], [-480, 32], [32, 32]]
    );
    for ((oa, ra), (ob, rb)) in a.iter().zip(&b) {
        assert_eq!(
            [ra.x - 480, ra.y - 480, ra.w as i32, ra.h as i32],
            [rb.x, rb.y, rb.w as i32, rb.h as i32]
        );
        for sample in 0..4 {
            let pa = full.tile(*oa, sample).unwrap();
            let pb = crop.tile(*ob, sample).unwrap();
            assert_eq!(pa.density.to_bits(), pb.density.to_bits());
            assert_eq!(pa.kernel_count.to_bits(), pb.kernel_count.to_bits());
            assert_eq!(pa.bounds, pb.bounds);
            assert_eq!(
                serde_json::to_value(pa.filter_plan().unwrap()).unwrap(),
                serde_json::to_value(pb.filter_plan().unwrap()).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&pa.primitives).unwrap(),
                serde_json::to_value(&pb.primitives).unwrap()
            );
            assert_eq!(pa.coordinate([480.5, 480.5]), pb.coordinate([0.5, 0.5]));
        }
    }
    assert!(crop.tile([0, 0], 0).is_err());
}
