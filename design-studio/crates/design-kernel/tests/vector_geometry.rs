use futureox_design_kernel::{
    Engine, RenderOptions, View,
    fidelity::RasterProfile,
    math::{Point, Transform},
    scene::{Document, Network},
    vector_geometry::{Curve, MAX_COMMANDS, VectorGeometry},
};
use serde_json::json;
fn network(count: usize) -> Network {
    serde_json::from_value(json!({"fillRule":"nonzero","vertices":(0..count).map(|i|{let a=i as f64*std::f64::consts::TAU/count as f64;json!({"id":format!("v{i}"),"x":30.+a.cos()*20.,"y":30.+a.sin()*20.})}).collect::<Vec<_>>(),"edges":(0..count).map(|i|json!({"id":format!("e{i}"),"from":format!("v{i}"),"to":format!("v{}",(i+1)%count)})).collect::<Vec<_>>()})).unwrap()
}
fn document(network: &Network) -> Document {
    serde_json::from_value(json!({"schemaVersion":16,"id":"d","name":"Geometry","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"vector","width":60,"height":60,"network":network,"fills":[{"kind":"solid","color":"#427bdc"}],"strokes":[{"paint":{"kind":"solid","color":"#123456"},"width":1.5,"align":"center","cap":"round","join":"round","dash":""}]}}})).unwrap()
}
#[test]
fn large_render_contour_is_admitted_without_relaxing_edit_network_limits() {
    let network = network(27889);
    let mut doc = document(&network);
    assert!(
        doc.validate()
            .unwrap_err()
            .contains("Invalid vector network")
    );
    let geometry = VectorGeometry::ordered_network(&network, true).unwrap();
    assert!(geometry.network(10000).is_err());
    assert_eq!(geometry.paths().unwrap().0.commands.len(), 27891);
    doc.nodes.get_mut("n").unwrap().network = None;
    doc.nodes.get_mut("n").unwrap().vector_geometry = Some(geometry);
    doc.validate().unwrap();
    doc.schema_version = 15;
    assert!(doc.validate().is_err());
}
#[test]
fn source_f64_values_and_signed_zero_survive_json_without_f32_rounding() {
    let value = 0.12345678901234567;
    let geometry = VectorGeometry {
        fill_rule: "evenodd".into(),
        fill: vec![
            Curve::Move([-0.0, value]),
            Curve::Cubic([
                value,
                9_000_000.000000002,
                1.0000000000000002,
                value,
                -0.0,
                value,
            ]),
            Curve::Close,
        ],
        stroke: None,
    };
    let json = serde_json::to_string(&geometry).unwrap();
    let restored: VectorGeometry = serde_json::from_str(&json).unwrap();
    let Curve::Move(p) = restored.fill[0] else {
        panic!()
    };
    assert_eq!(p[0].to_bits(), (-0.0f64).to_bits());
    assert_eq!(p[1].to_bits(), value.to_bits());
    let Curve::Cubic(p) = restored.fill[1] else {
        panic!()
    };
    assert_eq!(p[1].to_bits(), 9_000_000.000000002f64.to_bits());
}
#[test]
fn render_geometry_preserves_cpu_pixels_hit_and_native_format_export() {
    let mut net = network(4);
    net.edges[0].c1 = Some(Point::new(49.1234567890123, 45.));
    net.edges[0].c2 = Some(Point::new(42., 51.9876543210987));
    let mut original = document(&net);
    original.color_management = Some(Default::default());
    original.raster_profile = Some(RasterProfile::FigmaSoftware);
    let mut compact = original.clone();
    let layer = compact.nodes.get_mut("n").unwrap();
    layer.network = None;
    layer.vector_geometry = Some(VectorGeometry::ordered_network(&net, true).unwrap());
    let mut a = Engine::new();
    let mut b = Engine::new();
    a.load_document(&serde_json::to_string(&original).unwrap())
        .unwrap();
    b.load_document(&serde_json::to_string(&compact).unwrap())
        .unwrap();
    let mut options = RenderOptions {
        page_id: "p".into(),
        width: 64,
        height: 64,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: RasterProfile::FigmaSoftware,
        interactive_effects: false,
        checkerboard: false,
    };
    for zoom in [1., 3., 32.] {
        options.view = View {
            x: 30. - 30. * zoom,
            y: 30. - 30. * zoom,
            zoom,
        };
        assert_eq!(
            a.render_linear(&options).unwrap(),
            b.render_linear(&options).unwrap()
        );
    }
    for p in [
        Point::new(30., 30.),
        Point::new(0., 0.),
        Point::new(49., 31.),
    ] {
        assert_eq!(
            futureox_design_kernel::hit_test_fill_device(
                &original.nodes["n"],
                p,
                Transform::default()
            )
            .unwrap(),
            futureox_design_kernel::hit_test_fill_device(
                &compact.nodes["n"],
                p,
                Transform::default()
            )
            .unwrap()
        );
    }
    let restored: Document =
        serde_json::from_slice(&serde_json::to_vec(&compact).unwrap()).unwrap();
    assert_eq!(restored, compact);
    let exported = futureox_design_kernel::interop::export_sketch(&compact).unwrap();
    let report = futureox_design_kernel::interop::import_sketch_report(&exported).unwrap();
    let layer = report
        .document
        .nodes
        .values()
        .find(|n| n.kind == "vector")
        .unwrap();
    let back = layer.network.as_ref().unwrap();
    assert_eq!(back.edges[0].c1, net.edges[0].c1);
    assert_eq!(back.edges[0].c2, net.edges[0].c2);
}
#[test]
fn malformed_sequences_nonfinite_and_command_overflow_fail_before_render() {
    let mut geometry = VectorGeometry {
        fill_rule: "nonzero".into(),
        fill: vec![Curve::Line([0., 0.])],
        stroke: None,
    };
    assert!(geometry.validate().is_err());
    geometry.fill = vec![Curve::Move([0., f64::NAN]), Curve::Close];
    assert!(geometry.validate().is_err());
    geometry.fill = vec![Curve::Move([0., 0.])];
    assert!(geometry.validate().is_err());
    geometry.fill = vec![Curve::Move([0., 0.]); MAX_COMMANDS + 1];
    assert!(geometry.validate().is_err());
    let mut doc = document(&network(4));
    doc.nodes.get_mut("n").unwrap().vector_geometry =
        Some(VectorGeometry::ordered_network(&network(4), true).unwrap());
    assert!(doc.validate().is_err());
}
