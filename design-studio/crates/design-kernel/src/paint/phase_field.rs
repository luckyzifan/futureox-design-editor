//! Lossless four-phase gradient parameters. The original coordinate/stop
//! sampler owns every value. Integer predictions only encode exact bit
//! residuals; exceptions store the original words. No color is cached here.
use super::GradientCoordinates;
use crate::{
    math::{Point, Rect, Transform},
    scene::Paint,
};
use std::collections::HashMap;

pub const MAGIC: u32 = 0x47504631;
pub const WIDTH: usize = 2048;
pub const LIMIT: usize = 32 * 1024 * 1024 / 4;
const HEADER: usize = 8;
const SIDE: usize = 8;
const PIXELS: usize = 64;

pub struct Builder {
    rect: Rect,
    coordinates: GradientCoordinates,
    tiles_x: usize,
    tiles_y: usize,
    base: Vec<u32>,
    words: Vec<u32>,
    constants: HashMap<u32, u32>,
    next: usize,
    stage: u8,
    limit: usize,
}
impl Builder {
    pub fn new(
        rect: Rect,
        matrix: Transform,
        size: [f64; 2],
        paint: &Paint,
    ) -> Result<Self, String> {
        Self::with_limit(rect, matrix, size, paint, LIMIT)
    }
    fn with_limit(
        rect: Rect,
        matrix: Transform,
        size: [f64; 2],
        paint: &Paint,
        limit: usize,
    ) -> Result<Self, String> {
        if paint.stops.len() > 3
            || !matches!(
                paint.kind.as_str(),
                "linear" | "radial" | "angular" | "diamond"
            )
        {
            return Err("Unsupported gradient phase field".into());
        }
        i32::try_from(i64::from(rect.x) + i64::from(rect.w))
            .map_err(|_| "Parameter field horizontal bounds overflow")?;
        i32::try_from(i64::from(rect.y) + i64::from(rect.h))
            .map_err(|_| "Parameter field vertical bounds overflow")?;
        let count = (rect.w as usize)
            .checked_mul(rect.h as usize)
            .ok_or("Parameter field size overflow")?;
        if count > 4_194_304 {
            return Err("Parameter field exceeds 64 MiB".into());
        }
        let coordinates = GradientCoordinates::new(paint, size, matrix, rect)?;
        let tiles_x = (rect.w as usize).div_ceil(SIDE);
        let tiles_y = (rect.h as usize).div_ceil(SIDE);
        let head = HEADER + tiles_x * tiles_y;
        let mut result = Self {
            rect,
            coordinates,
            tiles_x,
            tiles_y,
            base: Vec::new(),
            words: Vec::new(),
            constants: HashMap::new(),
            next: 0,
            stage: 0,
            limit: limit.min(LIMIT),
        };
        if count == 0 || head > result.limit {
            result.decline();
            return Ok(result);
        }
        result
            .base
            .try_reserve_exact(count)
            .map_err(|_| "Parameter field allocation failed")?;
        let reserve = head
            .saturating_add(count.saturating_mul(2))
            .min(result.limit);
        result
            .words
            .try_reserve_exact(reserve)
            .map_err(|_| "Parameter field allocation failed")?;
        result.words.resize(head, 0);
        result.words[..HEADER].copy_from_slice(&[
            MAGIC,
            rect.w,
            rect.h,
            tiles_x as u32,
            tiles_y as u32,
            WIDTH as u32,
            0,
            0,
        ]);
        Ok(result)
    }
    fn decline(&mut self) {
        self.stage = 3;
        self.base = Vec::new();
        self.words = Vec::new();
        self.constants.clear();
    }
    fn reserve(&mut self, count: usize) -> Result<bool, String> {
        let end = self
            .words
            .len()
            .checked_add(count)
            .ok_or("Parameter field size overflow")?;
        if end > self.limit {
            self.decline();
            return Ok(false);
        }
        if end > self.words.capacity() {
            let capacity = end
                .max(
                    self.words
                        .capacity()
                        .saturating_add(self.words.capacity() / 2),
                )
                .min(self.limit);
            self.words
                .try_reserve_exact(capacity - self.words.len())
                .map_err(|_| "Parameter field allocation failed")?;
        }
        Ok(true)
    }
    fn sample(&self, x: usize, y: usize, phase: usize) -> Result<u32, String> {
        let offset = crate::fidelity::SAMPLE_OFFSETS[phase];
        let point = Point::new(
            f64::from(self.rect.x) + x as f64 + offset.0,
            f64::from(self.rect.y) + y as f64 + offset.1,
        );
        encode(self.coordinates.locate(point))
    }
    fn base_at(&self, x: i32, y: i32) -> u32 {
        let x = x.clamp(0, self.rect.w as i32 - 1) as usize;
        let y = y.clamp(0, self.rect.h as i32 - 1) as usize;
        self.base[y * self.rect.w as usize + x]
    }
    fn predictions(&self, x: usize, y: usize) -> Option<[u32; 3]> {
        let x = x as i32;
        let y = y as i32;
        let q = self.base_at(x, y);
        predict(
            q,
            [
                self.base_at(x + 1, y),
                self.base_at(x, y + 1),
                self.base_at(x + 1, y + 1),
                self.base_at(x - 1, y),
                self.base_at(x - 1, y + 1),
            ],
        )
    }
    /// Bounded CPU work; callers yield/check generation between these steps.
    /// A single invocation evaluates at most 8192 original sample positions.
    pub fn advance(&mut self) -> Result<bool, String> {
        if self.stage >= 2 {
            return Ok(true);
        }
        crate::render_cancellation::checkpoint()?;
        if self.stage == 0 {
            let count = self.rect.w as usize * self.rect.h as usize;
            let end = (self.next + 8192).min(count);
            for i in self.next..end {
                self.base.push(self.sample(
                    i % self.rect.w as usize,
                    i / self.rect.w as usize,
                    0,
                )?);
            }
            self.next = end;
            if end == count {
                self.stage = 1;
                self.next = 0;
            }
            return Ok(false);
        }
        let end = (self.next + 32).min(self.tiles_x * self.tiles_y);
        while self.next < end {
            let tile = self.next;
            self.next += 1;
            if !self.append_tile(tile)? {
                return Ok(true);
            }
        }
        if self.next == self.tiles_x * self.tiles_y {
            let padded = self.words.len().div_ceil(WIDTH) * WIDTH;
            if self.reserve(padded - self.words.len())? {
                self.words[6] = self.words.len() as u32;
                self.words.resize(padded, 0);
                self.base = Vec::new();
                self.constants.clear();
                self.stage = 2;
            }
            return Ok(true);
        }
        Ok(false)
    }
    fn append_tile(&mut self, tile: usize) -> Result<bool, String> {
        let tx = tile % self.tiles_x * SIDE;
        let ty = tile / self.tiles_x * SIDE;
        let mut values = [[0_u32; 4]; PIXELS];
        let mut residuals = [[0_i32; 3]; PIXELS];
        let mut bad8 = [false; PIXELS];
        let mut bad16 = [false; PIXELS];
        for i in 0..PIXELS {
            let x = (tx + i % SIDE).min(self.rect.w as usize - 1);
            let y = (ty + i / SIDE).min(self.rect.h as usize - 1);
            values[i][0] = self.base_at(x as i32, y as i32);
            for phase in 1..4 {
                values[i][phase] = self.sample(x, y, phase)?;
            }
            if let Some(predictions) = self.predictions(x, y) {
                for phase in 0..3 {
                    let delta = i64::from(values[i][phase + 1]) - i64::from(predictions[phase]);
                    bad8[i] |= !(-127..=127).contains(&delta);
                    bad16[i] |= !(-32767..=32767).contains(&delta);
                    residuals[i][phase] = delta as i32;
                }
            } else {
                bad8[i] = true;
                bad16[i] = true;
            }
        }
        let constant = values.iter().flatten().all(|v| *v == values[0][0]);
        if constant {
            let code = values[0][0];
            let offset = if let Some(&known) = self.constants.get(&code) {
                known
            } else {
                if !self.reserve(1)? {
                    return Ok(false);
                }
                let offset = self.words.len() as u32;
                self.words.push(code);
                if self.constants.len() < 1024 {
                    self.constants.insert(code, offset);
                }
                offset
            };
            self.words[HEADER + tile] = (3 << 30) | offset;
            return Ok(true);
        }
        let costs = [
            114 + 3 * bad8.iter().filter(|v| **v).count(),
            162 + 3 * bad16.iter().filter(|v| **v).count(),
            256,
        ];
        let mode = (0..3).min_by_key(|m| costs[*m]).unwrap();
        if !self.reserve(costs[mode])? {
            return Ok(false);
        }
        let start = self.words.len();
        self.words[HEADER + tile] = ((mode as u32) << 30) | start as u32;
        if mode == 2 {
            for pixel in values {
                self.words.extend(pixel);
            }
            return Ok(true);
        }
        let bad = if mode == 0 { bad8 } else { bad16 };
        let bits = if mode == 0 { 8 } else { 16 };
        let mask = [0_u32; 2];
        self.words.extend(mask);
        for pixel in values {
            self.words.push(pixel[0]);
        }
        let delta_start = self.words.len();
        self.words
            .resize(delta_start + if mode == 0 { 48 } else { 96 }, 0);
        for i in 0..PIXELS {
            if bad[i] {
                self.words[start + i / 32] |= 1 << (i % 32);
                self.words.extend_from_slice(&values[i][1..]);
            } else {
                for phase in 0..3 {
                    let index = i * 3 + phase;
                    let per_word = 32 / bits;
                    self.words[delta_start + index / per_word] |= ((residuals[i][phase] as u32)
                        & ((1 << bits) - 1))
                        << ((index % per_word) * bits);
                }
            }
        }
        Ok(true)
    }
    pub fn finish(&mut self) -> Result<Vec<u32>, String> {
        if self.stage < 2 {
            return Err("Gradient phase field is incomplete".into());
        }
        Ok(std::mem::take(&mut self.words))
    }
}
fn encode(value: Option<(usize, usize, f32)>) -> Result<u32, String> {
    let Some((a, b, k)) = value else {
        return Ok(0x40a00000);
    };
    if a == b && a <= 2 && k.to_bits() == 0 {
        return Ok(0x40000000 + ((a as u32) << 22));
    }
    if a <= 1 && b == a + 1 && k.is_finite() && (0. ..=1.).contains(&k) && k.to_bits() >> 31 == 0 {
        return Ok(k.to_bits() | ((a as u32) << 31));
    }
    Err("Invalid gradient phase tuple".into())
}
fn predict(q: u32, neighbours: [u32; 5]) -> Option<[u32; 3]> {
    let d = neighbours.map(|v| i64::from(v) - i64::from(q));
    if d.iter().any(|v| v.abs() > 0x3fffff) {
        return None;
    }
    let [dx, dy, dxy, dl, dly] = d;
    Some(
        [
            (3 * dx + dy + dxy) / 8,
            (dl + dly + 3 * dy) / 8,
            (dx + 9 * dy + 3 * dxy) / 16,
        ]
        .map(|v| (i64::from(q) + v) as u32),
    )
}

#[cfg(test)]
mod tests;
