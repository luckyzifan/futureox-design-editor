use super::*;
    fn legacy_from_working(settings: &ColorSettings, rgb: [f64; 3], space: ColorSpace) -> [f64; 3] {
        if space == ColorSpace::LinearSrgb {
            return rgb;
        }
        if space == ColorSpace::Srgb {
            return rgb.map(srgb_encode);
        }
        let mut xyz = mul(SRGB, rgb);
        if d50(space) {
            xyz = mul(inverse(D50_TO_D65), xyz);
        }
        let mut v = mul(inverse(matrix(space)), xyz);
        if space == ColorSpace::Pq {
            v = v.map(|c| c * settings.reference_white_nits / 10000.);
        }
        if space == ColorSpace::Hlg {
            v = v.map(|c| c * settings.reference_white_nits / settings.peak_luminance_nits);
            let y = mul(REC2020, v)[1].max(0.);
            let gamma = 1.2 + 0.42 * (settings.peak_luminance_nits / 1000.).log10();
            let gain = if y > 0. { y.powf(1. / gamma - 1.) } else { 0. };
            v = v.map(|c| c * gain);
        }
        v.map(|c| encode(c, space))
    }

    fn legacy_output(settings: &ColorSettings, p: Pixel, out: ColorOutput) -> [f32; 4] {
        let mut rgb = p.rgb().map(f64::from);
        // Reinhard et al. (2002), equation 4, global white-point operator.
        // https://www-old.cs.utah.edu/docs/techreports/2002/pdf/UUCS-02-001.pdf
        // No automatic exposure or local dodging/burning is implied here.
        if out.tone_map == ToneMap::Reinhard {
            let y = mul(SRGB, rgb)[1].max(0.);
            let white = settings.peak_luminance_nits / settings.reference_white_nits;
            let gain = (1. + y / (white * white)) / (1. + y);
            rgb = rgb.map(|c| c * gain);
        }
        let mut v = legacy_from_working(settings, rgb, out.space);
        if out.tone_map != ToneMap::None {
            v = v.map(|c| c.clamp(0., 1.));
        }
        [v[0] as f32, v[1] as f32, v[2] as f32, p.0[3].clamp(0., 1.)]
    }
#[test]
fn prepared_output_matches_original_word_for_word() {
    let spaces=[ColorSpace::Srgb,ColorSpace::LinearSrgb,ColorSpace::DisplayP3,ColorSpace::LinearP3,
        ColorSpace::Rec2020,ColorSpace::LinearRec2020,ColorSpace::A98,ColorSpace::ProPhoto,ColorSpace::XyzD50,ColorSpace::XyzD65];
    let values=[-2.,-0.25,-0.0,0.,0.0031308,0.04045,0.125,0.5,1.,2.];
    for settings in [ColorSettings::default(),ColorSettings{document_space:ColorSpace::DisplayP3,reference_white_nits:100.,peak_luminance_nits:400.}] {
        for space in spaces {
            let transform=settings.prepare_from_working(space);
            for &r in &values {for &g in &values {for &b in &values {
                let rgb=[r,g,b];assert_eq!(transform.apply(rgb).map(f64::to_bits),legacy_from_working(&settings,rgb,space).map(f64::to_bits));
                for tone_map in [ToneMap::Clip,ToneMap::None,ToneMap::Reinhard] {
                    let output=ColorOutput{space,tone_map};let prepared=settings.prepare_output(output);
                    for alpha in [0.,1e-11,0.125,0.7,1.] {
                        let pixel=Pixel::rgba(r as f32,g as f32,b as f32,alpha);
                        assert_eq!(prepared.apply(pixel).map(f32::to_bits),legacy_output(&settings,pixel,output).map(f32::to_bits));
                    }
                }
            }}}
        }
    }
}
