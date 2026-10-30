use super::*;
fn legacy_channel(b: f32, s: f32, mode: &str) -> f32 {
    match mode {
        "multiply" => b * s,
        "screen" => b + s - b * s,
        "overlay" => {
            if b <= 0.5 {
                2. * b * s
            } else {
                1. - 2. * (1. - b) * (1. - s)
            }
        }
        "darken" => b.min(s),
        "lighten" => b.max(s),
        "color-dodge" => {
            if b <= 0. {
                0.
            } else if s >= 1. {
                1.
            } else {
                (b / (1. - s)).min(1.)
            }
        }
        "color-burn" => {
            if b >= 1. {
                1.
            } else if s <= 0. {
                0.
            } else {
                1. - ((1. - b) / s).min(1.)
            }
        }
        "hard-light" => {
            if s <= 0.5 {
                2. * b * s
            } else {
                1. - 2. * (1. - b) * (1. - s)
            }
        }
        "soft-light" => {
            if s <= 0.5 {
                b - (1. - 2. * s) * b * (1. - b)
            } else {
                let d = if b <= 0.25 {
                    ((16. * b - 12.) * b + 4.) * b
                } else {
                    b.sqrt()
                };
                b + (2. * s - 1.) * (d - b)
            }
        }
        "difference" => (b - s).abs(),
        "exclusion" => b + s - 2. * b * s,
        _ => s,
    }
}
// W3C Compositing and Blending Level 1, source-over with premultiplied storage.
// https://www.w3.org/TR/compositing-1/#blending
fn legacy_over(dst: Pixel, src: Pixel, mode: &str) -> Pixel {
    if src.0[3] <= 0. {
        return dst;
    }
    if dst.0[3] <= 0. {
        return src;
    }
    if mode == "normal" {
        let inverse = 1. - src.0[3];
        return Pixel(std::array::from_fn(|i| src.0[i] + dst.0[i] * inverse));
    }
    let b = dst.rgb();
    let s = src.rgb();
    let mixed = match mode {
        "hue" => set_lum(set_sat(s, sat(b)), lum(b)),
        "saturation" => set_lum(set_sat(b, sat(s)), lum(b)),
        "color" => set_lum(s, lum(b)),
        "luminosity" => set_lum(b, lum(s)),
        // Figma blend types 17/18:
        // linear-burn = max(0, backdrop + source - 1) per channel in
        // premultiplied space; linear-dodge = min(1, backdrop + source).
        "linear-burn" => [
            (b[0] + s[0] - 1.).max(0.),
            (b[1] + s[1] - 1.).max(0.),
            (b[2] + s[2] - 1.).max(0.),
        ],
        "linear-dodge" => [
            (b[0] + s[0]).min(1.),
            (b[1] + s[1]).min(1.),
            (b[2] + s[2]).min(1.),
        ],
        _ => [
            legacy_channel(b[0], s[0], mode),
            legacy_channel(b[1], s[1], mode),
            legacy_channel(b[2], s[2], mode),
        ],
    };
    let sa = src.0[3];
    let da = dst.0[3];
    Pixel([
        src.0[0] * (1. - da) + sa * da * mixed[0] + dst.0[0] * (1. - sa),
        src.0[1] * (1. - da) + sa * da * mixed[1] + dst.0[1] * (1. - sa),
        src.0[2] * (1. - da) + sa * da * mixed[2] + dst.0[2] * (1. - sa),
        sa + da * (1. - sa),
    ])
}

#[test]
fn parsed_modes_preserve_all_original_float_words() {
    let modes=["normal","multiply","screen","overlay","darken","lighten","color-dodge","color-burn","hard-light","soft-light","difference","exclusion","hue","saturation","color","luminosity","linear-burn","linear-dodge","unknown"];
    let mut seed=7_u32;
    for mode in modes {
        let parsed=BlendMode::from_name(mode);
        for _ in 0..3000 {
            let mut value=||{seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);(seed>>8) as f32/(1_u32<<24) as f32};
            let a=Pixel::rgba(value()*2.,value()*2.,value()*2.,value());let b=Pixel::rgba(value()*2.,value()*2.,value()*2.,value());
            assert_eq!(over_mode(a,b,parsed).0.map(f32::to_bits),legacy_over(a,b,mode).0.map(f32::to_bits));
            assert_eq!(over_mode(a,Pixel::default(),parsed).0.map(f32::to_bits),legacy_over(a,Pixel::default(),mode).0.map(f32::to_bits));
        }
    }
}
#[test]
fn row_composite_keeps_clip_bounds_mask_order_and_exact_pixels() {
    for mode in ["normal","multiply","hue","linear-burn","unknown"] {
        let mut target=Surface::new(Rect::new(-9,-3,27,21)).unwrap();
        let mut source=Surface::new(Rect::new(-2,-8,13,19)).unwrap();
        for (i,p) in target.pixels.iter_mut().enumerate(){*p=Pixel::rgba(0.2,0.3,0.7,(i%7) as f32/7.)}
        for (i,p) in source.pixels.iter_mut().enumerate(){*p=Pixel::rgba(0.8,0.4,0.1,(i%5) as f32/5.)}
        let mut expected=target.try_clone().unwrap();let r=target.rect.intersect(source.rect);let calls=std::cell::RefCell::new(Vec::new());
        for y in r.y..r.bottom(){for x in r.x..r.right(){let i=expected.rect.index(x,y).unwrap();let mask=(x+y).rem_euclid(5) as f32/5.;let opacity=0.73*mask;expected.pixels[i]=legacy_over(expected.pixels[i],source.at(x,y).opacity(opacity),mode);}}
        target.composite(&source,mode,0.73,|x,y|{calls.borrow_mut().push((x,y));(x+y).rem_euclid(5) as f32/5.});
        assert_eq!(*calls.borrow(),(r.y..r.bottom()).flat_map(|y|(r.x..r.right()).map(move|x|(x,y))).collect::<Vec<_>>());
        assert_eq!(target.pixels.iter().map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>(),expected.pixels.iter().map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>());
        let empty=Surface::new(Rect::new(100,100,1,1)).unwrap();target.composite(&empty,mode,1.,|_,_|panic!("empty clip"));
    }
}

#[test]
fn byte_composite_and_interpolation_rows_keep_exact_offset_arithmetic() {
    for byte in [false,true] {
        let mut target=Surface::new(Rect::new(-3,5,19,17)).unwrap();let mut source=Surface::new(Rect::new(0,0,15,19)).unwrap();
        for (i,p) in target.pixels.iter_mut().enumerate(){*p=Pixel::rgba(0.2,0.4,0.7,(i%11) as f32/11.).rgba8_quantized()}
        for (i,p) in source.pixels.iter_mut().enumerate(){*p=Pixel::rgba(0.6,0.3,0.1,(i%7) as f32/7.).rgba8_quantized()}
        let base=target.try_clone().unwrap();let mut expected=target.try_clone().unwrap();let r=target.rect.intersect(source.rect);
        let factor=|x:i32,y:i32|(x*3+y).rem_euclid(9) as f32/9.;
        for y in r.y..r.bottom(){for x in r.x..r.right(){let i=expected.rect.index(x,y).unwrap();expected.pixels[i]=expected.pixels[i].interpolate(source.at(x,y),factor(x,y),byte);}}
        target.interpolate(&source,factor,byte);
        assert_eq!(target.pixels.iter().map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>(),expected.pixels.iter().map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>());
        target=base.try_clone().unwrap();expected=base;
        for y in r.y..r.bottom(){for x in r.x..r.right(){let i=expected.rect.index(x,y).unwrap();expected.pixels[i]=expected.pixels[i].over_rgba8(source.at(x,y),0.63*factor(x,y));}}
        target.composite_rgba8(&source,0.63,factor);
        assert_eq!(target.pixels.iter().map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>(),expected.pixels.iter().map(|p|p.0.map(f32::to_bits)).collect::<Vec<_>>());
    }
}
