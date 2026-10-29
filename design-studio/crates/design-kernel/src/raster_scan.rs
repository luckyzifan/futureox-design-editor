//! Shared scan conversion for CPU coverage and GPU interval programs.
//! Edge differences are cached, but the original binary64 intersection operation
//! order is retained. In particular, incremental x += slope would change pixels.
use super::*;

pub(super) const MAX_SCANLINE_EDGE_VISITS: u64 = 8_000_000;

#[derive(Clone, Copy)]
pub(super) struct Edge {
    pub a: Point,
    pub b: Point,
    pub sign: i32,
    dx: f64,
    dy: f64,
}
impl Edge {
    fn crossing(self, y: f64) -> f64 {
        self.a.x + (y - self.a.y) * self.dx / self.dy
    }
}

fn edge(
    a: Point,
    b: Point,
    rect: Rect,
    samples: u32,
    visits: &mut u64,
    max: u64,
) -> Result<Option<Edge>, String> {
    if a.y == b.y || (samples == 8 && (a.y - b.y).abs() < 1e-14) {
        return Ok(None);
    }
    let low = a.y.min(b.y).max(f64::from(rect.y));
    let high = a.y.max(b.y).min(f64::from(rect.bottom()));
    if high <= low {
        return Ok(None);
    }
    let (a, b, sign) = if a.y < b.y { (a, b, 1) } else { (b, a, -1) };
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if !dx.is_finite() || !dy.is_finite() {
        return Err("Non-finite scanline interpolation".into());
    }
    for y in [low, high] {
        let offset = y - a.y;
        let product = offset * dx;
        let quotient = product / dy;
        let crossing = a.x + quotient;
        if [offset, product, quotient, crossing]
            .iter()
            .any(|x| !x.is_finite())
        {
            return Err("Non-finite scanline interpolation".into());
        }
    }
    let rows = u64::from(rect.h) * u64::from(samples);
    let count = (((high - low) * f64::from(samples)).ceil() as u64 + 1).min(rows);
    *visits = visits.saturating_add(count);
    if *visits > max {
        return Err("Scanline work budget exceeded".into());
    }
    Ok(Some(Edge { a, b, sign, dx, dy }))
}

#[derive(Clone, Copy)]
struct ActiveEdge {
    index: usize,
    order: usize,
    x: f64,
}
fn active_order(a: &ActiveEdge, b: &ActiveEdge) -> std::cmp::Ordering {
    a.x.total_cmp(&b.x).then_with(|| a.order.cmp(&b.order))
}

/// Reused within one painter. No document identity or rendered coverage is cached.
#[derive(Default)]
pub struct RasterWorkspace {
    edges: Vec<Edge>,
    buckets: Vec<(usize, usize)>,
    links: Vec<usize>,
    active: Vec<ActiveEdge>,
    next_order: usize,
    vertical_only: bool,
}
impl RasterWorkspace {
    fn prepare(
        &mut self,
        cs: &[Contour],
        rect: Rect,
        samples: u32,
        max: u64,
    ) -> Result<(), String> {
        self.edges.clear();
        self.active.clear();
        self.next_order = 0;
        self.vertical_only = true;
        let mut vertical_x = None;
        let mut visits = 0;
        // Called after point/clip validation, including the rectangle fast path.
        for c in cs.iter().filter(|c| c.closed && c.points.len() >= 3) {
            checkpoint()?;
            for (i, &a) in c.points.iter().enumerate() {
                if i % 256 == 0 {
                    checkpoint()?;
                }
                if let Some(e) = edge(
                    a,
                    c.points[(i + 1) % c.points.len()],
                    rect,
                    samples,
                    &mut visits,
                    max,
                )? {
                    self.vertical_only &= e.a.x == e.b.x && vertical_x.is_none_or(|x| x == e.a.x);
                    vertical_x.get_or_insert(e.a.x);
                    self.edges.push(e);
                }
            }
        }
        Ok(())
    }

    fn activate(&mut self, index: usize) {
        self.active.push(ActiveEdge {
            index,
            order: self.next_order,
            x: 0.,
        });
        self.next_order += 1;
    }

    fn order_active(&mut self, y: f64) -> Result<(), String> {
        for (i, active) in self.active.iter_mut().enumerate() {
            if i % 256 == 0 {
                checkpoint()?;
            }
            active.x = self.edges[active.index].crossing(y);
        }
        // Like tiny-skia's active-edge repair, exploit order from the preceding
        // row. Recompute x with the original formula; never accumulate slope.
        // Authored activation order resolves ties exactly like the old stable
        // full sort. Bound insertion work before falling back on complex paths.
        let limit = self.active.len().saturating_mul(4);
        let mut moves = 0;
        for i in 1..self.active.len() {
            if i % 256 == 0 {
                checkpoint()?;
            }
            let value = self.active[i];
            let mut j = i;
            while j > 0 && active_order(&self.active[j - 1], &value).is_gt() {
                self.active[j] = self.active[j - 1];
                j -= 1;
                moves += 1;
                if moves % 1024 == 0 {
                    checkpoint()?;
                }
                if moves > limit {
                    self.active[j] = value;
                    self.active.sort_unstable_by(active_order);
                    return checkpoint();
                }
            }
            self.active[j] = value;
        }
        checkpoint()
    }

    pub(super) fn sample_spans(
        &mut self,
        cs: &[Contour],
        rect: Rect,
        even_odd: bool,
        sample: Option<usize>,
        mut emit: impl FnMut(u32, f64, f64) -> Result<bool, String>,
    ) -> Result<bool, String> {
        validate_sample(sample)?;
        if u64::from(rect.h) * 4 > MAX_SCANLINE_EDGE_VISITS {
            return Err("Scanline row budget exceeded".into());
        }
        let mut indices = [0, 1, 2, 3];
        indices.sort_by(|&a, &b| {
            crate::fidelity::SAMPLE_OFFSETS[a]
                .1
                .total_cmp(&crate::fidelity::SAMPLE_OFFSETS[b].1)
        });
        if let Some([x0, y0, x1, y1]) = crate::coverage::rectangle(cs) {
            for y in rect.y..rect.bottom() {
                checkpoint()?;
                for index in indices {
                    if sample.is_some_and(|s| s != index) {
                        continue;
                    }
                    let py = f64::from(y) + crate::fidelity::SAMPLE_OFFSETS[index].1;
                    if py >= y0 && py < y1 && !emit((y - rect.y) as u32 * 4 + index as u32, x0, x1)?
                    {
                        return Ok(false);
                    }
                }
            }
            return Ok(true);
        }
        self.prepare(cs, rect, 4, MAX_SCANLINE_EDGE_VISITS)?;
        // A common vertical supporting line cannot enclose horizontal area.
        // Admission above still counts every authored edge, including retraces.
        if self.vertical_only {
            return Ok(true);
        }
        self.edges.sort_by(|a, b| a.a.y.total_cmp(&b.a.y));
        let mut next = 0;
        for y in rect.y..rect.bottom() {
            for index in indices {
                if sample.is_some_and(|s| s != index) {
                    continue;
                }
                // Also runs on empty/retraced rows, before any output callback.
                checkpoint()?;
                let py = f64::from(y) + crate::fidelity::SAMPLE_OFFSETS[index].1;
                self.active.retain(|a| self.edges[a.index].b.y > py);
                while next < self.edges.len() && self.edges[next].a.y <= py {
                    if next % 256 == 0 {
                        checkpoint()?;
                    }
                    if self.edges[next].b.y > py {
                        self.activate(next);
                    }
                    next += 1;
                }
                self.order_active(py)?;
                if !emit_crossings(
                    self.active.iter().map(|a| (a.x, self.edges[a.index].sign)),
                    even_odd,
                    |l, r| emit((y - rect.y) as u32 * 4 + index as u32, l, r),
                )? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    pub(super) fn area_spans(
        &mut self,
        cs: &[Contour],
        rect: Rect,
        even_odd: bool,
        mut emit: impl FnMut(u32, f64, f64) -> Result<bool, String>,
    ) -> Result<bool, String> {
        let rows = u64::from(rect.h) * 8;
        if rows > MAX_SCANLINE_EDGE_VISITS {
            return Err("Scanline row budget exceeded".into());
        }
        self.prepare(cs, rect, 8, MAX_SCANLINE_EDGE_VISITS)?;
        if self.vertical_only {
            return Ok(true);
        }
        self.buckets.clear();
        self.buckets.resize(rows as usize, (usize::MAX, usize::MAX));
        self.links.clear();
        self.links.resize(self.edges.len(), usize::MAX);
        for (i, e) in self.edges.iter().enumerate() {
            if i % 256 == 0 {
                checkpoint()?;
            }
            let first = ((e.a.y - f64::from(rect.y)) * 8. - 0.5).ceil().max(0.) as usize;
            if first < self.buckets.len() {
                let (head, tail) = &mut self.buckets[first];
                if *tail == usize::MAX {
                    *head = i;
                } else {
                    self.links[*tail] = i;
                }
                *tail = i;
            }
        }
        for row in 0..self.buckets.len() {
            checkpoint()?;
            let y = f64::from(rect.y) + (row as f64 + 0.5) / 8.;
            self.active.retain(|a| self.edges[a.index].b.y > y);
            let mut at = self.buckets[row].0;
            while at != usize::MAX {
                if at % 256 == 0 {
                    checkpoint()?;
                }
                if self.edges[at].b.y > y {
                    self.activate(at);
                }
                at = self.links[at];
            }
            self.order_active(y)?;
            if !emit_crossings(
                self.active.iter().map(|a| (a.x, self.edges[a.index].sign)),
                even_odd,
                |l, r| {
                    let left = l.max(f64::from(rect.x));
                    let right = r.min(f64::from(rect.right()));
                    if right <= left {
                        Ok(true)
                    } else {
                        emit(row as u32, left, right)
                    }
                },
            )? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn emit_crossings(
    crossings: impl Iterator<Item = (f64, i32)>,
    even_odd: bool,
    mut emit: impl FnMut(f64, f64) -> Result<bool, String>,
) -> Result<bool, String> {
    let mut winding = 0_i64;
    let mut left = 0.;
    for (i, (right, sign)) in crossings.enumerate() {
        if i % 256 == 0 {
            checkpoint()?;
        }
        let before = if even_odd {
            winding % 2 != 0
        } else {
            winding != 0
        };
        winding += i64::from(sign);
        let after = if even_odd {
            winding % 2 != 0
        } else {
            winding != 0
        };
        if !before && after {
            left = right;
        } else if before && !after && !emit(left, right)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) fn check_work(cs: &[Contour], rect: Rect, samples: u32, max: u64) -> Result<(), String> {
    RasterWorkspace::default().prepare(cs, rect, samples, max)
}
