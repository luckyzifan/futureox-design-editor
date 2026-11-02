//! Explicit color management. Working pixels are premultiplied, extended-range
//! linear sRGB (D65), where 1.0 is reference white, never an implicit clamp.
//! Matrices/transfers: W3C CSS Color 4 and CSS Color HDR, BT.2100 PQ/HLG.
//! https://www.w3.org/TR/css-color-4/#color-conversion-code
//! https://www.w3.org/TR/css-color-hdr/
//! Conversion order follows Skia/skcms: unassociate, decode, transform, encode,
//! reassociate. Alpha is coverage and never receives a transfer function.
use crate::blend::Pixel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorSpace {
    #[default]
    #[serde(rename = "srgb")]
    Srgb,
    #[serde(rename = "srgb-linear")]
    LinearSrgb,
    #[serde(rename = "display-p3")]
    DisplayP3,
    #[serde(rename = "display-p3-linear")]
    LinearP3,
    #[serde(rename = "rec2020")]
    Rec2020,
    #[serde(rename = "rec2100-linear")]
    LinearRec2020,
    #[serde(rename = "rec2100-pq")]
    Pq,
    #[serde(rename = "rec2100-hlg")]
    Hlg,
    #[serde(rename = "a98-rgb")]
    A98,
    #[serde(rename = "prophoto-rgb")]
    ProPhoto,
    #[serde(rename = "xyz-d50")]
    XyzD50,
    #[serde(rename = "xyz-d65")]
    XyzD65,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorSettings {
    pub document_space: ColorSpace,
    pub reference_white_nits: f64,
    pub peak_luminance_nits: f64,
}
fn reference_white() -> f64 {
    203.
}
fn peak_white() -> f64 {
    1000.
}
impl Default for ColorSettings {
    fn default() -> Self {
        Self {
            document_space: ColorSpace::Srgb,
            reference_white_nits: reference_white(),
            peak_luminance_nits: peak_white(),
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToneMap {
    #[default]
    Clip,
    Reinhard,
    None,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorOutput {
    pub space: ColorSpace,
    #[serde(default)]
    pub tone_map: ToneMap,
}
impl Default for ColorOutput {
    fn default() -> Self {
        Self {
            space: ColorSpace::Srgb,
            tone_map: ToneMap::Clip,
        }
    }
}
type Matrix = [[f64; 3]; 3];
const SRGB: Matrix = [
    [0.4123907992659595, 0.357584339383878, 0.1804807884018343],
    [0.2126390058715104, 0.715168678767756, 0.0721923153607337],
    [0.0193308187155919, 0.119194779794626, 0.9505321522496607],
];
const P3: Matrix = [
    [0.4865709486482162, 0.2656676931690931, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0., 0.0451133818589026, 1.043944368900976],
];
const REC2020: Matrix = [
    [0.6369580483012914, 0.1446169035862083, 0.1688809751641721],
    [0.2627002120112671, 0.6779980715188708, 0.059301716469862],
    [0., 0.0280726930490874, 1.060985057710791],
];
const A98: Matrix = [
    [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
    [0.297344975250536, 0.6273635662554661, 0.0752914584939979],
    [0.0270313613864123, 0.0706888525358272, 0.9913375368376388],
];
const PROPHOTO: Matrix = [
    [0.7977666449006423, 0.1351812974005331, 0.0313477341283922],
    [0.2880748288194013, 0.711835234241873, 0.0000899369387256],
    [0., 0., 0.8251046025104601],
];
const D50_TO_D65: Matrix = [
    [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
    [-0.0283697093338637, 1.0099953980813041, 0.02104144119191732],
    [
        0.012314014864481998,
        -0.020507649298898964,
        1.330365926242124,
    ],
];
const IDENTITY: Matrix = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
fn mul(m: Matrix, v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}
fn inverse(m: Matrix) -> Matrix {
    let [[a, b, c], [d, e, f], [g, h, i]] = m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    [
        [e * i - f * h, c * h - b * i, b * f - c * e],
        [f * g - d * i, a * i - c * g, c * d - a * f],
        [d * h - e * g, b * g - a * h, a * e - b * d],
    ]
    .map(|r| r.map(|v| v / det))
}
fn matrix(space: ColorSpace) -> Matrix {
    match space {
        ColorSpace::Srgb | ColorSpace::LinearSrgb => SRGB,
        ColorSpace::DisplayP3 | ColorSpace::LinearP3 => P3,
        ColorSpace::Rec2020 | ColorSpace::LinearRec2020 | ColorSpace::Pq | ColorSpace::Hlg => {
            REC2020
        }
        ColorSpace::A98 => A98,
        ColorSpace::ProPhoto => PROPHOTO,
        ColorSpace::XyzD50 | ColorSpace::XyzD65 => IDENTITY,
    }
}
fn d50(space: ColorSpace) -> bool {
    matches!(space, ColorSpace::ProPhoto | ColorSpace::XyzD50)
}
pub fn srgb_decode(v: f64) -> f64 {
    let x = v.abs();
    v.signum()
        * if x <= 0.04045 {
            x / 12.92
        } else {
            ((x + 0.055) / 1.055).powf(2.4)
        }
}
pub fn srgb_encode(v: f64) -> f64 {
    let x = v.abs();
    v.signum()
        * if x <= 0.0031308 {
            12.92 * x
        } else {
            1.055 * x.powf(1. / 2.4) - 0.055
        }
}

/// Encoded sRGB straight RGB to encoded Display P3. Alpha is coverage and is
/// not converted. Values inside sRGB stay inside P3; this is not a second
/// compositing space.
pub fn encoded_srgb_to_display_p3(rgb: [f64; 3]) -> [f64; 3] {
    ColorSettings::default().from_working(rgb.map(srgb_decode), ColorSpace::DisplayP3)
}
fn decode(v: f64, space: ColorSpace) -> f64 {
    let x = v.abs();
    let sign = v.signum();
    match space {
        ColorSpace::Srgb | ColorSpace::DisplayP3 => srgb_decode(v),
        ColorSpace::A98 => sign * x.powf(563. / 256.),
        ColorSpace::ProPhoto => {
            sign * if x <= 16. / 512. {
                x / 16.
            } else {
                x.powf(1.8)
            }
        }
        ColorSpace::Rec2020 => {
            sign * if x < 4.5 * 0.018053968510807 {
                x / 4.5
            } else {
                ((x + 0.09929682680944) / 1.09929682680944).powf(1. / 0.45)
            }
        }
        ColorSpace::Pq => {
            let p = x.powf(32. / 2523.);
            ((p - 107. / 128.).max(0.) / (2413. / 128. - 2392. / 128. * p)).powf(8192. / 1305.)
        }
        ColorSpace::Hlg => {
            if x <= 0.5 {
                x * x / 3.
            } else {
                (((x - 0.559910729529562) / 0.17883277).exp() + 0.28466892) / 12.
            }
        }
        _ => v,
    }
}
fn encode(v: f64, space: ColorSpace) -> f64 {
    let x = v.abs();
    let sign = v.signum();
    match space {
        ColorSpace::Srgb | ColorSpace::DisplayP3 => srgb_encode(v),
        ColorSpace::A98 => sign * x.powf(256. / 563.),
        ColorSpace::ProPhoto => {
            sign * if x <= 1. / 512. {
                x * 16.
            } else {
                x.powf(1. / 1.8)
            }
        }
        ColorSpace::Rec2020 => {
            sign * if x < 0.018053968510807 {
                x * 4.5
            } else {
                1.09929682680944 * x.powf(0.45) - 0.09929682680944
            }
        }
        ColorSpace::Pq => {
            let p = v.max(0.).powf(1305. / 8192.);
            ((107. / 128. + 2413. / 128. * p) / (1. + 2392. / 128. * p)).powf(2523. / 32.)
        }
        ColorSpace::Hlg => {
            if v <= 1. / 12. {
                (3. * v.max(0.)).sqrt()
            } else {
                0.17883277 * (12. * v - 0.28466892).ln() + 0.559910729529562
            }
        }
        _ => v,
    }
}
impl ColorSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.reference_white_nits.is_finite()
            || !(1. ..=1000.).contains(&self.reference_white_nits)
            || !self.peak_luminance_nits.is_finite()
            || !(self.reference_white_nits..=10000.).contains(&self.peak_luminance_nits)
            || 1.2 + 0.42 * (self.peak_luminance_nits / 1000.).log10() <= 0.
        {
            return Err("Invalid reference white / peak luminance".into());
        }
        Ok(())
    }
    /// Straight source components -> straight extended linear sRGB.
    pub fn to_working(&self, rgb: [f64; 3], space: ColorSpace) -> [f64; 3] {
        if space == ColorSpace::LinearSrgb {
            return rgb;
        }
        if space == ColorSpace::Srgb {
            return rgb.map(srgb_decode);
        }
        let mut v = rgb.map(|c| decode(c, space));
        if space == ColorSpace::Pq {
            v = v.map(|c| c * 10000. / self.reference_white_nits);
        }
        if space == ColorSpace::Hlg {
            let y = mul(REC2020, v)[1].max(0.);
            let gamma = 1.2 + 0.42 * (self.peak_luminance_nits / 1000.).log10();
            let gain = if y > 0. {
                y.powf(gamma - 1.) * self.peak_luminance_nits / self.reference_white_nits
            } else {
                0.
            };
            v = v.map(|c| c * gain);
        }
        let mut xyz = mul(matrix(space), v);
        if d50(space) {
            xyz = mul(D50_TO_D65, xyz);
        }
        mul(inverse(SRGB), xyz)
    }
    pub fn prepare_from_working(&self, space: ColorSpace) -> FromWorkingTransform {
        FromWorkingTransform {
            settings: *self, space,
            destination: if matches!(space, ColorSpace::Srgb | ColorSpace::LinearSrgb) { IDENTITY } else { inverse(matrix(space)) },
            adaptation: if d50(space) { inverse(D50_TO_D65) } else { IDENTITY },
        }
    }
    pub fn from_working(&self, rgb: [f64; 3], space: ColorSpace) -> [f64; 3] {
        self.prepare_from_working(space).apply(rgb)
    }
    /// Working-space components before premultiplication. GPU material
    /// constants must not be reconstructed by dividing a rounded Pixel by alpha.
    pub fn parse_straight(&self, s: &str) -> Result<[f32; 4], String> {
        let (space, components, alpha) = parse(s, self.document_space)?;
        let rgb = self.to_working(components, space);
        if rgb.iter().any(|v| !v.is_finite() || v.abs() > 65504.) {
            return Err("Color exceeds finite float16 working range".into());
        }
        Ok([rgb[0] as f32, rgb[1] as f32, rgb[2] as f32, alpha as f32])
    }
    pub fn parse(&self, s: &str, opacity: f32) -> Result<Pixel, String> {
        let c = self.parse_straight(s)?;
        Ok(Pixel::rgba(c[0], c[1], c[2], c[3] * opacity))
    }
    pub fn prepare_output(&self, output: ColorOutput) -> OutputTransform {
        OutputTransform { transform: self.prepare_from_working(output.space), output }
    }
    pub fn output(&self, pixel: Pixel, output: ColorOutput) -> [f32; 4] {
        self.prepare_output(output).apply(pixel)
    }
}
/// Frame-owned exact transform. Keep the separate matrix multiplies in their
/// original order: composing matrices or approximating transfer curves would
/// change rounding. No inverse or allocation occurs in the per-pixel path.
#[derive(Clone, Copy)]
pub struct FromWorkingTransform {
    settings: ColorSettings,
    space: ColorSpace,
    destination: Matrix,
    adaptation: Matrix,
}
impl FromWorkingTransform {
    pub fn apply(&self, rgb: [f64; 3]) -> [f64; 3] {
        let space = self.space;
        if space == ColorSpace::LinearSrgb {
            return rgb;
        }
        if space == ColorSpace::Srgb {
            return rgb.map(srgb_encode);
        }
        let mut xyz = mul(SRGB, rgb);
        if d50(space) {
            xyz = mul(self.adaptation, xyz);
        }
        let mut v = mul(self.destination, xyz);
        if space == ColorSpace::Pq {
            v = v.map(|c| c * self.settings.reference_white_nits / 10000.);
        }
        if space == ColorSpace::Hlg {
            v = v.map(|c| c * self.settings.reference_white_nits / self.settings.peak_luminance_nits);
            let y = mul(REC2020, v)[1].max(0.);
            let gamma = 1.2 + 0.42 * (self.settings.peak_luminance_nits / 1000.).log10();
            let gain = if y > 0. { y.powf(1. / gamma - 1.) } else { 0. };
            v = v.map(|c| c * gain);
        }
        v.map(|c| encode(c, space))
    }
}
#[derive(Clone, Copy)]
pub struct OutputTransform { transform: FromWorkingTransform, output: ColorOutput }
impl OutputTransform {
    pub fn apply(&self, p: Pixel) -> [f32; 4] {
        let out = self.output;
        let mut rgb = p.rgb().map(f64::from);
        // Reinhard et al. (2002), equation 4, global white-point operator.
        // https://www-old.cs.utah.edu/docs/techreports/2002/pdf/UUCS-02-001.pdf
        // No automatic exposure or local dodging/burning is implied here.
        if out.tone_map == ToneMap::Reinhard {
            let y = mul(SRGB, rgb)[1].max(0.);
            let white = self.transform.settings.peak_luminance_nits / self.transform.settings.reference_white_nits;
            let gain = (1. + y / (white * white)) / (1. + y);
            rgb = rgb.map(|c| c * gain);
        }
        let mut v = self.transform.apply(rgb);
        if out.tone_map != ToneMap::None {
            v = v.map(|c| c.clamp(0., 1.));
        }
        [v[0] as f32, v[1] as f32, v[2] as f32, p.0[3].clamp(0., 1.)]
    }
}
/// Supported portable CSS color() forms, with optional straight alpha. This is
/// deliberately a strict numeric subset, not a browser CSS parser.
pub fn parse(s: &str, default_space: ColorSpace) -> Result<(ColorSpace, [f64; 3], f64), String> {
    if s.len() > 256 {
        return Err("Color expression too long".into());
    }
    if s.starts_with('#') {
        let p = Pixel::hex(s, 1.)?;
        return Ok((default_space, p.rgb().map(f64::from), 1.));
    }
    let body = s
        .strip_prefix("color(")
        .and_then(|s| s.strip_suffix(')'))
        .ok_or("Expected #RRGGBB or color(space r g b / alpha)")?;
    let normalized = body.replace('/', " / ");
    let parts: Vec<_> = normalized.split_whitespace().collect();
    if parts.len() != 4 && (parts.len() != 6 || parts[4] != "/") {
        return Err("Invalid color() components".into());
    }
    let space: ColorSpace = serde_json::from_value(serde_json::Value::String(parts[0].to_owned()))
        .map_err(|_| "Unsupported color space")?;
    let num = |s: &str| {
        s.parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .ok_or_else(|| "Invalid finite color component".to_string())
    };
    let rgb = [num(parts[1])?, num(parts[2])?, num(parts[3])?];
    let a = if parts.len() == 6 { num(parts[5])? } else { 1. };
    if !(0. ..=1.).contains(&a) || rgb.iter().any(|x| x.abs() > 65504.) {
        return Err("Color components exceed limits".into());
    }
    if matches!(space, ColorSpace::Pq | ColorSpace::Hlg)
        && rgb.iter().any(|x| !(0. ..=1.).contains(x))
    {
        return Err("PQ/HLG signals must be in [0, 1]".into());
    }
    Ok((space, rgb, a))
}
/// Encoded SDR channels, without a colour-space transform or premultiplication.
/// Explicit sRGB alpha is portable even in an unmanaged document; wide-gamut
/// and extended-range expressions must still opt into colour management.
pub fn unmanaged_straight(s: &str) -> Result<[f32; 4], String> {
    let (space, rgb, alpha) = parse(s, ColorSpace::Srgb)?;
    if space != ColorSpace::Srgb || rgb.iter().any(|v| !(0. ..=1.).contains(v)) {
        return Err("Unmanaged color requires bounded sRGB components".into());
    }
    Ok([rgb[0] as f32, rgb[1] as f32, rgb[2] as f32, alpha as f32])
}
pub fn pixel(settings: Option<ColorSettings>, s: &str, opacity: f32) -> Result<Pixel, String> {
    match settings {
        Some(c) => c.parse(s, opacity),
        None => {
            let c = unmanaged_straight(s)?;
            Ok(Pixel::rgba(c[0], c[1], c[2], c[3] * opacity))
        }
    }
}

#[cfg(test)]
#[path="color_prepared_tests.rs"]
mod prepared_output_tests;
