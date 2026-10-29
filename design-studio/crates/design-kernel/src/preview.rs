use crate::{RenderOptions, View};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub width: u32,
    pub height: u32,
    pub offset_x: f64,
    pub offset_y: f64,
    pub scale: f64,
}
pub struct Plan {
    pub source: RenderOptions,
    pub presentation: Presentation,
}

pub fn plan(options: &RenderOptions) -> Result<Plan, String> {
    let density = options
        .pixel_preview
        .ok_or("Missing pixel preview density")?;
    if ![1, 2].contains(&density)
        || ![options.view.x, options.view.y, options.view.zoom]
            .iter()
            .all(|v| v.is_finite())
        || !(0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&options.view.zoom)
        || options.width == 0
        || options.height == 0
        || options.width > 8192
        || options.height > 8192
        || u64::from(options.width) * u64::from(options.height) > 8_388_608
    {
        return Err("Invalid pixel preview options".into());
    }
    let density = f64::from(density);
    let scale = options.view.zoom / density;
    if scale < 1. / 64. {
        return Err("像素预览缩小范围过大，请放大画布".into());
    }
    let left = (-options.view.x / scale).floor();
    let top = (-options.view.y / scale).floor();
    let right = ((f64::from(options.width) - options.view.x) / scale).ceil();
    let bottom = ((f64::from(options.height) - options.view.y) / scale).ceil();
    let width = right - left;
    let height = bottom - top;
    if width < 1.
        || height < 1.
        || width > 8192.
        || height > 8192.
        || width * height > 8_388_608.
        || left.abs() > 1e9
        || top.abs() > 1e9
    {
        return Err("像素预览范围超过当前像素预算，请放大画布".into());
    }
    Ok(Plan {
        source: RenderOptions {
            page_id: options.page_id.clone(),
            width: width as u32,
            height: height as u32,
            view: View {
                x: -left,
                y: -top,
                zoom: density,
            },
            transparent: options.transparent,
            grid: options.grid,
            pixel_preview: None,
            animation: options.animation.clone(),
            interactive_effects: options.interactive_effects,
            checkerboard: options.checkerboard,
            raster_profile: options.raster_profile,
        },
        presentation: Presentation {
            width: options.width,
            height: options.height,
            offset_x: options.view.x + left * scale,
            offset_y: options.view.y + top * scale,
            scale,
        },
    })
}

/// Source pixels are fixed to document coordinates. Magnification uses nearest
/// sampling; minification integrates premultiplied pixels to avoid dropping fine
/// lines. The source and output budgets are validated by plan/render.
pub fn resample(bytes: &[u8], plan: &Plan) -> Vec<u8> {
    let p = &plan.presentation;
    let mut out = vec![0; p.width as usize * p.height as usize * 4];
    let width = plan.source.width as i32;
    let height = plan.source.height as i32;
    for y in 0..p.height {
        for x in 0..p.width {
            let dst = (y as usize * p.width as usize + x as usize) * 4;
            if p.scale >= 1. {
                let sx = ((f64::from(x) + 0.5 - p.offset_x) / p.scale).floor() as i32;
                let sy = ((f64::from(y) + 0.5 - p.offset_y) / p.scale).floor() as i32;
                if sx >= 0 && sy >= 0 && sx < width && sy < height {
                    let src = (sy as usize * width as usize + sx as usize) * 4;
                    out[dst..dst + 4].copy_from_slice(&bytes[src..src + 4]);
                }
            } else {
                // Match the portable RGBA8 presentation surface: integrate
                // premultiplied bytes, quantize once, then unpremultiply. Doing
                // division before attachment quantization changes edge colors
                // and leaves invisible RGB under zero alpha.
                let scale = p.scale as f32;
                let x0 = (x as f32 - p.offset_x as f32) / scale;
                let y0 = (y as f32 - p.offset_y as f32) / scale;
                let x1 = (x as f32 + 1. - p.offset_x as f32) / scale;
                let y1 = (y as f32 + 1. - p.offset_y as f32) / scale;
                let mut sum = [0_u32; 4];
                // Difference of quantized CDF endpoints makes axis weights
                // telescope to exactly 4096. The 2D byte sum fits u32:
                // 255 * 4096² = 4_278_190_080 < u32::MAX.
                let cdf = |edge: f32, lo: f32| {
                    ((edge - lo) * scale)
                        .clamp(0., 1.)
                        .mul_add(4096., 0.)
                        .round_ties_even() as u32
                };
                for sy in (y0.floor() as i32).max(0)..(y1.ceil() as i32).min(height) {
                    for sx in (x0.floor() as i32).max(0)..(x1.ceil() as i32).min(width) {
                        let weight = (cdf(sx as f32 + 1., x0) - cdf(sx as f32, x0))
                            * (cdf(sy as f32 + 1., y0) - cdf(sy as f32, y0));
                        let src = (sy as usize * width as usize + sx as usize) * 4;
                        let alpha = u32::from(bytes[src + 3]);
                        for c in 0..3 {
                            let premultiplied = (u32::from(bytes[src + c]) * alpha + 127) / 255;
                            sum[c] += premultiplied * weight;
                        }
                        sum[3] += alpha * weight;
                    }
                }
                let channels = sum.map(|v| {
                    let q = v >> 24;
                    let r = v & 0x00ff_ffff;
                    q + u32::from(r > 0x0080_0000 || (r == 0x0080_0000 && q % 2 == 1))
                });
                if channels[3] > 0 {
                    for c in 0..3 {
                        out[dst + c] = ((channels[c] * 255 * 2 + channels[3]) / (channels[3] * 2))
                            .min(255) as u8;
                    }
                }
                out[dst + 3] = channels[3] as u8;
            }
        }
    }
    out
}

/// Pixel preview in the same premultiplied linear working space as the scene.
/// Quantization/display encoding happens only after this resolve.
pub fn resample_linear(pixels: &[crate::blend::Pixel], plan: &Plan) -> Vec<crate::blend::Pixel> {
    use crate::blend::Pixel;
    let p = &plan.presentation;
    let at = |x: i32, y: i32| -> Pixel {
        if x < 0 || y < 0 || x >= plan.source.width as i32 || y >= plan.source.height as i32 {
            Pixel::default()
        } else {
            pixels[y as usize * plan.source.width as usize + x as usize]
        }
    };
    let mut out = Vec::with_capacity(p.width as usize * p.height as usize);
    for y in 0..p.height {
        for x in 0..p.width {
            if p.scale >= 1. {
                out.push(at(
                    ((f64::from(x) + 0.5 - p.offset_x) / p.scale).floor() as i32,
                    ((f64::from(y) + 0.5 - p.offset_y) / p.scale).floor() as i32,
                ));
                continue;
            }
            let lo = [
                (f64::from(x) - p.offset_x) / p.scale,
                (f64::from(y) - p.offset_y) / p.scale,
            ];
            let hi = [
                (f64::from(x + 1) - p.offset_x) / p.scale,
                (f64::from(y + 1) - p.offset_y) / p.scale,
            ];
            let mut value = [0.; 4];
            for sy in lo[1].floor() as i32..hi[1].ceil() as i32 {
                for sx in lo[0].floor() as i32..hi[0].ceil() as i32 {
                    let w = ((hi[0].min(f64::from(sx + 1)) - lo[0].max(f64::from(sx))).max(0.)
                        * (hi[1].min(f64::from(sy + 1)) - lo[1].max(f64::from(sy))).max(0.)
                        * p.scale
                        * p.scale) as f32;
                    let sample = at(sx, sy);
                    for (c, value) in value.iter_mut().enumerate() {
                        *value += sample.0[c] * w;
                    }
                }
            }
            out.push(Pixel(value));
        }
    }
    out
}
