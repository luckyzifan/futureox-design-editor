use futureox_design_kernel::{
    area_program::AreaProgram,
    math::{Point, Rect},
    path::Contour,
    raster::{RasterWorkspace, try_rasterize, try_rasterize_sample, try_rasterize_sample_linear},
    render_cancellation::with_probe,
};
fn polygon(points: &[(f64, f64)]) -> Contour {
    Contour {
        closed: true,
        points: points.iter().map(|&(x, y)| Point::new(x, y)).collect(),
    }
}
#[test]
fn invalid_points_limits_and_samples_fail_without_panics_or_partial_masks() {
    let valid = polygon(&[(0., 0.), (2., 0.), (1., 2.)]);
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for closed in [false, true] {
            let cs = [
                valid.clone(),
                Contour {
                    closed,
                    points: vec![Point::new(bad, 0.), Point::new(1., 1.), Point::new(2., 0.)],
                },
            ];
            assert!(try_rasterize(&cs, Rect::new(0, 0, 4, 4), false).is_err());
            assert!(try_rasterize_sample(&cs, Rect::new(0, 0, 4, 4), false, None).is_err());
            assert!(
                RasterWorkspace::default()
                    .samples(&cs, Rect::new(0, 0, 4, 4), false)
                    .is_err()
            );
        }
    }
    for limit in [
        Rect::new(i32::MAX, 0, 1, 1),
        Rect::new(0, i32::MAX, 1, 1),
        Rect::new(0, 0, u32::MAX, 1),
    ] {
        assert!(try_rasterize(std::slice::from_ref(&valid), limit, false).is_err());
        assert!(try_rasterize_sample(std::slice::from_ref(&valid), limit, false, None).is_err());
        assert!(
            RasterWorkspace::default()
                .samples(std::slice::from_ref(&valid), limit, false)
                .is_err()
        );
    }
    for x in [i32::MIN, i32::MAX - 1] {
        assert!(
            try_rasterize(std::slice::from_ref(&valid), Rect::new(x, 0, 1, 1), false)
                .unwrap()
                .rect
                .empty()
        );
    }
    assert!(try_rasterize_sample(&[valid], Rect::new(0, 0, 4, 4), false, Some(4)).is_err());
}
#[test]
fn finite_interpolation_overflow_is_explicitly_rejected_in_cpu_and_gpu() {
    for cs in [
        vec![polygon(&[(-1e308, 0.), (1e308, 1.), (0., 2.)])],
        vec![polygon(&[(0., -1e308), (1., 1e308), (2., 0.)])],
        vec![polygon(&[(0., -1e200), (1e200, 1e200), (0., 2.)])],
    ] {
        let r = Rect::new(0, 0, 16, 2);
        assert_eq!(
            try_rasterize(&cs, r, false).unwrap_err(),
            "Non-finite scanline interpolation"
        );
        assert_eq!(
            try_rasterize_sample_linear(&cs, r, false, None).unwrap_err(),
            "Non-finite scanline interpolation"
        );
        assert!(RasterWorkspace::default().samples(&cs, r, false).is_err());
        assert!(AreaProgram::compile(&cs, r, false).is_err());
        assert!(AreaProgram::compile_samples(&cs, r, false).is_err());
    }
    let cs = [polygon(&[
        (-1e308, -1e308),
        (1e308, -1e308),
        (1e308, 1e308),
        (-1e308, 1e308),
    ])];
    let r = Rect::new(0, 0, 2, 2);
    assert_eq!(try_rasterize(&cs, r, false).unwrap().data, vec![1.; 4]);
    let compact = RasterWorkspace::default().samples(&cs, r, false).unwrap();
    for s in 0..4 {
        assert_eq!(compact.at(s, 1, 1), 1.);
    }
}
#[test]
fn irrelevant_finite_open_contours_do_not_enlarge_fill_bounds() {
    let valid = polygon(&[(1., 1.), (3., 1.), (2., 3.)]);
    let open = Contour {
        closed: false,
        points: vec![Point::new(-1e100, -1e100), Point::new(1e100, 1e100)],
    };
    let r = Rect::new(-10, -10, 40, 40);
    let a = try_rasterize(std::slice::from_ref(&valid), r, false).unwrap();
    let b = try_rasterize(&[valid, open], r, false).unwrap();
    assert_eq!(a.rect, b.rect);
    assert_eq!(a.data, b.data);
}
#[test]
fn retraced_edges_cannot_hide_unbounded_work_behind_empty_output() {
    let cs = [Contour {
        closed: true,
        points: (0..512)
            .map(|i| Point::new(5., if i % 2 == 0 { 0. } else { 4096. }))
            .collect(),
    }];
    let r = Rect::new(0, 0, 16, 4096);
    assert_eq!(
        try_rasterize(&cs, r, false).unwrap_err(),
        "Scanline work budget exceeded"
    );
    assert!(RasterWorkspace::default().samples(&cs, r, false).is_err());
}
#[test]
fn cancellation_and_workspace_reuse_do_not_publish_partial_coverage() {
    use std::{cell::Cell, rc::Rc};
    // Short edge list, tall empty interior: cancellation must occur inside scanning.
    let cs = [polygon(&[
        (1., 0.),
        (3., 20000.),
        (2., 10.),
        (3., 20000.),
        (1., 0.),
    ])];
    let count = Rc::new(Cell::new(0));
    let probe = count.clone();
    let mut workspace = RasterWorkspace::default();
    let result = with_probe(
        move || {
            probe.set(probe.get() + 1);
            probe.get() > 100
        },
        || workspace.samples(&cs, Rect::new(0, 0, 4, 20000), false),
    );
    assert_eq!(result.unwrap_err(), "PREVIEW_CANCELLED");
    assert!(count.get() <= 102);
    for compile in [AreaProgram::compile, AreaProgram::compile_samples] {
        let count = Rc::new(Cell::new(0));
        let probe = count.clone();
        let result = with_probe(
            move || {
                probe.set(probe.get() + 1);
                probe.get() > 100
            },
            || compile(&cs, Rect::new(0, 0, 4, 20000), false),
        );
        assert_eq!(result.err().unwrap(), "PREVIEW_CANCELLED");
        assert!(count.get() <= 102);
    }
    let result = with_probe(|| true, || try_rasterize(&cs, Rect::new(0, 0, 4, 4), false));
    assert_eq!(result.unwrap_err(), "PREVIEW_CANCELLED");
    let triangle = [polygon(&[(0., 0.), (2., 0.), (0., 2.)])];
    let fresh = RasterWorkspace::default()
        .samples(&triangle, Rect::new(0, 0, 2, 2), false)
        .unwrap();
    let reused = workspace
        .samples(&triangle, Rect::new(0, 0, 2, 2), false)
        .unwrap();
    for s in 0..4 {
        for y in 0..2 {
            for x in 0..2 {
                assert_eq!(fresh.at(s, x, y), reused.at(s, x, y));
            }
        }
    }
}
#[test]
fn ordinary_polygon_area_has_independent_analytic_answers() {
    let triangle = [polygon(&[(0., 0.), (2., 0.), (0., 2.)])];
    assert_eq!(
        try_rasterize(&triangle, Rect::new(0, 0, 2, 2), false)
            .unwrap()
            .data,
        vec![1., 0.5, 0.5, 0.]
    );
    let diamond = [polygon(&[(0., 1.), (1., 0.), (2., 1.), (1., 2.)])];
    assert_eq!(
        try_rasterize(&diamond, Rect::new(0, 0, 2, 2), false)
            .unwrap()
            .data,
        vec![0.5; 4]
    );
}

#[test]
fn admitted_vertical_retraces_finish_without_walking_empty_rows() {
    use std::{cell::Cell, rc::Rc};
    let cs = [polygon(&[(1., 0.), (1., 20000.), (1., 0.)])];
    let rect = Rect::new(0, 0, 4, 20000);
    let count = Rc::new(Cell::new(0));
    let probe = count.clone();
    let result = with_probe(
        move || {
            probe.set(probe.get() + 1);
            probe.get() > 100
        },
        || RasterWorkspace::default().samples(&cs, rect, false),
    )
    .unwrap();
    assert_eq!(result.at(0, 1, 10000), 0.);
    assert!(count.get() < 100, "must not visit 80,000 empty sample rows");
    let count = Rc::new(Cell::new(0));
    let probe = count.clone();
    let result = with_probe(
        move || {
            probe.set(probe.get() + 1);
            probe.get() > 100
        },
        || try_rasterize(&cs, rect, false),
    )
    .unwrap();
    assert!(result.data.iter().all(|&v| v == 0.));
}
