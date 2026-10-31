use super::*;

fn legacy_to_working(
    image: &mut Rgba32FImage,
    settings: ColorSettings,
    space: Option<ColorSpace>,
    icc: Option<&[u8]>,
) -> Result<(), String> {
    if space.is_none()
        && let Some(icc) = icc
    {
        use moxcms::{
            ColorProfile, DataColorSpace, Layout, ParsingOptions, ToneReprCurve, TransformOptions,
        };
        let source = ColorProfile::new_from_slice_with_options(
            icc,
            ParsingOptions {
                max_profile_size: 4 * 1024 * 1024,
                max_allowed_clut_size: 4 * 1024 * 1024,
                max_allowed_trc_size: 40000,
            },
        )
        .map_err(|e| format!("Invalid ICC profile: {e}"))?;
        if source.color_space != DataColorSpace::Rgb {
            return Err("ICC source must be RGB; CMYK/Gray need a matching decoder layout".into());
        }
        if source.cicp.is_some_and(|c| {
            matches!(
                c.transfer_characteristics,
                moxcms::TransferCharacteristics::Smpte2084 | moxcms::TransferCharacteristics::Hlg
            )
        }) {
            return Err(
                "HDR ICC luminance normalization is not defined; import a cICP-tagged PQ/HLG PNG"
                    .into(),
            );
        }
        let mut target = ColorProfile::new_srgb();
        let linear = Some(ToneReprCurve::Parametric(vec![1.]));
        target.red_trc = linear.clone();
        target.green_trc = linear.clone();
        target.blue_trc = linear;
        target.cicp = None;
        let transform = source
            .create_transform_f32(
                Layout::Rgba,
                &target,
                Layout::Rgba,
                TransformOptions {
                    prefer_fixed_point: false,
                    allow_extended_range_rgb_xyz: true,
                    ..Default::default()
                },
            )
            .map_err(|e| format!("Unsupported ICC transform: {e}"))?;
        let stride = image.width() as usize * 4;
        let mut row = vec![0_f32; stride];
        for pixels in image.as_mut().chunks_exact_mut(stride) {
            transform
                .transform(pixels, &mut row)
                .map_err(|e| e.to_string())?;
            pixels.copy_from_slice(&row);
        }
    } else {
        for p in image.pixels_mut() {
            let rgb = settings.to_working(
                [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])],
                space.unwrap_or(ColorSpace::Srgb),
            );
            for i in 0..3 {
                p[i] = rgb[i] as f32;
            }
        }
    }
    if image
        .as_raw()
        .iter()
        .any(|v| !v.is_finite() || v.abs() > 65504.)
    {
        return Err("Decoded image exceeds finite float16 color range".into());
    }
    Ok(())
}

#[test]
fn prepared_colour_matches_original_float_bits_and_reuses_icc() {
    let settings=ColorSettings::default();
    let icc=moxcms::ColorProfile::new_display_p3().encode().unwrap();
    let samples=vec![0.,0.01,0.5,0.25, 1.,0.75,0.125,1., -0.,0.2,0.9,0.];
    for space in [None,Some(ColorSpace::Srgb),Some(ColorSpace::DisplayP3),Some(ColorSpace::LinearSrgb),Some(ColorSpace::Pq),Some(ColorSpace::Hlg)] {
        for profile in [None,Some(icc.as_slice())] {
            let start=icc_preparations();
            let mut prepared=WorkingTransform::new(settings,space,profile).unwrap();
            for _ in 0..3 {
                let mut expected=Rgba32FImage::from_raw(3,1,samples.clone()).unwrap();let mut actual=expected.clone();
                legacy_to_working(&mut expected,settings,space,profile).unwrap();prepared.apply(&mut actual).unwrap();
                assert_eq!(actual.as_raw().iter().map(|v|v.to_bits()).collect::<Vec<_>>(),expected.as_raw().iter().map(|v|v.to_bits()).collect::<Vec<_>>());
            }
            assert_eq!(icc_preparations()-start,usize::from(space.is_none()&&profile.is_some()));
        }
    }
}
#[test]
fn prepared_colour_keeps_profile_precedence_and_invalid_sample_failures() {
    let settings=ColorSettings::default();
    assert!(WorkingTransform::new(settings,None,Some(b"invalid")).is_err());
    assert!(WorkingTransform::new(settings,Some(ColorSpace::Srgb),Some(b"invalid")).is_ok());
    for value in [f32::NAN,f32::INFINITY,100000.] {
        let mut a=Rgba32FImage::from_raw(1,1,vec![value,0.,0.,1.]).unwrap();let mut b=a.clone();
        assert_eq!(legacy_to_working(&mut a,settings,Some(ColorSpace::LinearSrgb),None).unwrap_err(),WorkingTransform::new(settings,Some(ColorSpace::LinearSrgb),None).unwrap().apply(&mut b).unwrap_err());
    }
}
