//! CPU-only contracts for noise on the existing regional foreground path.
//! These verify compiler geometry, support, effect parameters and CPU crop
//! pixels; they do not claim a GPU backend readback comparison.
use futureox_design_kernel::{
    Engine, RenderOptions, color::ColorSettings,
    gpu::{GpuNode, GpuPath, GpuScene}, math::Rect,
};
use serde_json::{Value, json};

fn noise() -> Value {
    json!({"kind":"noise","amount":0.73,"opacity":0.37,"color":"#000000"})
}
fn document(order: usize, transform: [f64; 6]) -> Value {
    let mut effects = vec![noise(), json!({"kind":"blur","radius":1.75,"color":"#000000"}),
        json!({"kind":"inner-shadow","radius":1.25,"spread":0.75,"x":0,"y":0,
            "opacity":0.3,"color":"#112233"})];
    effects.rotate_left(order);
    let mut doc = json!({"schemaVersion":5,"id":"noise-regions","name":"noise regions",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","background":"#78899a","children":["clip"]}],
        "nodes":{
            "clip":{"id":"clip","kind":"frame","width":74.75,"height":57.25,
                "transform":[1,0,0,1,-3.125,-4.375],"clip":true,"radii":[4,4,4,4],
                "fills":[{"kind":"solid","color":"#aabbcc","opacity":0.6}],
                "children":["nested","sibling"],"effects":[noise()]},
            "nested":{"id":"nested","kind":"frame","width":61.5,"height":46.25,
                "transform":transform,"clip":true,"opacity":0.83,"radii":[3,3,3,3],
                "fills":[{"kind":"solid","color":"#225588","opacity":0.4}],
                "children":["paint"],"effects":[noise(),
                    {"kind":"shadow","radius":1.5,"x":0,"y":0,"opacity":0.2,"color":"#000000"}]},
            "paint":{"id":"paint","kind":"ellipse","width":45.375,"height":32.875,
                "transform":[1,0,0,1,11.125,8.375],"opacity":0.77,
                "fills":[{"kind":"solid","color":"#dc6543","opacity":0.8}],
                "strokes":[{"width":1.375,"paint":{"kind":"solid","color":"#4c7e39"}}],
                "effects":effects},
            "sibling":{"id":"sibling","kind":"rectangle","width":13.25,"height":21.75,
                "transform":[1,0,0,1,57.625,37.125],
                "fills":[{"kind":"solid","color":"#956adb","opacity":0.6}],"effects":[noise()]}
        }});
    if order == 2 {
        doc["nodes"]["sibling"]["mask"] = json!(true);
        doc["nodes"]["sibling"]["width"] = json!(58.25);
        doc["nodes"]["sibling"]["height"] = json!(42.75);
        doc["nodes"]["sibling"]["transform"] = json!([1,0,0,1,3.625,2.125]);
    }
    doc
}
fn engine(doc: &Value) -> Engine {
    let mut e = Engine::new();
    e.load_document(&doc.to_string()).unwrap();
    e
}
fn options(profile: &str, zoom: f64, x: f64, y: f64) -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":80,"height":64,
        "view":{"x":x,"y":y,"zoom":zoom},"rasterProfile":profile,
        "transparent":true,"grid":false,"interactiveEffects":false})).unwrap()
}
fn source_region(options: &RenderOptions, crop: Rect) -> Rect {
    if options.raster_profile.is_export() {
        Rect::new(crop.x * 2, crop.y * 2, crop.w * 2, crop.h * 2)
    } else { crop }
}
fn conservative_document(doc: &Value) -> Value {
    let mut doc = doc.clone();
    // Camera admission scans every node. This hidden, validated texture
    // keeps the old global-support path without contributing any pixels.
    doc["nodes"]["admission-sentinel"] = json!({"id":"admission-sentinel",
        "kind":"rectangle","width":1,"height":1,"visible":false,
        "effects":[{"kind":"texture","amount":1,"color":"#000000"}]});
    doc["pages"][0]["children"].as_array_mut().unwrap().push(json!("admission-sentinel"));
    doc
}
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
fn noise_signature(node: &GpuNode, x: i32, y: i32, amount: f64) -> [u32; 3] {
    // The shared shader uses fragment position + global surface origin, then
    // the authored inverse. Verify that crop changes keep every input bit.
    let px = ((x - node.rect.x) as f32 + 0.5) + node.rect.x as f32;
    let py = ((y - node.rect.y) as f32 + 0.5) + node.rect.y as f32;
    let m = node.inverse.0.map(|v| v as f32);
    let qx = m[0] * px + m[2] * py + m[4];
    let qy = m[1] * px + m[3] * py + m[5];
    let density = (amount as f32).max(0.01);
    [qx.to_bits(), qy.to_bits(), futureox_design_kernel::effects::noise(
        (qx * density).floor() as i32, (qy * density).floor() as i32, 7).to_bits()]
}

#[test]
fn pointwise_noise_admits_branch_local_surfaces_without_reducing_filter_support() {
    let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
    for id in ["clip", "nested", "paint"] {
        doc["nodes"][id]["width"] = json!(1000);
        doc["nodes"][id]["height"] = json!(1000);
        doc["nodes"][id]["transform"] = json!([1,0,0,1,0,0]);
    }
    doc["nodes"]["nested"]["effects"] = json!([]);
    doc["nodes"]["paint"]["effects"] = json!([
        {"kind":"inner-shadow","radius":83,"spread":132,"color":"#000000","opacity":0.5}, noise()]);
    let crop = Rect::new(100, 100, 64, 64);
    let mut candidate = engine(&doc);
    let mut conservative = engine(&conservative_document(&doc));
    for profile in ["analytic", "figmaSubpixel", "figma"] {
        let options = options(profile, 1., 0.375, -0.125);
        let regional = candidate.compile_gpu_region(&options, crop, None).unwrap();
        let old = conservative.compile_gpu_region(&options, crop, None).unwrap();
        let source = source_region(&options, crop);
        assert_eq!(regional.extent, source.expand(2), "{profile}");
        assert_eq!(regional.nodes["clip"].rect, source.expand(2));
        assert!(regional.nodes["paint"].rect.w > regional.nodes["clip"].rect.w + 200);
        assert!(old.extent.pixels() > regional.extent.pixels() * 10);
        assert_eq!(regional.nodes["paint"].effects, old.nodes["paint"].effects);
        let allocated = |scene: &GpuScene| scene.extent.pixels() + scene.nodes.values().map(|n| n.rect.pixels()).sum::<usize>();
        eprintln!("{profile}: conservative surface rectangles {} pixels; regional {} pixels",
            allocated(&old), allocated(&regional));
        assert!(allocated(&regional) < allocated(&old));
    }
}

#[test]
fn pointwise_noise_preserves_full_and_conservative_crop_geometry_and_parameters() {
    for (profile, transform, camera) in [
        ("analytic", [1., 0.125, -0.0625, 0.875, 3.375, 2.625], (1., 0.375, -0.125)),
        ("figmaSubpixel", [0.875, -0.1875, 0.125, 1.125, 2.625, 3.375], (1.3, -9.625, -6.375)),
        ("figma", [-1., 0., 0., 0.875, 67.375, 2.625], (0.75, 0.125, 0.625)),
    ] {
        for order in 0..3 {
            let doc = document(order, transform);
            let options = options(profile, camera.0, camera.1, camera.2);
            let mut candidate = engine(&doc);
            let full = candidate.compile_gpu(&options).unwrap();
            let mut reference = engine(&conservative_document(&doc));
            for crop in [Rect::new(0, 0, 17, 13), Rect::new(19, 11, 23, 19), Rect::new(61, 47, 19, 17)] {
                let regional = candidate.compile_gpu_region(&options, crop, None).unwrap();
                let old = reference.compile_gpu_region(&options, crop, None).unwrap();
                let source = source_region(&options, crop);
                assert_eq!(regional.extent, source.expand(2));
                assert_eq!(regional.coherent_samples, full.coherent_samples);
                assert_eq!(regional.integrated_blur, full.integrated_blur);
                assert_eq!(regional.color_management, full.color_management);
                for (id, node) in &regional.nodes {
                    let base = &full.nodes[id];
                    let (legacy_scene, legacy) = match old.nodes.get(id) {
                        Some(legacy) => (&old, legacy),
                        None => {
                            // Ancestor +2 guards can retain a child outside
                            // the old working extent. It has no legacy pixel
                            // to compare; still check its full-frame program.
                            assert!(node.rect.intersect(old.extent).empty());
                            (&full, base)
                        }
                    };
                    assert_eq!(node.matrix.0.map(f64::to_bits), base.matrix.0.map(f64::to_bits));
                    assert_eq!(node.inverse.0.map(f64::to_bits), base.inverse.0.map(f64::to_bits));
                    assert_eq!(node.effects, base.effects, "effect order {profile}, {order}, {id}");
                    assert_eq!(node.effects, legacy.effects);
                    assert_eq!((node.clip, &node.mask_id, &node.children), (base.clip, &base.mask_id, &base.children));
                    assert_eq!((node.opacity, &node.blend), (base.opacity, &base.blend));
                    // Compare the entire common dependency region, including
                    // filter input outside the output and clipped frame edges.
                    let common = node.rect.intersect(base.rect).intersect(legacy.rect);
                    for y in common.y..common.bottom() {
                        for x in common.x..common.right() {
                            for (a, b, c) in std::iter::once((&node.fill, &base.fill, &legacy.fill))
                                .chain(node.strokes.iter().zip(&base.strokes).zip(&legacy.strokes)
                                    .map(|((a, b), c)| (&a.path, &b.path, &c.path))) {
                                let actual = coverage_signature(&regional, a, x, y);
                                // Empty packed programs and zero coverage are
                                // equivalent; nonempty signatures retain all bits.
                                let normalize = |v: Vec<u64>| if v.iter().all(|v| *v == 0) { vec![] } else { v };
                                assert_eq!(normalize(actual.clone()), normalize(coverage_signature(&full, b, x, y)),
                                    "full coverage {profile}, order={order}, {id}, {x},{y}");
                                assert_eq!(normalize(actual), normalize(coverage_signature(legacy_scene, c, x, y)),
                                    "legacy coverage {profile}, order={order}, {id}, {x},{y}");
                            }
                            for effect in node.effects.iter().filter(|e| e.kind == "noise") {
                                assert_eq!(noise_signature(node, x, y, effect.amount), noise_signature(base, x, y, effect.amount));
                                assert_eq!(noise_signature(node, x, y, effect.amount), noise_signature(legacy, x, y, effect.amount));
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn pointwise_noise_full_cpu_pixels_equal_crops_with_nested_clips_and_effect_orders() {
    for (profile, zoom, x, y) in [("analytic", 1., 0.375, -0.125),
        ("figmaSubpixel", 1.3, -9.625, -6.375), ("figma", 0.75, 0.125, 0.625)] {
        for order in 0..3 {
            let doc = document(order, [1., 0.125, -0.0625, 0.875, 3.375, 2.625]);
            let mut e = engine(&doc);
            let options = options(profile, zoom, x, y);
            let full = e.render(&options).unwrap();
            assert!(full.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255));
            for (x, y, w, h) in [(0, 0, 17, 13), (19, 11, 23, 19), (61, 47, 19, 17)] {
                let actual = e.render_device_rect(&options, x, y, w, h).unwrap();
                let expected: Vec<u8> = (y..y + h).flat_map(|row| {
                    let start = (row * options.width + x) as usize * 4;
                    full[start..start + w as usize * 4].iter().copied()
                }).collect();
                assert_eq!(actual, expected, "{profile}, order={order}, crop={x},{y}");
            }
        }
    }
}

#[test]
fn texture_backdrops_and_unmanaged_noise_keep_global_support() {
    let crop = Rect::new(12, 9, 24, 20);
    let options = options("figmaSubpixel", 1., 0.375, -0.125);
    for kind in ["texture", "glass", "background-blur"] {
        let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
        doc["nodes"]["paint"]["effects"][0] = json!({"kind":kind,"radius":8,"amount":2,"color":"#000000"});
        let scene = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
        assert!(scene.extent.w > crop.expand(2).w, "{kind} stays conservative");
    }
    let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
    doc.as_object_mut().unwrap().remove("colorManagement");
    let scene = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
    assert!(scene.extent.w > crop.expand(2).w);
}

#[test]
fn noise_admission_refreshes_after_effect_patches_and_camera_reuse() {
    let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
    let mut retained = engine(&doc);
    for kind in ["noise", "texture", "noise", "background-blur", "noise"] {
        doc["nodes"]["sibling"]["effects"][0] = json!({"kind":kind,"radius":2,"amount":0.73,"opacity":0.37,"color":"#000000"});
        retained.apply_document_patch(&serde_json::from_value(json!({"nodes":{"sibling":doc["nodes"]["sibling"]},"fields":{}})).unwrap()).unwrap();
        for zoom in [1., 1.3, 1.] {
            let options = options("figmaSubpixel", zoom, 0.375, -0.125);
            let crop = Rect::new(0, 0, 32, 24);
            for guard in [Rect::new(-16, -16, 128, 96), Rect::new(-32, -32, 160, 128)] {
                let actual = retained.compile_gpu_region(&options, crop, Some(guard)).unwrap();
                let fresh = engine(&doc).compile_gpu_region(&options, crop, Some(guard)).unwrap();
                if kind == "noise" { assert_eq!(actual.extent, crop.expand(2)); }
                else { assert!(actual.extent.w > crop.expand(2).w); }
                assert_eq!(actual.into_packet().unwrap(), fresh.into_packet().unwrap());
            }
        }
    }
}


#[test]
fn noise_admission_and_padding_follow_page_switches_and_effect_insertions() {
    let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
    doc["pages"].as_array_mut().unwrap().push(json!({"id":"other","name":"other",
        "background":"#445566","children":["other-node"]}));
    doc["nodes"]["other-node"] = json!({"id":"other-node","kind":"rectangle",
        "width":200,"height":160,"transform":[1,0,0,1,-22.125,-31.375],
        "fills":[{"kind":"solid","color":"#bcd123"}],
        "effects":[noise(), {"kind":"blur","radius":21.75,"color":"#000000"}]});
    let mut retained = engine(&doc);
    let crop = Rect::new(-1, -1, 34, 26);
    for add_texture in [false, true, false] {
        doc["nodes"]["other-node"]["effects"] = json!([noise(),
            {"kind":"blur","radius":21.75,"color":"#000000"}]);
        if add_texture {
            doc["nodes"]["other-node"]["effects"].as_array_mut().unwrap().push(
                json!({"kind":"texture","amount":1.5,"color":"#000000"}));
        }
        retained.apply_document_patch(&serde_json::from_value(json!({"nodes":{
            "other-node":doc["nodes"]["other-node"]},"fields":{}})).unwrap()).unwrap();
        for page in ["p", "other", "p", "other"] {
            let mut options = options("figmaSubpixel", 1.3, 0.375, -0.125);
            options.page_id = page.into();
            let actual = retained.compile_gpu_region(&options, crop, None).unwrap();
            let fresh = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
            if add_texture && page=="other" { assert!(actual.extent.w > crop.expand(2).w); }
            else { assert_eq!(actual.extent, crop.expand(2)); }
            assert_eq!(actual.into_packet().unwrap(), fresh.into_packet().unwrap(),
                "page={page}, inserted texture={add_texture}");
        }
    }
}

#[test]
fn noise_hash_inputs_stay_stable_at_large_global_crop_coordinates() {
    let doc = json!({"schemaVersion":5,"id":"far-noise","name":"far noise",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","children":["n"],"background":"#778899"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":200,"height":160,
            "fills":[{"kind":"solid","color":"#abcd12"}],
            "effects":[noise(), {"kind":"blur","radius":1.75,"color":"#000000"}]}}});
    for origin in [-15_999_900, -8_388_600, -1_048_620, -1_048_600, -524_350,
        -524_300, 524_200, 524_250, 1_048_490, 1_048_510, 8_388_550, 15_999_900] {
        for profile in ["analytic", "figmaSubpixel", "figma"] {
            for zoom in [0.75, 1., 1.3, 2., 32.] {
                let options = options(profile, zoom, f64::from(origin) + 0.375, f64::from(origin) - 0.125);
                let crop = Rect::new(origin + 49, origin + 51, 17, 13);
                let regional = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
                let old = engine(&conservative_document(&doc)).compile_gpu_region(&options, crop, None).unwrap();
                let region = source_region(&options, crop);
                let guard = (3.5 * regional.nodes["n"].matrix.max_scale()).ceil() as i64 + 4;
                let certified = [region.x, region.y, region.right(), region.bottom()].iter()
                    .all(|v| i64::from(*v).abs() + guard <= 1_048_576);
                if certified { assert_eq!(regional.extent, region.expand(2)); }
                else {
                    assert_eq!(regional.extent, old.extent);
                    assert_eq!(regional.nodes["n"].rect, old.nodes["n"].rect);
                }
                for y in region.y..region.bottom() {
                    for x in region.x..region.right() {
                        assert_eq!(noise_signature(&regional.nodes["n"], x, y, 0.73),
                            noise_signature(&old.nodes["n"], x, y, 0.73),
                            "origin={origin}, profile={profile}, zoom={zoom}, pixel={x},{y}, regional={:?}, old={:?}",
                            regional.nodes["n"].rect, old.nodes["n"].rect);
                    }
                }
            }
        }
    }
}

#[test]
fn noise_with_fractional_shadow_or_non_solid_paint_retains_original_extents() {
    let base = json!({"schemaVersion":5,"id":"phase-fallback","name":"phase fallback",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","children":["n"],"background":"#778899"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":20,"height":20,
            "transform":[1,0,0,1,0.25,0.25],"fills":[{"kind":"solid","color":"#abcd12"}],
            "effects":[noise(), {"kind":"shadow","radius":0,"x":0.1,"opacity":1,"color":"#000000"}]}}});
    for profile in ["analytic", "figmaSubpixel", "figma"] {
        for gradient in [false, true] {
            let mut doc = base.clone();
            if gradient {
                doc["nodes"]["n"]["effects"][1]["x"] = json!(0);
                doc["nodes"]["n"]["effects"][1]["radius"] = json!(2);
                doc["nodes"]["n"]["fills"][0] = json!({"kind":"linear","color":"#abcdef","angle":37.25,
                    "stops":[{"offset":0,"color":"#123456"},{"offset":1,"color":"#abcdef"}]});
            }
            let options = options(profile, 1., 0., 0.);
            let crop = Rect::new(0, 0, 4, 4);
            let actual = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
            let old = engine(&conservative_document(&doc)).compile_gpu_region(&options, crop, None).unwrap();
            assert_eq!(actual.extent, old.extent);
            assert_eq!(serde_json::to_value(&actual.nodes["n"]).unwrap(),
                serde_json::to_value(&old.nodes["n"]).unwrap());
            assert_eq!(actual.curves.iter().map(|f| f.to_bits()).collect::<Vec<_>>(),
                old.curves.iter().map(|f| f.to_bits()).collect::<Vec<_>>());
            if !gradient {
                // Reproduce why the arbitrary-offset case cannot be admitted:
                // f32 subtraction changes a bilinear weight with crop origin.
                let p = 0.5_f32 - 0.1_f32;
                assert_ne!((p - -1_f32 - 0.5).fract().to_bits(),
                    (p - -3_f32 - 0.5).fract().to_bits());
            }
        }
    }
}


#[test]
fn noise_phase_certificate_refreshes_after_shadow_offset_and_paint_patches() {
    let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
    let mut retained = engine(&doc);
    let options = options("figmaSubpixel", 1.3, 0.375, -0.125);
    let crop = Rect::new(0, 0, 32, 24);
    for (offset, gradient) in [(0., false), (0.1, false), (0., false), (0., true), (0., false)] {
        doc["nodes"]["nested"]["effects"][1]["x"] = json!(offset);
        doc["nodes"]["nested"]["fills"][0] = if gradient {
            json!({"kind":"linear","color":"#abcdef","angle":37.25,
                "stops":[{"offset":0,"color":"#123456"},{"offset":1,"color":"#abcdef"}]})
        } else { json!({"kind":"solid","color":"#225588","opacity":0.4}) };
        retained.apply_document_patch(&serde_json::from_value(json!({"nodes":{
            "nested":doc["nodes"]["nested"]},"fields":{}})).unwrap()).unwrap();
        let actual = retained.compile_gpu_region(&options, crop, None).unwrap();
        let fresh = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
        if offset == 0. && !gradient { assert_eq!(actual.extent, crop.expand(2)); }
        else { assert!(actual.extent.w > crop.expand(2).w); }
        assert_eq!(actual.into_packet().unwrap(), fresh.into_packet().unwrap());
    }
}

#[test]
fn compiled_gradient_strokes_are_not_certified_by_their_paint_visibility_flag() {
    let mut doc = document(0, [1., 0., 0., 1., 3.375, 2.625]);
    doc["nodes"]["paint"]["strokes"][0]["paint"] = json!({"kind":"linear",
        "visible":false,"color":"#abcdef","angle":37.25,
        "stops":[{"offset":0,"color":"#123456"},{"offset":1,"color":"#abcdef"}]});
    let options = options("figmaSubpixel", 1.3, 0.375, -0.125);
    let crop = Rect::new(0, 0, 32, 24);
    let actual = engine(&doc).compile_gpu_region(&options, crop, None).unwrap();
    let old = engine(&conservative_document(&doc)).compile_gpu_region(&options, crop, None).unwrap();
    assert_eq!(actual.nodes["paint"].strokes.len(), 1);
    assert_eq!(actual.extent, old.extent);
    assert_eq!(serde_json::to_value(&actual.nodes).unwrap(), serde_json::to_value(&old.nodes).unwrap());
}
