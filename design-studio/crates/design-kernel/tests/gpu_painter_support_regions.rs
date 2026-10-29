//! Native dependency/packet tests only. These do not execute GPU shaders.
use futureox_design_kernel::{Engine, RenderOptions, color::ColorSettings, math::Rect,
    rational_filter, blend::{Pixel, Surface}};
use serde_json::{Value, json};
#[path="support/frame_scene.rs"] mod frame_scene;

fn document() -> Value {
    json!({"schemaVersion":9,"id":"painter-support","name":"painter support",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","background":"#abcdef","children":["frame"]}],
        "nodes":{
            "frame":{"id":"frame","kind":"frame","width":4096,"height":4096,
                "transform":[1,0,0,1,-2048,-2048],"children":["source","backdrop","distant"]},
            "source":{"id":"source","kind":"rectangle","width":4096,"height":4096,
                "fills":[{"kind":"solid","color":"#345678","opacity":0.7}],
                "effects":[{"kind":"blur","color":"#000000","radius":9.564871788024902}]},
            "backdrop":{"id":"backdrop","kind":"rectangle","width":4096,"height":4096,
                "fills":[{"kind":"solid","color":"#abcdef","opacity":0.2}],
                "effects":[{"kind":"background-blur","color":"#000000","radius":18.39398384094238}]},
            "distant":{"id":"distant","kind":"rectangle","width":10,"height":10,
                "transform":[1,0,0,1,3500,3500],"effects":[
                    {"kind":"background-blur","color":"#000000","radius":18.39398384094238}]}
        }})
}
fn options(profile: &str, zoom: f64) -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":64,"height":64,
        "view":{"x":0.125,"y":-0.375,"zoom":zoom},"rasterProfile":profile,
        "interactiveEffects":false,"transparent":false})).unwrap()
}
fn compile(d: &Value, o: &RenderOptions, region: Option<Rect>) -> Result<futureox_design_kernel::gpu::GpuScene,String> {
    let mut engine = Engine::new(); engine.load_document(&d.to_string()).unwrap();
    match region {
        Some(r) => {
            let mut request = serde_json::to_value(o).unwrap();
            request["gpuViewport"] = serde_json::to_value(r).unwrap();
            request["gpuPainterSupport"] = json!(true);
            engine.compile_gpu_request(&request.to_string())
        },
        None => engine.compile_gpu(o),
    }
}
#[test]
fn earlier_foreground_support_is_added_to_the_backdrop_dependency() {
    let crop = Rect::new(0,0,64,64); let d = document();
    for profile in ["analytic","figmaSubpixel"] {
        let o = options(profile,64.);
        let scene = compile(&d,&o,Some(crop)).unwrap();
        // The former uniform 2*r backdrop extent exceeded 16M even for one
        // output pixel. Keep BOTH actual tent supports, including outer taps
        // and the capture's fractional-origin bilinear neighbours.
        let needed = (18.39398384094238_f64*64.).ceil() as i32
            + (9.564871788024902_f64*64.).ceil() as i32;
        assert!(scene.extent.x <= -needed);
        assert!(scene.extent.right() >= crop.right()+needed);
        assert!(scene.extent.pixels() < 16_777_216);
        assert!(scene.nodes["source"].rect.x <= -needed);
        assert_eq!(scene.nodes["source"].effects[0].radius.to_bits(),9.564871788024902_f64.to_bits());
        assert_eq!(scene.nodes["backdrop"].effects[0].radius.to_bits(),18.39398384094238_f64.to_bits());
        assert!(scene.integrated_blur);
        assert!(compile(&d,&o,None).err().unwrap().contains("surface budget"));
    }
}
#[test]
fn painter_order_and_independent_foreground_branches_have_distinct_dependencies() {
    let crop = Rect::new(0,0,64,64); let mut d = document();
    let a = compile(&d,&options("figmaSubpixel",8.),Some(crop)).unwrap();
    d["nodes"]["frame"]["children"] = json!(["backdrop","source","distant"]);
    let b = compile(&d,&options("figmaSubpixel",8.),Some(crop)).unwrap();
    assert!(a.extent.pixels() > b.extent.pixels(),"a later foreground source cannot feed an earlier backdrop");
    let mut source2 = d["nodes"]["source"].clone(); source2["id"] = json!("source2");
    d["nodes"]["source2"] = source2;
    d["nodes"]["frame"]["children"] = json!(["backdrop","source","source2","distant"]);
    let c = compile(&d,&options("figmaSubpixel",8.),Some(crop)).unwrap();
    assert_eq!(b.extent,c.extent,"isolated foreground sources need their own support, not the sum of sibling supports");
}
#[test]
fn a_second_observable_backdrop_keeps_the_sum_of_prefix_dependencies() {
    let crop = Rect::new(0,0,64,64); let mut d = document();
    d["nodes"]["source"]["effects"][0]["radius"] = json!(1.);
    d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(2.25);
    let first = compile(&d,&options("figmaSubpixel",1.),Some(crop)).unwrap();
    let mut second = d["nodes"]["backdrop"].clone(); second["id"] = json!("second");
    second["effects"][0]["radius"] = json!(32.25);
    d["nodes"]["second"] = second;
    d["nodes"]["frame"]["children"] = json!(["source","backdrop","second","distant"]);
    let chained = compile(&d,&options("figmaSubpixel",1.),Some(crop)).unwrap();
    assert!(chained.extent.x < first.extent.x);
    assert!(chained.extent.right() > first.extent.right());
    assert!(chained.extent.x <= -(1+3+33),"retain both backdrops and the earlier foreground support");
    let first_output = chained.nodes["backdrop"].backdrop_output_box.unwrap();
    let last_output = chained.nodes["second"].backdrop_output_box.unwrap();
    assert!(first_output[0] <= last_output[0]-33.,"earlier backdrop output covers the later backdrop input");
}
#[test]
fn backdrop_output_certificate_covers_parent_foreground_support_and_packet_metadata() {
    let mut d = document();
    d["nodes"]["source"]["effects"][0]["radius"] = json!(1.);
    d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(32.25);
    d["nodes"]["frame"]["effects"] = json!([{"kind":"blur","color":"#000000","radius":2.75}]);
    let crop = Rect::new(0,0,64,64); let o = options("figmaSubpixel",1.);
    let scene = compile(&d,&o,Some(crop)).unwrap();
    let output = scene.nodes["backdrop"].backdrop_output_box.unwrap();
    assert!(output[0] <= -5. && output[1] <= -5.);
    assert!(output[0]+output[2] >= f64::from(crop.right()+5));
    assert!(output[1]+output[3] >= f64::from(crop.bottom()+5));
    let json = serde_json::to_value(&scene).unwrap();
    assert_eq!(json["nodes"]["backdrop"]["backdropOutputBox"],serde_json::to_value(output).unwrap());
    let packet = scene.into_packet().unwrap();
    let metadata = frame_scene::scene(&packet);
    assert_eq!(metadata["nodes"]["backdrop"]["backdropOutputBox"],json["nodes"]["backdrop"]["backdropOutputBox"]);
    let old = compile(&d,&o,None).unwrap();
    assert!(old.nodes.values().all(|n| n.backdrop_output_box.is_none()));
    assert!(serde_json::to_value(&old).unwrap()["nodes"]["backdrop"].get("backdropOutputBox").is_none());
}
#[test]
fn unsupported_dependency_domains_retain_the_previous_admission_error() {
    let crop = Rect::new(0,0,64,64);
    for variant in ["unmanaged","mask","blend","gradient","shadow","glass","gradient-blur","large-coordinates"] {
        let mut d = document(); let mut o = options("analytic",64.);
        match variant {
            "unmanaged" => { d.as_object_mut().unwrap().remove("colorManagement"); },
            "mask" => d["nodes"]["source"]["mask"] = json!(true),
            "blend" => d["nodes"]["source"]["blend"] = json!("multiply"),
            "gradient" => d["nodes"]["source"]["fills"][0] = json!({"kind":"linear","color":"#ffffff",
                "stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]}),
            "shadow" => d["nodes"]["source"]["effects"].as_array_mut().unwrap().push(json!({"kind":"shadow","color":"#000000","radius":2})),
            "glass" => d["nodes"]["backdrop"]["effects"][0]["kind"] = json!("glass"),
            "gradient-blur" => d["nodes"]["source"]["effects"][0]["gradientBlur"] = json!({"start":[0.,0.],"end":[1.,1.],"startCount":1.,"endCount":2.,"smooth":false}),
            "large-coordinates" => { o.view.x = 1_048_576.; },
            _ => unreachable!(),
        }
        let crop = if variant == "large-coordinates" {Rect::new(1_048_576,0,64,64)} else {crop};
        assert!(compile(&d,&o,Some(crop)).is_err(),"{variant} must not acquire a new support certificate");
    }
}
fn field(r: Rect, phase: usize) -> Surface {
    let mut s = Surface::new(r).unwrap();
    for y in r.y..r.bottom() { for x in r.x..r.right() {
        let seed = (x.wrapping_mul(7919)^y.wrapping_mul(104729)^phase as i32) as u32;
        let i = r.index(x,y).unwrap();
        s.pixels[i] = Pixel([((seed%31) as f32-15.)/3., (seed%19) as f32*1.125,
            f32::from_bits(1+seed%64),if seed%3 == 0 {0.} else {(seed%17) as f32/17.}]);
    }} s
}
#[test]
fn exact_filter_chain_matches_the_unchanged_wider_source_at_every_crop_boundary() {
    let crop = Rect::new(0,0,4,3); let mut d = document();
    for (foreground,backdrop) in [(0.25,9.125),(1.,12.25),(2.75,16.000000000000004)] {
        d["nodes"]["source"]["effects"][0]["radius"] = json!(foreground);
        d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(backdrop);
        let mut o = options("analytic",1.); o.width = crop.w; o.height = crop.h;
        let tight = compile(&d,&o,Some(crop)).unwrap();
        let old = compile(&d,&o,None).unwrap();
        // This is a native rectangle/coefficients oracle plus independent exact
        // CPU filtering, never a claim that the GPU scene has executed.
        assert!(tight.extent.pixels() < old.extent.pixels());
        for id in ["source","backdrop"] {
            assert_eq!(tight.nodes[id].matrix.0.map(f64::to_bits),old.nodes[id].matrix.0.map(f64::to_bits));
            assert_eq!(tight.nodes[id].inverse.0.map(f64::to_bits),old.nodes[id].inverse.0.map(f64::to_bits));
            assert_eq!(tight.nodes[id].effects,old.nodes[id].effects);
        }
        for phase in 0..4 {
            let a = rational_filter::blur(&field(tight.extent,phase),foreground,false).unwrap();
            let a = rational_filter::blur(&a,backdrop,true).unwrap();
            let b = rational_filter::blur(&field(old.extent,phase),foreground,false).unwrap();
            let b = rational_filter::blur(&b,backdrop,true).unwrap();
            for y in crop.y..crop.bottom() { for x in crop.x..crop.right() {
                assert_eq!(a.at(x,y).0.map(f32::to_bits),b.at(x,y).0.map(f32::to_bits),
                    "foreground={foreground}, backdrop={backdrop}, phase={phase}, ({x},{y})");
            }}
        }
    }
}
fn shadow_document() -> Value {
    let mut d = document();
    d.as_object_mut().unwrap().remove("colorManagement");
    d["pages"][0]["children"] = json!(["source"]);
    d["nodes"].as_object_mut().unwrap().retain(|id,_|id=="source");
    d["nodes"]["source"]["height"] = json!(700);
    d["nodes"]["source"]["width"] = json!(1128);
    d["nodes"]["source"]["transform"] = json!([1,0,0,1,-560,-700]);
    d["nodes"]["source"]["effects"] = json!([{"kind":"shadow","color":"#000000",
        "radius":30,"x":0,"y":10,"spread":0,"opacity":0.75}]);
    d
}
#[test]
fn coherent_shadow_uses_full_source_support_without_allocating_known_zero_rows() {
    let d = shadow_document(); let o = options("figmaSubpixel",64.);
    let crop = Rect::new(0,0,64,64);
    let scene = compile(&d,&o,Some(crop)).unwrap();
    assert!(scene.integrated_blur && scene.coherent_samples && !scene.float_compositing);
    assert!(scene.extent.pixels() < 16_777_216);
    assert!(scene.extent.x <= -1920);
    assert!(scene.extent.y <= -1920-640);
    assert!(scene.extent.bottom() >= crop.bottom());
    assert!(scene.extent.bottom() < 1920,"source outside the leaf is exactly transparent");
    assert!(scene.nodes["source"].backdrop_output_box.is_none());
    assert_eq!(scene.nodes["source"].shadow_output_box,Some([-2.,-2.,68.,68.]));
    assert_eq!(scene.nodes["source"].effects[0].radius,30.);
    assert!(compile(&d,&o,None).is_err());
}
#[test]
fn shadow_certificate_rejects_unproved_offsets_spread_and_gaussian_profiles() {
    let crop = Rect::new(0,0,64,64);
    for variant in ["fractional-offset","spread","inner-shadow","mask","clip","multiple","analytic"] {
        let mut d = shadow_document(); let mut o = options("figmaSubpixel",64.);
        match variant {
            "fractional-offset" => d["nodes"]["source"]["effects"][0]["x"] = json!(0.1),
            "spread" => d["nodes"]["source"]["effects"][0]["spread"] = json!(1),
            "inner-shadow" => d["nodes"]["source"]["effects"][0]["kind"] = json!("inner-shadow"),
            "mask" => d["nodes"]["source"]["mask"] = json!(true),
            "clip" => d["nodes"]["source"]["clip"] = json!(true),
            "multiple" => d["nodes"]["source"]["effects"].as_array_mut().unwrap().push(json!({"kind":"blur","color":"#000000","radius":1})),
            "analytic" => o = options("analytic",64.),
            _ => unreachable!(),
        }
        assert!(compile(&d,&o,Some(crop)).is_err(),"{variant}");
    }
}


// Stage-two allocation-domain contracts; GPU parity is validated separately.
#[test]
fn staged_bundle_domains_separate_prefix_targets_from_independent_filter_sources() {
    let d = document(); let crop = Rect::new(0,0,64,64);
    let scene = compile(&d,&options("figmaSubpixel",64.),Some(crop)).unwrap();
    let root = scene.root_input_box.unwrap();
    let frame = &scene.nodes["frame"];
    let source = &scene.nodes["source"];
    let backdrop = &scene.nodes["backdrop"];
    assert_eq!(root,[-2.,-2.,68.,68.],"normal frame isolation does not read the outer root prefix");
    let children = frame.children_input_box.unwrap();
    assert!(children[2] > root[2] && children[3] > root[3]);
    assert!(children[2] < f64::from(scene.extent.w));
    assert!(children[3] < f64::from(scene.extent.h));
    assert!(source.rect.w > frame.rect.w && source.rect.h > frame.rect.h,
        "independent foreground filter source retains its own larger halo");
    assert!(source.rect.x <= children[0] as i32 - 613);
    assert_eq!(source.post_composite_box,Some(children));
    assert_eq!(frame.post_composite_box,Some(root));
    assert_eq!(backdrop.post_composite_box,Some([-2.,-2.,68.,68.]));
    assert_eq!(backdrop.rect,crop.expand(2));
    assert_eq!(backdrop.fill.rect,crop.expand(2),
        "native interval rows must be recompiled for the mask crop");
    assert!(backdrop.backdrop_box[2] > f64::from(backdrop.rect.w)+2.*1177.);
    assert!(backdrop.backdrop_box[3] > f64::from(backdrop.rect.h)+2.*1177.);
    let old = compile(&d,&options("figmaSubpixel",1.),None).unwrap();
    assert!(old.root_input_box.is_none());
    assert!(old.nodes.values().all(|n|n.children_input_box.is_none() && n.post_composite_box.is_none()));
}
#[test]
fn suffix_demand_retains_old_target_pixels_outside_the_current_child_shape() {
    let mut d = document();
    d["nodes"]["backdrop"]["width"] = json!(4);
    d["nodes"]["backdrop"]["height"] = json!(4);
    d["nodes"]["backdrop"]["transform"] = json!([1,0,0,1,2048,2048]);
    d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(32.25);
    d["nodes"]["source"]["effects"][0]["radius"] = json!(1.25);
    let crop = Rect::new(0,0,64,64);
    let scene = compile(&d,&options("figmaSubpixel",1.),Some(crop)).unwrap();
    let n = &scene.nodes["backdrop"];
    assert_eq!(n.post_composite_box,Some([-2.,-2.,68.,68.]));
    assert!(n.rect.w < 68 && n.rect.h < 68);
    assert!(n.post_composite_box.unwrap()[2] > f64::from(n.rect.w),
        "post-composite demand is not the child's visible intersection");
}
#[test]
fn effect_bearing_containers_keep_phase_one_until_their_third_domain_is_proved() {
    let mut d = document();
    d["nodes"]["source"]["effects"][0]["radius"] = json!(1.);
    d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(32.25);
    d["nodes"]["frame"]["effects"] = json!([{"kind":"blur","color":"#000000","radius":2.75}]);
    let scene = compile(&d,&options("figmaSubpixel",1.),Some(Rect::new(0,0,64,64))).unwrap();
    assert!(scene.nodes["backdrop"].backdrop_output_box.is_some(),"phase-one certificate remains available");
    assert!(scene.root_input_box.is_none());
    assert!(scene.nodes.values().all(|n|n.children_input_box.is_none() && n.post_composite_box.is_none()));
}

#[test]
fn painter_support_request_policy_is_strict_opt_in_and_public_native_defaults_stay_conservative() {
    let d = document(); let o = options("figmaSubpixel",64.); let crop = Rect::new(0,0,64,64);
    let mut engine = Engine::new(); engine.load_document(&d.to_string()).unwrap();
    assert!(engine.compile_gpu_region(&o,crop,None).is_err());
    let mut request = serde_json::to_value(o).unwrap(); request["gpuViewport"] = serde_json::to_value(crop).unwrap();
    assert!(engine.compile_gpu_request(&request.to_string()).is_err(),"missing policy retains default");
    request["gpuPainterSupport"] = json!(false);
    assert!(engine.compile_gpu_request(&request.to_string()).is_err(),"false retains default");
    request["gpuPainterSupport"] = json!(true);
    let scene = engine.compile_gpu_request(&request.to_string()).unwrap();
    assert!(scene.nodes["backdrop"].backdrop_output_box.is_some());
    for value in [json!(null),json!("true"),json!(1),json!({}),json!([])] {
        request["gpuPainterSupport"] = value;
        let error = engine.compile_gpu_request(&request.to_string()).err().unwrap();
        assert!(error.contains("painter support policy"));
    }
}

#[test]
fn complete_support_can_exceed_the_legacy_tree_max_without_raising_the_surface_cap() {
    let mut d = document();
    d["nodes"]["source"]["effects"][0]["radius"] = json!(7.125);
    d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(11.375);
    d["nodes"]["distant"]["effects"] = json!([]);
    let mut second = d["nodes"]["backdrop"].clone(); second["id"] = json!("second");
    second["effects"][0]["radius"] = json!(4.000000000000001);
    d["nodes"]["second"] = second;
    d["nodes"]["frame"]["children"] = json!(["source","backdrop","second","distant"]);
    let o = options("figmaSubpixel",1.); let crop = Rect::new(0,0,64,64);
    let mut engine = Engine::new(); engine.load_document(&d.to_string()).unwrap();
    let legacy = engine.compile_gpu_region(&o,crop,None).unwrap();
    assert_eq!(legacy.extent,crop.expand(23));
    let mut request = serde_json::to_value(&o).unwrap();
    request["gpuViewport"] = serde_json::to_value(crop).unwrap();
    request["gpuPainterSupport"] = json!(true);
    // A fresh narrow geometry guard cannot certify the longer sibling chain.
    let unproved = engine.compile_gpu_request(&request.to_string()).unwrap();
    assert_eq!(unproved.extent,legacy.extent);
    assert!(unproved.root_input_box.is_none());
    assert!(unproved.nodes.values().all(|n|n.backdrop_output_box.is_none()));
    request["prepareViewport"] = serde_json::to_value(crop.expand(64)).unwrap();
    let complete = engine.compile_gpu_request(&request.to_string()).unwrap();
    assert_eq!(complete.extent,crop.expand(33));
    assert!(complete.extent.pixels() > legacy.extent.pixels());
    assert!(complete.extent.pixels() <= 16_777_216);
    assert!(complete.nodes["backdrop"].backdrop_output_box.is_some());
    // The cache still owns that wider prepared window on the next narrow
    // request, even though its explicit prepareViewport has been removed.
    request.as_object_mut().unwrap().remove("prepareViewport");
    let retained = engine.compile_gpu_request(&request.to_string()).unwrap();
    assert_eq!(retained.extent,complete.extent);
    assert!(retained.nodes["backdrop"].backdrop_output_box.is_some());
}

#[test]
fn unsafe_backdrop_phase_rejects_the_entire_certificate_including_without_stage_metadata() {
    let mut d = document();
    d["nodes"]["frame"]["width"] = json!(180);
    d["nodes"]["frame"]["height"] = json!(160);
    d["nodes"]["frame"]["transform"] = json!([1,0,0,1,-9.375,-7.125]);
    d["nodes"]["source"]["width"] = json!(155);
    d["nodes"]["source"]["height"] = json!(141);
    d["nodes"]["source"]["transform"] = json!([1,0,0,1,3.125,1.375]);
    d["nodes"]["source"]["effects"][0]["radius"] = json!(7.125);
    d["nodes"]["backdrop"]["width"] = json!(128);
    d["nodes"]["backdrop"]["height"] = json!(101);
    d["nodes"]["backdrop"]["radii"] = json!([7,7,7,7]);
    d["nodes"]["backdrop"]["transform"] = json!([0.992197667,0.124674733,-0.124674733,0.992197667,14.375,15.125]);
    d["nodes"]["backdrop"]["effects"][0]["radius"] = json!(11.375);
    let o = options("figmaSubpixel",1.375); let crop = Rect::new(47,39,64,57);
    for parent_blur in [false,true] {
        if parent_blur { d["nodes"]["frame"]["effects"] = json!([{"kind":"blur","color":"#000000","radius":2.75}]); }
        let mut engine = Engine::new(); engine.load_document(&d.to_string()).unwrap();
        let legacy = engine.compile_gpu_region(&o,crop,None).unwrap();
        let candidate = compile(&d,&o,Some(crop)).unwrap();
        assert!(candidate.root_input_box.is_none());
        assert!(candidate.nodes.values().all(|n|n.backdrop_output_box.is_none() && n.post_composite_box.is_none()));
        assert_eq!(serde_json::to_value(&candidate).unwrap(),serde_json::to_value(&legacy).unwrap(),
            "phase fallback must preserve the complete same-crop legacy scene, not just omit stage hints");
    }
}
#[test]
fn an_integer_offset_shadow_without_backdrops_keeps_its_existing_large_coordinate_domain() {
    let d = shadow_document(); let mut o = options("figmaSubpixel",64.);
    o.view.x += 50000.;
    let crop = Rect::new(50000,0,64,64);
    let scene = compile(&d,&o,Some(crop)).unwrap();
    assert!(scene.root_input_box.is_some());
    assert!(scene.nodes["source"].shadow_output_box.is_some());
    assert!(scene.nodes["source"].rect.x > 32768);
    assert!(scene.extent.pixels() < 16_777_216);
}
