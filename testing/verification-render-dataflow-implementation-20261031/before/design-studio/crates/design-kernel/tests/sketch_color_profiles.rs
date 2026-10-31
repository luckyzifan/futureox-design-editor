//! Color exchange only: real Sketch archives, no GPU or physical display claims.
use futureox_design_kernel::{
    color::{ColorSettings, ColorSpace},
    interop::{export_sketch, import_sketch, read_zip_public},
    scene::Document,
};
use serde_json::{Value, json};

fn document(color: &str, space: Option<&str>) -> Document {
    let mut v = json!({"schemaVersion":13,"id":"d","name":"profile test",
        "pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":8,"height":8,
            "fills":[{"kind":"solid","color":color}]}}});
    if let Some(space) = space {
        v["colorManagement"] = json!({"documentSpace":space,"referenceWhiteNits":203,"peakLuminanceNits":1000});
    }
    serde_json::from_value(v).unwrap()
}
fn parts(bytes: &[u8]) -> (Value, Value) {
    let files = read_zip_public(bytes).unwrap();
    let page = files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap().1;
    (serde_json::from_slice(&files["document.json"]).unwrap(), serde_json::from_slice(page).unwrap())
}
fn channels(color: &Value) -> [f64; 4] {
    ["red", "green", "blue", "alpha"].map(|key| color[key].as_f64().unwrap())
}
fn close(a: [f64; 4], b: [f64; 4], tolerance: f64) {
    for i in 0..4 { assert!((a[i]-b[i]).abs() <= tolerance, "{a:?} != {b:?}"); }
}
#[test]
fn explicit_p3_solid_exports_red_and_roundtrips_profile_and_alpha() {
    let mut doc = document("color(display-p3 1 0 0 / 0.25)", Some("display-p3"));
    doc.nodes.get_mut("n").unwrap().fills[0].opacity = 0.5;
    let bytes = export_sketch(&doc).unwrap();
    let (archive, page) = parts(&bytes);
    assert_eq!(archive["colorSpace"], 2);
    close(channels(&page["layers"][0]["style"]["fills"][0]["color"]), [1.,0.,0.,0.25], 0.);
    let back = import_sketch(&bytes).unwrap();
    assert_eq!(back.color_management.unwrap().document_space, ColorSpace::DisplayP3);
    let paint = &back.nodes["n"].fills[0];
    assert_eq!(paint.color, "color(display-p3 1 0 0 / 0.25)");
    assert_eq!(paint.opacity, 0.5);
    close(channels(&parts(&export_sketch(&back).unwrap()).1["layers"][0]["style"]["fills"][0]["color"]), [1.,0.,0.,0.25], 0.);
}
#[test]
fn explicit_srgb_to_p3_uses_f64_coordinates_without_premultiplying() {
    let doc = document("color(srgb 1 0 0 / 0.3)", Some("display-p3"));
    let (_, page) = parts(&export_sketch(&doc).unwrap());
    // Independent W3C CSS Color 4 matrix/transfer reference, not the helper.
    close(channels(&page["layers"][0]["style"]["fills"][0]["color"]),
        [0.9174875573251657,0.200286807740847,0.138560591211114,0.3], 1e-12);
}
#[test]
fn hex_and_same_profile_srgb_archive_coordinates_stay_exact() {
    for profile in [None, Some("srgb"), Some("display-p3")] {
        let (_, page) = parts(&export_sketch(&document("#123456",profile)).unwrap());
        assert_eq!(channels(&page["layers"][0]["style"]["fills"][0]["color"]), [18./255.,52./255.,86./255.,1.]);
    }
    let (_, page) = parts(&export_sketch(&document("color(srgb 0.1 0.2 0.3 / 0.4)",None)).unwrap());
    assert_eq!(channels(&page["layers"][0]["style"]["fills"][0]["color"]),[0.1,0.2,0.3,0.4]);
}
#[test]
fn p3_transparent_gradient_has_one_source_profile_after_import_and_reexport() {
    let mut doc = document("#ff0000",Some("display-p3"));
    let p=&mut doc.nodes.get_mut("n").unwrap().fills[0];
    p.kind="linear".into();
    p.stops=serde_json::from_value(json!([
        {"offset":0,"color":"#ff0000"},
        {"offset":0.5,"color":"color(display-p3 1 0 0 / 0.5)"},
        {"offset":1,"color":"color(display-p3 1 0 0 / 0)"}])).unwrap();
    let bytes=export_sketch(&doc).unwrap();
    let back=import_sketch(&bytes).unwrap();
    let p=&back.nodes["n"].fills[0];
    assert_eq!(p.stops[0].color,"#ff0000");
    assert_eq!(p.stops[1].color,"color(display-p3 1 0 0 / 0.5)");
    assert_eq!(p.stops[2].color,"color(display-p3 1 0 0 / 0)");
    let settings=back.color_management.unwrap();
    let straight=settings.parse_straight(&p.stops[0].color).unwrap();
    for stop in &p.stops { let got=settings.parse_straight(&stop.color).unwrap();assert_eq!(&got[..3],&straight[..3]); }
    let (_, again)=parts(&export_sketch(&back).unwrap());
    let stops=again["layers"][0]["style"]["fills"][0]["gradient"]["stops"].as_array().unwrap();
    for (stop,alpha) in stops.iter().zip([1.,0.5,0.]) {assert_eq!(channels(&stop["color"]),[1.,0.,0.,alpha]);}
}
#[test]
fn unsupported_profiles_hdr_and_real_gamut_loss_fail_before_archive_creation() {
    for profile in ["srgb-linear","display-p3-linear","rec2020","rec2100-linear","rec2100-pq","rec2100-hlg","a98-rgb","prophoto-rgb","xyz-d50","xyz-d65"] {
        let error=export_sketch(&document("#ff0000",Some(profile))).unwrap_err().to_string();
        assert!(error.contains("only supports sRGB or Display P3"),"{error}");
    }
    for color in ["color(display-p3 1 0 0)","color(srgb-linear 4 0 0)","color(srgb 1.00000001 0 0)","color(srgb -0.00000001 0 0)","color(rec2100-pq 0.5 0.5 0.5)","color(rec2100-hlg 0.5 0.5 0.5)"] {
        assert!(export_sketch(&document(color,Some("srgb"))).is_err(),"must reject {color}");
    }
    // Only documented floating-point boundary roundoff may snap.
    let (_, page)=parts(&export_sketch(&document("color(srgb 1.00000000001 -0.00000000001 0)",Some("srgb"))).unwrap());
    assert_eq!(channels(&page["layers"][0]["style"]["fills"][0]["color"]),[1.,0.,0.,1.]);
}
#[test]
fn border_shadow_and_text_colors_receive_profile_conversion_and_alpha_once() {
    let mut doc=document("#ffffff",Some("display-p3"));
    let n=doc.nodes.get_mut("n").unwrap();
    n.kind="text".into();n.text="A".into();
    n.text_runs=serde_json::from_value(json!([{"start":0,"end":1,"color":"color(srgb 1 0 0 / 0.5)"}])).unwrap();
    n.strokes=serde_json::from_value(json!([{"width":1,"paint":{"kind":"solid","color":"color(srgb 1 0 0 / 0.5)","opacity":0.5}}])).unwrap();
    n.effects=serde_json::from_value(json!([{"kind":"shadow","color":"color(srgb 1 0 0 / 0.5)","opacity":0.5}])).unwrap();
    let (_, page)=parts(&export_sketch(&doc).unwrap());let node=&page["layers"][0];
    let target=ColorSettings::default().from_working([1.,0.,0.],ColorSpace::DisplayP3);
    close(channels(&node["style"]["borders"][0]["color"]),[target[0],target[1],target[2],0.5],1e-12);
    assert_eq!(node["style"]["borders"][0]["contextSettings"]["opacity"],0.5);
    close(channels(&node["style"]["shadows"][0]["color"]),[target[0],target[1],target[2],0.25],1e-12);
    close(channels(&node["attributedString"]["attributes"][0]["attributes"]["MSAttributedStringColorAttribute"]),[target[0],target[1],target[2],0.5],1e-12);
}
#[test]
fn shared_paint_style_colors_cannot_silently_turn_black() {
    let mut doc=document("#ffffff",Some("display-p3"));
    doc.design_system=Some(serde_json::from_value(json!({"styles":{"s":{"name":"P3","kind":"paint","value":[{"kind":"solid","color":"color(display-p3 1 0 0 / 0.25)"}]}}})).unwrap());
    let (archive,_)=parts(&export_sketch(&doc).unwrap());
    assert_eq!(channels(&archive["layerStyles"]["objects"][0]["value"]["fills"][0]["color"]),[1.,0.,0.,0.25]);
    doc.design_system.as_mut().unwrap().styles.get_mut("s").unwrap().value[0]["color"]=json!("color(srgb-linear 8 0 0)");
    assert!(export_sketch(&doc).unwrap_err().to_string().contains("outside the target"));
}

#[test]
fn unsupported_node_and_shared_strokes_reject_instead_of_flattening() {
    for kind in ["diamond", "image"] {
        for shared in [false, true] {
            for visible in [false, true] {
                for color in ["#123456", "color(rec2100-pq 0.5 0.5 0.5)"] {
                    let mut doc = document("#ffffff", Some("srgb"));
                    let mut paint = json!({"kind":kind,"color":"#000000","visible":visible});
                    if kind == "image" {
                        paint["image"] = json!("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGIAAQAAAAUAAQ0KLbQAAAAASUVORK5CYII=");
                    } else {
                        paint["stops"] = json!([
                            {"offset":0,"color":color}, {"offset":1,"color":color}
                        ]);
                    }
                    let strokes = json!([{"width":1,"paint":paint}]);
                    if shared {
                        doc.design_system = Some(serde_json::from_value(json!({
                            "styles":{"s":{"name":"s","kind":"paint","value":[],"strokes":strokes}}
                        })).unwrap());
                    } else {
                        doc.nodes.get_mut("n").unwrap().strokes = serde_json::from_value(strokes).unwrap();
                    }
                    doc.validate().unwrap();
                    let error = export_sketch(&doc).unwrap_err().to_string();
                    assert!(error.contains(&format!("cannot preserve {kind} stroke paints")), "{error}");
                }
            }
        }
    }
}

#[test]
fn solid_node_and_shared_strokes_preserve_exact_legacy_fields() {
    for profile in [None, Some("srgb"), Some("display-p3")] {
        for shared in [false, true] {
            for visible in [false, true] {
                let mut doc = document("#ffffff", profile);
                let strokes = json!([{"width":2.5,"align":"inside","cap":"square",
                    "join":"bevel","dash":"4,2","paint":{"kind":"solid",
                    "color":"#123456","opacity":0.25,"visible":visible}}]);
                if shared {
                    doc.design_system = Some(serde_json::from_value(json!({
                        "styles":{"s":{"name":"s","kind":"paint","value":[],"strokes":strokes}}
                    })).unwrap());
                } else {
                    doc.nodes.get_mut("n").unwrap().strokes = serde_json::from_value(strokes).unwrap();
                }
                doc.validate().unwrap();
                let (archive, page) = parts(&export_sketch(&doc).unwrap());
                let style = if shared { &archive["layerStyles"]["objects"][0]["value"] }
                    else { &page["layers"][0]["style"] };
                let border = &style["borders"][0];
                assert_eq!(channels(&border["color"]), [18./255.,52./255.,86./255.,1.]);
                assert_eq!(border["fillType"], 0);
                assert_eq!(border["isEnabled"], visible);
                assert_eq!(border["thickness"], 2.5);
                assert_eq!(border["position"], 1);
                assert_eq!(border["contextSettings"]["opacity"], 0.25);
                assert_eq!(style["borderOptions"]["dashPattern"], json!([4.,2.]));
                assert_eq!(style["borderOptions"]["lineCapStyle"], 2);
                assert_eq!(style["borderOptions"]["lineJoinStyle"], 2);
            }
        }
    }
}
