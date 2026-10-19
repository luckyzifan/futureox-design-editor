use futureox_design_kernel::{
    Engine, RenderOptions,
    blend::Pixel,
    color::{ColorOutput, ColorSettings, ColorSpace, ToneMap},
};
fn close(a: f64, b: f64, t: f64) {
    assert!((a - b).abs() <= t, "{a} != {b}");
}
#[test]
fn unmanaged_srgb_alpha_preserves_encoded_channels_and_multiplies_opacity_once() {
    use futureox_design_kernel::color::{unmanaged_straight, pixel};
    assert_eq!(unmanaged_straight("color(srgb 0.2 0.4 0.8 / 0.25)").unwrap(), [0.2, 0.4, 0.8, 0.25]);
    assert_eq!(pixel(None, "color(srgb 0.2 0.4 0.8 / 0.25)", 0.5).unwrap().0, [0.025, 0.05, 0.1, 0.125]);
    for value in ["color(display-p3 1 0 0 / 0.5)", "color(srgb-linear 1 0 0)",
        "color(srgb 2 0 0)", "color(srgb -0.1 0 0)", "color(srgb 1 0 0 / NaN)"] {
        assert!(unmanaged_straight(value).is_err(), "{value}");
    }
}
#[test]
fn standard_transfer_and_reference_white_anchors() {
    let c = ColorSettings::default();
    close(
        futureox_design_kernel::color::srgb_decode(0.5),
        0.21404114048223255,
        1e-12,
    );
    let pq = c.from_working([1.; 3], ColorSpace::Pq);
    close(pq[0], 0.5806888810416109, 1e-9);
    for v in c.to_working([1.; 3], ColorSpace::Pq) {
        close(v, 10000. / 203., 1e-9);
    }
    let hlg = c.to_working([0.75; 3], ColorSpace::Hlg);
    close(hlg[1] * 203., 203.152145, 1e-4);
    assert_eq!(
        c.parse("color(srgb-linear 4 -0.2 0.5 / 0.25)", 1.)
            .unwrap()
            .0,
        [1., -0.05, 0.125, 0.25]
    );
}
#[test]
fn gamut_and_white_adaptation_roundtrips_do_not_clip() {
    let c = ColorSettings::default();
    let red = c.to_working([1., 0., 0.], ColorSpace::DisplayP3);
    close(red[0], 1.224940176, 1e-8);
    close(red[1], -0.042056955, 1e-8);
    for space in [
        ColorSpace::Srgb,
        ColorSpace::DisplayP3,
        ColorSpace::Rec2020,
        ColorSpace::A98,
        ColorSpace::ProPhoto,
        ColorSpace::Pq,
        ColorSpace::Hlg,
    ] {
        let input = [0.1, 0.5, 0.9];
        let output = c.from_working(c.to_working(input, space), space);
        for i in 0..3 {
            close(input[i], output[i], 2e-7);
        }
    }
    let d50 = [0.3457 / 0.3585, 1., (1. - 0.3457 - 0.3585) / 0.3585];
    for v in c.to_working(d50, ColorSpace::XyzD50) {
        close(v, 1., 2e-6);
    }
}
pub fn fixture() -> (String, RenderOptions) {
    let doc=serde_json::json!({"schemaVersion":3,"colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},"id":"hdr","name":"HDR","pages":[{"id":"p","name":"Page","children":["red","blue"],"background":"#000000"}],"nodes":{
        "red":{"id":"red","kind":"rectangle","width":12,"height":12,"fills":[{"kind":"solid","color":"color(srgb-linear 4 0 0)"}]},
        "blue":{"id":"blue","kind":"rectangle","width":12,"height":12,"opacity":0.5,"fills":[{"kind":"solid","color":"color(srgb-linear 0 0 2)"}]}
    }}).to_string();
    let opts=serde_json::from_value(serde_json::json!({"pageId":"p","width":16,"height":16,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figma"})).unwrap();
    (doc, opts)
}
#[test]
fn renderer_composites_in_linear_light_without_clipping_hdr() {
    let (doc, opts) = fixture();
    let mut e = Engine::new();
    e.load_document(&doc).unwrap();
    let p = e.render_linear(&opts).unwrap()[5 * 16 + 5];
    assert_eq!(p.0, [2., 0., 1., 1.]);
    let png = e
        .render_color_png(
            &opts,
            ColorOutput {
                space: ColorSpace::Pq,
                tone_map: ToneMap::None,
            },
        )
        .unwrap();
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let mut reader = decoder.read_info().unwrap();
    assert_eq!(reader.info().bit_depth, png::BitDepth::Sixteen);
    let mut bytes = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut bytes).unwrap();
    let i = (5 * 16 + 5) * 8;
    let encoded = std::array::from_fn(|k| {
        f64::from(u16::from_be_bytes([bytes[i + k * 2], bytes[i + k * 2 + 1]])) / 65535.
    });
    let recovered = ColorSettings::default().to_working(encoded, ColorSpace::Pq);
    for (i, value) in recovered.iter().enumerate() {
        close(*value, f64::from(p.0[i]), 0.001);
    }
}
#[test]
fn malformed_colors_and_old_schema_are_rejected() {
    let c = ColorSettings::default();
    for color in [
        "color(rec2100-pq -1 0 0)",
        "color(srgb NaN 0 0)",
        "color(display-p3 1 0 0 / 2)",
        "color(unknown 1 0 0)",
        "color(srgb 1 0)",
    ] {
        assert!(c.parse(color, 1.).is_err());
    }
    let (doc, _) = fixture();
    let mut v: serde_json::Value = serde_json::from_str(&doc).unwrap();
    v["schemaVersion"] = 2.into();
    assert!(Engine::new().load_document(&v.to_string()).is_err());
}
#[test]
fn linear_blur_preserves_hdr_energy_and_negative_gamut_components() {
    let mut s = futureox_design_kernel::blend::Surface::new(
        futureox_design_kernel::math::Rect::new(0, 0, 31, 31),
    )
    .unwrap();
    s.pixels[15 * 31 + 15] = Pixel([8., -2., 4., 1.]);
    let b = futureox_design_kernel::effects::linear_tent_blur(&s, 4.25, false).unwrap();
    for (ch, expected) in [8., -2., 4., 1.].iter().enumerate() {
        close(
            b.pixels.iter().map(|p| f64::from(p.0[ch])).sum(),
            *expected,
            1e-6,
        );
    }
}

#[test]
fn png_hdr_and_rgb_icc_inputs_are_converted_before_sampling() {
    use base64::Engine as _;
    let settings = ColorSettings::default();
    let pixels = [Pixel([2., 1., 0.5, 1.])];
    let encoded = futureox_design_kernel::export::encode_color_png(
        1,
        1,
        &pixels,
        settings,
        ColorOutput {
            space: ColorSpace::Pq,
            tone_map: ToneMap::None,
        },
    )
    .unwrap();
    let uri = |bytes: &[u8]| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    };
    let mut images = futureox_design_kernel::paint::Images::default();
    images.set_color_settings(Some(settings));
    let image = images.image(&uri(&encoded)).unwrap();
    for i in 0..4 {
        close(
            f64::from(image.pixels[0].0[i]),
            f64::from(pixels[0].0[i]),
            0.001,
        );
    }
    let profile = moxcms::ColorProfile::new_display_p3().encode().unwrap();
    let mut info = png::Info::with_size(1, 1);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Eight;
    info.icc_profile = Some(std::borrow::Cow::Owned(profile));
    let mut bytes = Vec::new();
    {
        let mut writer = png::Encoder::with_info(&mut bytes, info)
            .unwrap()
            .write_header()
            .unwrap();
        writer.write_image_data(&[255, 0, 0, 128]).unwrap();
        writer.finish().unwrap();
    }
    let image = images.image(&uri(&bytes)).unwrap();
    let p = image.pixels[0];
    let expected = settings.to_working([1., 0., 0.], ColorSpace::DisplayP3);
    for (i, value) in expected.iter().enumerate() {
        close(f64::from(p.0[i]), value * 128. / 255., 0.001);
    }
    close(f64::from(p.0[3]), 128. / 255., 1e-6);
}

#[test]
fn managed_animation_interpolates_light_and_metadata_undo_is_atomic() {
    use futureox_design_kernel::{
        animation::{Pose, Sample},
        editing::{DocumentEditor, DocumentPatch},
        scene::Document,
    };
    let (json, _) = fixture();
    let mut doc: Document = serde_json::from_str(&json).unwrap();
    let a = Pose::from(&doc.nodes["red"]);
    let mut b = a.clone();
    b.fills[0].color = "color(srgb-linear 0 0 2)".into();
    doc.animations=serde_json::from_value(serde_json::json!([{"id":"clip","name":"HDR","pageId":"p","durationMs":1000,"tracks":[{"nodeId":"red","keyframes":[{"timeMs":0,"value":a},{"timeMs":1000,"value":b}]}]}])).unwrap();
    let (sample, _) = futureox_design_kernel::animation::sample(
        &doc,
        &Sample {
            clip_id: "clip".into(),
            time_ms: 500.,
        },
    )
    .unwrap();
    let color = doc
        .color_management
        .unwrap()
        .parse(&sample.nodes["red"].fills[0].color, 1.)
        .unwrap();
    assert_eq!(color.0, [2., 0., 1., 1.]);
    let mut next = doc.clone();
    next.color_management.as_mut().unwrap().document_space = ColorSpace::DisplayP3;
    let mut editor = DocumentEditor::new(doc.clone()).unwrap();
    editor
        .apply(0, DocumentPatch::between(&doc, &next).unwrap())
        .unwrap();
    assert_eq!(editor.document(), &next);
    editor.undo().unwrap();
    assert_eq!(editor.document(), &doc);
    editor.redo().unwrap();
    assert_eq!(editor.document(), &next);
}

#[test]
fn float_tiling_and_pixel_preview_preserve_values_above_sdr() {
    let (doc, mut options) = fixture();
    let mut e = Engine::new();
    e.load_document(&doc).unwrap();
    options.width = 1050;
    options.view.x = 506.;
    let tiled = e.render_linear(&options).unwrap();
    options.width = 32;
    options.view.x = 6.;
    let small = e.render_linear(&options).unwrap();
    for y in 0..16usize {
        for x in 0..32usize {
            assert_eq!(tiled[y * 1050 + x + 500], small[y * 32 + x]);
        }
    }
    options.pixel_preview = Some(2);
    let preview = e.render_linear(&options).unwrap();
    assert!(preview.iter().any(|p| p.0[0] > 1.));
}

#[test]
fn generated_icc_header_is_canonical_across_native_and_wasm_clocks() {
    let profile =
        futureox_design_kernel::export::canonical_icc(&moxcms::ColorProfile::new_display_p3())
            .unwrap();
    assert_eq!(&profile[24..36], &[7, 208, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
    let parsed = moxcms::ColorProfile::new_from_slice(&profile).unwrap();
    assert_eq!(parsed.creation_date_time.year, 2000);
    assert_eq!(
        futureox_design_kernel::export::canonical_icc(&parsed).unwrap(),
        profile
    );
}
