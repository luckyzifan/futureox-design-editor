//! Exact output oracle for targeted native preparation-cache invalidation.
use futureox_design_kernel::{Engine, RenderOptions, math::{Rect, Transform}};
use serde_json::json;

#[test]
fn repeated_parent_and_child_translations_match_fresh_packets_and_pixels() {
    for managed in [false, true] {
        for profile in ["analytic", "figmaSubpixel"] {
            let mut document = json!({"schemaVersion":5,"id":"invalidation-oracle","name":"Oracle",
                "pages":[{"id":"p","name":"Page","children":["frame"],"background":"#d7d9de"}],
                "nodes":{
                    "frame":{"id":"frame","kind":"frame","width":80,"height":80,"clip":true,
                        "radii":[6,6,6,6],"transform":[1,0,0,1,2.25,1.5],"children":["moving","fixed"],
                        "fills":[{"kind":"solid","color":"#ffffff"}],
                        "effects":[{"kind":"shadow","radius":2,"x":1,"y":2,"color":"#000000","opacity":0.3}]},
                    "moving":{"id":"moving","kind":"rectangle","width":18,"height":16,
                        "radii":[3,3,3,3],"transform":[1,0,0,1,8.25,12.5],"opacity":0.75,
                        "fills":[{"kind":"solid","color":"#2468ce"}],
                        "strokes":[{"width":1.25,"paint":{"kind":"solid","color":"#142536"}}]},
                    "fixed":{"id":"fixed","kind":"ellipse","width":12,"height":12,
                        "transform":[1,0,0,1,40,24],"fills":[{"kind":"solid","color":"#d04a38"}]}
                }});
            if managed {
                document["colorManagement"] = json!(futureox_design_kernel::color::ColorSettings::default());
            }
            let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,
                "view":{"x":0.125,"y":0.375,"zoom":1.25},"rasterProfile":profile})).unwrap();
            let region = Rect::new(-1, -1, 66, 66);
            let guard = Rect::new(-1, -1, 128, 128);
            let mut engine = Engine::new();
            engine.load_document(&document.to_string()).unwrap();
            let initial_packet = engine.compile_gpu_region(&options, region, Some(guard)).unwrap().into_packet().unwrap();
            let initial_pixels = engine.render(&options).unwrap();
            for step in 1..=6 {
                let (id, transform) = if step % 2 == 0 {
                    ("frame", Transform([1., 0., 0., 1., 2.25 + step as f64*0.375, 1.5]))
                } else {
                    ("moving", Transform([1., 0., 0., 1., 8.25 + step as f64*0.375, 12.5 - step as f64*0.125]))
                };
                document["nodes"][id]["transform"] = json!(transform);
                assert!(engine.apply_interaction_transforms(&[(id.to_owned(), transform)].into_iter().collect()).unwrap());
                let actual_packet = engine.compile_gpu_region(&options, region, Some(guard)).unwrap().into_packet().unwrap();
                let actual_pixels = engine.render(&options).unwrap();
                let mut fresh = Engine::new();
                fresh.load_document(&document.to_string()).unwrap();
                assert_eq!(actual_packet, fresh.compile_gpu_region(&options, region, Some(guard)).unwrap().into_packet().unwrap(),
                    "complete packet: managed={managed}, profile={profile}, step={step}");
                assert_eq!(actual_pixels, fresh.render(&options).unwrap(),
                    "CPU RGBA bytes: managed={managed}, profile={profile}, step={step}");
                assert_ne!(actual_packet, initial_packet, "fixture must change geometry");
                assert_ne!(actual_pixels, initial_pixels, "fixture must change visible pixels");
            }
        }
    }
}

#[test]
fn rotated_and_scaled_interaction_poses_match_fresh_packets_and_pixels() {
    for managed in [false, true] {
        for profile in ["analytic", "figmaSubpixel"] {
            let mut document = json!({"schemaVersion":5,"id":"affine-oracle","name":"Oracle",
                "pages":[{"id":"p","name":"Page","children":["frame"],"background":"#d7d9de"}],
                "nodes":{
                    "frame":{"id":"frame","kind":"frame","width":80,"height":80,"clip":true,
                        "radii":[6,6,6,6],"transform":[1,0,0,1,2.25,1.5],"children":["moving","fixed"],
                        "fills":[{"kind":"solid","color":"#ffffff"}],
                        "effects":[{"kind":"shadow","radius":4,"x":2,"y":3,"color":"#000000","opacity":0.35},
                            {"kind":"blur","radius":3,"color":"#000000","opacity":0.2}]},
                    "moving":{"id":"moving","kind":"rectangle","width":18,"height":16,
                        "radii":[3,3,3,3],"transform":[1,0,0,1,8.25,12.5],"opacity":0.85,
                        "fills":[{"kind":"solid","color":"#2468ce"}],
                        "strokes":[{"width":1.25,"paint":{"kind":"solid","color":"#142536"}}],
                        "effects":[{"kind":"shadow","radius":2,"x":1,"y":-1,"color":"#000000","opacity":0.4}]},
                    "fixed":{"id":"fixed","kind":"ellipse","width":12,"height":12,
                        "transform":[1,0,0,1,40,24],"fills":[{"kind":"solid","color":"#d04a38"}]}
                }});
            if managed {
                document["colorManagement"] = json!(futureox_design_kernel::color::ColorSettings::default());
            }
            let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,
                "view":{"x":0.125,"y":0.375,"zoom":1.25},"rasterProfile":profile})).unwrap();
            let region = Rect::new(-1, -1, 66, 66);
            let guard = Rect::new(-1, -1, 128, 128);
            let mut engine = Engine::new();
            engine.load_document(&document.to_string()).unwrap();
            let initial_packet = engine.compile_gpu_region(&options, region, Some(guard)).unwrap().into_packet().unwrap();
            let initial_pixels = engine.render(&options).unwrap();
            for step in 1..=6 {
                // Steps 1-4 rotate the child (with stroke and shadow) around
                // its own origin; steps 5-6 non-uniformly scale the shadowed
                // root frame so scaled effect margins exercise the rebuilt
                // camera metadata summary.
                let (id, transform) = if step <= 4 {
                    let angle = step as f64 * 0.375;
                    ("moving", Transform([angle.cos(), angle.sin(), -angle.sin(), angle.cos(), 8.25, 12.5]))
                } else {
                    let scale = 1.0 + (step - 4) as f64 * 0.125;
                    ("frame", Transform([1.0 + (step - 4) as f64 * 0.125, 0., 0., scale, 2.25, 1.5]))
                };
                document["nodes"][id]["transform"] = json!(transform);
                assert!(engine.apply_interaction_transforms(&[(id.to_owned(), transform)].into_iter().collect()).unwrap());
                let actual_packet = engine.compile_gpu_region(&options, region, Some(guard)).unwrap().into_packet().unwrap();
                let actual_pixels = engine.render(&options).unwrap();
                let mut fresh = Engine::new();
                fresh.load_document(&document.to_string()).unwrap();
                assert_eq!(actual_packet, fresh.compile_gpu_region(&options, region, Some(guard)).unwrap().into_packet().unwrap(),
                    "complete packet: managed={managed}, profile={profile}, step={step}");
                assert_eq!(actual_pixels, fresh.render(&options).unwrap(),
                    "CPU RGBA bytes: managed={managed}, profile={profile}, step={step}");
                assert_ne!(actual_packet, initial_packet, "fixture must change geometry");
                assert_ne!(actual_pixels, initial_pixels, "fixture must change visible pixels");
            }
        }
    }
}
