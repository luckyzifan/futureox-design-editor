use futureox_design_kernel::{
    math::{Point, Transform},
    path::winding,
    scene::Node,
};

#[test]
fn separated_cubic_segments_with_coincident_endpoints_have_closed_offset_boundaries() {
    let mut n: Node = serde_json::from_str(include_str!("fixtures/offset-cut-curve.json")).unwrap();
    for offset in [0.01, 0.1, 0.34895833333337123, 0.5, 1., 2., 5., 10., 20.] {
        n.path_offset = offset;
        let (fill, _) = n.paths().unwrap_or_else(|e| panic!("offset={offset}: {e}"));
        let contours = fill.flatten(Transform::default(), 0.005).unwrap();
        assert!(contours.iter().all(|c| c.closed));
        assert_ne!(
            winding(Point::new(106.3333340183725, 66.66666666666663), &contours),
            0
        );
        assert_eq!(winding(Point::new(-30., -30.), &contours), 0);
    }
}
#[test]
fn dragging_a_cut_cubic_vertex_keeps_a_tiny_positive_offset_closed() {
    let mut n: Node = serde_json::from_str(include_str!("fixtures/offset-cut-curve.json")).unwrap();
    let p = &mut n.network.as_mut().unwrap().vertices[0];
    p.x -= 30.;
    p.y -= 0.1;
    n.path_offset = 0.001;
    let (fill, _) = n.paths().unwrap();
    assert!(!fill.commands.is_empty());
    assert!(
        fill.flatten(Transform::default(), 0.0001)
            .unwrap()
            .iter()
            .all(|c| c.closed)
    );
}
