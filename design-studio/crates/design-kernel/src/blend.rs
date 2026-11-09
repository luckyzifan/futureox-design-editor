use crate::math::Rect;
pub fn valid_mode(mode: &str) -> bool {
    matches!(
        mode,
        "normal"
            | "multiply"
            | "screen"
            | "overlay"
            | "darken"
            | "lighten"
            | "color-dodge"
            | "color-burn"
            | "hard-light"
            | "soft-light"
            | "difference"
            | "exclusion"
            | "hue"
            | "saturation"
            | "color"
            | "luminosity"
            | "linear-burn"
            | "linear-dodge"
    )
}

/// Parsed once per paint/composite, outside pixel loops. Unknown names keep
/// the legacy source-channel fallback used by the public string API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BlendMode { Normal, Multiply, Screen, Overlay, Darken, Lighten, ColorDodge, ColorBurn, HardLight, SoftLight, Difference, Exclusion, Hue, Saturation, Color, Luminosity, LinearBurn, LinearDodge, Other }
impl BlendMode {
    pub(crate) fn from_name(name:&str)->Self {
        match name {
            "normal"=>Self::Normal,
            "multiply"=>Self::Multiply,
            "screen"=>Self::Screen,
            "overlay"=>Self::Overlay,
            "darken"=>Self::Darken,
            "lighten"=>Self::Lighten,
            "color-dodge"=>Self::ColorDodge,
            "color-burn"=>Self::ColorBurn,
            "hard-light"=>Self::HardLight,
            "soft-light"=>Self::SoftLight,
            "difference"=>Self::Difference,
            "exclusion"=>Self::Exclusion,
            "hue"=>Self::Hue,
            "saturation"=>Self::Saturation,
            "color"=>Self::Color,
            "luminosity"=>Self::Luminosity,
            "linear-burn"=>Self::LinearBurn,
            "linear-dodge"=>Self::LinearDodge,
            _=>Self::Other,
        }
    }
}
#[cfg(test)]
mod surface_storage_tests {
    use super::{Pixel, Surface};
    use crate::{math::Rect, memory::Budget};

    #[test]
    fn byte_surfaces_charge_actual_storage_and_cumulative_surface_work() {
        let budget = Budget::new(64);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &budget).unwrap();
        let bytes = template.reserve_surface::<[u8; 4]>(8).unwrap();
        let usage = budget.usage();
        assert_eq!(usage.live_bytes, size_of::<Pixel>() + 8 * 4);
        assert_eq!(usage.live_surface_pixels, 9);
        assert_eq!(usage.allocated_surface_pixels, 9);
        assert!(template.reserve_surface::<[u8; 4]>(5).is_err());
        drop(bytes);
        assert_eq!(budget.usage().live_bytes, size_of::<Pixel>());
        assert_eq!(budget.usage().allocated_surface_pixels, 9);

        let budget = Budget::new(256 * 1024 * 1024);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &budget).unwrap();
        for _ in 0..19 {
            let reservation = template.reserve_surface::<[u8; 4]>(10_000_000).unwrap();
            drop(reservation);
        }
        assert!(template.reserve_surface::<[u8; 4]>(10_000_000).is_err());
        assert_eq!(budget.usage().live_bytes, size_of::<Pixel>());
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pixel(pub [f32; 4]);
impl Pixel {
    pub fn straight_rgba8(self) -> [u8; 4] {
        let rgb = self.rgb();
        [rgb[0], rgb[1], rgb[2], self.0[3]].map(|v| (v.clamp(0., 1.) * 255.).round() as u8)
    }
    pub fn mask_alpha(self, luminance: bool) -> f32 {
        if luminance {
            (self.0[0] * 0.2126 + self.0[1] * 0.7152 + self.0[2] * 0.0722).clamp(0., 1.)
        } else {
            self.0[3]
        }
    }
    pub fn over_rgba8(self, source: Self, opacity: f32) -> Self {
        self.over_rgba8_mode(source, opacity, BlendMode::Normal)
    }
    pub(crate) fn over_rgba8_blend(self, source: Self, opacity: f32, mode: &str) -> Self {
        self.over_rgba8_mode(source,opacity,BlendMode::from_name(mode))
    }
    pub(crate) fn over_rgba8_mode(self, source: Self, opacity: f32, mode: BlendMode) -> Self {
        let dst = self.0.map(|v| (v * 255.).round_ties_even() as u32);
        let src = source.0.map(|v| (v * 255.).round_ties_even() as u32);
        let weight = (opacity.clamp(0., 1.) * 65535.).round_ties_even() as u32;
        const DENOMINATOR: u32 = 255 * 65535;
        Self(std::array::from_fn(|c| {
            let numerator = if c < 3 && mode == BlendMode::Multiply {
                src[c] * weight * (255 - dst[3] + dst[c]) + dst[c] * (DENOMINATOR - src[3] * weight)
            } else if c < 3 && mode == BlendMode::Screen {
                src[c] * weight * (255 - dst[c]) + dst[c] * DENOMINATOR
            } else {
                dst[c] * (DENOMINATOR - src[3] * weight) + src[c] * 255 * weight
            };
            let q = numerator / DENOMINATOR;
            let remainder = numerator % DENOMINATOR;
            (q + u32::from(remainder * 2 > DENOMINATOR)) as f32 / 255.
        }))
    }
    pub fn interpolate(self, other: Self, amount: f32, rgba8: bool) -> Self {
        Self(std::array::from_fn(|c| {
            if rgba8 {
                let a = (self.0[c] * 255.).round_ties_even();
                let b = (other.0[c] * 255.).round_ties_even();
                (a * (1. - amount) + b * amount).round_ties_even() / 255.
            } else {
                self.0[c] * (1. - amount) + other.0[c] * amount
            }
        }))
    }
    pub fn rgba8_quantized(self) -> Self {
        Self(
            self.0
                .map(|v| (v.clamp(0., 1.) * 255.).round_ties_even() / 255.),
        )
    }
    pub fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        let a = a.clamp(0., 1.);
        Self([r * a, g * a, b * a, a])
    }
    pub fn hex(s: &str, alpha: f32) -> Result<Self, String> {
        if s.len() != 7 || !s.starts_with('#') {
            return Err("Invalid color".into());
        }
        let v = u32::from_str_radix(&s[1..], 16).map_err(|_| "Invalid color")?;
        Ok(Self::rgba(
            ((v >> 16) & 255) as f32 / 255.,
            ((v >> 8) & 255) as f32 / 255.,
            (v & 255) as f32 / 255.,
            alpha,
        ))
    }
    pub fn opacity(self, a: f32) -> Self {
        Self(self.0.map(|v| v * a))
    }
    pub fn rgb(self) -> [f32; 3] {
        if self.0[3] <= 1e-10 {
            return [0.; 3];
        }
        [
            self.0[0] / self.0[3],
            self.0[1] / self.0[3],
            self.0[2] / self.0[3],
        ]
    }
}
fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}
fn sat(c: [f32; 3]) -> f32 {
    c.into_iter().fold(f32::NEG_INFINITY, f32::max) - c.into_iter().fold(f32::INFINITY, f32::min)
}
fn set_lum(mut c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    c = c.map(|v| v + d);
    let l = lum(c);
    let min = c.into_iter().fold(f32::INFINITY, f32::min);
    let max = c.into_iter().fold(f32::NEG_INFINITY, f32::max);
    if min < 0. {
        c = c.map(|v| l + (v - l) * l / (l - min).max(1e-10));
    }
    if max > 1. {
        c = c.map(|v| l + (v - l) * (1. - l) / (max - l).max(1e-10));
    }
    c
}
fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let mut idx = [0, 1, 2];
    idx.sort_by(|a, b| c[*a].total_cmp(&c[*b]));
    let mut o = [0.; 3];
    let [min, mid, max] = idx;
    if c[max] > c[min] {
        o[mid] = (c[mid] - c[min]) * s / (c[max] - c[min]);
        o[max] = s;
    }
    o
}
fn channel(b: f32, s: f32, mode: BlendMode) -> f32 {
    match mode {
        BlendMode::Multiply => b * s,
        BlendMode::Screen => b + s - b * s,
        BlendMode::Overlay => {
            if b <= 0.5 {
                2. * b * s
            } else {
                1. - 2. * (1. - b) * (1. - s)
            }
        }
        BlendMode::Darken => b.min(s),
        BlendMode::Lighten => b.max(s),
        BlendMode::ColorDodge => {
            if b <= 0. {
                0.
            } else if s >= 1. {
                1.
            } else {
                (b / (1. - s)).min(1.)
            }
        }
        BlendMode::ColorBurn => {
            if b >= 1. {
                1.
            } else if s <= 0. {
                0.
            } else {
                1. - ((1. - b) / s).min(1.)
            }
        }
        BlendMode::HardLight => {
            if s <= 0.5 {
                2. * b * s
            } else {
                1. - 2. * (1. - b) * (1. - s)
            }
        }
        BlendMode::SoftLight => {
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
        BlendMode::Difference => (b - s).abs(),
        BlendMode::Exclusion => b + s - 2. * b * s,
        _ => s,
    }
}
// W3C Compositing and Blending Level 1, source-over with premultiplied storage.
// https://www.w3.org/TR/compositing-1/#blending
pub fn over(dst: Pixel, src: Pixel, mode: &str) -> Pixel {
    over_mode(dst,src,BlendMode::from_name(mode))
}
pub(crate) fn over_mode(dst: Pixel, src: Pixel, mode: BlendMode) -> Pixel {
    if src.0[3] <= 0. {
        return dst;
    }
    if dst.0[3] <= 0. {
        return src;
    }
    if mode == BlendMode::Normal {
        let inverse = 1. - src.0[3];
        return Pixel(std::array::from_fn(|i| src.0[i] + dst.0[i] * inverse));
    }
    let b = dst.rgb();
    let s = src.rgb();
    let mixed = match mode {
        BlendMode::Hue => set_lum(set_sat(s, sat(b)), lum(b)),
        BlendMode::Saturation => set_lum(set_sat(b, sat(s)), lum(b)),
        BlendMode::Color => set_lum(s, lum(b)),
        BlendMode::Luminosity => set_lum(b, lum(s)),
        // Figma blend types 17/18:
        // linear-burn = max(0, backdrop + source - 1) per channel in
        // premultiplied space; linear-dodge = min(1, backdrop + source).
        BlendMode::LinearBurn => [
            (b[0] + s[0] - 1.).max(0.),
            (b[1] + s[1] - 1.).max(0.),
            (b[2] + s[2] - 1.).max(0.),
        ],
        BlendMode::LinearDodge => [
            (b[0] + s[0]).min(1.),
            (b[1] + s[1]).min(1.),
            (b[2] + s[2]).min(1.),
        ],
        _ => [
            channel(b[0], s[0], mode),
            channel(b[1], s[1], mode),
            channel(b[2], s[2], mode),
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

pub struct Surface {
    pub rect: Rect,
    pub pixels: Vec<Pixel>,
    allocation: Option<crate::memory::Allocation>,
}
pub(crate) fn sample_rgba8_index_from(x: f32, y: f32, opacity: f32, at:impl Fn(i32,i32)->Pixel) -> Pixel {
        let (ix, iy) = (x.floor() as i32, y.floor() as i32);
        let (u, v) = (x - x.floor(), y - y.floor());
        let byte = |x, y| at(x, y).0.map(|c| (c * 255.).round_ties_even());
        let (a, b, c, d) = (
            byte(ix, iy),
            byte(ix + 1, iy),
            byte(ix, iy + 1),
            byte(ix + 1, iy + 1),
        );
        Pixel(std::array::from_fn(|i| {
            let top = a[i] * (1. - u) + b[i] * u;
            let bottom = c[i] * (1. - u) + d[i] * u;
            ((top * (1. - v) + bottom * v) * opacity).round_ties_even() / 255.
        }))
}
pub(crate) fn sample_from(x: f64, y: f64, at:impl Fn(i32,i32)->Pixel) -> Pixel {
        let x = x - 0.5;
        let y = y - 0.5;
        let (ix, iy) = (x.floor() as i32, y.floor() as i32);
        let (u, v) = ((x - x.floor()) as f32, (y - y.floor()) as f32);
        let ps = [
            at(ix, iy),
            at(ix + 1, iy),
            at(ix, iy + 1),
            at(ix + 1, iy + 1),
        ];
        let ws = [(1. - u) * (1. - v), u * (1. - v), (1. - u) * v, u * v];
        let mut out = [0.; 4];
        for (p, w) in ps.into_iter().zip(ws) {
            for (i, c) in out.iter_mut().enumerate() {
                *c += p.0[i] * w;
            }
        }
        Pixel(out)
}
pub(crate) fn sample_linear_from(x: f64, y: f64, at:impl Fn(i32,i32)->Pixel) -> Pixel {
        let (x, y) = (x - 0.5, y - 0.5);
        let (ix, iy) = (x.floor() as i32, y.floor() as i32);
        let (u, v) = ((x - x.floor()) as f32, (y - y.floor()) as f32);
        let p = [
            at(ix, iy),
            at(ix + 1, iy),
            at(ix, iy + 1),
            at(ix + 1, iy + 1),
        ];
        Pixel(std::array::from_fn(|c| {
            crate::sampling::bilinear(p.map(|p| p.0[c]), u, v)
        }))
}
impl Surface {
    pub fn quantize_rgba8(&mut self) {
        for p in &mut self.pixels {
            *p = p.rgba8_quantized();
        }
    }
    pub fn new(rect: Rect) -> Result<Self, String> {
        Self::new_accounted(rect, None)
    }
    pub(crate) fn new_in(rect: Rect, budget: &crate::memory::Budget) -> Result<Self, String> {
        Self::new_accounted(rect, Some(budget))
    }
    fn new_accounted(rect: Rect, budget: Option<&crate::memory::Budget>) -> Result<Self, String> {
        if rect.pixels() > 16_777_216 {
            return Err("Layer surface exceeds 16 million pixels".into());
        }
        let allocation = budget
            .map(|b| b.reserve(rect.pixels(), size_of::<Pixel>(), true))
            .transpose()?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(rect.pixels())
            .map_err(|_| "Could not allocate layer surface")?;
        pixels.resize(rect.pixels(), Pixel::default());
        Ok(Self {
            rect,
            pixels,
            allocation,
        })
    }
    pub(crate) fn new_like(&self, rect: Rect) -> Result<Self, String> {
        Self::new_accounted(rect, self.allocation.as_ref().map(|a| &a.budget))
    }
    pub fn try_clone(&self) -> Result<Self, String> {
        let mut out = self.new_like(self.rect)?;
        out.pixels.clone_from_slice(&self.pixels);
        Ok(out)
    }
    pub(crate) fn reserve_scratch<T>(
        &self,
        count: usize,
    ) -> Result<Option<crate::memory::Allocation>, String> {
        self.allocation
            .as_ref()
            .map(|a| a.budget.reserve(count, size_of::<T>(), false))
            .transpose()
    }
    /// Alternative pixel storage still consumes the frame's surface-work
    /// allowance, but charges the bytes actually retained by each pixel.
    pub(crate) fn reserve_surface<T>(
        &self,
        count: usize,
    ) -> Result<Option<crate::memory::Allocation>, String> {
        self.allocation
            .as_ref()
            .map(|a| a.budget.reserve(count, size_of::<T>(), true))
            .transpose()
    }
    pub(crate) fn sample_rgba8_index(&self, x: f32, y: f32, opacity: f32) -> Pixel {
        sample_rgba8_index_from(x,y,opacity,|x,y|self.at(x,y))
    }
    pub fn at(&self, x: i32, y: i32) -> Pixel {
        self.rect
            .index(x, y)
            .map_or(Pixel::default(), |i| self.pixels[i])
    }
    pub fn sample(&self, x: f64, y: f64) -> Pixel {
        sample_from(x,y,|x,y|self.at(x,y))
    }
    /// Managed linear-light sampling: exact bilinear expression, one f32 RNE.
    /// Geometry selects the texel cell in f64; interpolation fractions are f32.
    pub fn sample_linear(&self, x: f64, y: f64) -> Pixel {
        sample_linear_from(x,y,|x,y|self.at(x,y))
    }
    /// Bilinear resampling at an RGBA8 filter boundary. Interpolate byte values
    /// before normalizing so binary UNORM representations cannot move exact
    /// half-byte results to opposite sides of a ties-to-even rounding boundary.
    pub fn sample_rgba8(&self, x: f64, y: f64) -> Pixel {
        let (x, y) = (x - 0.5, y - 0.5);
        let (ix, iy) = (x.floor() as i32, y.floor() as i32);
        let (u, v) = (x - x.floor(), y - y.floor());
        let byte = |x, y| {
            self.at(x, y)
                .0
                .map(|c| f64::from((c * 255.).round_ties_even()))
        };
        let (a, b, c, d) = (
            byte(ix, iy),
            byte(ix + 1, iy),
            byte(ix, iy + 1),
            byte(ix + 1, iy + 1),
        );
        Pixel(std::array::from_fn(|i| {
            let top = a[i] * (1. - u) + b[i] * u;
            let bottom = c[i] * (1. - u) + d[i] * u;
            (top * (1. - v) + bottom * v).round_ties_even() as f32 / 255.
        }))
    }
    pub fn composite(
        &mut self,
        source: &Self,
        mode: &str,
        opacity: f32,
        mask: impl Fn(i32, i32) -> f32,
    ) {
        let r = self.rect.intersect(source.rect);
        if r.empty() {return;}
        let mode=BlendMode::from_name(mode);
        for y in r.y..r.bottom() {
            let dst=self.rect.index(r.x,y).expect("intersection");
            let src=source.rect.index(r.x,y).expect("intersection");
            for (x,(dst,src)) in (r.x..r.right()).zip(self.pixels[dst..dst+r.w as usize].iter_mut().zip(&source.pixels[src..src+r.w as usize])) {
                let s=src.opacity(opacity*mask(x,y));*dst=over_mode(*dst,s,mode);
            }
        }
    }
    /// Source-over of a layer whose mask is identically one. Same `over_mode`
    /// formula as `composite`. A Normal, fully opaque source run is the source
    /// pixel, so those spans are copied.
    pub fn composite_unmasked(&mut self, source: &Self, mode: &str, opacity: f32) {
        let r = self.rect.intersect(source.rect);
        if r.empty() {
            return;
        }
        let mode = BlendMode::from_name(mode);
        let width = r.w as usize;
        if mode == BlendMode::Normal && opacity == 1. {
            for y in r.y..r.bottom() {
                let dst = self.rect.index(r.x, y).expect("intersection");
                let src = source.rect.index(r.x, y).expect("intersection");
                let dst_row = &mut self.pixels[dst..dst + width];
                let src_row = &source.pixels[src..src + width];
                let mut x = 0;
                while x < width {
                    if src_row[x].0[3] == 1. {
                        let start = x;
                        x += 1;
                        while x < width && src_row[x].0[3] == 1. {
                            x += 1;
                        }
                        dst_row[start..x].copy_from_slice(&src_row[start..x]);
                    } else if src_row[x].0[3] <= 0. {
                        x += 1;
                    } else {
                        dst_row[x] = over_mode(dst_row[x], src_row[x], BlendMode::Normal);
                        x += 1;
                    }
                }
            }
            return;
        }
        for y in r.y..r.bottom() {
            let dst = self.rect.index(r.x, y).expect("intersection");
            let src = source.rect.index(r.x, y).expect("intersection");
            for (dst, src) in self.pixels[dst..dst + width]
                .iter_mut()
                .zip(&source.pixels[src..src + width])
            {
                *dst = over_mode(*dst, src.opacity(opacity), mode);
            }
        }
    }
    pub fn composite_rgba8(&mut self, source: &Self, opacity: f32, mask: impl Fn(i32, i32) -> f32) {
        let r=self.rect.intersect(source.rect);
        if r.empty(){return;}
        for y in r.y..r.bottom(){
            let dst=self.rect.index(r.x,y).expect("intersection");
            let src=source.rect.index(r.x,y).expect("intersection");
            for (x,(dst,src)) in (r.x..r.right()).zip(self.pixels[dst..dst+r.w as usize].iter_mut().zip(&source.pixels[src..src+r.w as usize])) {
                *dst=dst.over_rgba8(*src,opacity*mask(x,y));
            }
        }
    }
    pub fn interpolate(&mut self, source: &Self, amount: impl Fn(i32, i32) -> f32, rgba8: bool) {
        let r=self.rect.intersect(source.rect);
        if r.empty(){return;}
        for y in r.y..r.bottom(){
            let dst=self.rect.index(r.x,y).expect("intersection");
            let src=source.rect.index(r.x,y).expect("intersection");
            for (x,(dst,src)) in (r.x..r.right()).zip(self.pixels[dst..dst+r.w as usize].iter_mut().zip(&source.pixels[src..src+r.w as usize])) {
                *dst=dst.interpolate(*src,amount(x,y),rgba8);
            }
        }
    }
    pub fn rgba8(&self, crop: Rect) -> Vec<u8> {
        let mut out = Vec::with_capacity(crop.pixels() * 4);
        // Contained crops can walk contiguous rows without repeating the
        // coordinate/bounds lookup for every pixel. Keep the scalar conversion
        // unchanged, including unpremultiplication and its rounding contract.
        let rows = (|| {
            if crop.empty() || self.rect.empty() {
                return None;
            }
            let right = self.rect.x.checked_add(i32::try_from(self.rect.w).ok()?)?;
            let bottom = self.rect.y.checked_add(i32::try_from(self.rect.h).ok()?)?;
            let crop_right = crop.x.checked_add(i32::try_from(crop.w).ok()?)?;
            let crop_bottom = crop.y.checked_add(i32::try_from(crop.h).ok()?)?;
            if crop.x < self.rect.x
                || crop.y < self.rect.y
                || crop_right > right
                || crop_bottom > bottom
            {
                return None;
            }
            let stride = usize::try_from(self.rect.w).ok()?;
            let height = usize::try_from(crop.h).ok()?;
            let width = usize::try_from(crop.w).ok()?;
            let storage = stride.checked_mul(usize::try_from(self.rect.h).ok()?)?;
            if self.pixels.len() != storage {
                return None;
            }
            let x = usize::try_from(crop.x.checked_sub(self.rect.x)?).ok()?;
            let y = usize::try_from(crop.y.checked_sub(self.rect.y)?).ok()?;
            let start = y.checked_mul(stride)?.checked_add(x)?;
            let end = start
                .checked_add((height - 1).checked_mul(stride)?)?
                .checked_add(width)?;
            (end <= storage).then_some((start, stride, width, height))
        })();
        if let Some((start, stride, width, height)) = rows {
            for row in 0..height {
                // The checked last-row endpoint above bounds every row here.
                let offset = start + row * stride;
                out.extend(
                    self.pixels[offset..offset + width]
                        .iter()
                        .flat_map(|p| p.straight_rgba8()),
                );
            }
            return out;
        }
        for y in crop.y..crop.bottom() {
            for x in crop.x..crop.right() {
                let p = self.at(x, y);
                out.extend(p.straight_rgba8());
            }
        }
        out
    }
}

#[cfg(test)]
#[path="blend_prepared_tests.rs"]
mod prepared_blend_tests;
