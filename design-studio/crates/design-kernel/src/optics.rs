//! Continuous rounded-rectangle glass geometry. The shared field contains
//! displacement and scalar illumination, never sampled or rendered colours.
//! Each backend still reads and composites its own backdrop. Nonuniform
//! corners, smoothing and arbitrary paths retain the distance-field path.
use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    scene::{GlassParameters, Node},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GlassShape {
    pub size: [f64; 2],
    pub radius: f64,
}
impl GlassShape {
    pub fn from_node(node: &Node) -> Option<Self> {
        (matches!(node.kind.as_str(), "rectangle" | "frame")
            && node.network.is_none()
            && node.derived_path.is_none()
            && node.smoothing == 0.
            && node.radii.iter().all(|r| *r == node.radii[0]))
        .then_some(Self {
            size: [node.width, node.height],
            radius: node.radii[0].min(node.width.min(node.height) * 0.5),
        })
    }
    pub fn validate(self) -> Result<(), String> {
        if self.size.iter().any(|v| !v.is_finite() || *v <= 0.)
            || !self.radius.is_finite()
            || self.radius < 0.
            || self.radius > self.size[0].min(self.size[1]) * 0.5
        {
            return Err("Invalid analytic glass shape".into());
        }
        Ok(())
    }
    fn geometry(self, point: [f64; 2], radius: f64, bevel: f64) -> (f64, [f64; 2]) {
        let radius = radius.min(self.size[0].min(self.size[1]) * 0.5);
        let q = std::array::from_fn::<_, 2, _>(|i| point[i].abs() - self.size[i] * 0.5 + radius);
        let outside = q.map(|v| v.max(0.));
        let length = outside[0].hypot(outside[1]);
        let distance = length + q[0].max(q[1]).min(0.) - radius;
        // Straight edges and the circular arc meet continuously. Deep inside
        // the centre rectangle there is no bevel normal to illuminate.
        let normal = if length > 0. {
            std::array::from_fn(|i| outside[i] / length * point[i].signum())
        } else if radius <= bevel && q[0].max(q[1]) > -bevel && q[0] != q[1] {
            if q[0] > q[1] {
                [point[0].signum(), 0.]
            } else {
                [0., point[1].signum()]
            }
        } else {
            [0.; 2]
        };
        (distance, normal)
    }
}

fn ramp(start: f64, end: f64, value: f64) -> f64 {
    ((value - start) / (end - start)).clamp(0., 1.)
}
fn smooth(start: f64, end: f64, value: f64) -> f64 {
    let t = ramp(start, end, value);
    t * t * (3. - 2. * t)
}

pub fn sample_offset(sample: Option<usize>) -> Result<[f32; 2], String> {
    match sample {
        None => Ok([0.; 2]),
        Some(index) => crate::fidelity::SAMPLE_OFFSETS
            .get(index)
            .map(|&(x, y)| [(x - 0.5) as f32, (y - 0.5) as f32])
            .ok_or_else(|| "Invalid glass sample index".into()),
    }
}

struct Geometry {
    shape: GlassShape,
    inverse: Transform,
    matrix: Transform,
    light: [f64; 2],
    offset: [f32; 2],
}
#[derive(Serialize)]
pub struct GlassFieldInterior {
    pub interior: Rect,
    pub value: [f32; 4],
}

/// Exact constant interior of an axis-aligned optical field. Only this proved
/// region may omit per-pixel evaluation; the border still uses the original
/// binary64 geometry, sample phase, and inverse validation domain.
pub fn field_interior(basis: Rect, region: Rect, shape: GlassShape, matrix: Transform,
    glass: &GlassParameters, sample: Option<usize>, software: bool) -> Result<Option<GlassFieldInterior>, String> {
    if region.x < basis.x || region.y < basis.y || i64::from(region.x)+i64::from(region.w)>i64::from(basis.x)+i64::from(basis.w)
        || i64::from(region.y)+i64::from(region.h)>i64::from(basis.y)+i64::from(basis.h) {return Err("Glass field region exceeds original geometry domain".into());}
    let g=Geometry::with_raster(basis,shape,matrix,glass,sample,software)?;
    if matrix.0[1]!=0. || matrix.0[2]!=0. || region.empty() { return Ok(None); }
    let margin=shape.radius.max(glass.depth).max(glass.bevel_size()) + glass.depth + glass.bevel_size() + 2.;
    if shape.size.iter().any(|v|*v<=margin*2.) {return Ok(None);}
    let corners=[Point::new(margin,margin),Point::new(shape.size[0]-margin,shape.size[1]-margin)]
        .map(|p|matrix.point(p));
    let interior=Rect::from_points(corners.into_iter()).expand(-2).intersect(region);
    if interior.empty() {return Ok(None);}
    for (x,y) in [(interior.x,interior.y),(interior.right()-1,interior.y),
        (interior.x,interior.bottom()-1),(interior.right()-1,interior.bottom()-1)] {
        let p=g.inverse.point(Point::new(f64::from(x)+0.5+f64::from(g.offset[0]),f64::from(y)+0.5+f64::from(g.offset[1])));
        let m=margin-1.;
        if (p.x-shape.size[0]*0.5).abs()+m>=shape.size[0]*0.5 ||
            (p.y-shape.size[1]*0.5).abs()+m>=shape.size[1]*0.5 {return Ok(None);}
    }
    Ok(Some(GlassFieldInterior {interior,value:g.at(interior.x,interior.y,glass)}))
}
impl Geometry {
    fn new(
        rect: Rect,
        shape: GlassShape,
        matrix: Transform,
        glass: &GlassParameters,
        sample: Option<usize>,
    ) -> Result<Self, String> {
        Self::with_raster(rect, shape, matrix, glass, sample, false)
    }
    fn with_raster(
        rect: Rect,
        shape: GlassShape,
        matrix: Transform,
        glass: &GlassParameters,
        sample: Option<usize>,
        software: bool,
    ) -> Result<Self, String> {
        shape.validate()?;
        let rotation = (matrix.0[1] as f32).atan2(matrix.0[0] as f32);
        // Read the hexadecimal binary64 constant, not the shortened decimal
        // printed by a decompiler: it is standard binary64 pi.
        let authored = (f64::from(glass.light_angle.rem_euclid(360.) as f32) * std::f64::consts::PI
            / 180.) as f32;
        let angle = authored - rotation + std::f32::consts::FRAC_PI_2;
        let (sin, cos) = if software {
            crate::software_raster::trigonometry::sin_cos(angle)
        } else {
            angle.sin_cos()
        };
        Ok(Self {
            shape,
            inverse: matrix.inverse_composed(rect)?,
            matrix,
            light: [f64::from(cos), f64::from(sin)],
            offset: sample_offset(sample)?,
        })
    }
    fn at(&self, x: i32, y: i32, glass: &GlassParameters) -> [f32; 4] {
        self.at_impl(x, y, glass, true)
    }
    fn at_impl(&self, x: i32, y: i32, glass: &GlassParameters, interior_shortcut: bool) -> [f32; 4] {
        let local = self.inverse.point(Point::new(
            f64::from(x) + 0.5 + f64::from(self.offset[0]),
            f64::from(y) + 0.5 + f64::from(self.offset[1]),
        ));
        let centered = [
            local.x - self.shape.size[0] * 0.5,
            local.y - self.shape.size[1] * 0.5,
        ];
        // Strictly inside both rounded-rectangle centre regions and beyond
        // every optical ramp, both normals and all ramps are exactly zero.
        // Preserve the signed-zero matrix arithmetic of the full expression.
        let margin = self.shape.radius.max(glass.depth).max(glass.bevel_size())
            + glass.depth + glass.bevel_size() + 1.;
        if interior_shortcut && centered[0].abs()+margin < self.shape.size[0]*0.5 &&
            centered[1].abs()+margin < self.shape.size[1]*0.5 {
            let m=self.matrix.0; let z=-0.0_f64;
            return [(m[0]*z+m[2]*z) as f32,(m[1]*z+m[3]*z) as f32,(glass.light_intensity*0.) as f32,0.];
        }
        let (distance, normal) = self.shape.geometry(centered, self.shape.radius, glass.bevel_size());
        let (_, bend_normal) = self
            .shape
            .geometry(centered, self.shape.radius.max(glass.depth).max(glass.bevel_size()), glass.bevel_size());
        let depth = glass.depth;
        let bevel = glass.bevel_size();
        let t = ramp(-depth - bevel, -bevel, distance);
        // t^3.5 expressed without a platform pow implementation.
        let curve = depth * ((t * t * t) * t.sqrt()) * glass.refraction;
        let limit = depth * 0.999;
        let body = curve.clamp(-limit, limit);
        let rim = glass.refraction * 0.2 * limit;
        let transition = ramp(-bevel - 0.0001, -bevel * 0.3, distance);
        let magnitude = body + (rim - body) * transition;
        let displacement = bend_normal.map(|v| -v * magnitude);
        let dot = |n: [f64; 2]| n[0] * self.light[0] + n[1] * self.light[1];
        let alignment = dot(normal);
        let edge = smooth(-bevel - 0.001, -bevel * 0.2, distance);
        let broad = ramp(-depth, -bevel + 0.0001, distance);
        let light = glass.light_intensity
            * (edge * (smooth(0.35, 1., -alignment) + 0.6 * smooth(0.35, 1., alignment))
                + (dot(bend_normal) * broad * broad) * 0.05);
        let m = self.matrix.0;
        [
            (m[0] * displacement[0] + m[2] * displacement[1]) as f32,
            (m[1] * displacement[0] + m[3] * displacement[1]) as f32,
            light as f32,
            0.,
        ]
    }
}

pub fn field(
    rect: Rect,
    shape: GlassShape,
    matrix: Transform,
    glass: &GlassParameters,
    sample: Option<usize>,
) -> Result<Vec<f32>, String> {
    let geometry = Geometry::new(rect, shape, matrix, glass, sample)?;
    crate::sampling::parameter_grid(rect, |x, y| Ok(geometry.at(x, y, glass)))
}

pub fn field_with_raster(
    rect: Rect,
    shape: GlassShape,
    matrix: Transform,
    glass: &GlassParameters,
    sample: Option<usize>,
    software: bool,
) -> Result<Vec<f32>, String> {
    field_region_with_raster(rect, rect, shape, matrix, glass, sample, software)
}

/// Crop parameter evaluation, retaining the original inverse validation domain
/// and absolute pixel centres. Cropping must not rebase floating-point math.
pub fn field_region_with_raster(
    basis: Rect, rect: Rect, shape: GlassShape, matrix: Transform,
    glass: &GlassParameters, sample: Option<usize>, software: bool,
) -> Result<Vec<f32>, String> {
    if rect.x < basis.x || rect.y < basis.y ||
        i64::from(rect.x)+i64::from(rect.w) > i64::from(basis.x)+i64::from(basis.w) ||
        i64::from(rect.y)+i64::from(rect.h) > i64::from(basis.y)+i64::from(basis.h) {
        return Err("Glass field region exceeds original geometry domain".into());
    }
    let geometry = Geometry::with_raster(basis, shape, matrix, glass, sample, software)?;
    crate::sampling::parameter_grid(rect, |x, y| Ok(geometry.at(x, y, glass)))
}

fn shade(
    params: [f32; 4],
    dispersion: f32,
    captured_sdr: bool,
    ray: impl Fn(f32) -> Pixel,
) -> Pixel {
    let mut pixel = if dispersion < 0.001 {
        ray(1.)
    } else {
        let mut sum = [0_f32; 4];
        let mut weight_sum = 0_f32;
        for tap in 0..8 {
            let t = if captured_sdr {
                // The last phase is one float above .5, so its measured
                // weight is slightly negative. Clamping it changes the mean.
                (tap as f32).mul_add(1_f32 / 7., -0.5)
            } else {
                tap as f32 * (1_f32 / 7.) - 0.5
            };
            let weight = 1. - (t * 2.).abs();
            let r = ray(1. + (t + 0.5) * dispersion);
            let g = ray(1. + t * dispersion);
            let b = ray(1. + (t - 0.5) * dispersion);
            let value = [r.0[0], g.0[1], b.0[2], r.0[3].max(g.0[3]).max(b.0[3])];
            for c in 0..4 {
                sum[c] = if captured_sdr {
                    value[c].mul_add(weight, sum[c])
                } else {
                    sum[c] + value[c] * weight
                };
            }
            weight_sum += weight;
        }
        Pixel(if captured_sdr {
            let reciprocal = 1_f32 / weight_sum;
            sum.map(|v| v * reciprocal)
        } else {
            sum.map(|v| v / weight_sum)
        })
    };
    for c in 0..3 {
        pixel.0[c] += params[2];
    }
    pixel
}
fn encode(pixel: Pixel) -> Pixel {
    Pixel(
        pixel
            .0
            .map(|v| f32::from(crate::figma_sampling::encode_unorm8(v.clamp(0., 1.))) / 255.),
    )
}

fn encode_with_raster(pixel: Pixel, software: bool) -> Pixel {
    if software {
        Pixel(pixel.0.map(|v| {
            crate::software_raster::normalize_byte(crate::software_raster::encode_unorm8(
                v.clamp(0., 1.),
            ))
        }))
    } else {
        encode(pixel)
    }
}

pub fn render(
    backdrop: &Surface,
    shape: GlassShape,
    matrix: Transform,
    glass: &GlassParameters,
    sample: Option<usize>,
    linear: bool,
) -> Result<Surface, String> {
    render_with_raster(backdrop, shape, matrix, glass, sample, linear, false)
}

pub fn render_with_raster(
    backdrop: &Surface,
    shape: GlassShape,
    matrix: Transform,
    glass: &GlassParameters,
    sample: Option<usize>,
    linear: bool,
    software: bool,
) -> Result<Surface, String> {
    let software = software && !linear;
    let geometry = Geometry::with_raster(backdrop.rect, shape, matrix, glass, sample, software)?;
    let mut result = backdrop.new_like(backdrop.rect)?;
    let dispersion = glass.chromatic_aberration();
    for y in backdrop.rect.y..backdrop.rect.bottom() {
        for x in backdrop.rect.x..backdrop.rect.right() {
            let params = geometry.at(x, y, glass);
            let ray = |factor: f32| {
                let delta: [f32; 2] =
                    std::array::from_fn(|i| geometry.offset[i] + params[i] * factor);
                if linear {
                    return crate::material::sample(backdrop, x, y, delta, true);
                }
                let ix = x + delta[0].floor() as i32;
                let iy = y + delta[1].floor() as i32;
                let pixels = [
                    backdrop.at(ix, iy),
                    backdrop.at(ix + 1, iy),
                    backdrop.at(ix, iy + 1),
                    backdrop.at(ix + 1, iy + 1),
                ];
                let weights = delta.map(|v| crate::figma_sampling::fraction_q8(v - v.floor()));
                let sampler = if software {
                    crate::software_raster::sample_q8
                } else {
                    crate::figma_sampling::sample_q8
                };
                Pixel(sampler(
                    pixels.map(|p| p.0.map(|v| (v * 255.).round_ties_even() as u8)),
                    weights[0],
                    weights[1],
                ))
            };
            let pixel = shade(params, dispersion, false, ray);
            result.pixels[backdrop.rect.index(x, y).expect("glass output")] = if linear {
                pixel
            } else {
                encode_with_raster(pixel, software)
            };
        }
    }
    Ok(result)
}

/// Colour remains local to each backend. This entry replays the verified
/// rectangle source recipe separately for each export camera and tile.
pub fn render_captured(
    template: &Surface,
    replay: &crate::glass_capture::Replay,
    shape: GlassShape,
    matrix: Transform,
    glass: &GlassParameters,
    sample: usize,
    output: Rect,
) -> Result<Surface, String> {
    render_captured_with_raster(
        template, replay, shape, matrix, glass, sample, output, false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn render_captured_with_raster(
    template: &Surface,
    replay: &crate::glass_capture::Replay,
    shape: GlassShape,
    matrix: Transform,
    glass: &GlassParameters,
    sample: usize,
    output: Rect,
    software: bool,
) -> Result<Surface, String> {
    let geometry =
        Geometry::with_raster(template.rect, shape, matrix, glass, Some(sample), software)?;
    let mut result = template.new_like(template.rect)?;
    // The checked replay recipe is the terminal child of the only plain root
    // frame. There is no later backdrop reader or spatial effect that needs
    // its output halo. Source captures remain complete; only unused output
    // tiles are omitted when the CPU renders a portion of the final frame.
    for (origin, region) in replay.tiles(template.rect.intersect(output)) {
        let plan = replay.tile(origin, sample)?;
        let source = crate::glass_capture::render_with_raster(template, &plan, software)?;
        for y in region.y..region.bottom() {
            for x in region.x..region.right() {
                let params = geometry.at(x, y, glass);
                let ray = |factor: f32| {
                    // Capture already uses this camera's jitter. Only optical
                    // displacement is added here; adding the sample offset a
                    // second time would move the captured background twice.
                    let p = [
                        x as f32 + 0.5 + params[0] * factor,
                        y as f32 + 0.5 + params[1] * factor,
                    ];
                    crate::glass_capture::sample_with_raster(&source, plan.coordinate(p), software)
                };
                let raw = ray(1.);
                let pixel = shade(params, glass.chromatic_aberration(), true, ray);
                let encoded = encode_with_raster(pixel, software);
                if std::env::var_os("DESIGN_GLASS_DEBUG").is_some() {
                    eprintln!(
                        "glass-debug sample={sample} x={x} y={y} params={:08x?} ray={:08x?} shaded={:08x?} byte={:08x?}",
                        params.map(f32::to_bits),
                        raw.0.map(f32::to_bits),
                        pixel.0.map(f32::to_bits),
                        encoded.0.map(f32::to_bits),
                    );
                }
                result.pixels[template.rect.index(x, y).expect("captured glass")] = encoded;
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod spectral_tests {
    use super::{Pixel, shade};

    #[test]
    fn constant_interior_is_bit_exact_for_every_proved_pixel_and_sample() {
        use super::*;
        let shape=GlassShape{size:[120.,96.],radius:7.};
        let mut glass:GlassParameters=serde_json::from_value(serde_json::json!({"depth":3.,"bevelSize":2.,"refraction":0.5,"dispersion":0.3,"lightAngle":225.,"lightIntensity":0.5})).unwrap();
        let mut proved=0;
        for sx in [0.6,1.,1.2,-1.2] {for tx in [-20.375,0.125,51.75] {for sample in [None,Some(0),Some(1),Some(2),Some(3)] {
            let matrix=Transform([sx,0.,0.,1.2,tx,-13.375]);
            let basis=Rect::new(-200,-100,512,512);
            let geometry=Geometry::with_raster(basis,shape,matrix,&glass,sample,false).unwrap();
            let plan=field_interior(basis,basis,shape,matrix,&glass,sample,false).unwrap().unwrap();
            for y in plan.interior.y..plan.interior.bottom(){for x in plan.interior.x..plan.interior.right(){
                assert_eq!(plan.value.map(f32::to_bits),geometry.at_impl(x,y,&glass,false).map(f32::to_bits));proved+=1;
            }}
        }}}
        assert!(proved>100000);
        glass.light_intensity=-0.;
        let basis=Rect::new(-100,-100,300,300);
        let plan=field_interior(basis,basis,shape,Transform::default(),&glass,None,false).unwrap().unwrap();
        assert_eq!(plan.value[2].to_bits(),(-0_f32).to_bits());
        assert!(field_interior(basis,basis,shape,Transform([1.,0.1,0.,1.,0.,0.]),&glass,None,false).unwrap().is_none());
    }

    #[test]
    fn optical_interior_shortcut_matches_full_arithmetic_including_zero_signs() {
        use super::*;
        let rect=Rect{x:-80,y:-70,w:180,h:160};
        let shape=GlassShape{size:[140.,120.],radius:8.};
        let glass:GlassParameters=serde_json::from_value(serde_json::json!({
            "depth":8.,"refraction":0.5,"dispersion":0.3,"lightAngle":225.,"lightIntensity":0.5
        })).unwrap();
        let mut signed=glass.clone(); signed.light_intensity=-0.;
        let g=Geometry::with_raster(rect,shape,Transform([1.,0.,0.,1.,-60.125,-50.375]),&signed,None,false).unwrap();
        assert_eq!(g.at_impl(10,10,&signed,true).map(f32::to_bits),g.at_impl(10,10,&signed,false).map(f32::to_bits));
        for m in [Transform([1.,0.,0.,1.,-60.125,-50.375]),Transform([-1.,0.125,0.25,-0.95,70.25,60.125])] {
            for software in [false,true] { for sample in [None,Some(0),Some(1),Some(2),Some(3)] {
                let g=Geometry::with_raster(rect,shape,m,&glass,sample,software).unwrap();
                for y in rect.y..rect.y+rect.h as i32 { for x in rect.x..rect.x+rect.w as i32 {
                    assert_eq!(g.at_impl(x,y,&glass,true).map(f32::to_bits),g.at_impl(x,y,&glass,false).map(f32::to_bits));
                }}
            }}
        }
    }
    #[test]
    fn cropped_fields_preserve_every_bit_of_the_original_sampling_domain() {
        use super::*;
        let basis=Rect{x:-37,y:19,w:83,h:71};
        let crop=Rect{x:-21,y:28,w:27,h:39};
        let shape=GlassShape{size:[58.,47.],radius:6.};
        let glass:GlassParameters=serde_json::from_value(serde_json::json!({
            "depth":12.,"refraction":1.2,"dispersion":0.3,"lightAngle":37.,"lightIntensity":0.6,
            "bevelSize":4.
        })).unwrap();
        for software in [false,true] { for sample in [None,Some(0),Some(1),Some(2),Some(3)] {
            let m=Transform([1.2,0.125,-0.25,0.95,-30.375,24.125]);
            let all=field_with_raster(basis,shape,m,&glass,sample,software).unwrap();
            let part=field_region_with_raster(basis,crop,shape,m,&glass,sample,software).unwrap();
            for y in 0..crop.h as usize { for x in 0..crop.w as usize { for c in 0..4 {
                let old=(((y+(crop.y-basis.y) as usize)*basis.w as usize)+x+(crop.x-basis.x) as usize)*4+c;
                assert_eq!(all[old].to_bits(),part[(y*crop.w as usize+x)*4+c].to_bits());
            }}}
        }}
    }

    #[test]
    fn captured_spectrum_matches_every_independent_q4_dawn_mean() {
        let oracle: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../testing/fixtures/design/spectral-q4-natural-vectors.json"
        ))
        .unwrap();
        let inputs = oracle["inputBits"].as_array().unwrap();
        let means = oracle["expectedMeanBits"].as_array().unwrap();
        assert_eq!(inputs.len(), 4081);
        assert_eq!(means.len(), inputs.len());
        for (q, (input, expected)) in inputs.iter().zip(means).enumerate() {
            let input = f32::from_bits(input.as_u64().unwrap() as u32);
            assert_eq!(
                input.to_bits(),
                crate::figma_sampling::normalize_q4(q as u32).to_bits()
            );
            let result = shade([0.; 4], 0.2, true, |_| Pixel([input, input, input, 1.]));
            let expected = expected.as_u64().unwrap() as u32;
            assert_eq!(
                result.0.map(f32::to_bits),
                [expected, expected, expected, 1_f32.to_bits()]
            );
        }
    }
}
