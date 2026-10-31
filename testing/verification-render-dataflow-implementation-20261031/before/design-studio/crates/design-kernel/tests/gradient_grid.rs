use futureox_design_kernel::{
    math::{Rect, Transform},
    paint::gradient_sampling_grid,
    scene::Paint,
};
use serde_json::json;
#[test]
fn gradient_stop_boundaries_keep_binary64_distinctions_before_interpolation() {
    for exponent in [-30, -45, -53] {
        let delta = 2_f64.powi(exponent);
        assert_eq!((0.5 - delta) as f32, (0.5 + delta) as f32);
        let paint:Paint=serde_json::from_value(json!({"kind":"linear","color":"#000000","angle":0,
        "stops":[{"offset":1,"color":"#ffffff"},{"offset":0.5+delta,"color":"#ffffff"},{"offset":0,"color":"#000000"},{"offset":0.5-delta,"color":"#000000"}]})).unwrap();
        let values = gradient_sampling_grid(
            Rect::new(0, 0, 1, 1),
            Transform::default(),
            [1., 1.],
            &paint,
            None,
        )
        .unwrap();
        assert_eq!(values, [1., 2., 0.5, 0.]);
    }
}
#[test]
fn empty_palette_and_parameter_budget_are_explicit() {
    let paint: Paint =
        serde_json::from_value(json!({"kind":"radial","color":"#000000","stops":[]})).unwrap();
    let values = gradient_sampling_grid(
        Rect::new(0, 0, 1, 1),
        Transform::default(),
        [1., 1.],
        &paint,
        None,
    )
    .unwrap();
    assert_eq!(values, [-1., -1., 0., 0.]);
    assert!(
        gradient_sampling_grid(
            Rect::new(0, 0, 4097, 4097),
            Transform::default(),
            [1., 1.],
            &paint,
            None
        )
        .unwrap_err()
        .contains("64 MiB")
    );
    assert!(
        gradient_sampling_grid(
            Rect::new(0, 0, 1, 1),
            Transform::default(),
            [1., 1.],
            &paint,
            Some(4)
        )
        .is_err()
    );
}
