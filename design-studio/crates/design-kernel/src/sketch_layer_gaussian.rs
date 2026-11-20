//! The byte pipeline used by imported Sketch layer blurs. The working raster
//! has its own density. Round its dimensions before mapping the layer into it.
use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    paint::Images,
    scene::{Document, Effect, Node},
};
use base64::Engine as _;
use std::sync::Arc;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchLayerGaussian {
    pub output: Rect,
    pub work: [usize; 2],
    logical_size: [usize; 2],
    scale: i32,
    margin: usize,
    phase: [f64; 2],
    rotation: Option<Rotation>,
    pub mirrored: [bool; 2],
    pub tap_count: usize,
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct Rotation {
    axes: [f64; 4],
    center: [f64; 2],
}

impl Rotation {
    fn bounded(self) -> bool {
        let [a, b, c, d] = self.axes;
        self.center.iter().all(|v| v.abs() <= 1_048_576.)
            && (a.hypot(b) - 1.).abs() < 1e-9
            && (c.hypot(d) - 1.).abs() < 1e-9
            && (a * c + b * d).abs() < 1e-9
    }

    fn bounds(self, span: [usize; 2]) -> Rect {
        let [a, b, c, d] = self.axes;
        let [w, h] = span.map(|value| value as f64 / 2.);
        let dx = a.abs() * w + c.abs() * h;
        let dy = b.abs() * w + d.abs() * h;
        let [x, y] = self.center;
        Rect::from_points([Point::new(x - dx, y - dy), Point::new(x + dx, y + dy)].into_iter())
    }
}

impl SketchLayerGaussian {
    pub(crate) fn for_effect(
        doc: &Document,
        node: &Node,
        effect: &Effect,
        matrix: Transform,
    ) -> Option<Self> {
        let [a, b, c, d, tx, ty] = matrix.0;
        if effect.kind != "gaussian-blur"
            || effect.gradient_blur.is_some()
            || doc.color_management.is_some()
            || node.kind != "rectangle"
            || node.mask
            || !node.children.is_empty()
            || node.radii != [0.; 4]
            || node.strokes.iter().any(|stroke| stroke.visible)
            || node.effects.iter().filter(|effect| effect.visible).count() != 1
            || crate::interop::sketch_binding(doc, node, "sketchSourceBlur").is_none()
        {
            return None;
        }
        let mut fills = node.fills.iter().filter(|fill| fill.visible);
        let fill = fills.next()?;
        if fill.kind != "image"
            || fill.opacity != 1.
            || fill.adjust.is_some()
            || fill.transform.is_some()
            || fill.tile.as_ref().is_some_and(|tile| tile.is_active())
            || fill.fit != "stretch"
            || fills.next().is_some()
        {
            return None;
        }
        let size = [node.width, node.height];
        let plan = if b == 0. && c == 0. && a.abs() == d.abs() {
            Self::new(
                size,
                a.abs(),
                effect.radius,
                [tx.min(tx + node.width * a), ty.min(ty + node.height * d)],
                [a < 0., d < 0.],
            )?
        } else {
            let scale = a.hypot(b).round();
            if effect.radius != 1. || !matches!(scale, 1. | 2.) {
                return None;
            }
            let center = matrix.point(Point::new(node.width / 2., node.height / 2.));
            let rotation = Rotation {
                axes: [a, b, c, d].map(|v| v / scale),
                center: [center.x, center.y],
            };
            Self::new(size, scale, effect.radius, [0.; 2], [false; 2])?.with_rotation(rotation)?
        };
        if plan.reads_bitmap()
            && (crate::interop::sketch_binding(doc, node, "sketchSourceBitmap") != Some("true")
                || !fill
                    .image
                    .as_deref()
                    .is_some_and(|uri| plan.can_capture_inline_bitmap(uri)))
        {
            return None;
        }
        Some(plan)
    }

    fn new(
        logical_size: [f64; 2],
        scale: f64,
        radius: f64,
        origin: [f64; 2],
        mirrored: [bool; 2],
    ) -> Option<Self> {
        // Working-grid widths measured against independent Sketch inputs.
        // Interpolation of the widths across authored radii is unsupported.
        let tap_count = match radius {
            1. => 3,
            5. => 9,
            10. => 13,
            20. => 23,
            _ => return None,
        };
        if !matches!(scale, 1. | 2.)
            || logical_size
                .iter()
                .any(|v| !(1. ..=4096.).contains(v) || v.fract() != 0.)
            || origin.iter().any(|v| !(v.abs() <= 1_048_576.))
        {
            return None;
        }
        let phase = origin.map(|coordinate| coordinate - coordinate.floor());
        if phase != [0.; 2] && (radius != 1. || mirrored != [false; 2]) {
            return None;
        }
        let margin = (3. * radius) as usize;
        let logical_size = logical_size.map(|v| v as usize);
        let padded = logical_size.map(|v| v + 2 * margin);
        let work = padded.map(|size| (size * tap_count).div_ceil(2 * radius as usize));
        let output_size = padded.map(|size| size * scale as usize);
        let extent = std::array::from_fn::<_, 2, _>(|axis| {
            output_size[axis] + usize::from(phase[axis] != 0.)
        });
        if work.into_iter().chain(extent).any(|size| size > 8192) {
            return None;
        }
        if work
            .iter()
            .zip(output_size)
            .any(|(&work, output)| work > output && work * 2 != output * 3)
        {
            return None;
        }
        let margin_px = margin as i32 * scale as i32;
        let output = Rect::new(
            origin[0].floor() as i32 - margin_px,
            origin[1].floor() as i32 - margin_px,
            extent[0] as u32,
            extent[1] as u32,
        );
        Some(Self {
            output,
            work,
            logical_size,
            scale: scale as i32,
            margin,
            phase,
            rotation: None,
            mirrored,
            tap_count,
        })
    }

    fn with_rotation(mut self, rotation: Rotation) -> Option<Self> {
        if !rotation.bounded() || self.margin != 3 {
            return None;
        }
        let output = rotation.bounds([self.span(0), self.span(1)]);
        if output.w > 8192 || output.h > 8192 {
            return None;
        }
        self.rotation = Some(rotation);
        self.output = output;
        Some(self)
    }

    pub fn rotates(&self) -> bool {
        self.rotation.is_some()
    }

    pub fn downsample(&self) -> bool {
        self.work[0] > self.span(0)
    }

    pub fn reads_bitmap(&self) -> bool {
        self.phase != [0.; 2] || self.rotates()
    }

    fn can_capture_inline_bitmap(&self, uri: &str) -> bool {
        // The direct capture interpolator models magnification. Minifying an
        // authored bitmap uses an additional high-quality shrink in Sketch.
        // Inspect the already-admitted PNG header without decoding its pixels.
        let Some(prefix) = uri
            .strip_prefix("data:image/png;base64,")
            .and_then(|encoded| encoded.as_bytes().get(..32))
        else {
            return false;
        };
        let mut header = [0u8; 24];
        if !matches!(
            base64::engine::general_purpose::STANDARD.decode_slice(prefix, &mut header),
            Ok(24)
        ) || !header.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
        {
            return false;
        }
        for (axis, size) in header[16..].chunks_exact(4).enumerate() {
            let pixels = u64::from(u32::from_be_bytes([size[0], size[1], size[2], size[3]]));
            let logical = self.logical_size[axis];
            let padded = logical + 2 * self.margin;
            if pixels == 0 || pixels * padded as u64 > (self.work[axis] * logical) as u64 {
                return false;
            }
        }
        true
    }

    pub(crate) fn source_bitmap(
        &self,
        node: &Node,
        images: &mut Images,
    ) -> Result<Option<Arc<Surface>>, String> {
        if !self.reads_bitmap() {
            return Ok(None);
        }
        let source = node
            .fills
            .iter()
            .find(|fill| fill.visible)
            .and_then(|fill| fill.image.as_deref())
            .ok_or("Missing source bitmap for Sketch layer blur")?;
        images.image(source).map(Some)
    }

    pub fn shift_after_shrink(&self) -> bool {
        self.phase != [0.; 2] && self.downsample()
    }

    pub fn phase_bits(&self) -> [u64; 2] {
        self.phase.map(f64::to_bits)
    }

    pub fn rotation_bits(&self) -> Option<[u64; 6]> {
        self.rotation.map(|r| {
            let [a, b, c, d] = r.axes;
            let [x, y] = r.center;
            [a, b, c, d, x, y].map(f64::to_bits)
        })
    }

    pub fn rotation_source_size(&self) -> [usize; 2] {
        if self.downsample() {
            [self.span(0), self.span(1)]
        } else {
            self.work
        }
    }

    fn span(&self, axis: usize) -> usize {
        (self.logical_size[axis] + 2 * self.margin) * self.scale as usize
    }

    fn unshifted_bounds(&self) -> Rect {
        Rect::new(
            self.output.x,
            self.output.y,
            self.span(0) as u32,
            self.span(1) as u32,
        )
    }

    pub fn projection_bounds(&self) -> Rect {
        if self.rotates() {
            Rect::new(0, 0, self.span(0) as u32, self.span(1) as u32)
        } else if self.downsample() {
            self.unshifted_bounds()
        } else {
            self.output
        }
    }

    pub fn projection_source(&self, target: Rect) -> Rect {
        if self.shift_after_shrink() {
            let [dx, dy] = self.phase.map(|phase| i32::from(phase != 0.));
            Rect::new(
                target.x - dx,
                target.y - dy,
                target.w + dx as u32,
                target.h + dy as u32,
            )
            .intersect(self.unshifted_bounds())
        } else {
            target
        }
    }

    fn work_halo(&self) -> i32 {
        (3 * (self.tap_count / 2) + if self.downsample() { 4 } else { 2 }) as i32
            + i32::from(self.reads_bitmap())
    }

    pub fn work_rect(&self, target: Rect) -> Rect {
        let bounds = self.projection_bounds();
        let target = bounds.intersect(target);
        if target.empty() {
            return Rect::default();
        }
        // The work window includes all three box reads and every projection
        // tap. All axis phases remain relative to the complete layer.
        let halo = self.work_halo();
        let range = |start: i32, length: u32, full: u32, work: usize| {
            let first = (start as i64 * work as i64 / i64::from(full)) as i32;
            let end = ((i64::from(start) + i64::from(length)) * work as i64 + i64::from(full) - 1)
                / i64::from(full);
            let lo = (first - halo).max(0);
            let hi = (end as i32 + halo).min(work as i32);
            (lo, (hi - lo) as u32)
        };
        let x_start = if self.mirrored[0] {
            bounds.right() - target.right()
        } else {
            target.x - bounds.x
        };
        let y_start = if self.mirrored[1] {
            target.y - bounds.y
        } else {
            bounds.bottom() - target.bottom()
        };
        let (x, w) = range(x_start, target.w, bounds.w, self.work[0]);
        let (y, h) = range(y_start, target.h, bounds.h, self.work[1]);
        Rect::new(x, y, w, h)
    }

    pub fn projection_rect(&self, target: Rect, work: Rect) -> Rect {
        let target = self.projection_bounds().intersect(target);
        if self.downsample() {
            Rect::new(target.x, work.y, target.w, work.h)
        } else {
            Rect::new(work.x, target.y, work.w, target.h)
        }
    }

    pub fn gpu_bands(&self, input: Rect) -> Vec<[Rect; 4]> {
        let target = self.output.intersect(input);
        if target.empty() {
            return Vec::new();
        }
        if self.rotates() {
            return self.rotation_tiles(target);
        }
        let projection = self.projection_source(target);
        let full = self.work_rect(projection);
        // Two scratch textures of this size use at most 8 MiB in the float
        // compositor. The output layer still uses the ordinary frame pool.
        const SCRATCH_PIXELS: u32 = 262_144;
        if full.pixels() <= SCRATCH_PIXELS as usize {
            return vec![[
                target,
                full,
                self.projection_rect(projection, full),
                projection,
            ]];
        }
        let halo = self.work_halo() as u32 * 2 + 1 + 2 * u32::from(self.shift_after_shrink());
        let height = self.projection_bounds().h;
        let max_useful_rows = (SCRATCH_PIXELS / full.w).saturating_sub(halo);
        let band_height = (max_useful_rows * height / self.work[1] as u32).max(1);
        let work_height =
            ((band_height * self.work[1] as u32).div_ceil(height) + halo).min(self.work[1] as u32);
        (target.y..target.bottom())
            .step_by(band_height as usize)
            .map(|y| {
                let height = band_height.min((target.bottom() - y) as u32);
                let output = Rect::new(target.x, y, target.w, height);
                let projection = self.projection_source(output);
                let work = self.work_rect(projection);
                // A fixed allocation size lets successive strips reuse the same
                // scratch pair. Keep the padded window inside the physical grid.
                let region = Rect::new(
                    work.x,
                    work.y.min(self.work[1] as i32 - work_height as i32),
                    work.w,
                    work_height,
                );
                [
                    output,
                    region,
                    self.projection_rect(projection, region),
                    projection,
                ]
            })
            .collect()
    }

    fn rotation_axes(&self, axis: usize, coordinate: i32) -> [i64; 2] {
        let rotation = self
            .rotation
            .expect("rotation coordinates require a rotation");
        let grid = self.rotation_source_size();
        let distance = coordinate as f64 + 0.5 - rotation.center[axis];
        std::array::from_fn(|component| {
            let mut value = distance
                * (grid[component] as f64 / self.span(component) as f64)
                * rotation.axes[component * 2 + axis];
            if axis == 1 {
                value += (grid[component] as f64 - 1.) / 2.;
            }
            (value * Upscale::UNIT as f64).round() as i64
        })
    }

    fn rotation_tiles(&self, target: Rect) -> Vec<[Rect; 4]> {
        // A rotated strip can read distant rows at its two ends. Bound both
        // axes of the destination tile and reuse fixed-size scratch windows.
        const TILE_SIDE: u32 = 192;
        let grid = self.rotation_source_size();
        let rotation = self.rotation.expect("rotation tiles require a rotation");
        let entire = self.work[0] * self.work[1] <= 262_144;
        let side = if entire {
            target.w.max(target.h)
        } else {
            TILE_SIDE
        };
        let wanted = std::array::from_fn::<_, 2, _>(|axis| {
            let multiplier = (rotation.axes[2 * axis].abs() + rotation.axes[2 * axis + 1].abs())
                * grid[axis] as f64
                / self.span(axis) as f64;
            ((multiplier * side as f64).ceil() as usize + 3).min(grid[axis])
        });
        let work_size = std::array::from_fn::<_, 2, _>(|axis| {
            let length = if self.downsample() {
                (wanted[axis] * self.work[axis]).div_ceil(grid[axis]) + 1
            } else {
                wanted[axis]
            };
            (length + 2 * self.work_halo() as usize).min(self.work[axis])
        });
        let mut tiles = Vec::new();
        for y in (target.y..target.bottom()).step_by(side as usize) {
            for x in (target.x..target.right()).step_by(side as usize) {
                let band = Rect::new(
                    x,
                    y,
                    side.min((target.right() - x) as u32),
                    side.min((target.bottom() - y) as u32),
                );
                let edge = [
                    [
                        self.rotation_axes(0, x),
                        self.rotation_axes(0, band.right() - 1),
                    ],
                    [
                        self.rotation_axes(1, y),
                        self.rotation_axes(1, band.bottom() - 1),
                    ],
                ];
                let lower = std::array::from_fn::<_, 2, _>(|axis| {
                    let start = edge[0][0][axis].min(edge[0][1][axis])
                        + edge[1][0][axis].min(edge[1][1][axis]);
                    start
                        .div_euclid(Upscale::UNIT)
                        .clamp(0, grid[axis] as i64 - 1) as usize
                });
                let footprint = padded_work_rect(lower, wanted, grid);
                let needed = if self.downsample() {
                    self.work_rect(footprint)
                } else {
                    Rect::new(
                        footprint.x,
                        self.work[1] as i32 - footprint.bottom(),
                        footprint.w,
                        footprint.h,
                    )
                    .expand(self.work_halo())
                    .intersect(Rect::new(
                        0,
                        0,
                        self.work[0] as u32,
                        self.work[1] as u32,
                    ))
                };
                let work =
                    padded_work_rect([needed.x as usize, needed.y as usize], work_size, self.work);
                let mid = if self.downsample() {
                    self.projection_rect(footprint, work)
                } else {
                    Rect::default()
                };
                tiles.push([band, work, mid, footprint]);
            }
        }
        tiles
    }

    pub fn capture_origin(&self) -> [i32; 2] {
        let pad = self.margin as i32 * self.scale;
        let mut origin = [self.output.x + pad, self.output.y + pad];
        for (axis, coordinate) in origin.iter_mut().enumerate() {
            if self.mirrored[axis] {
                *coordinate += self.logical_size[axis] as i32 * self.scale - 1;
            }
        }
        origin
    }

    pub fn sampling_scale(&self) -> i32 {
        self.scale
    }

    pub fn capture_step(&self) -> [i32; 2] {
        self.mirrored
            .map(|mirrored| if mirrored { -self.scale } else { self.scale })
    }

    fn project_x(&self, x: i32) -> usize {
        let bounds = self.projection_bounds();
        (if self.mirrored[0] {
            bounds.right() - 1 - x
        } else {
            x - bounds.x
        }) as usize
    }

    fn project_y(&self, y: i32) -> usize {
        let bounds = self.projection_bounds();
        (if self.mirrored[1] {
            y - bounds.y
        } else {
            bounds.bottom() - 1 - y
        }) as usize
    }

    fn capture(&self, axis: usize, i: usize, source_size: usize) -> CaptureSample {
        capture_sample(
            self.work[axis],
            self.margin,
            self.logical_size[axis],
            source_size,
            axis,
            i,
            self.rotates(),
        )
    }

    pub fn parameter_width(&self) -> usize {
        self.work[0]
            .max(self.work[1])
            .max(self.output.w as usize)
            .max(self.output.h as usize)
    }

    pub fn parameter_rows(&self) -> usize {
        if self.rotates() {
            10
        } else {
            8
        }
    }

    pub fn parameters(&self, bitmap_size: Option<[u32; 2]>) -> Result<Vec<f32>, String> {
        let source_size = match bitmap_size {
            Some(size) if size.into_iter().all(|v| v > 0 && v <= 32_768) => {
                size.map(|v| v as usize)
            }
            None if !self.reads_bitmap() => self.logical_size,
            _ => return Err("Invalid Gaussian source bitmap dimensions".to_owned()),
        };
        const CAPTURE_ROWS: usize = 2;
        const ROWS_PER_AXIS: usize = 3;
        let width = self.parameter_width();
        let mut values = vec![0.; width * self.parameter_rows() * 4];
        let mut set = |x: usize, y: usize, value: [f32; 4]| {
            let i = 4 * (y * width + x);
            values[i..i + 4].copy_from_slice(&value);
        };
        let bounds = self.projection_bounds();
        for (axis, output) in [bounds.w as usize, bounds.h as usize]
            .into_iter()
            .enumerate()
        {
            let input = self.work[axis];
            for i in 0..input {
                let c = self.capture(axis, i, source_size[axis]);
                let entry = if self.rotates() {
                    [
                        c.source as f32,
                        c.far as f32,
                        c.weight as f32,
                        (c.alpha + u32::from(c.half_corner) * 256) as f32,
                    ]
                } else {
                    [
                        c.source as f32,
                        c.alpha as f32,
                        f32::from(c.half_corner),
                        0.,
                    ]
                };
                set(i, axis, entry);
            }
            let row = CAPTURE_ROWS + axis * ROWS_PER_AXIS;
            if self.downsample() {
                for i in 0..self.span(axis) {
                    let taps = DownscaleTaps::new(input, self.span(axis), i);
                    for pair in 0..ROWS_PER_AXIS {
                        let index = pair * 2;
                        set(
                            i,
                            row + pair,
                            [
                                taps.indices[index] as f32,
                                taps.weights[index] as f32,
                                taps.indices[index + 1] as f32,
                                taps.weights[index + 1] as f32,
                            ],
                        );
                    }
                }
            } else if !self.rotates() {
                for i in 0..output {
                    let tap = self.upscale_tap(axis, i);
                    set(
                        i,
                        row,
                        [tap.near as f32, tap.far as f32, tap.weight as f32, 0.],
                    );
                }
            }
        }
        if self.rotates() {
            // Store the integer and fractional parts separately so both
            // parts survive upload through f32. The GPU adds the two axes in
            // integer arithmetic and resolves the same phase as the CPU.
            for (axis, (start, end)) in [
                (self.output.x, self.output.right()),
                (self.output.y, self.output.bottom()),
            ]
            .into_iter()
            .enumerate()
            {
                for i in start..end {
                    let [a, b] = self.rotation_axes(axis, i);
                    let unit = Upscale::UNIT;
                    set(
                        (i - start) as usize,
                        8 + axis,
                        [
                            a.div_euclid(unit) as f32,
                            a.rem_euclid(unit) as f32,
                            b.div_euclid(unit) as f32,
                            b.rem_euclid(unit) as f32,
                        ],
                    );
                }
            }
        }
        Ok(values)
    }

    pub(crate) fn validated(&self) -> Option<Self> {
        let radius = self.margin as f64 / 3.;
        if let Some(rotation) = self.rotation {
            return Self::new(
                self.logical_size.map(|size| size as f64),
                f64::from(self.scale),
                radius,
                [0.; 2],
                [false; 2],
            )?
            .with_rotation(rotation);
        }
        let margin_px = i64::try_from(self.margin)
            .ok()?
            .checked_mul(i64::from(self.scale))?;
        Self::new(
            self.logical_size.map(|size| size as f64),
            f64::from(self.scale),
            radius,
            std::array::from_fn(|axis| {
                [self.output.x, self.output.y][axis] as f64 + margin_px as f64 + self.phase[axis]
            }),
            self.mirrored,
        )
    }

    pub(crate) fn apply(
        &self,
        input: &Surface,
        bitmap: Option<&Surface>,
    ) -> Result<Surface, String> {
        let rect = self.output.intersect(input.rect);
        let mut result = input.new_like(input.rect)?;
        if rect.empty() {
            return Ok(result);
        }
        if self.rotates() {
            for [band, work, _, projection] in self.rotation_tiles(rect) {
                self.filter_window(input, bitmap, &mut result, band, work, projection)?;
            }
        } else {
            let projection = self.projection_source(rect);
            self.filter_window(
                input,
                bitmap,
                &mut result,
                rect,
                self.work_rect(projection),
                projection,
            )?;
        }
        Ok(result)
    }

    fn filter_window(
        &self,
        input: &Surface,
        bitmap: Option<&Surface>,
        result: &mut Surface,
        rect: Rect,
        work: Rect,
        projection: Rect,
    ) -> Result<(), String> {
        if projection.empty() {
            return Ok(());
        }
        let (width, height) = (work.w as usize, work.h as usize);
        let count = width
            .checked_mul(height)
            .ok_or("Gaussian raster dimensions overflow")?;
        let _capture = input.reserve_surface::<[u8; 4]>(count)?;
        let _filtered = input.reserve_surface::<[u8; 4]>(count)?;
        let _columns = input.reserve_scratch::<[u32; 4]>(width)?;
        let _axes = input.reserve_scratch::<CaptureSample>(width + height)?;
        let source_size = bitmap.map_or(self.logical_size, |asset| {
            [asset.rect.w as usize, asset.rect.h as usize]
        });
        let columns: Vec<_> = (work.x..work.right())
            .map(|x| self.capture(0, x as usize, source_size[0]))
            .collect();
        let rows: Vec<_> = (work.y..work.bottom())
            .map(|y| self.capture(1, y as usize, source_size[1]))
            .collect();
        let [origin_x, origin_y] = bitmap.map_or_else(
            || self.capture_origin(),
            |asset| [asset.rect.x, asset.rect.y],
        );
        let [step_x, step_y] = bitmap.map_or_else(|| self.capture_step(), |_| [1, 1]);
        let sample = bitmap.unwrap_or(input);
        let read = |x, y| {
            read_bytes(sample.at(origin_x + x as i32 * step_x, origin_y + y as i32 * step_y))
        };
        let mut captured = vec![[0; 4]; count];
        let mut filtered = vec![[0; 4]; count];

        for (y, row) in rows.iter().enumerate() {
            crate::render_cancellation::checkpoint()?;
            for (x, col) in columns.iter().enumerate() {
                if col.alpha == 0 || row.alpha == 0 {
                    continue;
                }
                let vertical = |x| blend(read(x, row.source), read(x, row.far), row.weight);
                let source = if self.rotates() {
                    blend(vertical(col.source), vertical(col.far), col.weight)
                } else {
                    read(col.source, row.source)
                };
                let coverage = if col.half_corner && row.half_corner {
                    64
                } else {
                    col.alpha * row.alpha / 255
                };
                captured[y * width + x] =
                    source.map(|v| ((u32::from(v) * coverage + 127) / 255) as u8);
            }
        }
        for _ in 0..3 {
            box_pass(&captured, &mut filtered, width, height, self.tap_count)?;
            std::mem::swap(&mut captured, &mut filtered);
        }

        let sample =
            |x: usize, y: usize| captured[(y - work.y as usize) * width + x - work.x as usize];
        if self.rotates() && !self.downsample() {
            return self.place_rotated(result, rect, |x, y| sample(x, self.work[1] - 1 - y));
        }
        if self.downsample() {
            if self.reads_bitmap() {
                let mut intermediate = input.new_like(projection)?;
                self.project_down(&captured, &mut intermediate, projection, work)?;
                if self.rotates() {
                    self.place_rotated(result, rect, |x, y| {
                        read_bytes(intermediate.at(x as i32, y as i32))
                    })?;
                } else {
                    self.place_shifted(&intermediate, result, rect)?;
                }
            } else {
                self.project_down(&captured, result, rect, work)?;
            }
            return Ok(());
        }
        for y in rect.y..rect.bottom() {
            crate::render_cancellation::checkpoint()?;
            // The work image is projected in its bottom-to-top coordinates.
            // This keeps the fixed-point phase anchored before a crop.
            let yt = self.upscale_tap(1, self.project_y(y));
            for x in rect.x..rect.right() {
                let xt = self.upscale_tap(0, self.project_x(x));
                let vertical = |col| blend(sample(col, yt.near), sample(col, yt.far), yt.weight);
                let pixel = blend(vertical(xt.near), vertical(xt.far), xt.weight);
                result.pixels[result.rect.index(x, y).expect("blur projection pixel")] =
                    Pixel(pixel.map(|v| f32::from(v) / 255.));
            }
        }
        Ok(())
    }

    fn place_rotated(
        &self,
        result: &mut Surface,
        rect: Rect,
        sample: impl Fn(usize, usize) -> [u8; 4],
    ) -> Result<(), String> {
        let [width, height] = self.rotation_source_size();
        let _coordinates = result.reserve_scratch::<[i64; 2]>(rect.w as usize)?;
        let columns: Vec<_> = (rect.x..rect.right())
            .map(|x| self.rotation_axes(0, x))
            .collect();
        for y in rect.y..rect.bottom() {
            crate::render_cancellation::checkpoint()?;
            let [u, v] = self.rotation_axes(1, y);
            for (x, &[a, b]) in (rect.x..rect.right()).zip(&columns) {
                let xt = Upscale::at(width, a + u);
                let yt = Upscale::at(height, b + v);
                let vertical = |x| blend(sample(x, yt.near), sample(x, yt.far), yt.weight);
                let color = blend(vertical(xt.near), vertical(xt.far), xt.weight);
                result.pixels[result.rect.index(x, y).expect("rotated blur pixel")] =
                    Pixel(color.map(|value| f32::from(value) / 255.));
            }
        }
        Ok(())
    }

    fn upscale_tap(&self, axis: usize, index: usize) -> ProjectionTaps {
        let span = self.span(axis);
        let phase = self.phase[axis];
        let scale = Upscale::new(self.work[axis], span);
        if phase == 0. {
            scale.taps(index)
        } else {
            let offset = if axis == 0 { -phase } else { phase - 1. };
            scale.shifted_taps(index, offset)
        }
    }

    fn place_shifted(
        &self,
        source: &Surface,
        result: &mut Surface,
        rect: Rect,
    ) -> Result<(), String> {
        let [x_taps, y_taps] = self.translation_taps();
        let at = |x, y| {
            source
                .at(x, y)
                .0
                .map(|value| (value * 255.).round_ties_even() as u8)
        };
        for y in rect.y..rect.bottom() {
            crate::render_cancellation::checkpoint()?;
            for x in rect.x..rect.right() {
                let vertical =
                    |x| blend(at(x, y + y_taps[0]), at(x, y + y_taps[1]), y_taps[2] as u32);
                let color = blend(
                    vertical(x + x_taps[0]),
                    vertical(x + x_taps[1]),
                    x_taps[2] as u32,
                );
                result.pixels[result.rect.index(x, y).expect("translated blur pixel")] =
                    Pixel(color.map(|value| f32::from(value) / 255.));
            }
        }
        Ok(())
    }

    pub fn translation_taps(&self) -> [[i32; 3]; 2] {
        std::array::from_fn(|axis| {
            let unit = Upscale::UNIT;
            let phase = self.phase[axis] * unit as f64;
            let fixed = if axis == 0 {
                (phase.ceil() as i64 - 1).max(0)
            } else {
                phase.floor() as i64
            };
            let near = i32::from(fixed >= unit / 2);
            let distance = if near != 0 {
                unit - fixed - i64::from(axis == 1)
            } else {
                fixed
            };
            let bin = ((8 * distance + unit / 2) / unit) as usize;
            [-near, near - 1, [0, 0, 2, 4, 8][bin]]
        })
    }

    fn project_down(
        &self,
        source: &[[u8; 4]],
        result: &mut Surface,
        rect: Rect,
        work: Rect,
    ) -> Result<(), String> {
        let (width, height) = (work.w as usize, work.h as usize);
        let row_len = rect.w as usize;
        let _scratch = result.reserve_surface::<[u8; 4]>(row_len * height)?;
        let _taps = result.reserve_scratch::<DownscaleTaps>(row_len)?;
        let columns: Vec<_> = (rect.x..rect.right())
            .map(|x| DownscaleTaps::new(self.work[0], self.span(0), self.project_x(x)))
            .collect();
        let mut horizontal = vec![[0; 4]; row_len * height];
        for (y, row) in horizontal.chunks_exact_mut(row_len).enumerate() {
            crate::render_cancellation::checkpoint()?;
            for (value, taps) in row.iter_mut().zip(&columns) {
                *value = taps.sample(|x| source[y * width + x - work.x as usize]);
            }
        }
        for y in rect.y..rect.bottom() {
            crate::render_cancellation::checkpoint()?;
            let taps = DownscaleTaps::new(self.work[1], self.span(1), self.project_y(y));
            for (column, x) in (rect.x..rect.right()).enumerate() {
                let mut pixel =
                    taps.sample(|row| horizontal[(row - work.y as usize) * row_len + column]);
                // The negative interpolation lobes can move a color above
                // alpha. The final premultiplied bitmap raises alpha to fit.
                pixel[3] = pixel[3].max(pixel[0]).max(pixel[1]).max(pixel[2]);
                result.pixels[result.rect.index(x, y).expect("blur projection pixel")] =
                    Pixel(pixel.map(|v| f32::from(v) / 255.));
            }
        }
        Ok(())
    }
}

struct CaptureSample {
    source: usize,
    far: usize,
    weight: u32,
    alpha: u32,
    half_corner: bool,
}

fn read_bytes(pixel: Pixel) -> [u8; 4] {
    pixel
        .0
        .map(|value| (value.clamp(0., 1.) * 255.).round_ties_even() as u8)
}

fn padded_work_rect(low: [usize; 2], extent: [usize; 2], domain: [usize; 2]) -> Rect {
    let [x, y] = std::array::from_fn(|axis| low[axis].min(domain[axis] - extent[axis]) as i32);
    Rect::new(x, y, extent[0] as u32, extent[1] as u32)
}

fn capture_sample(
    work_size: usize,
    margin: usize,
    size: usize,
    source_size: usize,
    axis: usize,
    i: usize,
    interpolated: bool,
) -> CaptureSample {
    let padded = size + 2 * margin;
    let density = work_size as f64 / padded as f64;
    let start = margin as f64 * density;
    let stop = work_size as f64 - start;
    let i = if axis == 0 { i } else { work_size - 1 - i };
    let position = i as f64;
    // The bottom-to-top working Y axis reverses the horizontal tie rule.
    let offset = ((2 * i + 1) * padded) as i64 - (2 * work_size * margin) as i64;
    let numerator = offset * source_size as i64 - i64::from(axis == 0);
    let index = numerator.div_euclid((2 * work_size * size) as i64);
    let source = index.clamp(0, source_size as i64 - 1) as usize;
    let coverage = ((position + 1.).min(stop) - position.max(start)).clamp(0., 1.);
    let trailing = position >= stop.floor();
    let taps = if interpolated {
        let position = (offset as f64 * source_size as f64 / (2 * work_size * size) as f64 - 0.5)
            * Upscale::UNIT as f64;
        let fixed = if axis == 0 {
            position.ceil() as i64 - 1
        } else {
            position.floor() as i64
        };
        Upscale::at(source_size, fixed)
    } else {
        ProjectionTaps {
            near: source,
            far: source,
            weight: 0,
        }
    };
    CaptureSample {
        source: taps.near,
        far: taps.far,
        weight: taps.weight,
        alpha: edge_alpha(coverage, axis == 1 && !trailing),
        half_corner: coverage == 0.5 && (trailing == (axis == 0)),
    }
}

fn edge_alpha(coverage: f64, upper_half: bool) -> u32 {
    if coverage == 0.5 {
        return if upper_half { 128 } else { 127 };
    }
    (coverage * 255.).round_ties_even() as u32
}

fn box_pass(
    source: &[[u8; 4]],
    output: &mut [[u8; 4]],
    width: usize,
    height: usize,
    taps: usize,
) -> Result<(), String> {
    let reach = taps / 2;
    let divisor = (taps * taps) as u32;
    let mut columns = vec![[0_u32; 4]; width];
    for y in 0..taps {
        let offset = y.saturating_sub(reach).min(height - 1) * width;
        for (x, column) in columns.iter_mut().enumerate() {
            for (sum, sample) in column.iter_mut().zip(source[offset + x]) {
                *sum += u32::from(sample);
            }
        }
    }
    for y in 0..height {
        crate::render_cancellation::checkpoint()?;
        let mut sum = [0_u32; 4];
        for x in 0..taps {
            for (total, sample) in sum
                .iter_mut()
                .zip(columns[x.saturating_sub(reach).min(width - 1)])
            {
                *total += sample;
            }
        }
        let remove_row = y.saturating_sub(reach) * width;
        let add_row = (y + reach + 1).min(height - 1) * width;
        for x in 0..width {
            output[y * width + x] = sum.map(|total| ((total + divisor / 2) / divisor) as u8);
            let remove = x.saturating_sub(reach);
            let add = (x + reach + 1).min(width - 1);
            for c in 0..4 {
                sum[c] = sum[c] + columns[add][c] - columns[remove][c];
            }
        }
        for (x, column) in columns.iter_mut().enumerate() {
            for (c, total) in column.iter_mut().enumerate() {
                *total = *total + u32::from(source[add_row + x][c])
                    - u32::from(source[remove_row + x][c]);
            }
        }
    }
    Ok(())
}

struct Upscale {
    input: usize,
    step: i64,
}

struct ProjectionTaps {
    near: usize,
    far: usize,
    weight: u32,
}

impl Upscale {
    const UNIT: i64 = 1 << 24;

    fn new(input: usize, output: usize) -> Self {
        let step = (input as i64 * Self::UNIT + output as i64 / 2) / output as i64;
        Self { input, step }
    }

    fn taps(&self, index: usize) -> ProjectionTaps {
        let position = ((2 * index as i64 + 1) * self.step - Self::UNIT).div_euclid(2);
        Self::at(self.input, position)
    }

    fn shifted_taps(&self, index: usize, offset: f64) -> ProjectionTaps {
        let position = (index as f64 + 0.5 + offset) * self.step as f64 - (Self::UNIT / 2) as f64;
        Self::at(self.input, position.ceil() as i64 - 1)
    }

    fn at(input: usize, position: i64) -> ProjectionTaps {
        let left = position.div_euclid(Self::UNIT);
        let fractional = position.rem_euclid(Self::UNIT);
        let min = fractional.min(Self::UNIT - fractional);
        let phase = ((8 * min + Self::UNIT / 2) / Self::UNIT) as usize;
        let (near, far) = if fractional < Self::UNIT / 2 {
            (left, left + 1)
        } else {
            (left + 1, left)
        };
        let clamp = |index: i64| index.clamp(0, input as i64 - 1) as usize;
        ProjectionTaps {
            near: clamp(near),
            far: clamp(far),
            weight: [0, 1, 2, 4, 8][phase],
        }
    }
}

fn blend(near: [u8; 4], far: [u8; 4], weight: u32) -> [u8; 4] {
    std::array::from_fn(|i| {
        let a = u32::from(near[i]);
        let b = u32::from(far[i]);
        (a + b * weight / 16 - a * weight / 16) as u8
    })
}

struct DownscaleTaps {
    indices: [usize; 6],
    weights: [i32; 6],
}

impl DownscaleTaps {
    const UNIT: i32 = 1 << 14;
    // Six signed taps for the 3:2 shrink. Each tap has an even-phase
    // polynomial and reciprocal-span corrections measured on independent
    // resampling probes. The odd phase reflects both the phase and texels.
    const COEFFICIENTS: [[[f64; 8]; 4]; 6] = [
        [
            [
                -5.650570678313e-02,
                1.116886433067e-02,
                5.598252065541e-02,
                -2.541297194977e-02,
                -1.119256503841e-02,
                8.463767434032e-03,
                -2.113739332154e-04,
                -5.886748199167e-04,
            ],
            [
                1.389194755316e-04,
                -3.387512586941e-03,
                4.305633467369e-04,
                3.953147447411e-03,
                -5.962696486543e-03,
                7.018866817847e-03,
                -4.976731991865e-03,
                1.421482283147e-03,
            ],
            [
                5.540877329290e-05,
                -4.511102201492e-05,
                5.090983254558e-04,
                -2.883038468915e-03,
                7.257635783771e-03,
                -9.748090059473e-03,
                6.686375386134e-03,
                -1.831765939235e-03,
            ],
            [
                -4.419035027858e-07,
                7.582953493381e-06,
                -9.561690575975e-05,
                5.191598493581e-04,
                -1.358332896777e-03,
                1.857670398836e-03,
                -1.275926475557e-03,
                3.469982949561e-04,
            ],
        ],
        [
            [
                2.260231001553e-01,
                -2.943552466893e-01,
                5.822262667943e-03,
                8.233167945288e-02,
                -3.180495710913e-03,
                -2.693804470411e-02,
                1.185370882406e-02,
                -1.556907555940e-03,
            ],
            [
                2.857256464432e-03,
                4.133924857687e-03,
                -2.854407901315e-03,
                -2.932268008180e-03,
                1.623821706028e-03,
                8.601718626519e-04,
                -7.378736932848e-04,
                1.210838414732e-04,
            ],
            [
                -5.769336197504e-05,
                3.270244946527e-05,
                -1.726372654393e-04,
                1.164112706883e-03,
                -2.922470133958e-03,
                4.097969556771e-03,
                -3.071742369465e-03,
                9.420373410843e-04,
            ],
            [
                6.955359815987e-07,
                -7.437229465783e-06,
                5.955299157617e-05,
                -2.812843618720e-04,
                7.209220300093e-04,
                -1.024542611209e-03,
                7.565217227012e-04,
                -2.251454460551e-04,
            ],
        ],
        [
            [
                6.609650777050e-01,
                1.502634002841e-05,
                -1.051597738303e-01,
                4.644889009433e-03,
                2.404299436273e-02,
                -3.886820802887e-04,
                -7.229486112399e-03,
                2.302468640229e-03,
            ],
            [
                -5.991931152183e-03,
                1.144654180368e-03,
                4.314472763517e-03,
                -5.074660722936e-03,
                9.288166164349e-03,
                -1.411647075212e-02,
                1.044436338851e-02,
                -2.958497985473e-03,
            ],
            [
                5.137120932243e-05,
                2.304758831033e-05,
                -6.814525701030e-04,
                3.428157579000e-03,
                -9.075642868592e-03,
                1.264446624757e-02,
                -8.793435495242e-03,
                2.407341763370e-03,
            ],
            [
                -1.834436691415e-06,
                1.321070145317e-05,
                -2.708902805949e-05,
                -1.167890609781e-04,
                5.934764123824e-04,
                -9.817599377780e-04,
                7.074466085555e-04,
                -1.867397722318e-04,
            ],
        ],
        [
            [
                2.260228805814e-01,
                2.943605098714e-01,
                5.541221544573e-03,
                -7.931272952931e-02,
                -7.384644456133e-03,
                2.672151152886e-02,
                -9.504482863525e-03,
                9.555923896295e-04,
            ],
            [
                2.856874031658e-03,
                -3.340065072954e-03,
                -1.602042345565e-03,
                7.442494930482e-04,
                4.451739224271e-03,
                -7.000453790797e-03,
                4.642882433643e-03,
                -1.220274407006e-03,
            ],
            [
                -5.658938459211e-05,
                1.541064950411e-05,
                -9.428005950277e-05,
                8.428245757500e-04,
                -2.333481053938e-03,
                3.106070203489e-03,
                -2.001705441117e-03,
                4.932885808232e-04,
            ],
            [
                2.704766134993e-07,
                3.301842309725e-06,
                -1.752799773775e-05,
                4.021472971429e-05,
                -7.486716766617e-05,
                1.323312112632e-04,
                -1.447691079354e-04,
                6.174117374666e-05,
            ],
        ],
        [
            [
                -5.650568060791e-02,
                -1.117751767339e-02,
                5.605912772902e-02,
                2.438470647585e-02,
                -9.041260560853e-03,
                -8.490468708003e-03,
                5.968907816609e-03,
                -1.197921353614e-03,
            ],
            [
                1.397727272474e-04,
                3.244324332295e-03,
                6.138430895322e-04,
                2.523545200228e-05,
                -3.608278296842e-03,
                5.265642669051e-03,
                -3.584769491095e-03,
                9.772329336430e-04,
            ],
            [
                5.383279965002e-05,
                -9.221289872591e-06,
                7.486162824322e-05,
                -8.449802082448e-04,
                2.402973820340e-03,
                -3.368146508481e-03,
                2.346389167895e-03,
                -6.457749499153e-04,
            ],
            [
                -2.454053692720e-08,
                -8.075768538678e-06,
                3.462043121626e-05,
                -7.418983256403e-05,
                8.525725077433e-05,
                -5.962754014709e-05,
                3.347931029561e-05,
                -1.236239095814e-05,
            ],
        ],
        [
            [
                3.289494156340e-07,
                -1.163617937923e-05,
                -1.824535876665e-02,
                -6.635573459054e-03,
                6.755971403662e-03,
                6.319165293669e-04,
                -8.772737315441e-04,
                8.544269969639e-05,
            ],
            [
                -8.915466619672e-07,
                -1.795325710599e-03,
                -9.024289528015e-04,
                3.284296339033e-03,
                -5.792752312063e-03,
                7.972243194396e-03,
                -5.787870646725e-03,
                1.658973334432e-03,
            ],
            [
                -4.633003571837e-05,
                -1.682837530587e-05,
                3.644099413735e-04,
                -1.707076184862e-03,
                4.670984453116e-03,
                -6.732269441034e-03,
                4.834118752678e-03,
                -1.365126796294e-03,
            ],
            [
                1.334868141116e-06,
                -8.582499281444e-06,
                4.606050878147e-05,
                -8.711132356002e-05,
                3.354437105814e-05,
                7.592847928223e-05,
                -7.675205824815e-05,
                1.550814063095e-05,
            ],
        ],
    ];

    fn new(input: usize, output: usize, index: usize) -> Self {
        let mirrored = index % 2 != 0;
        let phase = if mirrored { output - 1 - index } else { index };
        let span = (output - 1) as f64;
        let position = phase as f64 / span;
        let reciprocal_span = 40. / span;
        let weights = Self::COEFFICIENTS.map(|tap| {
            tap.iter().rev().fold(0., |weight, polynomial| {
                weight * reciprocal_span
                    + polynomial
                        .iter()
                        .rev()
                        .fold(0., |value, coefficient| value * position + coefficient)
            })
        });
        let normalize = f64::from(Self::UNIT) / weights.iter().sum::<f64>();
        let mut weights = weights.map(|weight| (weight * normalize).round_ties_even() as i32);
        weights[2] += Self::UNIT - weights.iter().sum::<i32>();
        let start = (3 * (phase / 2)) as isize - 2;
        let indices = std::array::from_fn(|offset| {
            let location = (start + offset as isize).clamp(0, input as isize - 1) as usize;
            if mirrored {
                input - 1 - location
            } else {
                location
            }
        });
        Self { indices, weights }
    }

    fn sample(&self, mut load: impl FnMut(usize) -> [u8; 4]) -> [u8; 4] {
        let mut totals = [0; 4];
        for (&index, &weight) in self.indices.iter().zip(&self.weights) {
            for (total, sample) in totals.iter_mut().zip(load(index)) {
                *total += i32::from(sample) * weight;
            }
        }
        totals.map(|total| ((total + Self::UNIT / 2) / Self::UNIT).clamp(0, 255) as u8)
    }
}
