use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

fn document(id: &str, nodes: Value) -> Value {
    json!({"schemaVersion":4,"id":"d","name":"Composed inverse","pages":[{"id":"p","name":"p","background":"#ffffff","children":[id]}],"nodes":nodes})
}
fn pair(scale: f64, orientation: [f64; 4], kind: &str) -> (Value, Value) {
    let paint = json!({"kind":kind,"color":"#224466","angle":37,"stops":[{"offset":0,"color":"#ff0000"},{"offset":1,"color":"#0000ff"}]});
    let [a, b, c, d] = orientation;
    let nested = document(
        "g",
        json!({
            "g":{"id":"g","kind":"group","width":1,"height":1,"children":["n"],"transform":[scale,0,0,scale,0,0]},
            "n":{"id":"n","kind":"rectangle","width":10000000,"height":10000000,"transform":[a*scale,b*scale,c*scale,d*scale,0,0],"fills":[paint.clone()]}
        }),
    );
    // Algebraically absorb uniform scale into dimensions, without composing
    // parent inverses or asking the production layout for expected geometry.
    let side = 10000000. * scale * scale;
    let direct = document(
        "r",
        json!({"r":{"id":"r","kind":"rectangle","width":side,"height":side,"transform":[a,b,c,d,0,0],"fills":[paint]}}),
    );
    (nested, direct)
}
fn render(doc: &Value, zoom: f64, profile: &str) -> Result<Vec<u8>, String> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string())?;
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,"view":{"x":24.25,"y":20.5,"zoom":zoom},"transparent":true,"rasterProfile":profile})).unwrap();
    engine.render(&options)
}
#[test]
fn legal_nested_scales_match_independent_direct_dimension_cpu_reference() {
    for scale in [0.01, 0.001, 0.0005] {
        for orientation in [[1., 0., 0., 1.], [-1., 0., 0., 1.], [1.5, 0.25, 0.5, 1.1]] {
            for kind in ["solid", "linear"] {
                let (nested, direct) = pair(scale, orientation, kind);
                for zoom in [0.25, 1., 1.375, 4.] {
                    for profile in ["analytic", "figma"] {
                        let expected = render(&direct, zoom, profile).unwrap();
                        let actual = render(&nested, zoom, profile).unwrap_or_else(|e| {
                            panic!(
                                "scale={scale} {orientation:?} zoom={zoom} {kind} {profile}: {e}"
                            )
                        });
                        assert!(actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 1));
                    }
                }
            }
        }
    }
}

use futureox_design_kernel::math::{Point, Rect, Transform};
const DEVICE_ERROR: f64 = 1. / 8192.;
fn assert_roundtrip(m: Transform, bounds: Rect) {
    let inverse = m.inverse_composed(bounds).unwrap();
    assert!(inverse.0.iter().all(|v| v.is_finite()));
    for x in [f64::from(bounds.x) + 0.25, f64::from(bounds.right()) - 0.25] {
        for y in [
            f64::from(bounds.y) + 0.25,
            f64::from(bounds.bottom()) - 0.25,
        ] {
            let point = Point::new(x, y);
            let actual = m.point(inverse.point(point));
            assert!(
                (actual.x - x).abs() < DEVICE_ERROR && (actual.y - y).abs() < DEVICE_ERROR,
                "{m:?}: {point:?} -> {actual:?}"
            );
        }
    }
}
#[test]
fn legacy_successful_inverse_coefficients_remain_bit_identical() {
    for m in [
        Transform([1., 0., 0., 1., 0., 0.]),
        Transform([2., 0.25, 0.5, 3., 1e12, -1e12]),
        Transform([0.000001, 0., 0., 0.000001, 24.25, 20.5]),
        Transform([1e7, 0., 0., 1e-18, 24.25, 20.5]),
        Transform([1e7, 0., 1e7, 1e-6, 24.25, 20.5]),
        Transform([-1e7, 0., 0., 1e-18, 0., 0.]),
    ] {
        let expected = m.inverse().unwrap();
        let actual = m
            .inverse_composed(Rect::new(-2048, -2048, 20000, 20000))
            .unwrap();
        assert_eq!(actual.0.map(f64::to_bits), expected.0.map(f64::to_bits));
    }
}
#[test]
fn normalized_inverse_handles_uniform_scales_reflection_shear_and_rotated_anisotropy() {
    let samples = Rect::new(-2048, -2048, 10240, 10240);
    for scale in [1e-7, 1e-100, 1e-200, 1e200] {
        for sign in [-1., 1.] {
            let m = Transform([sign * scale, 0., 0., scale, 24.25, 20.5]);
            assert!(m.inverse().is_err());
            assert_roundtrip(m, samples);
        }
    }
    assert_roundtrip(
        Transform([1.5e-7, 0.25e-7, 0.5e-7, 1.1e-7, 24.25, 20.5]),
        samples,
    );
    let (sin, cos) = 0.3_f64.sin_cos();
    let rotated = Transform([cos * 1e5, sin * 1e5, -sin * 1e-19, cos * 1e-19, 24.25, 20.5]);
    assert!(rotated.inverse().is_err());
    assert_roundtrip(rotated, samples);
}
#[test]
fn sampling_rectangle_controls_conservative_near_parallel_precision_gate() {
    let m = Transform([2.5e-5, 0., 2.5e-5, 2.5e-13, 0., 0.]);
    assert!(m.inverse().is_err());
    assert_roundtrip(m, Rect::new(0, 0, 1, 1));
    assert!(
        m.inverse_composed(Rect::new(0, 0, 8192, 8192))
            .unwrap_err()
            .contains("precision budget")
    );
}
#[test]
fn cancellation_prone_translations_and_nonfinite_inverses_fail_explicitly() {
    let samples = Rect::new(0, 0, 8192, 8192);
    assert_roundtrip(
        Transform([1.5e-7, 0.25e-7, 0.5e-7, 1.1e-7, 1e8, -1e8]),
        samples,
    );
    for m in [
        Transform([1.5e-7, 0.25e-7, 0.5e-7, 1.1e-7, 1e12, -1e12]),
        Transform([1e-300, 0., 0., 1e-300, 1e12, -1e12]),
        Transform([f64::from_bits(1), 0., 0., f64::from_bits(1), 0., 0.]),
        Transform([
            1e-7,
            1e-7,
            1e-7,
            f64::from_bits(1e-7_f64.to_bits() + 1),
            0.,
            0.,
        ]),
    ] {
        assert!(
            m.inverse_composed(samples)
                .unwrap_err()
                .contains("precision budget"),
            "{m:?}"
        );
    }
    for m in [
        Transform([1e-7, 1e-7, 1e-7, 1e-7, 0., 0.]),
        Transform([1e-7, 0., 2e-7, 0., 0., 0.]),
        Transform([0., 0., 0., 0., 0., 0.]),
    ] {
        assert_eq!(
            m.inverse_composed(samples).unwrap_err(),
            "Singular transform"
        );
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(
            Transform([value, 0., 0., 1., 0., 0.])
                .inverse_composed(samples)
                .is_err()
        );
        assert!(
            Transform([1., 0., 0., 1., value, 0.])
                .inverse_composed(samples)
                .is_err()
        );
    }
}
#[test]
fn authored_transform_admission_and_composed_precision_limits_stay_unchanged() {
    let (mut nested, _) = pair(0.001, [1., 0., 0., 1.], "solid");
    for matrix in [
        [1e-7, 0., 0., 1e-7, 0., 0.],
        [1., 1., 1., 1., 0., 0.],
        [1e7 + 1., 0., 0., 1., 0., 0.],
    ] {
        nested["nodes"]["n"]["transform"] = json!(matrix);
        assert!(Engine::new().load_document(&nested.to_string()).is_err());
    }
    let (mut nested, _) = pair(0.001, [1., 0., 0., 1.], "solid");
    nested["nodes"]["n"]["fills"][0]["transform"] = json!([1e-7, 0., 0., 1e-7, 0., 0.]);
    assert!(
        Engine::new()
            .load_document(&nested.to_string())
            .unwrap_err()
            .contains("paint")
    );
    let (mut nested, _) = pair(0.001, [1., 0., 0., 1.], "solid");
    for id in ["g", "n"] {
        nested["nodes"][id]["transform"] = json!([1e7, 0., 0., 1e7, 0., 0.]);
    }
    assert_eq!(
        render(&nested, 1., "analytic").unwrap_err(),
        "Composed transform exceeds precision budget"
    );
}
#[test]
fn cpu_noise_and_texture_accept_small_composed_scales_in_scalar_and_managed_planes() {
    for effect in ["noise", "texture"] {
        for managed in [false, true] {
            let (mut nested, _) = pair(0.0005, [1., 0., 0., 1.], "solid");
            nested["nodes"]["n"]["effects"] =
                json!([{"kind":effect,"amount":0.25,"opacity":0.5,"color":"#000000"}]);
            if managed {
                nested["colorManagement"] = json!({"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000});
            }
            let actual = render(
                &nested,
                0.25,
                if managed { "figmaSubpixel" } else { "analytic" },
            )
            .unwrap();
            assert!(actual.chunks_exact(4).any(|p| p[3] > 0));
        }
    }
}

fn render_at(doc: &Value, zoom: f64, x: f64, y: f64, width: u32, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":width,"height":64,"view":{"x":x,"y":y,"zoom":zoom},"transparent":true,"rasterProfile":profile})).unwrap();
    engine.render(&options).unwrap()
}
#[test]
fn camera_cancellation_and_nonzero_tile_rectangles_match_direct_geometry() {
    for origin in [-1e7, 1e7] {
        let (mut nested, mut direct) = pair(0.001, [1.5, 0.25, 0.5, 1.1], "linear");
        nested["nodes"]["g"]["transform"][4] = json!(origin);
        nested["nodes"]["g"]["transform"][5] = json!(-origin);
        direct["nodes"]["r"]["transform"][4] = json!(origin);
        direct["nodes"]["r"]["transform"][5] = json!(-origin);
        for profile in ["analytic", "figma"] {
            for at in [24.25, 510.25] {
                let x = at - origin * 0.25;
                let y = 20.5 + origin * 0.25;
                let expected = render_at(&direct, 0.25, x, y, 600, profile);
                assert!(expected.chunks_exact(4).any(|p| p[3] > 0));
                let actual = render_at(&nested, 0.25, x, y, 600, profile);
                assert!(actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 1));
            }
        }
    }
}
