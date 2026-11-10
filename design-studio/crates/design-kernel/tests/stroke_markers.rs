use futureox_design_kernel::{
    Engine, RenderOptions, View,
    fidelity::RasterProfile,
    math::{Point, Transform},
    path::{Contour, winding},
    scene::{Document, Stroke},
    stroke::{self, Marker},
};
use serde_json::json;
fn line() -> Contour {
    Contour {
        points: vec![Point::new(10., 20.), Point::new(70., 20.)],
        closed: false,
    }
}
fn stroke() -> Stroke {
    serde_json::from_value(json!({"paint":{"kind":"solid","color":"#000000"},"width":4,"cap":"butt","join":"miter","endMarker":"triangle"})).unwrap()
}
#[test]
fn arrowhead_is_painted_picked_and_dash_independent() {
    let mut s = stroke();
    let contours = stroke::expand(&[line()], &s, 0.01, 0.).unwrap();
    assert_ne!(winding(Point::new(60., 24.), &contours), 0);
    assert_eq!(winding(Point::new(74., 20.), &contours), 0);
    s.dash = "4 8".into();
    let dashed = stroke::expand(&[line()], &s, 0.01, 0.).unwrap();
    assert_ne!(winding(Point::new(60., 24.), &dashed), 0);
    assert_eq!(
        contours.last().unwrap().points,
        dashed.last().unwrap().points
    );
}
#[test]
fn markers_ignore_closed_and_zero_length_paths_and_keep_width_zero_empty() {
    let mut s = stroke();
    let mut c = line();
    c.closed = true;
    let marked = stroke::expand(&[c.clone()], &s, 0.01, 0.).unwrap();
    s.end_marker = Marker::None;
    assert_eq!(
        serde_json::to_value(marked).unwrap(),
        serde_json::to_value(stroke::expand(&[c], &s, 0.01, 0.).unwrap()).unwrap()
    );
    s.end_marker = Marker::Circle;
    s.width = 0.;
    assert!(stroke::expand(&[line()], &s, 0.01, 0.).unwrap().is_empty());
    s.width = 4.;
    assert!(
        stroke::expand(
            &[Contour {
                points: vec![Point::new(0., 0.); 3],
                closed: false
            }],
            &s,
            0.01,
            0.
        )
        .unwrap()
        .is_empty()
    );
}
#[test]
fn all_marker_kinds_preserve_native_roundtrip_and_exact_cpu_render() {
    for marker in ["arrow", "triangle", "circle", "diamond", "square", "bar"] {
        let raw = json!({"schemaVersion":8,"id":"d","name":"markers","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"line","width":60,"height":20,"transform":[1,0.125,-0.25,1,15.125,15.375],"strokes":[{"paint":{"kind":"solid","color":"#426bdf"},"width":3.5,"startMarker":marker,"endMarker":marker}]}}});
        let d: Document = serde_json::from_value(raw).unwrap();
        d.validate().unwrap();
        let source = serde_json::to_string(&d).unwrap();
        let restored: Document = serde_json::from_str(&source).unwrap();
        assert_eq!(restored, d);
        let mut a = Engine::new();
        a.load_document(&source).unwrap();
        let o = RenderOptions {
            page_id: "p".into(),
            width: 128,
            height: 96,
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
        let expected = a.render(&o).unwrap();
        a.load_document(&serde_json::to_string(&restored).unwrap())
            .unwrap();
        assert_eq!(a.render(&o).unwrap(), expected);
        let mut old = d.clone();
        old.schema_version = 7;
        assert!(old.validate().is_err());
    }
}
#[test]
fn marker_tip_is_included_in_native_hit_testing_under_affine_transform() {
    let n=serde_json::from_value(json!({"id":"n","kind":"line","width":60,"height":0.01,"network":{"vertices":[{"id":"a","x":10,"y":20},{"id":"b","x":70,"y":20}],"edges":[{"id":"e","from":"a","to":"b"}]},"strokes":[{"paint":{"kind":"solid","color":"#000000"},"width":4,"endMarker":"triangle"}]})).unwrap();
    assert!(
        futureox_design_kernel::hit_test_device(&n, Point::new(60., 24.), Transform::default(), 0.)
            .unwrap()
    );
}

#[test]
fn native_export_presets_validate_roundtrip_and_cannot_be_dropped_by_old_schema() {
    let value = json!({"schemaVersion":8,"id":"d","name":"presets","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"rectangle","width":40,"height":30,"exportSettings":[{"id":"one","format":"png","scale":2.5,"suffix":"@detail"},{"id":"two","format":"svg","scale":1,"suffix":"-vector"}]}}});
    let mut d: Document = serde_json::from_value(value).unwrap();
    d.validate().unwrap();
    assert_eq!(
        serde_json::from_str::<Document>(&serde_json::to_string(&d).unwrap()).unwrap(),
        d
    );
    d.schema_version = 7;
    assert!(d.validate().is_err());
    d.schema_version = 8;
    // Positive multipliers below 0.001 are already part of the native model.
    d.nodes.get_mut("n").unwrap().export_settings[0].scale = 0.0001;
    d.validate().unwrap();
    d.nodes.get_mut("n").unwrap().export_settings[0].scale = 0.;
    assert!(d.validate().is_err());
}
