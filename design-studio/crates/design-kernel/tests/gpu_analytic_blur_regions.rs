//! CPU-only support/packet oracles. No GPU shader execution or timing claim.
use futureox_design_kernel::{Engine, RenderOptions, color::ColorSettings, math::Rect,
    rational_filter::{self, RationalKernel}, blend::{Pixel, Surface}};
use serde_json::{json,Value};
fn document() -> Value {
    json!({"schemaVersion":9,"id":"d","name":"analytic blur support",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","children":["image"],"background":"#223344"}],
        "nodes":{"image":{"id":"image","kind":"rectangle","width":8192,"height":8192,
            "transform":[-1,0,0,1,4096,-4096],"opacity":0.48,
            "fills":[{"kind":"solid","color":"#ad3344","opacity":0.7}],
            "effects":[{"kind":"blur","color":"#000000","radius":9.564871788024902}]}}})
}
fn options(profile:&str, zoom:f64)->RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":64,"height":48,
        "view":{"x":0.375,"y":-0.125,"zoom":zoom},"rasterProfile":profile,
        "interactiveEffects":false,"transparent":true})).unwrap()
}
fn compile(d:&Value, o:&RenderOptions, crop:Rect)->futureox_design_kernel::gpu::GpuScene {
    let mut e=Engine::new();e.load_document(&d.to_string()).unwrap();e.compile_gpu_region(o,crop,None).unwrap()
}
#[test]
fn analytic_managed_leaf_uses_exact_tent_support_at_fractional_and_high_device_scales() {
    let d=document();let crop=Rect::new(-8,-6,16,12);
    for zoom in [0.291363163371488,0.582726326742976,1.16545265348595,8.,16.,32.,64.] {
        let o=options("analytic",zoom);let scene=compile(&d,&o,crop);
        let n=&scene.nodes["image"];
        let radius=9.564871788024902*zoom;
        assert!(scene.integrated_blur && scene.float_compositing && !scene.coherent_samples);
        assert_eq!(n.rect,crop.expand(radius.ceil() as i32+2));
        assert_eq!(n.effects[0].radius.to_bits(),9.564871788024902_f64.to_bits());
        assert_eq!(n.opacity,0.48);
        assert_eq!(RationalKernel::tent(radius).unwrap().reach(),radius.ceil() as usize);
        // Coherent sample profiles retain their existing branch-local bounds.
        let coherent=compile(&d,&options("figmaSubpixel",zoom),crop);
        assert!(coherent.coherent_samples);assert_eq!(n.rect,coherent.nodes["image"].rect);
        assert_eq!(n.matrix.0.map(f64::to_bits),coherent.nodes["image"].matrix.0.map(f64::to_bits));
    }
}
#[test]
fn analytic_exclusions_keep_the_conservative_leaf_neighborhood() {
    let crop=Rect::new(-8,-6,16,12);let o=options("analytic",1.);
    let small=compile(&document(),&o,crop).nodes["image"].rect;
    for variant in ["mask","clip","stroke","shadow","two-blurs","gradient","gradient-blur"] {
        let mut d=document();let n=&mut d["nodes"]["image"];
        match variant {
            "mask"=>n["mask"]=json!(true),"clip"=>n["clip"]=json!(true),
            "stroke"=>n["strokes"]=json!([{"width":1,"paint":{"kind":"solid","color":"#000000"}}]),
            "shadow"=>n["effects"][0]["kind"]=json!("shadow"),
            "two-blurs"=>n["effects"].as_array_mut().unwrap().push(json!({"kind":"blur","color":"#000000","radius":0})),
            "gradient-blur"=>n["effects"][0]["gradientBlur"]=json!({"start":[0.,0.],"end":[1.,1.],"startCount":1.,"endCount":1.,"smooth":false}),
            "gradient"=>n["fills"]=json!([{"kind":"linear","color":"#ffffff","stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]}]),
            _=>unreachable!(),
        }
        let s=compile(&d,&o,crop);assert!(s.nodes["image"].rect.w>small.w,"{variant}");
    }
    let mut unmanaged=document();unmanaged.as_object_mut().unwrap().remove("colorManagement");
    let s=compile(&unmanaged,&o,crop);assert!(!s.integrated_blur);assert!(s.nodes["image"].rect.w>small.w);
}
#[test]
fn later_observable_backdrop_retains_earlier_image_support() {
    let mut d=document();d["pages"][0]["children"]=json!(["image","glass"]);
    d["nodes"]["glass"]=json!({"id":"glass","kind":"rectangle","width":8192,"height":8192,
        "transform":[1,0,0,1,-4096,-4096],"fills":[{"kind":"solid","color":"#ffffff","opacity":0.2}],
        "effects":[{"kind":"background-blur","color":"#000000","radius":18.39398384094238}]});
    let crop=Rect::new(-8,-6,16,12);let scene=compile(&d,&options("analytic",1.),crop);
    assert!(scene.nodes["glass"].effects.iter().any(|e|e.kind=="background-blur"));
    assert!(scene.extent.w>crop.w+4);
    assert!(scene.nodes["image"].rect.w>=crop.w+38);
}
#[test]
fn uncertain_large_global_lattice_keeps_the_conservative_support() {
    let mut o=options("analytic",1.);
    o.view.x=1_048_576.;
    let crop=Rect::new(1_048_570,-6,16,12);
    let scene=compile(&document(),&o,crop);
    assert_eq!(scene.nodes["image"].rect,crop.expand(22));
}
fn field(r:Rect,phase:usize)->Surface {
    let mut s=Surface::new(r).unwrap();
    for y in r.y..r.bottom(){for x in r.x..r.right(){
        let i=r.index(x,y).unwrap();
        // Signed extended-range channels, zero/tiny alpha and nontrivial
        // boundary values: no opacity-based or SDR-range simplification.
        let seed=(x.wrapping_mul(7919)^y.wrapping_mul(104729)^phase as i32) as u32;
        s.pixels[i]=Pixel([((seed%31) as f32-15.)/3., (seed%19) as f32*1.125,
            f32::from_bits(1+seed%64),if seed%3==0{0.}else{(seed%17) as f32/17.}]);
    }}s
}
#[test]
fn cropped_exact_cpu_filter_matches_every_boundary_pixel_in_all_four_source_phases() {
    let output=Rect::new(-2,3,4,3);
    for radius in [0.25,1.,1.0000000000000002,2.75,8.125] {
        for phase in 0..4 {
            let reach=RationalKernel::tent(radius).unwrap().reach() as i32;
            let wide=field(output.expand(2*reach+4),phase);
            let tight=field(output.expand(reach+2),phase);
            let expected=rational_filter::blur(&wide,radius,false).unwrap();
            let actual=rational_filter::blur(&tight,radius,false).unwrap();
            for y in output.y..output.bottom(){for x in output.x..output.right(){
                assert_eq!(expected.at(x,y).0.map(f32::to_bits),actual.at(x,y).0.map(f32::to_bits),
                    "radius={radius} phase={phase} at ({x},{y})");
            }}
        }
    }
}
#[test]
fn fractional_outer_tap_is_observable_and_must_not_be_rounded_down() {
    for radius in [0.25,1.0000000000000002,9.564871788024902,306.0758972167969,612.1517944335938] {
        let k=RationalKernel::tent(radius).unwrap();let mut taps=vec![0.;2*k.reach()+1];
        taps[0]=f32::MAX;assert!(k.convolve(&taps).unwrap()>0.,"last fractional tap radius={radius}");
    }
}

// Decode interval packets exactly, as in gpu_pointwise_regions.
use futureox_design_kernel::gpu::{GpuScene,GpuPath};
fn remainder(data: &[f32], offset: usize) -> f64 {
    f64::from_bits((0..4).fold(0_u64, |bits, i| bits | ((data[offset + i] as u64) << (16 * i))))
}
fn endpoint(data: &[f32], range: usize, side: usize, bits: usize, origin: i32) -> f64 {
    f64::from(origin) + f64::from(data[range + side]) +
        f64::from(data[range + side + 2]) + remainder(data, bits)
}
// Decode exact f64 interval endpoints. Compare only the requested pixel's
// intersections, so integer crop rebasing and packet offsets cannot hide a
// changed edge. No raster approximation or screenshot tolerance is involved.
fn coverage_signature(scene: &GpuScene, path: &GpuPath, x: i32, y: i32) -> Vec<u64> {
    if path.count == 0 || path.rect.index(x, y).is_none() { return vec![]; }
    let area = path.area.as_ref().unwrap();
    let data = &scene.curves[area.first as usize * 4..(area.first + area.count) as usize * 4];
    let mode = data[0] as u32;
    if mode == 2 { return vec![]; }
    if mode == 1 || mode == 4 {
        let left = endpoint(data, 4, 0, 12, path.rect.x);
        let right = endpoint(data, 4, 1, 16, path.rect.x);
        let top = endpoint(data, 8, 0, 20, path.rect.y);
        let bottom = endpoint(data, 8, 1, 24, path.rect.y);
        if mode == 4 {
            return futureox_design_kernel::fidelity::SAMPLE_OFFSETS.iter().map(|(dx, dy)| {
                u64::from(f64::from(x) + dx >= left && f64::from(x) + dx < right &&
                    f64::from(y) + dy >= top && f64::from(y) + dy < bottom)
            }).collect();
        }
        let width = (right.min(f64::from(x + 1)) - left.max(f64::from(x))).max(0.);
        let height = (bottom.min(f64::from(y + 1)) - top.max(f64::from(y))).max(0.);
        return vec![(width * height).to_bits()];
    }
    let samples = if mode == 3 { 4 } else { 8 };
    let mut signature = Vec::new();
    for sample in 0..samples {
        let row = (y - path.rect.y) as usize * samples + sample;
        let record = 4 + row * 4;
        let first = data[record] as usize * 4;
        let count = data[record + 1] as usize;
        let mut intervals = Vec::new();
        let mut inside = false;
        for index in 0..count {
            let at = first + index * 12;
            let left = endpoint(data, at, 0, at + 4, path.rect.x);
            let right = endpoint(data, at, 1, at + 8, path.rect.x);
            if mode == 3 {
                let q = f64::from(x) + futureox_design_kernel::fidelity::SAMPLE_OFFSETS[sample].0;
                inside |= q >= left && q < right;
            } else {
                let left = left.max(f64::from(x));
                let right = right.min(f64::from(x + 1));
                if right > left { intervals.extend([left.to_bits(), right.to_bits()]); }
            }
        }
        if mode == 3 { signature.push(u64::from(inside)); }
        else { signature.push(intervals.len() as u64); signature.extend(intervals); }
    }
    signature
}

#[test]
fn cropped_packets_preserve_exact_coverage_and_image_sampling_for_every_needed_pixel() {
    use futureox_design_kernel::{paint::image_sampling_grid_placed,scene::Paint};
    let crop=Rect::new(-5,-3,10,8);
    for kind in ["rectangle","ellipse"] {
        let mut d=document();let n=&mut d["nodes"]["image"];
        n["kind"]=json!(kind);n["width"]=json!(17.25);n["height"]=json!(12.75);
        n["transform"]=json!([-1.,-2.4492935982947064e-16,-2.4492935982947064e-16,1.,8.125,-6.375]);
        n["effects"][0]["radius"]=json!(2.75);
        let mut old=d.clone();old["nodes"]["image"]["effects"].as_array_mut().unwrap()
            .push(json!({"kind":"blur","color":"#000000","radius":0}));
        for profile in ["analytic","figmaSubpixel"] {
            let o=options(profile,1.);let new=compile(&d,&o,crop);let reference=compile(&old,&o,crop);
            let a=&new.nodes["image"];let b=&reference.nodes["image"];
            assert_eq!(a.matrix.0.map(f64::to_bits),b.matrix.0.map(f64::to_bits));
            assert_eq!(a.inverse.0.map(f64::to_bits),b.inverse.0.map(f64::to_bits));
            let needed=crop.expand(4);
            for y in needed.y..needed.bottom(){for x in needed.x..needed.right(){
                assert_eq!(coverage_signature(&new,&a.fill,x,y),coverage_signature(&reference,&b.fill,x,y),"{kind}/{profile} ({x},{y})");
            }}
            for fit in ["stretch","cover","contain"] {
                let p:Paint=serde_json::from_value(json!({"kind":"image","color":"#ffffff","fit":fit})).unwrap();
                for phase in [None,Some(0),Some(1),Some(2),Some(3)] {
                    let x=image_sampling_grid_placed(a.rect,a.matrix,[17.25,12.75],[13,9],&p,phase,0,[0,0]).unwrap();
                    let y=image_sampling_grid_placed(b.rect,b.matrix,[17.25,12.75],[13,9],&p,phase,0,[0,0]).unwrap();
                    for py in needed.y..needed.bottom(){for px in needed.x..needed.right(){
                        if let (Some(ai),Some(bi))=(a.rect.index(px,py),b.rect.index(px,py)) {
                            assert_eq!(x[ai*4..ai*4+4].iter().map(|v|v.to_bits()).collect::<Vec<_>>(),
                                y[bi*4..bi*4+4].iter().map(|v|v.to_bits()).collect::<Vec<_>>());
                        }
                    }}
                }
            }
        }
    }
}
