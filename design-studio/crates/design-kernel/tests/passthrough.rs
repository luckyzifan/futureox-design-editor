use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

#[test]
fn half_opacity_rgba8_composite_matches_an_integer_rational_oracle() {
    use futureox_design_kernel::blend::Pixel;
    for d in 0..=255_u32 {
        for alpha in 0..=255_u32 {
            let s = alpha / 2;
            // Independent wide-integer oracle for the UNORM16 half-opacity
            // code point (32768). The implementation uses bounded u32 math.
            let denominator = 255_u64 * 65535;
            let numerator = u64::from(d) * (denominator - u64::from(alpha) * 32768)
                + u64::from(s) * 255 * 32768;
            let expected = (numerator + denominator / 2) / denominator;
            let dst = Pixel([d as f32 / 255., 0., 0., 1.]);
            let src = Pixel([s as f32 / 255., 0., 0., alpha as f32 / 255.]);
            assert_eq!(dst.over_rgba8(src, 0.5).0[0], expected as f32 / 255.);
        }
    }
}

fn fixture(blend: &str, opacity: f64) -> Value {
    json!({"schemaVersion":1,"id":"d","name":"pass through","pages":[{"id":"p","name":"p","children":["bg","g"],"background":"#ffffff"}],"nodes":{
        "bg":{"id":"bg","kind":"rectangle","width":128,"height":128,"fills":[{"kind":"solid","color":"#80a0c0"}]},
        "g":{"id":"g","kind":"group","width":128,"height":128,"blend":blend,"opacity":opacity,"children":["a","b"]},
        "a":{"id":"a","kind":"rectangle","width":64,"height":64,"transform":[1,0,0,1,16,16],"blend":"multiply","fills":[{"kind":"solid","color":"#cc8040"}]},
        "b":{"id":"b","kind":"rectangle","width":64,"height":64,"transform":[1,0,0,1,48,48],"blend":"screen","fills":[{"kind":"solid","color":"#4080cc"}]}
    }})
}
fn render(doc: &Value, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":128,"height":128,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":profile})).unwrap();
    engine.render(&options).unwrap()
}
fn pixel(image: &[u8], x: usize, y: usize) -> &[u8] {
    &image[(y * 128 + x) * 4..(y * 128 + x) * 4 + 4]
}

#[test]
fn pass_through_preserves_ungrouped_blending() {
    let grouped = fixture("pass-through", 1.);
    let mut flat = grouped.clone();
    flat["nodes"].as_object_mut().unwrap().remove("g");
    flat["pages"][0]["children"] = json!(["bg", "a", "b"]);
    for profile in ["analytic", "figma"] {
        assert_eq!(render(&grouped, profile), render(&flat, profile));
    }
}
#[test]
fn pass_through_opacity_interpolates_the_whole_group_against_its_backdrop() {
    let result = render(&fixture("pass-through", 0.5), "figma");
    // Independently exported from the real Figma test frame, at interior pixels.
    assert_eq!(pixel(&result, 24, 24), &[115, 120, 120, 255]);
    assert_eq!(pixel(&result, 60, 60), &[134, 164, 203, 255]);
    assert_eq!(pixel(&result, 96, 96), &[144, 184, 217, 255]);
    assert_ne!(result, render(&fixture("normal", 0.5), "figma"));
}
#[test]
fn foreground_filter_establishes_isolation_even_in_pass_through_mode() {
    let mut pass = fixture("pass-through", 0.5);
    pass["nodes"]["g"]["effects"] = json!([{"kind":"blur","radius":4,"color":"#000000"}]);
    let mut normal = pass.clone();
    normal["nodes"]["g"]["blend"] = json!("normal");
    for profile in ["analytic", "figma"] {
        assert_eq!(render(&pass, profile), render(&normal, profile));
    }
}
#[test]
fn layer_paints_can_blend_with_the_external_backdrop() {
    let mut layer = fixture("pass-through", 1.);
    layer["nodes"]["a"]["blend"] = json!("pass-through");
    layer["nodes"]["a"]["fills"][0]["blend"] = json!("multiply");
    assert_eq!(
        render(&layer, "figma"),
        render(&fixture("pass-through", 1.), "figma")
    );
}
#[test]
fn zero_opacity_pass_through_does_not_change_transparent_background() {
    let mut doc = fixture("pass-through", 0.);
    doc["nodes"]["bg"]["opacity"] = json!(0.5);
    let mut bg = doc.clone();
    bg["nodes"]
        .as_object_mut()
        .unwrap()
        .retain(|id, _| id == "bg");
    bg["pages"][0]["children"] = json!(["bg"]);
    assert_eq!(render(&doc, "figma"), render(&bg, "figma"));
}

#[test]
fn backdrop_is_visible_across_nested_pass_through_groups() {
    let mut grouped = fixture("pass-through", 1.);
    grouped["nodes"]["b"]["effects"] =
        json!([{"kind":"background-blur","radius":4,"color":"#000000"}]);
    grouped["nodes"]["b"]["fills"][0]["opacity"] = json!(0.1);
    grouped["nodes"]["b"]["blend"] = json!("normal");
    let mut flat = grouped.clone();
    flat["pages"][0]["children"] = json!(["bg", "a", "b"]);
    flat["nodes"].as_object_mut().unwrap().remove("g");
    for profile in ["analytic", "figma"] {
        assert_eq!(render(&grouped, profile), render(&flat, profile));
    }
}

#[test]
fn pass_through_mask_applies_once_and_preserves_backdrop_alpha() {
    let mut doc = fixture("pass-through", 0.5);
    doc["nodes"]["bg"]["opacity"] = json!(0.5);
    doc["nodes"]["m"] = json!({"id":"m","kind":"rectangle","width":128,"height":128,"opacity":0.5,"mask":true,"fills":[{"kind":"solid","color":"#000000"}]});
    doc["nodes"]["g"]["children"] = json!(["m", "a", "b"]);
    for profile in ["analytic", "figma"] {
        let output = render(&doc, profile);
        // Opaque child aggregate is masked to 1/2, then group opacity to 1/2:
        // alpha = 1/2 + (1 - 1/2) * 1/2 * 1/2 = 5/8.
        // Analytic retains 0.625 until export (159); RGBA8 intermediates
        // quantize the backdrop and mask to 128 first (160).
        assert_eq!(
            pixel(&output, 60, 60)[3],
            if profile == "analytic" { 159 } else { 160 }
        );
        assert_eq!(pixel(&output, 4, 4)[3], 128);
    }
}

#[test]
fn only_the_first_visible_backdrop_effect_runs() {
    let mut doc = fixture("normal", 1.);
    let blur = json!({"kind":"background-blur","radius":4,"color":"#000000"});
    let glass = json!({"kind":"glass","radius":4,"amount":2,"color":"#000000"});
    for profile in ["analytic", "figma"] {
        for (first, second) in [(&blur, &glass), (&glass, &blur)] {
            doc["nodes"]["b"]["effects"] = json!([first, second]);
            let multiple = render(&doc, profile);
            doc["nodes"]["b"]["effects"] = json!([first]);
            assert_eq!(multiple, render(&doc, profile));
        }
        doc["nodes"]["b"]["effects"] =
            json!([{"kind":"background-blur","radius":0,"color":"#000000"},glass]);
        let zero = render(&doc, profile);
        doc["nodes"]["b"]["effects"] = json!([]);
        assert_eq!(zero, render(&doc, profile));
    }
}

#[test]
fn pass_through_is_rejected_for_paints_and_unknown_modes_are_not_silent_normal() {
    for (field, value) in [("blend", "typo"), ("paint", "pass-through")] {
        let mut doc = fixture("pass-through", 1.);
        if field == "paint" {
            doc["nodes"]["a"]["fills"][0]["blend"] = json!(value);
        } else {
            doc["nodes"]["a"][field] = json!(value);
        }
        assert!(Engine::new().load_document(&doc.to_string()).is_err());
    }
}
