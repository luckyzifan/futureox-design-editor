//! Private to one managed linear frame: the resolved page, fonts, two camera
//! transforms (output and sampling), and sampling policy cannot change between
//! its tiles. No Engine, worker, or subsequent render retains this plan.
use crate::{
    font::Fonts,
    geometry_snapshot::{Prepared, effect_halo},
    math::{Rect, Transform},
    path::{Command, Contour, Path},
    renderer::{Engine, RenderOptions},
    scene::{Document, Node},
    zoom_support::{self, ZoomBounds},
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

pub(crate) struct PageHalo {
    pub pixels: i32,
    pub concealed: HashSet<String>,
}

impl PageHalo {
    pub fn build(
        doc: &Document,
        roots: &[String],
        camera: Transform,
        coherent: bool,
    ) -> Result<Self, String> {
        fn visit(
            doc: &Document,
            id: &str,
            parent: Transform,
            next: Option<&String>,
            coherent: bool,
            concealed: &mut HashSet<String>,
        ) -> i32 {
            let node = &doc.nodes[id];
            if !node.visible {
                return 0;
            }
            if coherent
                && crate::optics::next_glass_consumer(doc, node, next)
                    .is_some_and(|upper| crate::optics::same_glass_coverage(node, upper))
            {
                concealed.insert(id.to_owned());
            }
            let matrix = parent.concat(node.transform);
            effect_halo(node, matrix).saturating_add(
                node.children
                    .iter()
                    .enumerate()
                    .map(|(i, child)| {
                        visit(
                            doc,
                            child,
                            matrix,
                            node.children.get(i + 1),
                            coherent,
                            concealed,
                        )
                    })
                    .max()
                    .unwrap_or(0),
            )
        }
        let mut concealed = HashSet::new();
        let mut pixels = 0;
        for (i, id) in roots.iter().enumerate() {
            if i % 64 == 0 {
                crate::render_cancellation::checkpoint()?;
            }
            pixels = pixels.max(visit(
                doc,
                id,
                camera,
                roots.get(i + 1),
                coherent,
                &mut concealed,
            ));
        }
        Ok(Self {
            pixels: pixels.min(2048),
            concealed,
        })
    }
}

enum Backdrops {
    Unbuilt,
    Indexed(Vec<(Rect, f64)>),
    Traverse,
}

enum Zoom {
    Inactive,
    Shared(ZoomBounds),
    PerTile,
}
pub(crate) struct FrameAnalysis {
    pub halo: PageHalo,
    zoom: Zoom,
}
impl FrameAnalysis {
    pub fn zoom_guard(
        &self,
        doc: &Document,
        roots: &[String],
        viewport: Rect,
        camera: Transform,
        fonts: &Fonts,
    ) -> Result<Option<Rect>, String> {
        match &self.zoom {
            Zoom::Inactive => Ok(None),
            Zoom::Shared(bounds) => {
                zoom_support::scene_guard_with_bounds(doc, roots, viewport, bounds).map(Some)
            }
            Zoom::PerTile => {
                zoom_support::scene_guard_active(doc, roots, camera, viewport, fonts).map(Some)
            }
        }
    }
}
pub(crate) struct CpuFramePlan {
    backdrops: Backdrops,
    analysis: Option<FrameAnalysis>,
    geometry: FrameGeometry,
}
impl CpuFramePlan {
    pub fn last_tile(&mut self) {
        self.geometry.retiring = true;
    }
    pub fn new() -> Self {
        Self {
            backdrops: Backdrops::Unbuilt,
            analysis: None,
            geometry: FrameGeometry::new(),
        }
    }
    pub fn padding(
        &mut self,
        engine: &Engine,
        options: &RenderOptions,
        tile: Rect,
        density: u32,
    ) -> Result<i32, String> {
        let region = tile.expand(2048 / density as i32);
        if matches!(self.backdrops, Backdrops::Unbuilt) {
            let doc = engine
                .doc
                .as_ref()
                .ok_or("Load a document before rendering")?;
            let page = doc
                .pages
                .iter()
                .find(|p| p.id == options.page_id)
                .ok_or("Page not found")?;
            let view = options.view;
            let camera = Transform([view.zoom, 0., 0., view.zoom, view.x, view.y]);
            let mut entries = Vec::new();
            let mut overflow = false;
            let mut first_tile_support = 0.;
            crate::export::visit_backdrops(doc, &page.children, camera, |bounds, support| {
                if !bounds.intersect(region).empty() {
                    first_tile_support += support;
                }
                // At most 96 KiB of ordered bounds; larger pages retain the
                // exact traversal including its per-tile dependency checks.
                if !overflow && entries.len() < 4096 && entries.try_reserve(1).is_ok() {
                    entries.push((bounds, support));
                } else {
                    overflow = true;
                }
            })?;
            self.backdrops = if overflow {
                Backdrops::Traverse
            } else {
                Backdrops::Indexed(entries)
            };
            // The initial traversal already covered this tile, even if the
            // index ran out of space. A declined index costs no second walk.
            return crate::export::checked_backdrop_padding(first_tile_support, f64::from(density));
        }
        if let Backdrops::Indexed(entries) = &self.backdrops {
            let mut support = 0.;
            for &(bounds, amount) in entries {
                if !bounds.intersect(region).empty() {
                    support += amount;
                }
            }
            crate::export::checked_backdrop_padding(support, f64::from(density))
        } else {
            crate::export::backdrop_padding(engine, options, tile)
        }
    }
    pub fn analysis(
        &mut self,
        doc: &Document,
        roots: &[String],
        camera: Transform,
        coherent: bool,
        fonts: &Fonts,
    ) -> Result<(&FrameAnalysis, &mut FrameGeometry), String> {
        if self.analysis.is_none() {
            // Frame analysis begins.
            let halo = PageHalo::build(doc, roots, camera, coherent)?;
            let zoom = if !zoom_support::has_zoom(doc, roots) {
                Zoom::Inactive
            } else {
                // render_bounds_map reserves for every document key. Allow a
                // conservative upper bound for buckets and owned ID strings
                // before extending this allocation into the paint phase.
                let limit =
                    (crate::capacity::memory_budget_bytes() / 512).min(4 * 1024 * 1024) as usize;
                let buckets = doc.nodes.len().saturating_mul(
                    4 * std::mem::size_of::<(String, ([f64; 4], Transform))>() + 32,
                );
                let within_budget = limit.checked_sub(buckets).is_some_and(|available| {
                    doc.nodes
                        .keys()
                        .try_fold(available, |left, id| left.checked_sub(id.len()))
                        .is_some()
                });
                if within_budget {
                    Zoom::Shared(crate::dirty_region::render_bounds_map(
                        doc, roots, camera, fonts,
                    )?)
                } else {
                    Zoom::PerTile
                }
            };
            self.analysis = Some(FrameAnalysis { halo, zoom });
        }
        Ok((self.analysis.as_ref().unwrap(), &mut self.geometry))
    }
}

struct Leaf {
    support: Rect,
    matrix: Transform,
    // None for a cull-only proof. For fully prepared paths an optional hull
    // means every polynomial control must still be inside the new guard.
    shape: Option<(Option<Rect>, Box<Prepared>)>,
}
pub(crate) struct FrameGeometry {
    leaves: HashMap<*const Node, Leaf>,
    empty: Arc<Vec<Contour>>,
    bytes: usize,
    limit: usize,
    retiring: bool,
}
impl FrameGeometry {
    fn new() -> Self {
        Self {
            leaves: HashMap::new(),
            empty: Arc::default(),
            retiring: false,
            bytes: 0,
            limit: (crate::capacity::memory_budget_bytes() / 512).min(2 * 1024 * 1024) as usize,
        }
    }
    pub fn get(&self, node: &Node, matrix: Transform, guard: Rect) -> Option<Prepared> {
        let entry = self.leaves.get(&std::ptr::from_ref(node))?;
        if !entry
            .matrix
            .0
            .iter()
            .zip(matrix.0)
            .all(|(a, b)| a.to_bits() == b.to_bits())
        {
            return None;
        }
        let result = if entry.support.intersect(guard).empty() {
            Prepared::culled(matrix, self.empty.clone())
        } else {
            let (hull, shape) = entry.shape.as_ref()?;
            if hull.is_some_and(|h| h.intersect(guard) != h) {
                return None;
            }
            (**shape).clone()
        };
        // Reuse exactly the same leaf result.
        Some(result)
    }
    pub fn cull(&mut self, node: &Node, matrix: Transform, support: Rect) {
        if self.retiring { return; }
        let key = std::ptr::from_ref(node);
        let charge = 4 * (std::mem::size_of::<(*const Node, Leaf)>() + 16);
        if self.bytes + charge <= self.limit
            && !self.leaves.contains_key(&key)
            && self.leaves.try_reserve(1).is_ok()
        {
            self.bytes += charge;
            self.leaves.insert(
                key,
                Leaf {
                    support,
                    matrix,
                    shape: None,
                },
            );
        }
    }
    pub fn shape(
        &mut self,
        node: &Node,
        support: Rect,
        guard: Rect,
        path: &Path,
        prepared: &Prepared,
    ) {
        if self.retiring { return; }
        self.cull(node, prepared.matrix, support);
        let Some(entry) = self.leaves.get_mut(&std::ptr::from_ref(node)) else {
            return;
        };
        if entry.shape.is_some()
            || entry.support != support
            || !entry
                .matrix
                .0
                .iter()
                .zip(prepared.matrix.0)
                .all(|(a, b)| a.to_bits() == b.to_bits())
        {
            return;
        }
        use std::mem::size_of;
        let hull = if path
            .commands
            .iter()
            .all(|c| matches!(c, Command::Move(_) | Command::Line(_) | Command::Close))
        {
            None // Lines do not use the guard in flatten_for_fill.
        } else if support.intersect(guard) == support
            && path
                .commands
                .iter()
                .all(|c| !matches!(c, Command::SmoothCorner(_) | Command::Arc { .. }))
        {
            Some(support)
        } else {
            return;
        };
        // Charge the full retained contour allocations, even where Arcs also
        // have another owner. This working set expires before render_linear returns.
        let mut charge = size_of::<Prepared>()
            + 64
            + prepared.strokes.capacity() * size_of::<Arc<Vec<Contour>>>()
            + prepared.stroke_program_bounds.capacity() * size_of::<Rect>();
        for contours in std::iter::once(&prepared.fill).chain(&prepared.strokes) {
            charge += 64 + contours.capacity() * size_of::<Contour>();
            for contour in contours.iter() {
                charge += 32 + contour.points.capacity() * size_of::<crate::math::Point>();
            }
        }
        if charge <= self.limit - self.bytes {
            self.bytes += charge;
            entry.shape = Some((hull, Box::new(prepared.clone())));
        }
    }
    /// On the last tile the painter already owns every contour it will use.
    /// Release other tiles' payloads and the key table before allocating layers.
    pub fn retire_if_finished(&mut self) {
        if self.retiring {
            self.leaves = HashMap::new();
            self.bytes = 0;
        }
    }
}
