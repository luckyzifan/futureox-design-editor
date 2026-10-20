//! Device-independent interval geometry/display list. CPU and GPU use the same
//! binary64 scanline crossings; GPUs evaluate coverage and all color operations.
//! The packet contains no CPU-rendered pixels or coverage bitmaps.
use crate::{
    font::Fonts,
    math::{Point, Rect, Transform},
    renderer::{Engine, RenderOptions},
    scene::{Document, Effect, Node, Paint},
    stroke,
};
use serde::Serialize;
/// One shader source for native wgpu and the browser WebGPU driver.
pub const VECTOR_SHADER: &str = concat!(
    "const BYTE_SURFACE:bool=false;\n",
    include_str!("../shaders/sampling.wgsl"),
    "\n",
    include_str!("../shaders/rational-filter.wgsl"),
    "\n",
    include_str!("../shaders/vector.wgsl")
);
pub const BYTE_VECTOR_SHADER: &str = concat!(
    "const BYTE_SURFACE:bool=true;\n",
    include_str!("../shaders/byte-sampling.wgsl"),
    "\n",
    "fn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{return vec4<f32>(0);}\n",
    include_str!("../shaders/vector.wgsl")
);
pub fn area_shader() -> String {
    let source = include_str!("../shaders/vector.wgsl");
    let first = source.find("fn fixedLinear").expect("static shader marker");
    let start = source
        .find("fn scaledPositive64")
        .expect("static shader marker");
    let end = source.find("fn paintUV").expect("static shader marker");
    format!(
        "{}\n{}\n{}\n{}\n{}",
        &source[..first],
        &source[start..end],
        include_str!("../shaders/coverage64.wgsl"),
        include_str!("../shaders/area.wgsl"),
        r#"
struct AreaParams { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:AreaParams;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
fn cvFetch(index:u32)->vec4<f32>{return curves[u32(params.values[9].x)+index];}
fn cvSampleIndex()->i32{return i32(params.values[9].z);}
@vertex fn areaQuad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);}
@fragment fn areaFragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{return vec4<f32>(areaCoverage(vec2<i32>(floor(p.xy))));}
"#
    )
}
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

/// Camera-scoped cache of the geometry-prepare phase shared by every tile of
/// one render request. The prepare guard is the union of all requested crop
/// rects, which is a superset of each tile's own guard: leaves outside the
/// union are the only entries emptied by a per-tile guard, so every entry a
/// tile actually consumes is byte-identical to a standalone per-tile compile.
/// One active entry plus bounded inactive camera variants are retained. All
/// variants remain keyed by exact document/font geometry lineage.
type CameraPrepareKey = (u64, String, (f64, f64, f64), (i32, i32, u32, u32), bool, Option<crate::animation::Sample>);
pub(crate) struct CameraPrepare {
    pub(crate) key: CameraPrepareKey,
    pub(crate) prepared: Arc<HashMap<String, crate::geometry_snapshot::Prepared>>,
    programs: ProgramCache,
    metadata: Option<CameraMetadata>,
    reuses: u64,
    incomplete: bool,
    retained_nodes: usize,
}
impl CameraPrepare {
    fn retained_bytes(&self) -> usize {
        let contours = |cs: &Vec<crate::path::Contour>| cs.capacity()*std::mem::size_of::<crate::path::Contour>() +
            cs.iter().map(|c|c.points.capacity()*std::mem::size_of::<Point>()).sum::<usize>();
        self.programs.bytes + self.prepared.capacity()*192 + self.prepared.iter().map(|(id,p)|
            id.capacity()+contours(&p.fill)+p.strokes.iter().map(|s|contours(s)).sum::<usize>()).sum::<usize>()
    }
    pub(crate) fn paint_changed(&mut self, revision: u64) {
        self.key.0 = revision;
        // Opacity can change whether a backdrop chain is active. Refresh this
        // summary even when all exact coverage programs remain reusable.
        self.metadata = None;
    }
    /// Only called after a validated pure-translation edit. The exact camera,
    /// guard, styles and resource lineage are unchanged. Descendants need new
    /// device geometry; ancestors need new aggregate bounds. Other entries and
    /// their exact-crop programs remain immutable.
    pub(crate) fn translated(&mut self, doc: &Document, ids: impl Iterator<Item = String>, revision: u64, parents: &HashMap<String, String>) {
        let mut dirty = std::collections::HashSet::new();
        let mut stack: Vec<String> = ids.collect();
        for id in &stack {
            let mut parent = parents.get(id.as_str());
            while let Some(id) = parent { dirty.insert(id.clone()); parent = parents.get(id); }
        }
        while let Some(id) = stack.pop() {
            if let Some(n) = doc.nodes.get(&id) { stack.extend(n.render_children().iter().cloned()); }
            dirty.insert(id);
        }
        // The precise dirty set is usually one node and its ancestors. Do not
        // scan every retained node for each pointer-move event. make_mut still
        // preserves any live snapshot reader before the targeted removals.
        let prepared = Arc::make_mut(&mut self.prepared);
        for id in &dirty { prepared.remove(id); }
        self.programs.retain_nodes(&dirty);
        self.key.0 = revision;
        // Rigid translation leaves effect radii, linear transforms and
        // dependency topology unchanged; camera metadata stays valid.
        self.incomplete = true;
        self.retained_nodes = self.prepared.len();
    }
    fn covers(&self, key: &CameraPrepareKey) -> bool {
        let old = &self.key;
        if old.0 != key.0 || old.1 != key.1 || old.2 != key.2 || old.4 != key.4 || old.5 != key.5 { return false; }
        let (x,y,w,h) = old.3; let (nx,ny,nw,nh) = key.3;
        x <= nx && y <= ny && i64::from(x)+i64::from(w) >= i64::from(nx)+i64::from(nw)
            && i64::from(y)+i64::from(h) >= i64::from(ny)+i64::from(nh)
    }
}

/// Keep exact camera variants across zoom levels. Never warp a coverage
/// program into a different sampling lattice. The active entry keeps its
/// existing budget; inactive variants share a separate bounded LRU.
#[derive(Default)]
pub(crate) struct CameraResidency {
    entries: std::collections::VecDeque<(CameraPrepare,usize)>,
    bytes: usize,
    restores: u64,
    evictions: u64,
}
impl CameraResidency {
    const LIMIT:usize=64*1024*1024;
    fn activate(&mut self, active:&mut Option<CameraPrepare>, revision:u64, page:&str,
        view:(f64,f64,f64), compatible:bool, animation:&Option<crate::animation::Sample>, window:Rect) {
        // A changed document/font lineage cannot revive old geometry. The
        // active cache may already have received the precise dirty-node patch.
        self.entries.retain(|(c,_)|c.key.0==revision);
        self.bytes=self.entries.iter().map(|(_,bytes)|*bytes).sum();
        let covers=|c:&CameraPrepare| {
            let padding=c.metadata.map_or(0,|m|m.padding);
            let guard=window.expand(padding);
            c.covers(&(revision,page.to_owned(),view,(guard.x,guard.y,guard.w,guard.h),compatible,animation.clone()))
        };
        if active.as_ref().is_some_and(covers) {return;}
        let found=self.entries.iter().position(|(c,_)|covers(c));
        let next=found.map(|index|{
            let (cache,bytes)=self.entries.remove(index).unwrap();self.bytes-=bytes;self.restores+=1;cache
        });
        if let Some(old)=active.take().filter(|c|c.key.0==revision) {
            let bytes=old.retained_bytes();
            if bytes<=Self::LIMIT {
                while self.entries.len()>=4 || self.bytes+bytes>Self::LIMIT {
                    if let Some((_,bytes))=self.entries.pop_front(){self.bytes-=bytes;self.evictions+=1;}else{break;}
                }
                self.bytes+=bytes;self.entries.push_back((old,bytes));
            }
        }
        *active=next;
    }
    pub(crate) fn clear(&mut self) {self.entries.clear();self.bytes=0;}
    fn stats(&self)->serde_json::Value {
        serde_json::json!({"entries":self.entries.len(),"bytes":self.bytes,"restores":self.restores,"evictions":self.evictions})
    }
}

#[derive(Clone, Copy)]
struct CameraMetadata {
    padding: i32,
    backdrop_chain: bool,
    foreground_only: bool,
    noise_guard: Option<i32>,
}

type ProgramShape = (usize, i32, i32, u32, u32, bool, bool);
type ProgramKey = (String, ProgramShape);
struct CachedProgram { program: crate::area_program::AreaProgram, fingerprint: u64 }
impl CachedProgram {
    fn new(program: crate::area_program::AreaProgram) -> Self {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        program.data.len().hash(&mut hash);
        for value in &program.data { value.to_bits().hash(&mut hash); }
        Self { program, fingerprint: hash.finish() }
    }
}
impl std::ops::Deref for CachedProgram {
    type Target = crate::area_program::AreaProgram;
    fn deref(&self) -> &Self::Target { &self.program }
}
/// Cached hashes only choose a bucket. Equality still checks every float bit,
/// including signed zero and NaNs; identical immutable owners are O(1).
#[derive(Clone)]
struct ProgramIdentity(Arc<CachedProgram>);
impl std::hash::Hash for ProgramIdentity {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) { h.write_u64(self.0.fingerprint); }
}
impl PartialEq for ProgramIdentity {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0,&other.0) || self.0.fingerprint == other.0.fingerprint &&
            self.0.data.len() == other.0.data.len() && self.0.data.iter().zip(&other.0.data).all(|(a,b)|a.to_bits()==b.to_bits())
    }
}
impl Eq for ProgramIdentity {}

/// Camera/geometry-revision scoped programs. Keys identify immutable prepared
/// contours and the exact crop/fill rule, never an approximate content hash.
#[derive(Default)]
struct ProgramCache {
    entries: HashMap<String, HashMap<ProgramShape, ProgramEntry>>,
    // Indexed FIFO: deleting a dirty node removes its exact order records in
    // O(log n), without scanning unrelated programs or leaving tombstones.
    order: BTreeMap<u64, ProgramKey>,
    next_order: u64,
    count: usize,
    bytes: usize,
    hits: u64,
    builds: u64,
}
struct ProgramEntry { order: u64, program: Arc<CachedProgram> }
impl ProgramCache {
    const LIMIT: usize = 32 * 1024 * 1024;
    fn program_bytes(id: &str, program: &CachedProgram) -> usize {
        program.data.len()*4 + id.len()*2 + 512
    }
    fn retain_nodes(&mut self, dirty: &std::collections::HashSet<String>) {
        for id in dirty {
            if let Some(entries) = self.entries.remove(id) {
                self.count -= entries.len();
                for entry in entries.into_values() {
                    self.bytes -= Self::program_bytes(id, &entry.program);
                    self.order.remove(&entry.order);
                }
            }
        }
    }
    fn len(&self) -> usize { self.count }
    fn get(&mut self, id: &str, shape: &ProgramShape) -> Option<Arc<CachedProgram>> {
        let value = self.entries.get(id)?.get(shape)?.program.clone(); self.hits += 1; Some(value)
    }
    fn allocate_order(&mut self) -> u64 {
        if self.next_order == u64::MAX {
            // Preserve live FIFO order on counter exhaustion, rather than
            // wrapping onto an occupied key and losing an eviction record.
            for (index, (_, (id, shape))) in std::mem::take(&mut self.order).into_iter().enumerate() {
                let order = index as u64;
                self.entries.get_mut(&id).unwrap().get_mut(&shape).unwrap().order = order;
                self.order.insert(order, (id, shape));
            }
            self.next_order = self.count as u64;
        }
        let order = self.next_order;
        self.next_order += 1;
        order
    }
    fn insert(&mut self, id: &str, shape: ProgramShape, program: Arc<CachedProgram>) {
        self.builds += 1;
        let size = Self::program_bytes(id, &program);
        if size > Self::LIMIT { return; }
        // Replacement is one live entry. Retire its old size/FIFO record
        // before admitting the new version, including at the byte limit.
        if let Some(old) = self.entries.get_mut(id).and_then(|entries| entries.remove(&shape)) {
            self.bytes -= Self::program_bytes(id, &old.program);
            self.count -= 1;
            self.order.remove(&old.order);
        }
        while self.bytes + size > Self::LIMIT {
            let Some((_, (old_id, old_shape))) = self.order.pop_first() else { break; };
            if let Some(entries) = self.entries.get_mut(&old_id) {
                if let Some(old) = entries.remove(&old_shape) {
                    self.bytes -= Self::program_bytes(&old_id, &old.program);
                    self.count -= 1;
                }
                if entries.is_empty() { self.entries.remove(&old_id); }
            }
        }
        let order = self.allocate_order();
        self.bytes += size;
        self.count += 1;
        self.order.insert(order, (id.to_owned(), shape));
        self.entries.entry(id.to_owned()).or_default().insert(shape, ProgramEntry { order, program });
    }
}

#[derive(Clone, Serialize)]
pub struct AnalyticPath {
    pub first: u32,
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bands: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuPath {
    /// Whole device pixels proved to have coverage exactly one. Optional
    /// metadata; old consumers can ignore it without changing output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opaque_rect: Option<Rect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<AreaPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analytic: Option<AnalyticPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u8>,
    pub rect: Rect,
    pub first: u32,
    pub count: u32,
    pub rule: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analytic_rect: Option<[f64; 4]>,
}
#[derive(Clone, Serialize)]
pub struct AreaPath {
    pub first: u32,
    pub count: u32,
    /// Stable bucket for immutable program bytes; consumers still compare
    /// exact words before reuse, so collisions never establish equivalence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<[u32;2]>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuPaint {
    #[serde(flatten)]
    pub paint: Paint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constant_color: Option<String>,
    pub figma_gradient: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gradient_plane: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed_gradient: Option<crate::fixed_gradient::FixedGradient>,
}
impl std::ops::Deref for GpuPaint {
    type Target = Paint;
    fn deref(&self) -> &Paint {
        &self.paint
    }
}
impl GpuPaint {
    fn new(
        paint: &Paint,
        inverse: Transform,
        size: [f64; 2],
        origin: Rect,
        measured: bool,
    ) -> Result<Self, String> {
        let gradient_plane = (paint.kind == "linear").then(|| {
            let (s, c) = paint.angle.to_radians().sin_cos();
            let denominator = (c.abs() + s.abs()).max(1e-12);
            let m = inverse.0;
            let local = inverse.point(Point::new(f64::from(origin.x), f64::from(origin.y)));
            [
                (m[0] / size[0] * c + m[1] / size[1] * s) / denominator,
                (m[2] / size[0] * c + m[3] / size[1] * s) / denominator,
                ((local.x / size[0] - 0.5) * c + (local.y / size[1] - 0.5) * s) / denominator + 0.5,
            ]
        });
        let mut canonical = paint.clone();
        canonical
            .stops
            .sort_by(|a, b| a.offset.total_cmp(&b.offset));
        Ok(Self {
            constant_color: paint.constant_color().map(str::to_owned),
            figma_gradient: measured && crate::figma_gradient::supported(paint, inverse),
            paint: canonical,
            gradient_plane,
            fixed_gradient: crate::fixed_gradient::FixedGradient::new(
                paint, inverse, size, origin,
            )?,
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStroke {
    pub path: GpuPath,
    pub paint: GpuPaint,
    pub align: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuNode {
    /// The entire working rectangle lies inside an opaque, simple fill.
    pub opaque_coverage: bool,
    pub passthrough: bool,
    pub backdrop_box: [f64; 4],
    pub id: String,
    pub rect: Rect,
    pub matrix: Transform,
    pub inverse: Transform,
    pub size: [f64; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glass_shape: Option<crate::optics::GlassShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_replay: Option<crate::glass_capture::Replay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_replay: Option<crate::texture_replay::Replay>,
    pub fill: GpuPath,
    pub fills: Vec<GpuPaint>,
    pub strokes: Vec<GpuStroke>,
    pub children: Vec<String>,
    /// The compositing constraint survives geometry culling. A missing node
    /// with this ID represents an empty mask, not an unmasked container.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask_id: Option<String>,
    pub mask: bool,
    pub mask_type: Option<String>,
    pub clip: bool,
    pub opacity: f64,
    pub blend: String,
    pub effects: Vec<Effect>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuScene {
    /// Persisted, deterministic SDR arithmetic; independent of GPU vendor.
    pub software_raster: bool,
    /// Global device-pixel output rectangle. Cropping must not rebase camera
    /// matrices or change intermediate binary32 rounding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Rect>,
    /// Numeric storage is independent of colour encoding: analytic SDR uses
    /// floating sRGB components, while managed scenes use linear-light floats.
    pub float_compositing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_management: Option<crate::color::ColorSettings>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub colors: BTreeMap<String, [f32; 4]>,
    pub backdrop_samples: bool,
    pub coherent_samples: bool,
    pub integrated_blur: bool,
    pub curves: Vec<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve: Option<crate::preview::Presentation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<crate::preview::Presentation>,
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub extent: Rect,
    pub background: String,
    pub transparent: bool,
    pub grid: bool,
    pub checkerboard: bool,
    pub checkerboard_size: u32,
    pub view: crate::renderer::View,
    pub roots: Vec<String>,
    pub nodes: BTreeMap<String, GpuNode>,
    pub vertices: Vec<f32>,
}
impl GpuScene {
    /// FGPK v1: 24-byte LE header, padded UTF-8 metadata, then exact f32
    /// vertex/curve words. No unsafe casts, numerical conversion or hashing.
    pub fn into_packet(mut self) -> Result<Vec<u8>, String> {
        let vertices = std::mem::take(&mut self.vertices);
        let curves = std::mem::take(&mut self.curves);
        let metadata = serde_json::to_vec(&self).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"FGPK");
        for size in [1, metadata.len(), vertices.len(), curves.len(), 0] {
            bytes.extend_from_slice(&u32::try_from(size).map_err(|_| "GPU packet too large")?.to_le_bytes());
        }
        bytes.extend_from_slice(&metadata);
        bytes.resize((bytes.len() + 3) & !3, 0);
        for value in vertices.iter().chain(&curves) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        Ok(bytes)
    }
}
fn halo(n: &Node, m: Transform) -> i32 {
    (n.effects
        .iter()
        .filter(|e| e.visible)
        .map(|e| e.blur_radius() * 2. + e.spread.abs() + e.x.abs() + e.y.abs() + e.material_halo())
        .sum::<f64>()
        * m.max_scale())
    .ceil() as i32
}

/// Source support for a managed analytic glass leaf, in device pixels.
///
/// The ordinary halo also covers distance-field construction and is deliberately
/// retained for arbitrary paths, rotated/sheared transforms, and SDR capture
/// replay. The rounded-box analytic field reads no neighbouring mask pixels.
/// Its only nonlocal colour reads are the finite tent filter followed by the
/// optical ray's bilinear taps. This changes allocation/culling only: the field,
/// filter coefficients, sample phases and colour operations remain unchanged.
fn analytic_glass_halo(n: &Node, m: Transform, region: Rect) -> Option<i32> {
    if !n.children.is_empty()
        || crate::optics::GlassShape::from_node(n).is_none()
        || m.0[1] != 0.
        || m.0[2] != 0.
        || [m.0[0], m.0[3]]
            .iter()
            .any(|s| !s.is_finite() || !(1. / 65536. ..=65536.).contains(&s.abs()))
    {
        return None;
    }
    let mut visible = n.effects.iter().filter(|e| e.visible);
    let effect = visible.next()?;
    if visible.next().is_some() || effect.kind != "glass" {
        return None;
    }
    let glass = effect.glass.as_ref()?;
    let old = halo(n, m);
    let guarded = region.expand(old);
    // Here global pixel centres and their +/- 1 bilinear neighbours remain
    // exactly representable binary32 half-integers. Larger coordinates retain
    // the old bound, including its existing validation/error behaviour.
    if [guarded.x, guarded.y, guarded.right(), guarded.bottom()]
        .iter()
        .any(|v| i64::from(*v).abs() > 1_048_576)
    {
        return None;
    }
    let radius = effect.backdrop_radius() * m.max_scale();
    if !radius.is_finite() || radius > 512. {
        return None;
    }
    // The managed integrated tent has support ceil(radius), not 2*radius.
    // Cover both the binary64 coefficient radius and the uploaded binary32
    // loop radius, rounding outward at the conversion boundary.
    let blur_reach = radius
        .next_up()
        .max(f64::from((radius as f32).next_up()))
        .ceil();
    // geometry.at clamps body to depth*.999; using depth*refraction is an
    // upper bound before that clamp. The rim is only .2 of that bound, and
    // interpolation between them cannot increase it. An axis-aligned matrix
    // scales each normal component by at most the larger diagonal magnitude.
    // Reserve 2^-20 relative slack for binary64 normal/matrix arithmetic, then
    // round every binary32 ray operation outwards. This slack exceeds the
    // combined rounding error of the bounded finite operations in this branch;
    // it is support padding, never a change to the sampled value.
    let device_displacement =
        (glass.depth * glass.refraction * m.0[0].abs().max(m.0[3].abs()) * (1. + 1. / 1_048_576.))
            as f32;
    // Use the same authored-to-rendered conversion as optics::shade and the
    // GPU material uniform. Effect::material_halo has a different conservative
    // coefficient; copying that coefficient here under-bounds inner-bevel rays.
    let dispersion = glass.chromatic_aberration();
    let spectral_factor = (1_f32 + dispersion).next_up();
    let ray = (device_displacement.next_up() * spectral_factor).next_up();
    // All four sample offsets have magnitude <= .375. floor(delta) and its
    // neighbouring texel require one additional pixel beyond ceil(abs(delta)).
    let ray_reach = f64::from((ray + 0.375).next_up()).ceil() + 1.;
    let required = blur_reach + ray_reach;
    if !required.is_finite() || required >= f64::from(old) {
        return None;
    }
    Some(required as i32)
}

/// The existing tree margin adds ancestor support but takes the maximum across
/// siblings. Do not tighten it when another sibling filter/backdrop can feed
/// the glass: such a dependency can require the sum of both supports. Noise is
/// pointwise. Other effect-bearing nodes must lie on the sole backdrop's path.
fn single_backdrop_support_chain(doc: &Document, roots: &[String]) -> bool {
    fn visit(doc: &Document, id: &str) -> (usize, bool) {
        let node = &doc.nodes[id];
        if !node.visible || node.opacity <= 0. {
            return (0, true);
        }
        let mut count = node
            .effects
            .iter()
            .filter(|e| e.visible && matches!(e.kind.as_str(), "glass" | "background-blur"))
            .count();
        let mut safe = true;
        for id in &node.children {
            let (children, child_safe) = visit(doc, id);
            count += children;
            safe &= child_safe;
        }
        if count == 0 && node.effects.iter().any(|e| e.visible && e.kind != "noise") {
            safe = false;
        }
        (count, safe && count <= 1)
    }
    let mut count = 0;
    let mut safe = true;
    for id in roots {
        let (children, child_safe) = visit(doc, id);
        count += children;
        safe &= child_safe;
    }
    safe && count == 1
}
// Only prove the convex central rectangle of an ordinary rounded box. Using
// the whole effect-expanded working extent preserves backdrop/filter neighbours.
fn opaque_interior(n: &Node, matrix: Transform, extent: Rect) -> bool {
    if !matches!(n.kind.as_str(), "frame" | "rectangle" | "section")
        || n.network.is_some()
        || n.boolean_operation.is_some()
        || n.smoothing != 0.
        || n.opacity != 1.
        || n.blend != "normal"
        || n.mask
        || n.effects.iter().any(|e| e.visible && e.kind != "shadow")
        || n.fills
            .iter()
            .filter(|p| p.visible)
            .any(|p| p.blend != "normal")
    {
        return false;
    }
    let Some(paint) = n.fills.iter().find(|p| p.visible) else {
        return false;
    };
    if paint.kind != "solid"
        || paint.opacity != 1.
        || paint.color.len() != 7
        || !paint.color.starts_with('#')
    {
        return false;
    }
    let Ok(inverse) = matrix.inverse() else {
        return false;
    };
    let inset = n.radii.iter().copied().fold(0., f64::max) + 1.;
    [
        (extent.x, extent.y),
        (extent.right(), extent.y),
        (extent.x, extent.bottom()),
        (extent.right(), extent.bottom()),
    ]
    .into_iter()
    .all(|(x, y)| {
        let p = inverse.point(Point::new(f64::from(x), f64::from(y)));
        p.x > inset && p.y > inset && p.x < n.width - inset && p.y < n.height - inset
    })
}
/// Certify an opaque ancestor before pruning its now-occluded outer shadow.
/// Masks, layer opacity/blending and complex frame fills retain the old path.
fn opaque_frame_shadow_candidate(doc: &Document, n: &Node) -> bool {
    if n.kind != "frame"
        || !n.clip
        || n.fills.iter().filter(|p| p.visible).count() != 1
        || !n.effects.iter().any(|e| e.visible && e.kind == "shadow")
        || n.effects.iter().any(|e| e.visible && e.kind != "shadow")
    {
        return false;
    }
    fn normal_branch(doc: &Document, n: &Node) -> bool {
        if !n.visible || n.opacity <= 0. {
            return true;
        }
        n.opacity == 1.
            && n.blend == "normal"
            && !n.mask
            && doc.mask_child(n).is_none()
            && n.fills.iter().all(|p| !p.visible || p.blend == "normal")
            && n.strokes
                .iter()
                .all(|s| !s.visible || s.paint.blend == "normal")
            && n.children
                .iter()
                .all(|id| normal_branch(doc, &doc.nodes[id]))
    }
    normal_branch(doc, n)
}
// Backdrop filters read outside a leaf, but their output is still clipped to
// its shape. Only use this bound in a certified single-backdrop dependency tree.
fn backdrop_output_bounds(n: &Node, p: &crate::geometry_snapshot::Prepared) -> Rect {
    if n.render_children().is_empty() && !n.passes_backdrop() && n.effects.iter()
        .filter(|e| e.visible).all(|e| matches!(e.kind.as_str(), "glass" | "background-blur")) {
        p.bounds.expand(-p.halo)
    } else { p.bounds }
}

// Certify only a constant-coverage interior: no flattened edge may enter the
// guarded rectangle. This also recognizes the empty interior of compound
// shapes. The winding rule is exactly the compiler's fill rule.
fn constant_fill_coverage(n: &Node, p: &crate::geometry_snapshot::Prepared, region: Rect) -> Option<bool> {
    if p.fill.is_empty() || [region.x, region.y, region.right(), region.bottom()].iter().any(|v| i64::from(*v).abs() > 1_048_576) {
        return None;
    }
    let r = region.expand(2);
    for contour in p.fill.iter() {
        if !contour.closed { return None; }
        for (i, a) in contour.points.iter().enumerate() {
            let b = contour.points[(i + 1) % contour.points.len()];
            if !a.finite() || !b.finite() { return None; }
            if a.x.min(b.x) <= f64::from(r.right()) && a.x.max(b.x) >= f64::from(r.x) &&
                a.y.min(b.y) <= f64::from(r.bottom()) && a.y.max(b.y) >= f64::from(r.y) { return None; }
        }
    }
    let winding = crate::path::winding(Point::new(f64::from(r.x) + f64::from(r.w) / 2.,
        f64::from(r.y) + f64::from(r.h) / 2.), &p.fill);
    Some(if n.kind == "text" || n.network.as_ref().is_some_and(|g| g.fill_rule == "nonzero") {
        winding != 0
    } else { winding % 2 != 0 })
}

fn irrelevant_backdrop(n: &Node, p: &crate::geometry_snapshot::Prepared, region: Rect, coherent: bool) -> bool {
    if !n.render_children().is_empty() || n.passes_backdrop() || n.opacity != 1. || n.blend != "normal" || n.mask ||
        n.effects.iter().any(|e| e.visible && e.kind != "background-blur") ||
        n.fills.iter().any(|paint| paint.visible && paint.blend != "normal") ||
        n.strokes.iter().any(|stroke| stroke.visible && stroke.paint.blend != "normal") { return false; }
    let opaque_fill = n.fills.iter().any(|paint| paint.visible && paint.kind == "solid" &&
        paint.opacity == 1. && paint.color.len() == 7 && paint.color.starts_with('#'));
    // Coherent path coverage is binary in each sample plane. An opaque fill
    // replaces every covered backdrop sample, including AA boundary samples;
    // uncovered samples have zero backdrop coverage. Keep continuous-area
    // and large-coordinate sampling on the guarded interior proof below.
    if coherent && opaque_fill && [region.x, region.y, region.right(), region.bottom()].iter()
        .all(|v| i64::from(*v).abs() <= 1_048_576) { return true; }
    match constant_fill_coverage(n, p, region) {
        Some(false) => true,
        Some(true) => opaque_fill,
        None => false,
    }
}

// A backdrop elsewhere on the page does not make a foreground-only crop read
// its siblings. Prove this for the actual dependency region, including every
// ancestor's filter support, before using the existing branch-local compiler.
// Keep arbitrary materials, passthrough effects and intersecting backdrops on
// the conservative path. The prepared guard already covers these dependencies.
fn foreground_region_supported(
    doc: &Document,
    id: &str,
    region: Rect,
    prepared: &HashMap<String, crate::geometry_snapshot::Prepared>,
    coherent: bool,
) -> bool {
    let n = &doc.nodes[id];
    let Some(p) = prepared.get(id) else { return true; };
    if !n.visible || n.opacity <= 0. || backdrop_output_bounds(n, p).intersect(region).empty() { return true; }
    if irrelevant_backdrop(n, p, region, coherent) { return true; }
    if n.effects.iter().any(|e| e.visible &&
        (!matches!(e.kind.as_str(), "blur" | "shadow" | "inner-shadow") || n.passes_backdrop())) {
        return false;
    }
    let source = region.expand(halo(n, p.matrix).saturating_add(2));
    n.render_children().iter().all(|child| foreground_region_supported(doc, child, source, prepared, coherent))
}

struct Compiler<'a> {
    doc: &'a Document,
    fonts: &'a Fonts,
    paths: &'a mut HashMap<String, crate::path::SharedPaths>,
    extent: Rect,
    prepared: Arc<HashMap<String, crate::geometry_snapshot::Prepared>>,
    compatible: bool,
    profile: crate::fidelity::RasterProfile,
    interactive_effects: bool,
    large_packet: bool,
    prune_backdrop_output: bool,
    curves: Vec<f32>,
    area_paths: HashMap<ProgramIdentity, AreaPath>,
    programs: ProgramCache,
    nodes: BTreeMap<String, GpuNode>,
    vertices: Vec<f32>,
}
impl Compiler<'_> {
    fn area_path(
        &mut self,
        contours: &[crate::path::Contour],
        slot: (&str, usize),
        limit: Rect,
        even_odd: bool,
        bounds:Option<Rect>,
    ) -> Result<GpuPath, String> {
        // Two larger limits which expose the same path pixels generate the
        // identical interval program. Key the actual compiler crop, so moving
        // a neighbouring effect's extent does not invalidate this path.
        let crop=match bounds{Some(b)=>crate::area_program::clip_bounds(b,limit)?,None=>crate::area_program::clipped_rect(contours,limit)?};
        let input = (slot.1,crop.x,crop.y,crop.w,crop.h,even_odd,self.compatible);
        let program = if let Some(program) = self.programs.get(slot.0, &input) { program } else {
            let program = Arc::new(CachedProgram::new(crate::area_program::AreaProgram::compile_crop(contours,crop,even_odd,self.compatible)?));
            self.programs.insert(slot.0,input,Arc::clone(&program)); program
        };
        let key = ProgramIdentity(Arc::clone(&program));
        let area = if let Some(area) = self.area_paths.get(&key) {
            area.clone()
        } else {
            // A path remains bounded by AreaProgram's 8 MiB admission. A
            // transient whole-viewport scene can contain many such small
            // paths: give their aggregate a separate 32 MiB ceiling, below
            // WebGPU's baseline storage-buffer binding limit. This does not
            // relax per-path scanline work or exact/export scene admission.
            let scene_limit = if self.large_packet {
                8_000_000
            } else {
                crate::area_program::MAX_FLOATS
            };
            if self.curves.len() + program.data.len() > scene_limit {
                return Err("GPU analytic interval program budget exceeded".into());
            }
            let area = AreaPath {
                first: (self.curves.len() / 4) as u32,
                count: (program.data.len() / 4) as u32,
                fingerprint: Some([program.fingerprint as u32,(program.fingerprint>>32) as u32]),
            };
            self.curves.extend_from_slice(&program.data);
            self.area_paths.insert(key, area.clone());
            area
        };
        Ok(GpuPath {
            opaque_rect: crate::coverage::rectangle(contours).and_then(|b| {
                let left=b[0].max(f64::from(program.rect.x)).ceil();let top=b[1].max(f64::from(program.rect.y)).ceil();
                let right=b[2].min(f64::from(program.rect.right())).floor();let bottom=b[3].min(f64::from(program.rect.bottom())).floor();
                (right>left&&bottom>top).then(||Rect::new(left as i32,top as i32,(right-left) as u32,(bottom-top) as u32))
            }),
            area: Some(area),
            analytic: None,
            analytic_rect: None,
            sample_count: None,
            rect: if program.rect.empty() {
                Rect::new(limit.x, limit.y, 1, 1)
            } else {
                program.rect
            },
            first: 0,
            count: if program.rect.empty() { 0 } else { 3 },
            rule: if even_odd { "evenodd" } else { "nonzero" }.into(),
        })
    }
    fn node(
        &mut self,
        id: &str,
        parent: Transform,
        requested: Option<Rect>,
    ) -> Result<Rect, String> {
        let n = &self.doc.nodes[id];
        if !n.visible {
            return Ok(Rect::default());
        }
        // Keep the immutable owner alive independently of the mutable compiler.
        // Borrowing one entry avoids cloning both per-node stroke vectors.
        let prepared_owner = Arc::clone(&self.prepared);
        let prepared = prepared_owner.get(id);
        if requested.is_some_and(|region| prepared.is_some_and(|p| backdrop_output_bounds(n, p).intersect(region).empty())) {
            return Ok(Rect::default());
        }
        let matrix = prepared
            .as_ref()
            .map_or_else(|| parent.concat(n.transform), |p| p.matrix);
        let scale = matrix.max_scale();
        if !scale.is_finite() || matrix.0.iter().any(|v| v.abs() > 1e12) {
            return Err("GPU transform exceeds precision budget".into());
        }
        // In foreground-only regional scenes each effect needs its own input
        // neighbourhood, not a halo on every ancestor and sibling surface.
        // Keep integer/global coordinates and the full filter support. Two
        // extra texels cover pointwise bilinear neighbours at crop boundaries.
        // A managed integrated tent reads ceil(radius) neighbours, including
        // its last fractional tap. The general 2*radius halo also covers other
        // effects and remains unchanged for those paths. Limit this reduction
        // to foreground blur leaves with no other sampling stages.
        let omit_backdrop = requested.is_some_and(|region| prepared.is_some_and(|p|
            irrelevant_backdrop(n, p, region, self.compatible && !self.interactive_effects)));
        let own_halo = if omit_backdrop { 0 } else if self.doc.color_management.is_some()
            && (self.profile != crate::fidelity::RasterProfile::Analytic ||
                // Managed analytic paints use the same integrated rational
                // tent, not the unmanaged three-box Gaussian. Admit only one
                // ordinary blur on an isolated leaf; image/solid coordinates
                // do not use the crop origin as a paint phase. Integer global
                // centres and their complete support stay exactly representable.
                // This changes only a branch-local source allocation: an
                // observable later backdrop still prevents `requested`.
                (!n.mask && !n.clip && !n.passes_backdrop()
                    && n.effects.iter().filter(|e| e.visible).count() == 1
                    && n.effects.iter().filter(|e| e.visible)
                        .all(|e| e.kind == "blur" && e.gradient_blur.is_none())
                    && n.fills.iter().all(|p| !p.visible || matches!(p.kind.as_str(), "solid" | "image"))
                    && requested.is_some_and(|r| {
                        let support = halo(n, matrix).saturating_add(2);
                        [r.x, r.y, r.right(), r.bottom()].iter().all(|v|
                            i64::from(*v).abs() + i64::from(support) <= 1_048_576)
                    })))
            && n.render_children().is_empty() && n.strokes.is_empty()
            && n.effects.iter().filter(|e| e.visible).all(|e| e.gradient_blur.is_none() &&
                (e.kind == "blur" || e.kind == "shadow" && e.spread == 0. && e.x == 0. && e.y == 0.))
        {
            n.effects.iter().filter(|e| e.visible)
                .map(|e| (e.blur_radius() * scale).ceil() as i32)
                .fold(0_i32, i32::saturating_add)
        } else { halo(n, matrix) };
        let source_region = requested.map(|r| r.expand(own_halo.saturating_add(2)));
        let extent = source_region.unwrap_or(self.extent);
        // Preparation already includes this leaf's strokes and effect support.
        // Reuse its exact final rejection before rereading paths/control bounds
        // and recomputing the same margins for every offscreen tile candidate.
        if n.render_children().is_empty() {
            if let Some(prepared) = prepared {
                let bounds = prepared.bounds.intersect(extent);
                if bounds.empty() { return Ok(bounds); }
            }
        }
        // Prepared bounds already include descendants, strokes and effect
        // support. A normal clipped frame outside this tile cannot contribute
        // pixels or expose descendants. Reject it before walking its subtree;
        // large imported pages otherwise revisit every board for every tile.
        // Keep masks and effect/blend containers on the dependency path.
        if n.kind == "frame" && n.clip && !n.mask && n.blend == "normal"
            && n.effects.iter().all(|effect| !effect.visible)
            && prepared.as_ref().is_some_and(|p| p.bounds.intersect(extent).empty())
        {
            return Ok(Rect::default());
        }
        if self.prune_backdrop_output && prepared.as_ref().is_some_and(|p|
            backdrop_output_bounds(n, p).intersect(extent).empty()) {
            return Ok(Rect::default());
        }
        if !self.paths.contains_key(id) {
            let paths = if n.kind == "text" {
                crate::path::LocalPaths::Text(self.fonts.node_path_shared(n)?)
            } else {
                crate::path::LocalPaths::Owned(n.paths()?)
            };
            self.paths.insert(id.to_owned(), Arc::new(paths));
        }
        let cached = Arc::clone(&self.paths[id]);
        let (fill_path, stroke_path) = cached.pair();
        let mut rect = fill_path
            .control_bounds(matrix)
            .union(stroke_path.control_bounds(matrix));
        let own = rect;
        for child in n.render_children() {
            let mut b = self.node(child, matrix, source_region)?;
            if n.clip {
                b = b.intersect(own);
            }
            rect = rect.union(b);
        }
        let margin = halo(n, matrix)
            + (n.strokes
                .iter()
                .filter(|s| s.visible)
                .map(|s| stroke::maximum_width(s) * 4. * scale)
                .fold(0., f64::max))
            .ceil() as i32
            + 2;
        rect = prepared
            .as_ref()
            .map_or_else(|| rect.expand(margin), |p| p.bounds)
            .intersect(extent);
        if rect.empty() {
            return Ok(rect);
        }
        let fill_contours = match prepared.as_ref() {
            Some(p) => Arc::clone(&p.fill),
            None => Arc::new(fill_path.flatten(matrix, 0.015625)?),
        };
        let rule =
            if n.kind == "text" || n.network.as_ref().is_some_and(|g| g.fill_rule == "nonzero") {
                "nonzero"
            } else {
                "evenodd"
            };
        let fill = self.area_path(&fill_contours, (id,0), rect, rule == "evenodd",prepared.as_ref().map(|p|p.fill_program_bounds))?;
        let mut strokes = Vec::new();
        let inverse = matrix.inverse_composed(rect)?;
        let rgba8 = self.compatible;
        for (index, s) in n
            .strokes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.visible && s.width > 0.)
        {
            let outline = if let Some(p) = prepared.as_ref() {
                Arc::clone(&p.strokes[index])
            } else {
                let lines = stroke_path.flatten(
                    Transform::default(),
                    (0.125 / scale.max(1e-6)).clamp(1e-6, 1.),
                )?;
                let mut outline =
                    stroke::expand(&lines, s, (0.125 / scale.max(1e-6)).max(1e-6), 0.)?;
                for c in &mut outline {
                    for p in &mut c.points {
                        *p = matrix.point(*p);
                    }
                }
                Arc::new(outline)
            };
            let path = self.area_path(&outline, (id,index+1), rect, false,prepared.as_ref().map(|p|p.stroke_program_bounds[index]))?;
            strokes.push(GpuStroke {
                path,
                paint: GpuPaint::new(
                    &s.paint,
                    inverse,
                    [n.width, n.height],
                    rect,
                    rgba8 && self.profile.is_export(),
                )?,
                align: s.align.clone(),
            });
        }
        let opaque_coverage = opaque_interior(n, matrix, extent);
        self.nodes.insert(
            id.to_owned(),
            GpuNode {
                opaque_coverage,
                passthrough: n.passes_backdrop(),
                backdrop_box: crate::coverage::backdrop_box(
                    crate::bounds::path_bounds(fill_path, matrix),
                    extent,
                ),
                id: id.into(),
                rect,
                matrix,
                inverse,
                size: [n.width, n.height],
                glass_shape: n
                    .effects
                    .iter()
                    .any(|e| e.glass.is_some())
                    .then(|| crate::optics::GlassShape::from_node(n))
                    .flatten(),
                capture_replay: if rgba8 && self.profile.is_export() {
                    n.backdrop_effect()
                        .map(|fx| crate::glass_capture::recipe(self.doc, n, matrix, fx))
                        .transpose()?
                        .flatten()
                } else {
                    None
                },
                texture_replay: if rgba8 && self.profile.is_export() {
                    n.effects
                        .iter()
                        .find(|fx| fx.visible && fx.kind == "texture")
                        .map(|fx| crate::texture_replay::recipe(self.doc, n, matrix, fx))
                        .transpose()?
                        .flatten()
                } else {
                    None
                },
                fill,
                fills: n
                    .fills
                    .iter()
                    .filter(|p| p.visible)
                    .map(|p| {
                        GpuPaint::new(
                            p,
                            inverse,
                            [n.width, n.height],
                            rect,
                            rgba8 && self.profile.is_export(),
                        )
                    })
                    .collect::<Result<_, String>>()?,
                strokes,
                children: n.render_children().to_vec(),
                mask_type: n.mask_type.clone(),
                mask_id: self.doc.mask_child(n).map(|m| m.id.clone()),
                mask: n.mask,
                clip: n.clip,
                opacity: n.opacity,
                blend: n.composite_blend().to_owned(),
                effects: n
                    .effects
                    .iter()
                    .filter(|e| e.visible && !(opaque_coverage && e.kind == "shadow") &&
                        !(omit_backdrop && e.kind == "background-blur"))
                    .cloned()
                    .map(|mut e| {
                        // Normalize only the layer-blur activation here, before
                        // native/WebGPU/WebGL2 consume the shared scene contract.
                        if e.kind == "blur"
                            && !crate::fidelity::layer_blur_active(
                                e.blur_radius() * scale,
                                self.profile,
                                self.doc.color_management.is_some(),
                                self.interactive_effects,
                            )
                        {
                            e.radius = 0.;
                        }
                        e
                    })
                    .collect(),
            },
        );
        Ok(rect)
    }
}
impl Engine {
    /// Shared JSON request envelope; geometry travels separately in the browser
    /// packet so decimal formatting never sits on the interactive hot path.
    pub fn compile_gpu_request(&mut self, request: &str) -> Result<GpuScene, String> {
        let mut value: serde_json::Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
        let object = value.as_object_mut().ok_or("Render options must be an object")?;
        let region = object.remove("gpuViewport").map(serde_json::from_value::<Rect>)
            .transpose().map_err(|e| format!("Invalid GPU viewport: {e}"))?;
        let capture = object.remove("captureViewport").map(serde_json::from_value::<Rect>)
            .transpose().map_err(|e| format!("Invalid native capture: {e}"))?;
        if capture.is_some() && region.is_some() { return Err("Ambiguous GPU region".into()); }
        let prepare = object.remove("prepareViewport").map(serde_json::from_value::<Rect>)
            .transpose().map_err(|e| format!("Invalid prepare viewport: {e}"))?;
        if prepare.is_some_and(|r| r.empty() || r.w > 32_000_000 || r.h > 32_000_000
            || i64::from(r.x).abs() > 16_000_000 || i64::from(r.y).abs() > 16_000_000)
        {
            return Err("Invalid prepare viewport bounds".into());
        }
        let options = self.parse_options(value)?;
        if let Some(capture) = capture {
            if options.pixel_preview.is_some() || options.raster_profile.is_export() { return Err("Native capture is a canvas operation".into()); }
            return self.compile_gpu_region_impl(&options, capture, prepare.or(Some(capture)), true);
        }
        match region {
            Some(region) => self.compile_gpu_region(&options, region, prepare.or(Some(region))),
            None => self.compile_gpu(&options),
        }
    }

    pub fn compile_gpu(&mut self, options: &RenderOptions) -> Result<GpuScene, String> {
        self.prepare_frame(options)?;
        if options.pixel_preview.is_some() {
            let plan = crate::preview::plan(options)?;
            let mut scene = self.compile_gpu(&plan.source)?;
            scene.presentation = Some(plan.presentation);
            return Ok(scene);
        }
        if options.raster_profile.is_export() {
            let source = crate::fidelity::source(options, 0, 0, options.width, options.height)?;
            let mut scene = self.compile_gpu_scene(&source, None, None)?;
            scene.resolve = Some(crate::preview::Presentation {
                width: options.width,
                height: options.height,
                offset_x: 0.,
                offset_y: 0.,
                scale: 0.5,
            });
            for n in scene.nodes.values_mut() {
                n.fill.analytic_rect = None;
                n.fill.sample_count = Some(4);
                for s in &mut n.strokes {
                    s.path.analytic_rect = None;
                    s.path.sample_count = Some(4);
                }
            }
            return Ok(scene);
        }
        self.compile_gpu_scene(options, None, None)
    }
    /// Compile a bounded crop in the original camera's device coordinate system.
    /// Only integer allocation/coverage limits change; authored transforms,
    /// inverse matrices, parameter fields and their operation order are retained.
    /// `prepare` optionally widens the geometry-prepare guard to a superset
    /// (the union of a request's crops) so the flattened-geometry phase can be
    /// cached per camera and shared by every tile in that request.
    pub fn compile_gpu_region(
        &mut self,
        options: &RenderOptions,
        region: Rect,
        prepare: Option<Rect>,
    ) -> Result<GpuScene, String> {
        self.compile_gpu_region_impl(options, region, prepare, false)
    }
    fn compile_gpu_region_impl(&mut self, options: &RenderOptions, region: Rect, prepare: Option<Rect>, capture: bool) -> Result<GpuScene, String> {
        // The production gutter tile is TILE_SIZE + 2 pixels wide.
        if region.empty()
            || region.w > if capture {8192} else {crate::tile_stack::TILE_SIZE as u32 + 2}
            || region.h > if capture {8192} else {crate::tile_stack::TILE_SIZE as u32 + 2}
            || capture && region.pixels() > 8_388_608
            || i64::from(region.x).abs() > 16_000_000
            || i64::from(region.y).abs() > 16_000_000
        {
            return Err("Invalid GPU tile viewport".into());
        }
        if options.pixel_preview.is_some() {
            return Err("Pixel preview uses complete-frame presentation".into());
        }
        self.prepare_frame(options)?;
        let mut cropped = options.clone();
        cropped.width = region.w;
        cropped.height = region.h;
        let mut scene = if options.raster_profile.is_export() {
            let source = crate::fidelity::source(&cropped, 0, 0, region.w, region.h)?;
            let source_region = Rect::new(region.x * 2, region.y * 2, region.w * 2, region.h * 2);
            let source_prepare = prepare.map(|r| Rect::new(r.x * 2, r.y * 2, r.w * 2, r.h * 2));
            let mut scene = self.compile_gpu_scene(&source, Some(source_region), source_prepare)?;
            scene.resolve = Some(crate::preview::Presentation {
                width: region.w,
                height: region.h,
                offset_x: 0.,
                offset_y: 0.,
                scale: 0.5,
            });
            scene
        } else {
            self.compile_gpu_scene(&cropped, Some(region), prepare)?
        };
        scene.output = Some(region);
        // Version 8 adds a global output rectangle. Older consumers must reject
        // it rather than silently present a crop at origin zero.
        scene.version = 8;
        Ok(scene)
    }
    pub fn gpu_compile_cache_stats(&self) -> serde_json::Value {
        self.camera_prepare.as_ref().map(|cache|serde_json::json!({"hits":cache.programs.hits,
            "builds":cache.programs.builds,"bytes":cache.programs.bytes,"entries":cache.programs.len(),
            "preparedNodes":cache.prepared.len(),"pathNodes":self.paths.len(),"prepareReuses":cache.reuses,"retainedNodes":cache.retained_nodes,"textPaths":self.fonts.text_path_cache_stats(),"residentStrokes":self.local_strokes.stats(),"cameraResidency":self.camera_residency.stats()}))
            .unwrap_or_else(||serde_json::json!({"hits":0,"builds":0,"bytes":0,"entries":0}))
    }
    fn compile_gpu_scene(
        &mut self,
        options: &RenderOptions,
        viewport: Option<Rect>,
        prepare_viewport: Option<Rect>,
    ) -> Result<GpuScene, String> {
        self.resolve_layout()?;
        if options.width == 0
            || options.height == 0
            || options.width > 8192
            || options.height > 8192
            || options.width as u64 * options.height as u64 > 8_388_608
            || !(0.001..=128.).contains(&options.view.zoom)
            || ![options.view.x, options.view.y]
                .iter()
                .all(|v| v.is_finite())
        {
            return Err("Invalid GPU viewport".into());
        }
        let doc = self.doc.as_ref().ok_or("Load document first")?;
        let page = doc
            .pages
            .iter()
            .find(|p| p.id == options.page_id)
            .ok_or("Missing page")?;
        let camera = Transform([
            options.view.zoom,
            0.,
            0.,
            options.view.zoom,
            options.view.x,
            options.view.y,
        ]);
        self.camera_residency.activate(&mut self.camera_prepare,self.geo_revision,&options.page_id,
            (options.view.x,options.view.y,options.view.zoom),
            options.raster_profile != crate::fidelity::RasterProfile::Analytic,&options.animation,
            prepare_viewport.or(viewport).unwrap_or_else(||Rect::new(0,0,options.width,options.height)));
        fn margin(doc: &Document, id: &str, parent: Transform) -> i32 {
            let n = &doc.nodes[id];
            if !n.visible {
                return 0;
            }
            let m = parent.concat(n.transform);
            halo(n, m).saturating_add(
                n.children
                    .iter()
                    .map(|id| margin(doc, id, m))
                    .max()
                    .unwrap_or(0),
            )
        }
        // These properties depend on the document and camera, not on a tile's
        // crop. Reuse them even when the next visible tile expands the geometry
        // guard. Revision/font invalidation and animation sampling retain the
        // same ownership rules as the prepared geometry cache.
        let compatible = options.raster_profile != crate::fidelity::RasterProfile::Analytic;
        let metadata = self.camera_prepare.as_ref().filter(|cache| {
            cache.key.0 == self.geo_revision && cache.key.1 == options.page_id &&
                cache.key.2 == (options.view.x, options.view.y, options.view.zoom) &&
                cache.key.4 == compatible && cache.key.5 == options.animation
        }).and_then(|cache| cache.metadata).unwrap_or_else(|| {
            let padding = page.children.iter().map(|id| margin(doc, id, camera)).max().unwrap_or(0);
            let noise_guard = doc.nodes.values().any(|n| n.effects.iter().any(|e| e.visible && e.kind == "noise"))
                .then(|| {
                    // A dependency path has at most one visit per node, each
                    // adding two texels. A blur-only leaf's per-effect ceil
                    // can exceed the general halo by at most its effect count.
                    let extra = doc.nodes.len().saturating_mul(2).saturating_add(
                        doc.nodes.values().map(|n| n.effects.len()).max().unwrap_or(0));
                    padding.saturating_add(i32::try_from(extra).unwrap_or(i32::MAX))
                });
            CameraMetadata {
                padding,
                backdrop_chain: single_backdrop_support_chain(doc, &page.children),
                foreground_only: doc.color_management.is_some() && doc.nodes.values().all(|n| {
                    // Noise is pointwise, but changing a neighbouring filter's
                    // crop must not change its sample phase. Newly admitted
                    // noise scenes use only solid paints and integer-tap
                    // filters. Fractional shadow offsets and origin-relative
                    // gradient/image arithmetic retain the old route.
                    let noise_phase_safe = noise_guard.is_none() ||
                        n.fills.iter().all(|p| !p.visible || p.kind == "solid") &&
                        n.strokes.iter().all(|s| !s.visible || s.width <= 0. || s.paint.kind == "solid") &&
                        n.effects.iter().all(|e| !e.visible || e.gradient_blur.is_none() &&
                            (!matches!(e.kind.as_str(), "shadow" | "inner-shadow") || e.x == 0. && e.y == 0.));
                    noise_phase_safe && n.effects.iter().all(|e| !e.visible ||
                        matches!(e.kind.as_str(), "blur" | "shadow" | "inner-shadow" | "noise"))
                }),
                noise_guard,
            }
        });
        let padding = metadata.padding;
        // This is a geometry search guard, not an allocated surface. An
        // offscreen effect must not reject every tile at a high zoom. Actual
        // surface admission follows the regional dependency walk below.
        if padding > 16_000_000 {
            return Err("GPU effect support exceeds coordinate budget".into());
        }
        let has_region = viewport.is_some();
        let mut regional_foreground = viewport.is_some_and(|region| metadata.foreground_only &&
            metadata.noise_guard.is_none_or(|guard| {
                // Global pixel centres, their neighbouring taps, and the
                // local-to-global addition must be exact binary32 values.
                // Export doubles device coordinates; outside this certificate
                // retain the old extents rather than change the noise hash.
                [region.x, region.y, region.right(), region.bottom()].iter()
                    .all(|v| i64::from(*v).abs() + i64::from(guard) <= 1_048_576)
            }));
        let viewport = viewport.unwrap_or_else(|| Rect::new(0, 0, options.width, options.height));
        // Whole-frame exact desktop captures need the same bounded aggregate
        // allowance as regional captures. Admission depends on output extent,
        // never on whether the caller permits simplified interactive effects.
        let large_packet = options.interactive_effects || viewport.w > 514 || viewport.h > 514;
        // The prepare guard defaults to this call's own viewport; a request may
        // widen it to the union of all its crops so the flattened geometry is
        // computed once per camera and cloned per tile. The union is a superset
        // of every tile guard, so entries consumed by a tile are identical to
        // a standalone compile; only far leaves differ (prepared vs empty), and
        // both cull to zero for this tile's halo and extent decisions.
        let prepare_guard = prepare_viewport.unwrap_or(viewport).expand(padding);
        // Full native interaction captures share the same geometry/program
        // lifetime as regional tiles. Their exact viewport is the guard when
        // no wider tile preparation window was supplied. Camera, resources,
        // profile and animation remain part of the key.
        let cache_key = Some({
            (
                self.geo_revision,
                options.page_id.clone(),
                (options.view.x, options.view.y, options.view.zoom),
                (
                    prepare_guard.x,
                    prepare_guard.y,
                    prepare_guard.w,
                    prepare_guard.h,
                ),
                compatible,
                options.animation.clone(),
            )
        });
        let mut prepared = match (&cache_key, &mut self.camera_prepare) {
            // A pan inside the retained preparation window does not change
            // geometry. Preserve that wider guard instead of shrinking it to
            // every new request; crops still compile their own exact pixels.
            (Some(key), Some(cache)) if cache.covers(key) => {
                cache.reuses += 1;
                if cache.incomplete {
                    // The compiler owns this partial map. Keeping a cache Arc
                    // here would force make_mut to clone every retained node
                    // for a one-node edit. Move it instead; live external
                    // readers still receive normal copy-on-write protection.
                    // A failed rebuild leaves an empty, incomplete cache, so
                    // the next attempt rebuilds against the same wider guard.
                    std::mem::take(&mut cache.prepared)
                } else { cache.prepared.clone() }
            },
            _ => Arc::new(HashMap::new()),
        };
        let partial = self.camera_prepare.as_ref().is_some_and(|cache| cache.incomplete && cache_key.as_ref().is_some_and(|key| cache.covers(key)));
        if prepared.is_empty() || partial {
            // A retained cache may cover a wider window than this request.
            // Rebuild dirty nodes against that original guard; otherwise a
            // small crop would poison later hits in the retained outer ring.
            let prepare_guard = if partial {
                let (x,y,w,h)=self.camera_prepare.as_ref().unwrap().key.3;
                Rect::new(x,y,w,h)
            } else { prepare_guard };
            let mut segments = 0;
            for root in &page.children {
                crate::geometry_snapshot::prepare_node_geometry(
                    root,
                    camera,
                    (doc, &self.fonts, prepare_guard, compatible),
                    &mut self.paths,
                    &mut self.local_strokes,
                    Arc::make_mut(&mut prepared),
                    &mut segments,
                )?;
            }
            if let Some(key) = &cache_key {
                if partial {
                    let cache = self.camera_prepare.as_mut().unwrap();
                    cache.prepared = prepared.clone(); cache.metadata = Some(metadata); cache.incomplete = false;
                } else {
                    self.camera_prepare = Some(CameraPrepare {
                        key: key.clone(), prepared: prepared.clone(), programs: ProgramCache::default(),
                        metadata: Some(metadata), reuses: 0, incomplete: false, retained_nodes: 0,
                    });
                }
            }
        }
        if has_region && !regional_foreground && doc.color_management.is_some() && metadata.noise_guard.is_none() {
            regional_foreground = page.children.iter().all(|id|
                foreground_region_supported(doc, id, viewport, &prepared, crate::fidelity::coherent_samples(doc, options)));
        }
        let backdrop_chain = metadata.backdrop_chain;
        let extent = {
            // A container's cached halo includes every descendant, including
            // effects outside this tile. Propagate the requested region down
            // the tree before admitting effect neighbourhoods into the target.
            fn required_halo(
                doc: &Document,
                id: &str,
                region: Rect,
                prepared: &HashMap<String, crate::geometry_snapshot::Prepared>,
                guard: i32,
                analytic_managed: bool,
                prune_opaque_shadow: bool,
                prune_backdrop_output: bool,
            ) -> i32 {
                let n = &doc.nodes[id];
                let Some(p) = prepared.get(id) else {
                    return 0;
                };
                let output = if prune_backdrop_output { backdrop_output_bounds(n, p) } else { p.bounds };
                if n.opacity <= 0. || output.intersect(region).empty() {
                    return 0;
                }
                if analytic_managed && prune_opaque_shadow && opaque_frame_shadow_candidate(doc, n)
                {
                    // Disable nested speculation during this trial traversal;
                    // failed ancestor certificates must not branch exponentially.
                    let descendants = n
                        .children
                        .iter()
                        .map(|child| {
                            required_halo(
                                doc,
                                child,
                                region,
                                prepared,
                                guard,
                                analytic_managed,
                                false,
                                prune_backdrop_output,
                            )
                        })
                        .max()
                        .unwrap_or(0);
                    // A pointwise composite can fetch the next texel even at a
                    // zero-weight bilinear corner. Include that neighbour too.
                    if opaque_interior(n, p.matrix, region.expand(descendants.saturating_add(2))) {
                        return descendants;
                    }
                }
                let own = if opaque_interior(n, p.matrix, region.expand(guard)) {
                    0
                } else {
                    if analytic_managed {
                        analytic_glass_halo(n, p.matrix, region)
                    } else {
                        None
                    }
                    .unwrap_or_else(|| halo(n, p.matrix))
                };
                own + n
                    .children
                    .iter()
                    .map(|child| {
                        required_halo(
                            doc,
                            child,
                            region.expand(own),
                            prepared,
                            guard,
                            analytic_managed,
                            prune_opaque_shadow,
                            prune_backdrop_output,
                        )
                    })
                    .max()
                    .unwrap_or(0)
            }
            let analytic_managed = doc.color_management.is_some()
                && options.raster_profile != crate::fidelity::RasterProfile::Analytic
                && backdrop_chain;
            let halo = page
                .children
                .iter()
                .map(|id| {
                    required_halo(
                        doc,
                        id,
                        viewport,
                        &prepared,
                        padding,
                        analytic_managed,
                        true,
                        backdrop_chain,
                    )
                })
                .max()
                .unwrap_or(0);
            if regional_foreground {
                viewport.expand(2)
            } else {
                viewport.expand(halo)
            }
        };
        if extent.pixels() > 16_777_216 {
            return Err("GPU surface budget exceeded".into());
        }
        let programs = if cache_key.is_some() {
            self.camera_prepare.as_mut().map(|cache|std::mem::take(&mut cache.programs)).unwrap_or_default()
        } else { ProgramCache::default() };
        let mut compiler = Compiler {
            doc,
            fonts: &self.fonts,
            paths: &mut self.paths,
            extent,
            prepared,
            compatible: options.raster_profile != crate::fidelity::RasterProfile::Analytic,
            profile: options.raster_profile,
            interactive_effects: options.interactive_effects,
            large_packet,
            prune_backdrop_output: backdrop_chain,
            curves: Vec::new(),
            area_paths: HashMap::new(),
            programs,
            nodes: BTreeMap::new(),
            vertices: Vec::new(),
        };
        for root in &page.children {
            compiler.node(root, camera, regional_foreground.then_some(viewport))?;
        }
        if cache_key.is_some() {
            if let Some(cache) = self.camera_prepare.as_mut() { cache.programs = compiler.programs; }
        }
        let mut nodes = compiler.nodes;
        if options.raster_profile != crate::fidelity::RasterProfile::Analytic {
            for n in nodes.values_mut() {
                n.fill.analytic_rect = None;
                n.fill.sample_count = Some(4);
                for s in &mut n.strokes {
                    s.path.analytic_rect = None;
                    s.path.sample_count = Some(4);
                }
            }
        }
        let mut colors = BTreeMap::new();
        {
            let mut add = |s: &str| -> Result<(), String> {
                if !colors.contains_key(s) && (doc.color_management.is_some() || s.starts_with("color(")) {
                    let value = match doc.color_management {
                        Some(settings) => settings.parse_straight(s)?,
                        None => crate::color::unmanaged_straight(s)?,
                    };
                    colors.insert(s.to_owned(), value);
                }
                Ok(())
            };
            add(&page.background)?;
            if options.checkerboard { add("#eeeeee")?; }
            for n in nodes.values() {
                for p in n.fills.iter().chain(n.strokes.iter().map(|s| &s.paint)) {
                    add(&p.color)?;
                    for s in &p.stops {
                        add(&s.color)?;
                    }
                }
                for e in &n.effects {
                    add(&e.color)?;
                }
            }
        }
        Ok(GpuScene {
            software_raster: options.raster_profile.is_software() && doc.color_management.is_none(),
            output: None,
            float_compositing: doc.color_management.is_some()
                || options.raster_profile == crate::fidelity::RasterProfile::Analytic,
            color_management: doc.color_management,
            colors,
            backdrop_samples: options.raster_profile != crate::fidelity::RasterProfile::Analytic
                && crate::fidelity::has_backdrop(doc, options),
            coherent_samples: crate::fidelity::coherent_samples(doc, options),
            integrated_blur: doc.color_management.is_some()
                || options.raster_profile != crate::fidelity::RasterProfile::Analytic,
            curves: compiler.curves,
            resolve: None,
            presentation: None,
            version: 7,
            width: options.width,
            height: options.height,
            extent,
            background: page.background.clone(),
            transparent: options.transparent,
            grid: options.grid,
            checkerboard: options.checkerboard && !options.transparent,
            checkerboard_size: if options.raster_profile.is_export() { 32 } else { 16 },
            view: options.view,
            roots: page.children.clone(),
            nodes,
            vertices: compiler.vertices,
        })
    }
}

#[cfg(test)]
mod analytic_glass_support_tests {
    use super::*;
    use crate::{
        blend::{Pixel, Surface},
        optics::{GlassShape, field},
    };
    use serde_json::json;

    fn lens(depth: f64, refraction: f64, dispersion: f64, radius: f64) -> Node {
        serde_json::from_value(json!({"id":"lens","kind":"rectangle","width":96,"height":64,
            "radii":[16,16,16,16],"fills":[{"kind":"solid","color":"#ffffff","opacity":0.14}],
            "effects":[{"kind":"glass","radius":radius,"color":"#000000","opacity":1,"glass":{"depth":depth,
                "refraction":refraction,"dispersion":dispersion,"lightAngle":31.25,"lightIntensity":0.75}}]})).unwrap()
    }

    #[test]
    fn analytic_glass_support_is_smaller_without_changing_general_fallbacks() {
        let node = lens(8., 0.5, 0.3, 12.);
        let region = Rect::new(0, 0, 516, 516);
        assert_eq!(halo(&node, Transform([4., 0., 0., 4., 0., 0.])), 163);
        assert_eq!(
            analytic_glass_halo(&node, Transform([4., 0., 0., 4., 0., 0.]), region),
            Some(68)
        );
        assert!(
            analytic_glass_halo(&node, Transform([2., 0., 0., 0.75, 0.125, 0.375]), region)
                .is_some()
        );
        for matrix in [
            Transform([1., 0.2, 0., 1., 0., 0.]),
            Transform([1., 0., 0.2, 1., 0., 0.]),
            Transform([0., 1., -1., 0., 0., 0.]),
        ] {
            assert!(analytic_glass_halo(&node, matrix, region).is_none());
        }
        assert!(
            analytic_glass_halo(&node, Transform::default(), Rect::new(1_048_576, 0, 16, 16))
                .is_none()
        );
        let mut other = node.clone();
        other.smoothing = 0.5;
        assert!(analytic_glass_halo(&other, Transform::default(), region).is_none());
        other = node.clone();
        other.kind = "ellipse".into();
        assert!(analytic_glass_halo(&other, Transform::default(), region).is_none());
        other = node.clone();
        other.effects.push(node.effects[0].clone());
        assert!(analytic_glass_halo(&other, Transform::default(), region).is_none());
    }

    #[test]
    fn compiler_only_reduces_managed_integrated_glass_support() {
        let node = lens(8., 0.5, 0.3, 12.);
        for managed in [false, true] {
            for profile in ["analytic", "figmaSubpixel", "figma"] {
                let mut document = json!({"schemaVersion":5,"id":"d","name":"support",
                    "pages":[{"id":"p","name":"p","background":"#808080","children":["lens"]}],
                    "nodes":{"lens":node}});
                if managed {
                    document["colorManagement"] =
                        serde_json::to_value(crate::color::ColorSettings::default()).unwrap();
                }
                let mut engine = Engine::new();
                engine.load_document(&document.to_string()).unwrap();
                let options: RenderOptions =
                    serde_json::from_value(json!({"pageId":"p","width":32,"height":32,
                    "view":{"x":-16.125,"y":-0.375,"zoom":1},"rasterProfile":profile,"grid":false}))
                    .unwrap();
                let scene = engine.compile_gpu(&options).unwrap();
                let scale = if profile == "figma" { 2. } else { 1. };
                let viewport = Rect::new(0, 0, (32. * scale) as u32, (32. * scale) as u32);
                let matrix = Transform([scale, 0., 0., scale, -16.125 * scale, -0.375 * scale]);
                let support = if managed && profile != "analytic" {
                    analytic_glass_halo(&node, matrix, viewport).unwrap()
                } else {
                    halo(&node, matrix)
                };
                assert_eq!(
                    scene.extent,
                    viewport.expand(support),
                    "managed={managed} profile={profile}"
                );
            }
        }
    }

    #[test]
    fn shared_camera_prepare_matches_per_tile_compile_byte_for_byte() {
        // The union prepare guard is a superset of every per-tile guard: leaves
        // outside the tile are empty under the tile guard and cull to zero
        // under the union guard, so each tile's scene must serialize
        // identically either way. Pan/edit reuse depends on this identity.
        let mut engine = Engine::new();
        engine
            .load_document(
                &json!({"schemaVersion":5,"id":"d","name":"tiles",
                    "colorManagement":crate::color::ColorSettings::default(),
                    "pages":[{"id":"p","name":"p","background":"#808080",
                        "children":["frame"]}],
                    "nodes":{"frame":{"id":"frame","kind":"frame","width":1200,"height":800,
                        "clip":true,"radii":[16,16,16,16],"fills":[{"kind":"solid","color":"#ffffff"}],
                        "children":["box","lens"],
                        "effects":[{"kind":"shadow","radius":8,"y":8,"color":"#000000","opacity":0.5}]},
                        "box":{"id":"box","kind":"rectangle","width":640,"height":480,
                            "transform":[1.,0.,0.,1.,300.5,200.25],"radii":[12,12,12,12],
                            "fills":[{"kind":"solid","color":"#3777e8"}],
                            "strokes":[{"paint":{"kind":"solid","color":"#101321","opacity":0.6},
                                "width":3,"align":"inside"}]},
                        "lens":lens(8., 0.5, 0.3, 12.)}})
                    .to_string(),
            )
            .unwrap();
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p",
            "width":514,"height":514,"view":{"x":-512.,"y":-512.,"zoom":1.},
            "rasterProfile":"figmaSubpixel"}))
        .unwrap();
        let union = Rect::new(-1, -1, 1543, 1543);
        // Prime the camera cache through a neighbouring tile first.
        engine
            .compile_gpu_region(
                &options,
                Rect::new(511, 511, 514, 514),
                Some(union),
            )
            .unwrap();
        for region in [
            Rect::new(-1, -1, 514, 514),
            Rect::new(511, -1, 514, 514),
            Rect::new(255, 255, 514, 514),
        ] {
            let mut reference = Engine::new();
            reference.load_document(&serde_json::to_string(engine.doc.as_ref().unwrap()).unwrap()).unwrap();
            let legacy = reference.compile_gpu_region(&options, region, None).unwrap();
            let shared = engine.compile_gpu_region(&options, region, Some(union)).unwrap();
            assert_eq!(
                serde_json::to_string(&legacy).unwrap(),
                serde_json::to_string(&shared).unwrap(),
                "tile {region:?} must be byte-identical under the shared prepare"
            );
        }
        let region = Rect::new(255, 255, 514, 514);
        let before = engine.compile_gpu_region(&options, region, Some(union)).unwrap().into_packet().unwrap();
        let hits = engine.gpu_compile_cache_stats()["hits"].as_u64().unwrap();
        let repeated = engine.compile_gpu_region(&options, region, Some(union)).unwrap().into_packet().unwrap();
        assert_eq!(before,repeated);
        let prepared = engine.camera_prepare.as_ref().unwrap().prepared.clone();
        let within = engine.compile_gpu_region(&options, region, Some(region)).unwrap().into_packet().unwrap();
        assert_eq!(before, within);
        assert!(Arc::ptr_eq(&prepared, &engine.camera_prepare.as_ref().unwrap().prepared));
        assert!(engine.gpu_compile_cache_stats()["hits"].as_u64().unwrap()>hits);
        assert!(engine.gpu_compile_cache_stats()["bytes"].as_u64().unwrap()<=ProgramCache::LIMIT as u64);
        let mut document=engine.doc.as_ref().unwrap().clone();
        document.nodes.get_mut("frame").unwrap().transform.0[4] += 16.;
        engine.load_document(&serde_json::to_string(&document).unwrap()).unwrap();
        let changed=engine.compile_gpu_region(&options,region,Some(union)).unwrap().into_packet().unwrap();
        let fresh=engine.compile_gpu_region(&options,region,None).unwrap().into_packet().unwrap();
        assert_eq!(changed,fresh,"a geometry revision must discard old compiled programs");
        assert!(changed!=before,"visible geometry changed after the revision");
    }

    #[test]
    fn sibling_filters_and_multiple_backdrops_keep_conservative_support() {
        let node = lens(8., 0.5, 0.3, 12.);
        let base = json!({"schemaVersion":5,"id":"d","name":"support",
            "pages":[{"id":"p","name":"p","background":"#808080","children":["parent"]}],
            "nodes":{"parent":{"id":"parent","kind":"frame","width":200,"height":200,
                "children":["lens","other"],"effects":[{"kind":"shadow","radius":3,"color":"#000000","opacity":0.5}]},
                "lens":node,"other":{"id":"other","kind":"rectangle","width":20,"height":20,
                    "effects":[{"kind":"noise","radius":12,"amount":0.75,"opacity":0.18,"color":"#000000"}]}}});
        let check = |value: serde_json::Value| {
            let doc: Document = serde_json::from_value(value).unwrap();
            single_backdrop_support_chain(&doc, &doc.pages[0].children)
        };
        assert!(
            check(base.clone()),
            "ancestor filter is already added by tree recursion; sibling noise is pointwise"
        );
        for kind in ["blur", "shadow", "texture", "glass", "background-blur"] {
            let mut value = base.clone();
            value["nodes"]["other"]["effects"][0]["kind"] = json!(kind);
            assert!(!check(value), "sibling {kind} needs conservative support");
        }
        let mut hidden = base;
        hidden["nodes"]["other"]["effects"][0]["kind"] = json!("blur");
        hidden["nodes"]["other"]["visible"] = json!(false);
        assert!(check(hidden));
    }

    #[test]
    fn opaque_parent_uses_descendant_support_but_keeps_uncertain_edges_and_masks() {
        let mut glass = lens(8., 0.5, 0.3, 12.);
        glass.transform = Transform([1., 0., 0., 1., 200.125, 216.375]);
        let base = json!({"schemaVersion":5,"id":"d","name":"parent support",
            "colorManagement":crate::color::ColorSettings::default(),
            "pages":[{"id":"p","name":"p","background":"#808080","children":["frame"]}],
            "nodes":{"frame":{"id":"frame","kind":"frame","width":300,"height":300,
                "clip":true,"radii":[16,16,16,16],"fills":[{"kind":"solid","color":"#ffffff"}],
                "children":["lens"],"effects":[{"kind":"shadow","radius":8,"y":8,"color":"#000000","opacity":0.5}]},
                "lens":glass}});
        let compile = |document: serde_json::Value, offset: f64| {
            let mut engine = Engine::new();
            engine.load_document(&document.to_string()).unwrap();
            let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":32,"height":32,
                "view":{"x":-offset-0.125,"y":-offset-0.375,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
            engine.compile_gpu(&options).unwrap()
        };
        let inside = compile(base.clone(), 220.);
        assert_eq!(inside.extent, Rect::new(0, 0, 32, 32).expand(19));
        assert!(inside.nodes["frame"].effects.is_empty());
        let boundary = compile(base.clone(), 258.);
        assert!(boundary.extent.w > inside.extent.w);
        assert!(!boundary.nodes["frame"].effects.is_empty());
        for (id, field, value) in [
            ("frame", "opacity", json!(0.75)),
            ("frame", "blend", json!("multiply")),
            ("frame", "clip", json!(false)),
            ("lens", "opacity", json!(0.5)),
            ("lens", "mask", json!(true)),
        ] {
            let mut document = base.clone();
            document["nodes"][id][field] = value;
            let scene = compile(document, 220.);
            assert!(
                scene.extent.w > inside.extent.w,
                "{id}.{field} must keep conservative support"
            );
        }
        let mut complex = base;
        let fill = complex["nodes"]["frame"]["fills"][0].clone();
        complex["nodes"]["frame"]["fills"]
            .as_array_mut()
            .unwrap()
            .push(fill);
        assert!(compile(complex, 220.).extent.w > inside.extent.w);
    }

    #[test]
    fn support_contains_every_dispersion_ray_and_bilinear_neighbour() {
        for depth in [1., 8., 64., 1000.] {
            for refraction in [0., 0.5, 1.] {
                for dispersion in [0., 0.3, 1.] {
                    for matrix in [
                        Transform([1., 0., 0., 1., -16.125, -16.375]),
                        Transform([2., 0., 0., 0.75, -32.375, -12.125]),
                        Transform([-0.5, 0., 0., 1.25, 48.625, -20.375]),
                    ] {
                        let node = lens(depth, refraction, dispersion, 3.75);
                        let Some(support) =
                            analytic_glass_halo(&node, matrix, Rect::new(0, 0, 32, 32))
                        else {
                            continue;
                        };
                        let glass = node.effects[0].glass.as_ref().unwrap();
                        let blur =
                            (node.effects[0].backdrop_radius() * matrix.max_scale()).ceil() as i32;
                        let shape = GlassShape::from_node(&node).unwrap();
                        for local in [
                            [0., 0.],
                            [16., 0.],
                            [48., 0.],
                            [96., 16.],
                            [96., 64.],
                            [48., 63.75],
                            [0., 32.],
                            [48., 32.],
                            // The refraction maximum is just inside the bevel,
                            // before transition to its much smaller outer rim.
                            [1., 32.],
                            [1.125, 32.],
                            [1.5, 32.],
                            [94.5, 32.],
                            [48., 1.],
                            [31.375, 1.125],
                            [48., 1.5],
                            [48., 62.5],
                        ] {
                            let p = matrix.point(Point::new(local[0], local[1]));
                            let region = Rect::new(p.x.floor() as i32, p.y.floor() as i32, 1, 1);
                            for sample in 0..4 {
                                let values =
                                    field(region, shape, matrix, glass, Some(sample)).unwrap();
                                let phase = crate::optics::sample_offset(Some(sample)).unwrap();
                                for tap in 0..8 {
                                    let t = tap as f32 * (1_f32 / 7.) - 0.5;
                                    for channel in 0..3 {
                                        let factor = 1.
                                            + (t + (0.5 - channel as f32 * 0.5))
                                                * glass.chromatic_aberration();
                                        for axis in 0..2 {
                                            let offset = phase[axis] + values[axis] * factor;
                                            for neighbour in
                                                [offset.floor() as i32, offset.floor() as i32 + 1]
                                            {
                                                assert!(
                                                    neighbour.abs() + blur <= support,
                                                    "depth={depth} r={refraction} d={dispersion} offset={offset} support={support}"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn support_includes_nonzero_weight_red_ray_at_the_inner_bevel_peak() {
        let node = lens(128., 1., 1., 3.75);
        let glass = node.effects[0].glass.as_ref().unwrap();
        let output = Rect::new(31, 1, 1, 1);
        let support = analytic_glass_halo(&node, Transform::default(), output).unwrap();
        let values = field(
            output,
            GlassShape::from_node(&node).unwrap(),
            Transform::default(),
            glass,
            Some(0),
        )
        .unwrap();
        let t = 6_f32 * (1_f32 / 7.) - 0.5;
        let weight = 1. - (t * 2.).abs();
        assert!(
            weight > 0.,
            "A zero-weight endpoint cannot alone demonstrate lost pixels"
        );
        let factor = 1. + (t + 0.5) * glass.chromatic_aberration();
        let offset = crate::optics::sample_offset(Some(0)).unwrap();
        let delta = offset[1] + values[1] * factor;
        let last_tap = delta.floor() as i32 + 1;
        let required = last_tap + node.effects[0].backdrop_radius().ceil() as i32;
        assert!(
            required >= 154,
            "Keep this control beyond the rejected 150px bound"
        );
        assert!(
            support >= required,
            "support={support} actual nonzero-ray support={required} displacement={} factor={factor} delta={delta}",
            values[1]
        );
    }

    #[test]
    fn cropped_filter_and_all_optical_read_operands_preserve_float_bits() {
        let output = Rect::new(0, 0, 9, 7);
        for (depth, refraction, dispersion, radius, matrix) in [
            (
                8.,
                0.5,
                0.3,
                1.,
                Transform([1., 0., 0., 1., -16.125, -0.375]),
            ),
            (
                8.,
                1.,
                1.,
                2.25,
                Transform([2., 0., 0., 2., -32.375, -1.125]),
            ),
            (
                24.,
                1.,
                1.,
                1.,
                Transform([1.25, 0., 0., 0.75, -20.625, -0.875]),
            ),
            (
                8.,
                0.,
                1.,
                3.75,
                Transform([-1., 0., 0., 1., 80.125, -0.125]),
            ),
        ] {
            let node = lens(depth, refraction, dispersion, radius);
            let required = analytic_glass_halo(&node, matrix, output).unwrap();
            let old = halo(&node, matrix);
            let make = |rect: Rect| {
                let mut image = Surface::new(rect).unwrap();
                for y in rect.y..rect.bottom() {
                    for x in rect.x..rect.right() {
                        // Extended-range, fractional-alpha data; no byte encoding.
                        image.pixels[rect.index(x, y).unwrap()] = Pixel([
                            (x.rem_euclid(19) as f32 - 3.) / 8.,
                            y.rem_euclid(13) as f32 / 16.,
                            (x - y).rem_euclid(11) as f32 / 4.,
                            0.75,
                        ]);
                    }
                }
                image
            };
            let full = make(output.expand(old + 3));
            let crop = make(output.expand(required));
            let filter_radius = node.effects[0].backdrop_radius() * matrix.max_scale();
            let full = crate::effects::linear_tent_blur(&full, filter_radius, false).unwrap();
            let crop = crate::effects::linear_tent_blur(&crop, filter_radius, false).unwrap();
            let shape = GlassShape::from_node(&node).unwrap();
            let glass = node.effects[0].glass.as_ref().unwrap();
            for sample in 0..4 {
                let af = field(full.rect, shape, matrix, glass, Some(sample)).unwrap();
                let bf = field(crop.rect, shape, matrix, glass, Some(sample)).unwrap();
                let phase = crate::optics::sample_offset(Some(sample)).unwrap();
                for y in output.y..output.bottom() {
                    for x in output.x..output.right() {
                        let ai = full.rect.index(x, y).unwrap() * 4;
                        let bi = crop.rect.index(x, y).unwrap() * 4;
                        assert_eq!(
                            af[ai..ai + 4]
                                .iter()
                                .map(|v| v.to_bits())
                                .collect::<Vec<_>>(),
                            bf[bi..bi + 4]
                                .iter()
                                .map(|v| v.to_bits())
                                .collect::<Vec<_>>()
                        );
                        for tap in 0..8 {
                            for channel in 0..3 {
                                let t = tap as f32 * (1_f32 / 7.) - 0.5;
                                let factor = 1.
                                    + (t + (0.5 - channel as f32 * 0.5))
                                        * glass.chromatic_aberration();
                                let delta =
                                    [phase[0] + af[ai] * factor, phase[1] + af[ai + 1] * factor];
                                let a = crate::material::sample(&full, x, y, delta, true);
                                let b = crate::material::sample(&crop, x, y, delta, true);
                                assert_eq!(
                                    a.0.map(f32::to_bits),
                                    b.0.map(f32::to_bits),
                                    "crop altered optical operand at {x},{y}; depth={depth} refraction={refraction}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod incremental_prepare_tests {
    use super::*;
    use serde_json::json;
    fn document() -> serde_json::Value {
        json!({"schemaVersion":5,"id":"incremental","name":"incremental",
          "colorManagement":crate::color::ColorSettings::default(),
          "pages":[{"id":"p","name":"p","background":"#ffffff","children":["frame","fixed"]}],
          "nodes":{
            "frame":{"id":"frame","kind":"frame","width":900,"height":600,"clip":true,
              "transform":[1,0,0,1,10.25,12.5],"children":["moving","sibling"],"blend":"multiply",
              "effects":[{"kind":"background-blur","radius":8,"color":"#000000"}],"fills":[{"kind":"solid","color":"#ffffff"}]},
            "moving":{"id":"moving","kind":"rectangle","width":80,"height":60,"transform":[1,0,0,1,20,30],
              "radii":[8,8,8,8],"fills":[{"kind":"solid","color":"#0099ff"}]},
            "sibling":{"id":"sibling","kind":"rectangle","width":75,"height":90,"transform":[1,0,0,1,170,100],
              "fills":[{"kind":"solid","color":"#ff9900"}]},
            "fixed":{"id":"fixed","kind":"rectangle","width":90,"height":100,"transform":[1,0,0,1,950,120],
              "fills":[{"kind":"solid","color":"#336699"}]}}})
    }
    fn large_document() -> serde_json::Value {
        let mut nodes = serde_json::Map::new();
        let mut children = Vec::new();
        for i in 0..3500 {
            let id = format!("node-{i:05}"); children.push(id.clone());
            nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":5,"height":5,
                "transform":[1,0,0,1,(i%80)*8,(i/80)*8],
                "fills":[{"kind":"solid","color":"#527acc"}],
                "strokes":[{"width":0.5,"paint":{"kind":"solid","color":"#203040"}}]}));
        }
        json!({"schemaVersion":1,"id":"large-prepare","name":"Large prepare",
            "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],"nodes":nodes})
    }
    #[test]
    fn partial_prepare_reuses_large_map_without_changing_packets() {
        for profile in ["analytic", "figmaSubpixel"] {
            let mut doc = large_document();
            let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
            let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":514,"height":514,
                "view":{"x":0.125,"y":0.375,"zoom":1.25},"rasterProfile":profile})).unwrap();
            let guard = Rect::new(-1,-1,1100,900);
            let region = Rect::new(-1,-1,514,514);
            engine.compile_gpu_region(&options,region,Some(guard)).unwrap();
            assert_eq!(engine.camera_prepare.as_ref().unwrap().prepared.len(),3500);
            for i in 1..=3 {
                let transform = Transform([1.,0.,0.,1.,i as f64*0.375,0.125]);
                doc["nodes"]["node-00000"]["transform"] = json!(transform);
                assert!(engine.apply_interaction_transforms(&[("node-00000".into(),transform)].into_iter().collect()).unwrap());
                let cache = engine.camera_prepare.as_ref().unwrap();
                assert_eq!(cache.prepared.len(),3499);
                // Do not retain an Arc here: a live external reader legitimately
                // requires copy-on-write. The production compiler owns this map.
                let allocation = Arc::as_ptr(&cache.prepared);
                let actual = engine.compile_gpu_region(&options,region,Some(region)).unwrap().into_packet().unwrap();
                let mut fresh = Engine::new(); fresh.load_document(&doc.to_string()).unwrap();
                assert_eq!(actual,fresh.compile_gpu_region(&options,region,Some(guard)).unwrap().into_packet().unwrap());
                assert_eq!(allocation,Arc::as_ptr(&engine.camera_prepare.as_ref().unwrap().prepared),
                    "a one-node translation must not clone all 3499 retained records");
                // The rebuilt map must retain the original outer guard, even
                // when its first consumer requests only the inner crop.
                let outer = Rect::new(511,-1,514,514);
                assert_eq!(engine.compile_gpu_region(&options,outer,Some(guard)).unwrap().into_packet().unwrap(),
                    fresh.compile_gpu_region(&options,outer,Some(guard)).unwrap().into_packet().unwrap());
            }
        }
    }
    #[test]
    fn partial_prepare_preserves_a_live_shared_reader() {
        let mut doc = large_document();
        let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":96,"height":96,
            "view":{"x":0.125,"y":0.375,"zoom":1.25}})).unwrap();
        engine.compile_gpu(&options).unwrap();
        let transform = Transform([1.,0.,0.,1.,0.375,0.125]);
        doc["nodes"]["node-00000"]["transform"] = json!(transform);
        assert!(engine.apply_interaction_transforms(&[("node-00000".into(),transform)].into_iter().collect()).unwrap());
        let reader = engine.camera_prepare.as_ref().unwrap().prepared.clone();
        assert_eq!(reader.len(),3499); assert!(!reader.contains_key("node-00000"));
        let actual = engine.compile_gpu(&options).unwrap().into_packet().unwrap();
        let mut fresh = Engine::new(); fresh.load_document(&doc.to_string()).unwrap();
        assert_eq!(actual,fresh.compile_gpu(&options).unwrap().into_packet().unwrap());
        assert_eq!(reader.len(),3499); assert!(!reader.contains_key("node-00000"));
        assert!(!Arc::ptr_eq(&reader,&engine.camera_prepare.as_ref().unwrap().prepared));
    }
    #[test]
    fn partial_prepare_failure_retries_without_reusing_unfinished_geometry() {
        let mut doc = large_document();
        doc["nodes"]["parent"] = json!({"id":"parent","kind":"group","width":1,"height":1,
            "transform":[10000000,0,0,10000000,0,0],"children":["node-00000"]});
        doc["pages"][0]["children"][0] = json!("parent");
        doc["nodes"]["node-00000"]["transform"] = json!([1,0,0,1,99999,0]);
        let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":96,"height":96,
            "view":{"x":0,"y":0,"zoom":1}})).unwrap();
        engine.compile_gpu(&options).unwrap();
        // Locally valid transforms can exceed the composed precision budget.
        // Two failed compilations must not certify a half-prepared cache.
        let invalid = Transform([1.,0.,0.,1.,100001.,0.]);
        assert!(engine.apply_interaction_transforms(&[("node-00000".into(),invalid)].into_iter().collect()).unwrap());
        for _ in 0..2 {
            assert_eq!(engine.compile_gpu(&options).err().unwrap(),"Composed transform exceeds precision budget");
            assert!(engine.camera_prepare.as_ref().unwrap().incomplete);
        }
        let valid = Transform([1.,0.,0.,1.,99998.,0.]);
        assert!(engine.apply_interaction_transforms(&[("node-00000".into(),valid)].into_iter().collect()).unwrap());
        doc["nodes"]["node-00000"]["transform"] = json!(valid);
        let actual = engine.compile_gpu(&options).unwrap().into_packet().unwrap();
        let mut fresh = Engine::new(); fresh.load_document(&doc.to_string()).unwrap();
        assert_eq!(actual,fresh.compile_gpu(&options).unwrap().into_packet().unwrap());
        assert!(!engine.camera_prepare.as_ref().unwrap().incomplete);
    }
    #[test]
    fn translation_keeps_unaffected_geometry_and_matches_fresh_packets() {
        for profile in ["analytic","figmaSubpixel"] {
            let mut doc=document();let mut engine=Engine::new();engine.load_document(&doc.to_string()).unwrap();
            let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":514,"height":514,
                "view":{"x":0.125,"y":0.375,"zoom":1.2},"rasterProfile":profile})).unwrap();
            let guard=Rect::new(-1,-1,1600,900);
            engine.compile_gpu_region(&options,Rect::new(-1,-1,514,514),Some(guard)).unwrap();
            let fixed=engine.camera_prepare.as_ref().unwrap().prepared["fixed"].fill.clone();
            let sibling=engine.camera_prepare.as_ref().unwrap().prepared["sibling"].fill.clone();
            for i in 1..=5 {
                doc["nodes"]["moving"]["transform"]=json!([1,0,0,1,20.+i as f64*0.375,30.-i as f64*0.25]);
                let patch=serde_json::from_value(json!({"nodes":{"moving":doc["nodes"]["moving"]}})).unwrap();
                let damage=engine.apply_document_patch_with_damage(&patch).unwrap();
                assert_eq!(damage.translation_only,Some(true));
                assert!(engine.camera_prepare.as_ref().unwrap().incomplete);
                for x in [-1,511,1023] {
                    let region=Rect::new(x,-1,514,514);
                    let actual=engine.compile_gpu_region(&options,region,Some(if x == -1 { region } else { guard })).unwrap().into_packet().unwrap();
                    let mut fresh=Engine::new();fresh.load_document(&doc.to_string()).unwrap();
                    let expected=fresh.compile_gpu_region(&options,region,Some(guard)).unwrap().into_packet().unwrap();
                    assert_eq!(actual,expected,"profile={profile},step={i},tile={x}");
                }
                let cache=engine.camera_prepare.as_ref().unwrap();
                assert!(Arc::ptr_eq(&fixed,&cache.prepared["fixed"].fill));
                assert!(Arc::ptr_eq(&sibling,&cache.prepared["sibling"].fill));
                assert!(cache.retained_nodes>=2);
            }
            // Material edits retain exact coverage, but never the old paint.
            doc["nodes"]["moving"]["fills"][0]["color"]=json!("#ff00ff");
            let patch=serde_json::from_value(json!({"nodes":{"moving":doc["nodes"]["moving"]}})).unwrap();
            assert_eq!(engine.apply_document_patch_with_damage(&patch).unwrap().translation_only,None);
            assert!(engine.camera_prepare.is_some());
            let mut fresh=Engine::new();fresh.load_document(&doc.to_string()).unwrap();
            let region=Rect::new(-1,-1,514,514);
            assert_eq!(engine.compile_gpu_region(&options,region,Some(guard)).unwrap().into_packet().unwrap(),
                fresh.compile_gpu_region(&options,region,Some(guard)).unwrap().into_packet().unwrap());
        }
    }
}

#[cfg(test)]
mod program_identity_tests {
    use super::*;
    #[test]
    fn colliding_hashes_still_compare_all_float_bits() {
        let make=|data|ProgramIdentity(Arc::new(CachedProgram{program:crate::area_program::AreaProgram{rect:Rect::default(),data},fingerprint:7}));
        let a=make(vec![0.,1.]);let equal=make(vec![0.,1.]);let signed=make(vec![-0.,1.]);let different=make(vec![0.,2.]);
        let mut map=HashMap::new();map.insert(a.clone(),1);
        assert_eq!(map.get(&a),Some(&1));assert_eq!(map.get(&equal),Some(&1));
        assert!(map.get(&signed).is_none());assert!(map.get(&different).is_none());
        map.insert(signed,2);assert_eq!(map.len(),2);
    }
}

#[cfg(test)]
mod program_cache_invalidation_tests {
    use super::*;
    use std::collections::HashSet;

    fn shape(slot: usize) -> ProgramShape { (slot, 0, 0, 1, 1, false, true) }
    fn program(value: f32, words: usize) -> Arc<CachedProgram> {
        Arc::new(CachedProgram::new(crate::area_program::AreaProgram {
            rect: Rect::new(0, 0, 1, 1), data: vec![value; words],
        }))
    }
    fn dirty(id: &str) -> HashSet<String> { [id.to_owned()].into_iter().collect() }

    #[test]
    fn replacement_accounts_only_one_live_program_and_fifo_record() {
        let mut cache = ProgramCache::default();
        cache.insert("moving", shape(0), program(1., 4));
        let replacement = program(2., 8);
        cache.insert("moving", shape(0), replacement.clone());
        assert_eq!(cache.bytes, 8*4 + "moving".len()*2 + 512);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.order.len(), 1);
        assert!(Arc::ptr_eq(&cache.get("moving", &shape(0)).unwrap(), &replacement));
    }

    #[test]
    fn invalidation_preserves_other_nodes_and_live_program_readers() {
        let mut cache = ProgramCache::default();
        let reader = program(1., 4);
        let fixed = program(3., 12);
        cache.insert("moving", shape(0), reader.clone());
        cache.insert("moving", shape(1), program(2., 8));
        cache.insert("fixed", shape(0), fixed.clone());
        cache.retain_nodes(&dirty("moving"));
        assert!(!cache.entries.contains_key("moving"));
        assert!(cache.get("moving", &shape(0)).is_none());
        assert!(cache.get("moving", &shape(1)).is_none());
        assert_eq!(reader.data, vec![1.; 4]);
        assert!(Arc::ptr_eq(&cache.get("fixed", &shape(0)).unwrap(), &fixed));
        assert_eq!(cache.bytes, 12*4 + "fixed".len()*2 + 512);
        assert_eq!(cache.order.len(), 1);
        cache.retain_nodes(&dirty("missing"));
        assert_eq!(cache.len(), 1);
        cache.retain_nodes(&dirty("fixed"));
        assert_eq!((cache.len(), cache.bytes, cache.order.len()), (0, 0, 0));
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn repeated_invalidation_and_reinsertion_keeps_fifo_storage_bounded() {
        let mut cache = ProgramCache::default();
        cache.insert("fixed", shape(0), program(3., 12));
        for i in 0..5000 {
            cache.insert("moving", shape(0), program(i as f32, 4));
            cache.retain_nodes(&dirty("moving"));
            assert_eq!(cache.order.len(), 1, "iteration {i}");
            assert_eq!(cache.len(), 1);
        }
        assert_eq!(cache.bytes, 12*4 + "fixed".len()*2 + 512);
    }

    #[test]
    fn reinsertion_is_evicted_in_its_new_fifo_position() {
        let mut cache = ProgramCache::default();
        let words = ProgramCache::LIMIT / 12;
        cache.insert("a", shape(0), program(1., words));
        cache.insert("b", shape(0), program(2., words));
        cache.retain_nodes(&dirty("a"));
        let newer = program(3., words);
        cache.insert("a", shape(0), newer.clone());
        cache.insert("c", shape(0), program(4., words));
        assert!(cache.get("b", &shape(0)).is_none());
        assert!(Arc::ptr_eq(&cache.get("a", &shape(0)).unwrap(), &newer));
        assert!(cache.get("c", &shape(0)).is_some());
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.order.len(), 2);
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.bytes, 2*(words*4 + 2 + 512));
        assert!(cache.bytes <= ProgramCache::LIMIT);
    }

    #[test]
    fn oversized_program_does_not_disturb_resident_entries() {
        let mut cache = ProgramCache::default();
        let fixed = program(1., 4);
        cache.insert("fixed", shape(0), fixed.clone());
        let before = cache.bytes;
        cache.insert("large", shape(0), program(2., ProgramCache::LIMIT/4));
        assert_eq!(cache.bytes, before);
        assert_eq!(cache.order.len(), 1);
        assert!(Arc::ptr_eq(&cache.get("fixed", &shape(0)).unwrap(), &fixed));
        assert!(cache.get("large", &shape(0)).is_none());
    }

    #[test]
    fn fifo_serial_rollover_preserves_entries_order_and_accounting() {
        let mut cache = ProgramCache::default();
        let words = ProgramCache::LIMIT / 12;
        cache.next_order = u64::MAX - 1;
        let first = program(1., words);
        cache.insert("first", shape(0), first.clone());
        assert_eq!(cache.next_order, u64::MAX);
        let second = program(2., words);
        cache.insert("second", shape(0), second.clone());
        assert_eq!(cache.next_order, 2);
        assert_eq!(cache.order.keys().copied().collect::<Vec<_>>(), vec![0, 1]);
        assert!(Arc::ptr_eq(&cache.get("first", &shape(0)).unwrap(), &first));
        assert!(Arc::ptr_eq(&cache.get("second", &shape(0)).unwrap(), &second));
        cache.insert("third", shape(0), program(3., words));
        assert!(cache.get("first", &shape(0)).is_none());
        assert!(cache.get("second", &shape(0)).is_some());
        assert!(cache.get("third", &shape(0)).is_some());
        assert_eq!(cache.order.len(), 2);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.bytes, 2*words*4 + ("second".len()+"third".len())*2 + 1024);
        cache.retain_nodes(&dirty("second"));
        assert_eq!(cache.order.len(), 1);
        assert_eq!(cache.bytes, words*4 + "third".len()*2 + 512);
    }

    #[test]
    #[ignore = "isolated native CPU benchmark; run with --ignored --nocapture"]
    fn benchmark_single_node_cache_invalidation() {
        use std::{hint::black_box, time::Instant};
        for count in [3000, 10000] {
            let mut cache = ProgramCache::default();
            let shared = program(1., 8);
            for i in 0..count { cache.insert(&format!("node-{i:05}"), shape(0), shared.clone()); }
            let dirty = dirty("node-00000");
            let mut samples = Vec::new();
            for sample in 0..36 {
                let start = Instant::now();
                for _ in 0..32 {
                    cache.retain_nodes(black_box(&dirty));
                    cache.insert("node-00000", shape(0), shared.clone());
                }
                if sample >= 5 { samples.push(start.elapsed().as_secs_f64()*1000./32.); }
            }
            samples.sort_by(f64::total_cmp);
            println!("{}", serde_json::json!({"nodes":count,"p50Ms":samples[15],"p95Ms":samples[29],"samplesMs":samples}));
            assert_eq!(cache.len(), count);
            assert_eq!(cache.order.len(), count);
        }
    }
}
