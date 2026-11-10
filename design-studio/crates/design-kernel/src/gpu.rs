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
mod suffix;
mod fragments;
mod source_filter;
mod dense_paint;
mod dense_coverage;
mod source_occlusion;
#[cfg(test)] mod page_dependency_tests;
pub mod scene_plan;
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
/// one render request. The retained guard may be the union of the request's
/// crops. `flatten_for_fill` replaces curves outside that guard with chords, so
/// a wider guard is not a superset of a tile guard: on a real FIG the published
/// rect of `fig-0-8200` moved from y=131,h=195 to y=90,h=236. Scene emission
/// therefore prepares again against the tile's own guard. The retained map
/// stays on the requested window for incremental edits. Programs are dropped
/// when that emission guard changes so a neighbouring tile cannot reuse a
/// crop compiled from different contours.
/// One active entry plus bounded inactive camera variants are retained. All
/// variants remain keyed by exact document/font geometry lineage.
type CameraPrepareKey = (u64, String, (f64, f64, f64), (i32, i32, u32, u32), bool, Option<crate::animation::Sample>);
pub(crate) struct CameraPrepare {
    pub(crate) key: CameraPrepareKey,
    pub(crate) prepared: Arc<HashMap<String, crate::geometry_snapshot::Prepared>>,
    programs: ProgramCache,
    /// Emission guard the cached programs were compiled from. A wider retained
    /// map can serve several tiles; their contours are not interchangeable.
    program_guard: Option<(i32, i32, u32, u32)>,
    fragments: fragments::FragmentCache,
    metadata: Option<CameraMetadata>,
    reuses: u64,
    incomplete: bool,
    retained_nodes: usize,
    incremental: bool,
}
impl CameraPrepare {
    fn retained_bytes(&self) -> usize {
        let contours = |cs: &Vec<crate::path::Contour>| cs.capacity()*std::mem::size_of::<crate::path::Contour>() +
            cs.iter().map(|c|c.points.capacity()*std::mem::size_of::<Point>()).sum::<usize>();
        self.programs.bytes + self.fragments.bytes + self.prepared.capacity()*192 + self.prepared.iter().map(|(id,p)|
            id.capacity()+contours(&p.fill)+p.strokes.iter().map(|s|contours(s)).sum::<usize>()).sum::<usize>()
    }
    pub(crate) fn paint_changed(&mut self, revision: u64, doc:&Document, ids:impl Iterator<Item=String>, parents:&impl crate::render_index::ParentLookup) {
        self.key.0 = revision;
        // Opacity can change whether a backdrop chain is active. Refresh this
        // summary even when all exact coverage programs remain reusable.
        self.metadata = None;
        self.fragments.invalidate_tree(doc,ids,parents); self.programs.reserve(self.fragments.bytes);
        self.incremental=true;
    }
    /// Affine interaction edits (rotation/scale) reuse the translation dirty
    /// set — moved subtree plus ancestors — but a changed linear part can move
    /// device-space effect margins (radius × scale) and the guard padding, so
    /// the camera metadata summary must be rebuilt instead of retained.
    pub(crate) fn transformed(&mut self, doc: &Document, ids: impl Iterator<Item = String>, revision: u64, parents: &impl crate::render_index::ParentLookup) {
        self.translated(doc, ids, revision, parents);
        self.metadata = None;
    }
    /// Only called after a validated pure-translation edit. The exact camera,
    /// guard, styles and resource lineage are unchanged. Descendants need new
    /// device geometry; ancestors need new aggregate bounds. Other entries and
    /// their exact-crop programs remain immutable.
    pub(crate) fn translated(&mut self, doc: &Document, ids: impl Iterator<Item = String>, revision: u64, parents: &impl crate::render_index::ParentLookup) {
        let mut dirty = std::collections::HashSet::new();
        let mut stack: Vec<String> = ids.collect();
        for id in &stack {
            parents.for_each_ancestor(id,|id|{dirty.insert(id.to_owned());});
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
        self.fragments.invalidate(&dirty); self.programs.reserve(self.fragments.bytes);
        self.key.0 = revision;
        // Rigid translation leaves effect radii, linear transforms and
        // dependency topology unchanged; camera metadata stays valid.
        self.incomplete = true;
        self.incremental = true;
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
    frame_resource_bytes: usize,
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
            if bytes<=Self::LIMIT.saturating_sub(self.frame_resource_bytes) {
                while self.entries.len()>=4 || self.bytes+bytes>Self::LIMIT.saturating_sub(self.frame_resource_bytes) {
                    if let Some((_,bytes))=self.entries.pop_front(){self.bytes-=bytes;self.evictions+=1;}else{break;}
                }
                self.bytes+=bytes;self.entries.push_back((old,bytes));
            }
        }
        *active=next;
    }
    pub(crate) fn reserve_frame_resources(&mut self,bytes:usize) {
        self.frame_resource_bytes=bytes;
        while self.bytes>Self::LIMIT.saturating_sub(bytes) {if let Some((_,size))=self.entries.pop_front(){self.bytes-=size;self.evictions+=1;}else{break;}}
    }
    pub(crate) fn clear(&mut self) {self.entries.clear();self.bytes=0;}
    fn stats(&self)->serde_json::Value {
        serde_json::json!({"entries":self.entries.len(),"bytes":self.bytes,"restores":self.restores,"evictions":self.evictions})
    }
}

/// Camera-independent page predicates, owned by the same immutable revision
/// as world support. Keep the original page traversal semantics, including
/// conservative flags below hidden nodes and raw-child backdrop dependencies.
#[derive(Clone, Copy)]
pub(crate) struct PageProperties {
    backdrop_chain:bool,foreground_only:bool,noise_extra:Option<i32>,has_zoom:bool,
}
impl PageProperties {
    #[cfg(all(not(target_arch="wasm32"),feature="mapped-source-snapshot"))]
    pub(crate) fn with_cold_ordinary(mut self,count:usize,solid:bool)->Self {
        // Cold units have no effects, derived children or backdrop reads.
        // Only noise's global raw-node count/paint predicate needs adjustment.
        if let Some(extra)=self.noise_extra {
            self.noise_extra=Some(extra.saturating_add(i32::try_from(count.saturating_mul(2)).unwrap_or(i32::MAX)));
            self.foreground_only &= solid;
        }
        self
    }
    pub(crate) fn build(doc:&Document,roots:&[String])->Self {
        let mut page_nodes=Vec::new();let mut seen=std::collections::HashSet::new();
        let mut stack=roots.iter().map(String::as_str).collect::<Vec<_>>();
        while let Some(id)=stack.pop(){if !seen.insert(id){continue}if let Some(node)=doc.nodes.get(id){
            page_nodes.push(node);stack.extend(node.render_children().iter().map(String::as_str));
        }}
        let noise_extra=page_nodes.iter().any(|n|n.effects.iter().any(|e|e.visible&&e.kind=="noise")).then(||{
            let extra=page_nodes.len().saturating_mul(2).saturating_add(page_nodes.iter().map(|n|n.effects.len()).max().unwrap_or(0));
            i32::try_from(extra).unwrap_or(i32::MAX)
        });
        Self {backdrop_chain:single_backdrop_support_chain(doc,roots),
            foreground_only:doc.color_management.is_some()&&page_nodes.iter().all(|n|{
                let phase_safe=noise_extra.is_none()||n.fills.iter().all(|p|!p.visible||p.kind=="solid")
                    &&n.strokes.iter().all(|s|!s.visible||s.width<=0.||s.paint.kind=="solid")
                    &&n.effects.iter().all(|e|!e.visible||e.gradient_blur.is_none()&&(!matches!(e.kind.as_str(),"shadow"|"inner-shadow")||e.x==0.&&e.y==0.));
                phase_safe&&n.effects.iter().all(|e|!e.visible||matches!(e.kind.as_str(),"blur"|"shadow"|"inner-shadow"|"noise"))
            }),noise_extra,has_zoom:crate::zoom_support::has_zoom(doc,roots)}
    }
}

/// Trusted whole-page facts retained while geometry consumes a resolved
/// demand projection. No request field can construct this context.
#[derive(Clone)]
pub(crate) struct SourceCompileContext {
    pub(crate) page:String,pub(crate) camera:(f64,f64,f64),pub(crate) properties:PageProperties,
    pub(crate) padding:i32,pub(crate) backdrop:bool,pub(crate) stage:String,
    pub(crate) stage_children:Arc<Vec<String>>,pub(crate) reserved_bytes:usize,
    pub(crate) page_paint_rects:Option<Vec<[f64;4]>>,
}
impl PageProperties {pub(crate) fn has_zoom(&self)->bool{self.has_zoom}}

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
    reserved_bytes: usize,
    hits: u64,
    builds: u64,
}
struct ProgramEntry { order: u64, program: Arc<CachedProgram> }
impl ProgramCache {
    const LIMIT: usize = 32 * 1024 * 1024;
    fn reserve(&mut self, bytes:usize) {
        self.reserved_bytes=bytes;
        while self.bytes>Self::LIMIT.saturating_sub(bytes) {
            let Some((_,(id,shape)))=self.order.pop_first()else{break};
            if let Some(entries)=self.entries.get_mut(&id){
                if let Some(entry)=entries.remove(&shape){self.bytes-=Self::program_bytes(&id,&entry.program);self.count-=1;}
                if entries.is_empty(){self.entries.remove(&id);}
            }
        }
    }
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
        if size > Self::LIMIT.saturating_sub(self.reserved_bytes) { return; }
        // Replacement is one live entry. Retire its old size/FIFO record
        // before admitting the new version, including at the byte limit.
        if let Some(old) = self.entries.get_mut(id).and_then(|entries| entries.remove(&shape)) {
            self.bytes -= Self::program_bytes(id, &old.program);
            self.count -= 1;
            self.order.remove(&old.order);
        }
        while self.bytes + size > Self::LIMIT.saturating_sub(self.reserved_bytes) {
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
#[derive(Clone, Serialize)]
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
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStroke {
    pub path: GpuPath,
    pub paint: GpuPaint,
    pub align: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct GaussianRegion { pub source:Rect, pub output:Rect, pub radii:[u32;3],
    #[serde(skip_serializing_if="Option::is_none")] pub factor:Option<u32>,
    #[serde(skip_serializing_if="Option::is_none")] pub full_output:Option<Rect>,
}
fn gaussian_region_plan(n:&Node,matrix:Transform,output:Rect)->Option<GaussianRegion>{
    gaussian_region_plan_above(n,matrix,output,512.)
}
fn gaussian_region_plan_above(n:&Node,matrix:Transform,output:Rect,minimum:f64)->Option<GaussianRegion>{
    if !n.render_children().is_empty()||n.clip||n.mask||n.blend!="normal"||n.passes_backdrop()||
        n.strokes.iter().any(|s|s.visible&&s.width>0.)||
        n.fills.len()!=1||!n.fills[0].visible||!matches!(n.fills[0].kind.as_str(),"solid"|"image")||n.fills[0].blend!="normal"||
        n.effects.iter().filter(|e|e.visible).count()!=1||output.empty()||output.w>1024||output.h>1024{return None}
    let effect=n.effects.iter().find(|e|e.visible)?;
    if effect.kind!="gaussian-blur"||effect.gradient_blur.is_some(){return None}
    let sigma=effect.radius*matrix.max_scale();if !(minimum..=1024.).contains(&sigma)||sigma==minimum{return None}
    let radii=crate::effects::gaussian_box_radii_region(sigma).ok()?;
    let support=radii.iter().sum::<u32>() as i32;
    let source=output.expand(support);
    let first_width=source.w.checked_sub(2*radii[0])?;
    // The input is produced in bounded strips. The first stored H result and
    // every smaller H/V result retain the original per-surface pixel budget.
    if source.w>8192||source.h>8192||u64::from(first_width)*u64::from(source.h)>16_777_216||
        [source.x,source.y,source.right(),source.bottom()].iter().any(|v|i64::from(*v).abs()>1_048_576){return None}
    Some(GaussianRegion{source,output,radii,factor:None,full_output:None})
}
// A separate display recipe. Original authored sigma, full output density and
// exact/export paths remain unchanged. Only a broad, single convex solid source
// may use the reduced effect grid; thin/concave/multi-contour/HDR sources decline.
fn reduced_gaussian_source(n:&Node,matrix:Transform,plan:&GaussianRegion,path:&crate::path::Path,factor:u32)
    -> Option<(GaussianRegion,Arc<Vec<crate::path::Contour>>)> {
    if !matches!(factor,2|4|8)||n.kind=="text"||n.fills.first()?.kind!="solid" {return None}
    let color=n.fills.first()?.color.as_bytes();
    if !matches!(color.len(),4|5|7|9)||color[0]!=b'#'||!color[1..].iter().all(u8::is_ascii_hexdigit){return None}
    let f=f64::from(factor);let mut reduced_matrix=matrix;
    for value in &mut reduced_matrix.0 {*value/=f;}
    let contours=path.flatten(reduced_matrix,0.015625).ok()?;
    if contours.len()!=1||!contours[0].closed{return None}
    let mut points=contours[0].points.clone();
    if points.first()==points.last(){points.pop();}
    if points.len()<3||points.len()>4096{return None}
    let cross=|a:Point,b:Point,c:Point|(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    let area=|p:&[Point]|{let a=p[0];p[1..].windows(2).map(|e|cross(a,e[0],e[1])).sum::<f64>().abs()/2.};
    let original_area=area(&points);
    let perimeter=(0..points.len()).map(|i|{let a=points[i];let b=points[(i+1)%points.len()];(a.x-b.x).hypot(a.y-b.y)}).sum::<f64>();
    if !original_area.is_finite()||!perimeter.is_finite()||original_area/perimeter<8.{return None}
    let mut sorted=points.clone();sorted.sort_by(|a,b|a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));sorted.dedup();
    let mut hull:Vec<Point>=Vec::new();
    for &p in &sorted {while hull.len()>=2&&cross(hull[hull.len()-2],hull[hull.len()-1],p)<=0.{hull.pop();}hull.push(p);}
    let lower=hull.len();
    for &p in sorted.iter().rev().skip(1){while hull.len()>lower&&cross(hull[hull.len()-2],hull[hull.len()-1],p)<=0.{hull.pop();}hull.push(p);}
    hull.pop();if hull.len()<3||(area(&hull)-original_area).abs()>original_area.max(1.)*1e-9{return None}
    let radii=crate::effects::gaussian_box_radii(matrix.max_scale()*n.effects.iter().find(|e|e.visible)?.radius/f).ok()?;
    if radii.iter().any(|r|*r<32){return None}
    // Two low-grid texels retain every bilinear neighbour during upsampling.
    let o=plan.output;let x=o.x.div_euclid(factor as i32)-2;let y=o.y.div_euclid(factor as i32)-2;
    let right=(f64::from(o.right())/f).ceil() as i32+2;let bottom=(f64::from(o.bottom())/f).ceil() as i32+2;
    let output=Rect::new(x,y,(right-x) as u32,(bottom-y) as u32);let source=output.expand(radii.iter().sum::<u32>() as i32);
    if source.w>8192||source.h>8192||source.pixels()>4_194_304{return None}
    Some((GaussianRegion{source,output,radii,factor:Some(factor),full_output:Some(plan.output)},Arc::new(contours)))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuNode {
    #[serde(skip_serializing_if="Option::is_none")]
    pub optical_prefix_next: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub gaussian_region:Option<GaussianRegion>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub source_filter_field:Option<source_filter::SourceFilter>,
    /// The entire working rectangle lies inside an opaque, simple fill.
    pub opaque_coverage: bool,
    pub passthrough: bool,
    pub backdrop_box: [f64; 4],
    /// Complete painter-dependency output demand, not merely the visible crop.
    /// Present only when the regional support certificate was adopted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backdrop_output_box: Option<[f64; 4]>,
    /// Single outer-shadow output demand; absent outside its narrow proof.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_output_box: Option<[f64; 4]>,
    /// Initial domain of this node's isolated child painter prefix.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children_input_box: Option<[f64; 4]>,
    /// Complete parent target demand after this node has been composited.
    /// Includes demanded pixels outside this node's visible output bounds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_composite_box: Option<[f64; 4]>,
    /// Parent pixels consumed after this node, without changing any source
    /// geometry, material field, filter or backdrop-capture domain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix_box: Option<[f64; 4]>,
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
    #[serde(skip_serializing_if="Option::is_none")]
    pub dense_paint:Option<dense_paint::DensePaint>,
    /// Complete page support, in device coordinates; only for uniform screen backgrounds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_paint_rects: Option<Vec<[f64;4]>>,
    /// Persisted, deterministic SDR arithmetic; independent of GPU vendor.
    pub software_raster: bool,
    /// Global device-pixel output rectangle. Cropping must not rebase camera
    /// matrices or change intermediate binary32 rounding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Rect>,
    /// Initial root target domain; independent leaf sources may be wider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_input_box: Option<[f64; 4]>,
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
mod frame_wire;
mod packet;
pub(crate) use packet::FrameSceneContext;
fn halo(n: &Node, m: Transform) -> i32 {
    crate::geometry_snapshot::effect_halo(n,m)
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

// The legacy halo deliberately overestimates all effect families. For an
// isolated managed leaf with one finite tent filter, pixels beyond this tighter
// support are provably transparent. Cull only; do not shrink a retained input,
// change filter coefficients or admit a radius the renderer cannot process.
fn integrated_leaf_output_bounds(n: &Node, p: &crate::geometry_snapshot::Prepared) -> Option<Rect> {
    if !n.render_children().is_empty() || !n.strokes.is_empty() || n.mask || n.clip || n.passes_backdrop()
        || n.blend != "normal" || n.fills.iter().any(|paint| paint.visible && paint.kind != "solid") {
        return None;
    }
    let mut effects = n.effects.iter().filter(|e| e.visible);
    let effect = effects.next()?;
    if effects.next().is_some() || effect.gradient_blur.is_some() || effect.spread != 0.
        || !matches!(effect.kind.as_str(), "blur" | "shadow") { return None; }
    let radius = effect.radius * p.matrix.max_scale();
    let dx = p.matrix.0[0] * effect.x + p.matrix.0[2] * effect.y;
    let dy = p.matrix.0[1] * effect.x + p.matrix.0[3] * effect.y;
    // Include uploaded f32 radius/offsets, coverage phase, bilinear neighbours
    // and outward conversion slack. Restricted coordinates retain exact pixel
    // centres and avoid claiming support from rounded large-coordinate math.
    let reach = radius.next_up().max(f64::from((radius as f32).next_up())).ceil()
        + dx.abs().max(dy.abs()).max(f64::from((dx as f32).abs())).max(f64::from((dy as f32).abs())).ceil() + 4.;
    if !reach.is_finite() || radius < 0. || reach > 1_048_576.
        || [p.fill_program_bounds.x, p.fill_program_bounds.y, p.fill_program_bounds.right(), p.fill_program_bounds.bottom()]
            .iter().any(|v| i64::from(*v).abs() as f64 + reach > 1_048_576.) { return None; }
    Some(p.fill_program_bounds.expand(reach as i32))
}

// Certify only a constant-coverage interior: no flattened edge may enter the
// guarded rectangle. This also recognizes the empty interior of compound
// shapes. The winding rule is exactly the compiler's fill rule.
fn constant_fill_coverage(n: &Node, p: &crate::geometry_snapshot::Prepared, region: Rect) -> Option<bool> {
    constant_contours(&p.fill,n.kind!="text"&&n.fill_even_odd(),region)
}
fn constant_contours(contours:&[crate::path::Contour], even_odd:bool, region:Rect)->Option<bool>{
    if contours.is_empty() || [region.x, region.y, region.right(), region.bottom()].iter().any(|v| i64::from(*v).abs() > 1_048_576) {
        return None;
    }
    let r = region.expand(2);
    for contour in contours {
        if !contour.closed { return None; }
        for (i, a) in contour.points.iter().enumerate() {
            let b = contour.points[(i + 1) % contour.points.len()];
            if !a.finite() || !b.finite() { return None; }
            if a.x.min(b.x) <= f64::from(r.right()) && a.x.max(b.x) >= f64::from(r.x) &&
                a.y.min(b.y) <= f64::from(r.bottom()) && a.y.max(b.y) >= f64::from(r.y) {
                // The AABB of a long diagonal frequently intersects an
                // isometric tile although the whole guarded tile is strictly
                // on one side of the actual edge. Keep a full pixel of slack.
                let dx=b.x-a.x;let dy=b.y-a.y;let slack=dx.abs()+dy.abs()+1.;
                let sides=[(r.x,r.y),(r.right(),r.y),(r.right(),r.bottom()),(r.x,r.bottom())]
                    .map(|(x,y)|dx*(f64::from(y)-a.y)-dy*(f64::from(x)-a.x));
                if !sides.iter().all(|s|*s>slack) && !sides.iter().all(|s|*s< -slack){return None;}
            }
        }
    }
    let winding = crate::path::winding(Point::new(f64::from(r.x) + f64::from(r.w) / 2.,
        f64::from(r.y) + f64::from(r.h) / 2.), contours);
    Some(if even_odd {winding%2!=0} else {winding!=0})
}

/// Prove empty source support or an identity filter over the complete
/// dependency neighbourhood. Colour, sharp strokes and the original
/// effect remain authored; only this tile can use the proof.
fn source_filter_constant(n:&Node,p:&crate::geometry_snapshot::Prepared,region:Rect)->Option<bool>{
    if p.support_culled || !n.render_children().is_empty() || n.mask || n.clip || n.blend!="normal" || n.passes_backdrop(){return None;}
    let mut effects=n.effects.iter().filter(|e|e.visible);
    let fx=effects.next()?;
    if !effects.all(|e|e.kind=="inner-shadow"&&fx.kind=="inner-shadow"&&e.gradient_blur.is_none()&&e.spread==0.) || fx.gradient_blur.is_some() || fx.spread!=0. ||
        !matches!(fx.kind.as_str(),"blur"|"gaussian-blur"|"inner-shadow"|"shadow"){return None;}
    let support=region.expand(halo(n,p.matrix).saturating_add(3));
    let mut fills=n.fills.iter().filter(|f|f.visible && f.opacity>0.);
    let fill=fills.next();
    if fills.next().is_some() || fill.is_some_and(|f|f.blend!="normal"){return None;}
    let inside=if fill.is_some(){constant_fill_coverage(n,p,support)}else{Some(false)};
    let solid_alpha=|color:&str|crate::color::parse(color,crate::color::ColorSpace::Srgb).is_ok_and(|(_,rgb,a)|
        a==1. && rgb.iter().all(|v|(0. ..=1.).contains(v)));
    if matches!(fx.kind.as_str(),"inner-shadow"|"shadow") && n.opacity==1. && inside==Some(true) &&
        n.strokes.iter().all(|s|!s.visible||s.paint.blend=="normal") &&
        fill.is_some_and(|f| f.opacity==1. && (f.kind=="solid"&&solid_alpha(&f.color) ||
            f.kind=="linear"&&!f.stops.is_empty()&&f.stops.iter().all(|s|solid_alpha(&s.color)))){return Some(true);}
    let stroke_free=n.strokes.iter().enumerate().all(|(i,s)|!s.visible||s.width<=0.||!s.paint.visible||
        p.strokes.get(i).is_some_and(|c|c.is_empty()||constant_contours(c,false,support)==Some(false)));
    if stroke_free && inside==Some(false){return Some(false);}
    if stroke_free && inside==Some(true) && matches!(fx.kind.as_str(),"blur"|"gaussian-blur") &&
        fill.is_some_and(|f|f.kind=="solid"&&solid_alpha(&f.color)){return Some(true);}
    None
}

fn constant_gaussian(n:&Node,p:&crate::geometry_snapshot::Prepared,region:Rect)->Option<bool>{
    // An opaque hex solid cannot introduce subnormal/undefined authored color
    // arithmetic. The full six-pass source (plus the coverage oracle's own
    // two-pixel guard) must contain no path boundary, including holes.
    let plan=gaussian_region_plan(n,p.matrix,region)?;
    let fill=&n.fills[0];
    if fill.kind!="solid"||fill.opacity!=1.||fill.color.len()!=7||!fill.color.starts_with('#'){return None}
    constant_fill_coverage(n,p,plan.source)
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
    gaussian_region: bool,
    large_gaussian: bool,
    soft_fields:bool,
) -> bool {
    let n = &doc.nodes[id];
    let Some(p) = prepared.get(id) else { return true; };
    if !n.visible || n.opacity <= 0. || backdrop_output_bounds(n, p).intersect(region).empty() { return true; }
    if irrelevant_backdrop(n, p, region, coherent) { return true; }
    if large_gaussian && source_filter_constant(n,p,region).is_some() || soft_fields&&(source_filter::eligible(n,p.matrix,region)||source_filter::group_supported(doc,n,p.matrix,region)){return true;}
    let gaussian_supported = gaussian_region && n.effects.iter().filter(|e| e.visible && e.kind=="gaussian-blur").all(|e| {
        // Gaussian is also a foreground convolution. Keep its full existing
        // three-box support on this node, rather than every ancestor/sibling.
        // This admission changes neither the kernel nor its supported radius.
        let sigma=e.radius*p.matrix.max_scale();
        sigma.is_finite() && ((0. ..=512.).contains(&sigma) || large_gaussian&&gaussian_region_plan(n,p.matrix,region).is_some()) &&
            [region.x,region.y,region.right(),region.bottom()].iter().all(|v|
                i64::from(*v).abs()+i64::from(halo(n,p.matrix))+2<=1_048_576)
    });
    if n.effects.iter().any(|e| e.visible &&
        (!(matches!(e.kind.as_str(), "blur" | "shadow" | "inner-shadow") ||
            // Colour controls transform just this foreground texel. They do
            // not make a neighbouring layer's shadow a full-scene capture.
            soft_fields && (e.kind=="color-controls" ||
                // The motion kernel reads only this foreground. effect_outset
                // includes its entire three-sigma support and bilinear neighbours.
                e.kind=="motion-blur" && e.gradient_blur.is_none() && n.render_children().is_empty() &&
                [region.x,region.y,region.right(),region.bottom()].iter().all(|v|
                    i64::from(*v).abs()+i64::from(halo(n,p.matrix))+2 <= 1_048_576)) ||
            e.kind=="gaussian-blur" && gaussian_supported) || n.passes_backdrop())) {
        return false;
    }
    let source = region.expand(halo(n, p.matrix).saturating_add(2));
    n.render_children().iter().all(|child| foreground_region_supported(doc, child, source, prepared, coherent,gaussian_region,large_gaussian,soft_fields))
}

/// A bounded dependency certificate for managed, ordinary tent filters and
/// isolated integer-offset outer shadows in coherent integrated profiles.
///
/// The tree's maximum halo is not a dependency graph: a backdrop consumes the
/// *preceding* siblings, which may themselves be blurred. Walk painter order
/// backwards, propagating a backdrop's input rectangle to that earlier prefix.
/// Foreground isolation instead expands its own source rectangle without
/// making unrelated earlier siblings provide that source. All demanded source
/// rectangles contribute to the shared allocation; no filter, tap, sample or
/// authored value is changed.
///
/// Unsupported materials/masks retain the conservative compiler. Prepared
/// geometry can have been culled outside its guard, so the complete dependency
/// rectangle must remain inside that guard before this proof may be used.
struct PainterSupport {
    extent: Rect,
    backdrop_outputs: HashMap<String, Rect>,
    shadow_outputs: HashMap<String, Rect>,
    stages: Option<PainterStages>,
}
struct PainterStages {
    root_input: Rect,
    node_regions: HashMap<String, Rect>,
    children_inputs: HashMap<String, Rect>,
    post_composites: HashMap<String, Rect>,
    backdrop_inputs: HashMap<String, Rect>,
}
fn device_box(r: Rect) -> [f64; 4] {
    [f64::from(r.x), f64::from(r.y), f64::from(r.w), f64::from(r.h)]
}

/// Every mode26 capture pixel samples four integer neighbours, even when one
/// bilinear weight is zero. In the separately checked exact phase domain,
/// p=o+i+.5 and q=(p-S)-.5 give global loads floor(o)+i and floor(o)+i+1.
/// Preserve the logical capture box; only narrow the earlier painter demand.
fn backdrop_capture_reads(previous_prefix: Rect, capture: [f64; 4]) -> Option<Rect> {
    if previous_prefix.empty() || [previous_prefix.x,previous_prefix.y,previous_prefix.right(),previous_prefix.bottom()].iter()
        .any(|v| i64::from(*v).abs() > 1_048_576) { return None; }
    for axis in 0..2 {
        if !capture[axis].is_finite() || capture[axis].abs() > 1_048_576. ||
            !capture[axis+2].is_finite() || capture[axis+2].fract() != 0. ||
            !(1. ..=8192.).contains(&capture[axis+2]) { return None; }
    }
    let reads = Rect::new(capture[0].floor() as i32,capture[1].floor() as i32,
        capture[2] as u32+1,capture[3] as u32+1).expand(2);
    if [reads.x,reads.y,reads.right(),reads.bottom()].iter()
        .any(|v| i64::from(*v).abs() > 1_048_576) { return None; }
    Some(previous_prefix.intersect(reads))
}

#[cfg(test)]
mod painter_capture_read_tests {
    use super::*;

    #[test]
    fn real_117_logical_box_is_not_charged_as_the_complete_read_domain() {
        let logical = Rect::new(-1182,-222,2428,2428);
        let capture = [-1182.8828125,964.162109375,2429.,1242.];
        let reads = backdrop_capture_reads(logical,capture).unwrap();
        assert_eq!(reads,Rect::new(-1182,962,2428,1244));
        assert_eq!(Rect::new(-2,958,68,68).union(reads),Rect::new(-1182,958,2428,1248));
        assert!(reads.pixels() < logical.pixels());
    }

    #[test]
    fn every_old_bilinear_load_including_zero_weight_neighbours_stays_available() {
        let logical = Rect::new(-14,-11,45,39);
        let demand = Rect::new(-18,3,60,12);
        let old = logical.union(demand);
        for x in [-16.,-13.875,-13.+1./512.,0.,17.5] {
            for y in [-14.,-10.75,-9.+1./512.,3.5,21.] {
                let capture = [x,y,19.,13.];
                let tight = demand.union(backdrop_capture_reads(logical,capture).unwrap());
                for j in 0..13 { for i in 0..19 {
                    // Literal mode26/smp binary32 addressing at a sample
                    // centre. Integer phases still read base+1 at weight 0.
                    let px = x as f32+(i as f32+0.5);
                    let py = y as f32+(j as f32+0.5);
                    let bx = ((px-old.x as f32)-0.5).floor() as i32+old.x;
                    let by = ((py-old.y as f32)-0.5).floor() as i32+old.y;
                    for dy in [0,1] { for dx in [0,1] {
                        if old.index(bx+dx,by+dy).is_some() {
                            assert!(tight.index(bx+dx,by+dy).is_some(),"capture={capture:?}, load={:?}",(bx+dx,by+dy));
                        }
                    }}
                }}
            }
        }
    }

    #[test]
    fn invalid_metadata_never_creates_a_read_certificate() {
        let logical = Rect::new(-16,-16,64,64);
        for capture in [[f64::NAN,0.,4.,4.],[0.,f64::INFINITY,4.,4.],
            [0.,0.,0.,4.],[0.,0.,4.25,4.],[0.,0.,8193.,4.],
            [1048575.,0.,4.,4.],[-1048576.,0.,4.,4.]] {
            assert!(backdrop_capture_reads(logical,capture).is_none(),"{capture:?}");
        }
        assert!(backdrop_capture_reads(Rect::default(),[0.,0.,4.,4.]).is_none());
        assert!(backdrop_capture_reads(logical,[100.,100.,4.,4.]).unwrap().empty());
    }

    #[test]
    fn a_later_consumer_cannot_revoke_the_original_prefixs_edge_neighbours() {
        let logical = Rect::new(0,0,10,8);
        let previous_post = Rect::new(-5,0,25,8);
        let current_demand = Rect::new(5,0,1,8);
        let capture = [-0.125,0.125,10.,6.];
        let previous_prefix = previous_post.union(logical);
        let reads = backdrop_capture_reads(previous_prefix,capture).unwrap();
        let next_prefix = current_demand.union(reads);
        assert!(previous_prefix.index(-1,0).is_some());
        assert!(next_prefix.index(-1,0).is_some());
        let incomplete = current_demand.union(backdrop_capture_reads(logical,capture).unwrap());
        assert!(incomplete.index(-1,0).is_none(),"a BI-only proof is not a general multi-consumer domain proof");
    }

    #[test]
    fn original_two_dimensional_hull_corners_are_part_of_the_capture_source_domain() {
        let logical = Rect::new(0,0,10,10);
        let previous_post = Rect::new(-5,-5,25,25);
        let current_demand = Rect::new(5,5,1,1);
        let capture = [-0.125,8.5,2.,2.];
        let previous_prefix = previous_post.union(logical);
        let next_prefix = current_demand.union(backdrop_capture_reads(previous_prefix,capture).unwrap());
        // Domain model, not a claim that this exact rectangle plan occurs in
        // an authored leaf: the proof no longer needs that hidden premise.
        assert!(previous_prefix.index(-1,10).is_some());
        assert!(next_prefix.index(-1,10).is_some());
        assert!(current_demand.union(backdrop_capture_reads(logical,capture).unwrap()).index(-1,10).is_none());
    }

    #[test]
    fn zero_weight_neighbours_with_nonfinite_values_cannot_be_omitted() {
        let previous_prefix = Rect::new(-2,-2,8,8);
        let capture = [0.,0.,1.,1.];
        let reads = backdrop_capture_reads(previous_prefix,capture).unwrap();
        let mut values = vec![1_f32;previous_prefix.pixels()];
        values[previous_prefix.index(1,0).unwrap()] = f32::INFINITY;
        assert!((values[previous_prefix.index(1,0).unwrap()]*0.).is_nan());
        assert!(reads.index(1,0).is_some(),"base+1 is an actual textureLoad even at zero bilinear weight");
        assert!(reads.index(1,1).is_some());
    }
}

/// Sufficient binary32 addressing domain for a cropped ordinary backdrop.
/// This is deliberately narrower than the general coordinate budget. Having
/// equal mathematical fractional origins is insufficient: q=p-origin can
/// cross a binary32 exponent boundary and change its bilinear fraction.
fn backdrop_phase_fraction_bits(origin: f64) -> Option<u32> {
    if !origin.is_finite() { return None; }
    let single = origin as f32;
    if f64::from(single).to_bits() != origin.to_bits() { return None; }
    let bits = single.to_bits() & 0x7fff_ffff;
    if bits == 0 { return Some(0); }
    let exponent = ((bits >> 23) & 255) as i32;
    if exponent == 255 { return None; }
    let significand = (bits & 0x7f_ffff) | if exponent == 0 { 0 } else { 0x80_0000 };
    let power = if exponent == 0 { -149 } else { exponent - 150 };
    // origin = significand * 2^power. Cancelling its integer low bits gives
    // the exact dyadic fractional grid, without scaling a float or rounding
    // a purported integer. Subnormal phases may be arbitrarily fine and will
    // fail the finite local-domain bound below.
    Some((-power - significand.trailing_zeros() as i32).max(0) as u32)
}

fn backdrop_sample_phase_supported(
    legacy_capture: [f64; 4],
    planned_capture: [f64; 4],
    legacy_extent: Rect,
    planned_extent: Rect,
    radius: f64,
) -> bool {
    if !radius.is_finite() || !(0. ..=16384.).contains(&radius) { return false; }
    // Retain the old 1/512, |value|<2^15 admission as the widest baseline.
    // A finer exact origin needs a correspondingly smaller domain: every
    // integer multiple of 2^-k with |value|<2^(24-k) is exactly binary32.
    // The common grid includes half-pixel centres (k>=9 already includes .5).
    let mut fraction_bits = 9_u32;
    for capture in [legacy_capture, planned_capture] {
        for origin in &capture[..2] {
            let Some(bits) = backdrop_phase_fraction_bits(*origin) else { return false; };
            fraction_bits = fraction_bits.max(bits);
        }
    }
    let Some(domain_bits) = 24_u32.checked_sub(fraction_bits) else { return false; };
    let limit = f64::from(1_u32 << domain_bits);
    for r in [legacy_extent, planned_extent] {
        if r.empty() || r.w > 8192 || r.h > 8192 ||
            [r.x,r.y,r.right(),r.bottom()].iter().any(|v| i64::from(*v).abs() > 1_048_576) {
            return false;
        }
    }
    let reach = if radius == 0. { 0. } else {
        radius.next_up().max(f64::from((radius as f32).next_up())).ceil()
    };
    // Integer source/target rectangles lie in these allocation bounds. All
    // relevant local q, its tent taps and bilinear neighbours then stay inside
    // the chosen exact grid domain. Coarse phases never gain a wider budget.
    let joined = legacy_extent.union(planned_extent);
    if f64::from(joined.w.max(joined.h)) + 2.*reach + 4. >= limit { return false; }
    for axis in 0..2 {
        let old = legacy_capture[axis];
        let new = planned_capture[axis];
        if !(new-old).is_finite() || (new-old).fract() != 0. { return false; }
        for capture in [legacy_capture, planned_capture] {
            let origin = capture[axis];
            let size = capture[axis+2];
            if !size.is_finite() || size.fract() != 0. || !(1. ..=8192.).contains(&size) {
                return false;
            }
            // Include global capture generation, p +/- integer tent taps,
            // clamp endpoints, and base+1. Every intermediate is on the same
            // 2^-k grid and strictly below 2^(24-k), so these additions and
            // subtractions are exact f32 rather than different rounded phases.
            let first = origin-reach-2.;
            let last = origin+size+reach+2.;
            let source_ends = if axis == 0 { [joined.x,joined.right()] } else { [joined.y,joined.bottom()] };
            // Do not assume a container's own fill/capture lies inside its
            // child source union. Bound each local subtraction explicitly,
            // including q-.5 and the neighbouring address reconstruction.
            if [first,last].iter().any(|point| source_ends.iter()
                .any(|source| (*point-f64::from(*source)).abs()+2. >= limit)) { return false; }
            if first <= -limit || last >= limit ||
                [origin,origin+size,origin+0.5,origin+size-0.5].iter()
                    .any(|value| f64::from(*value as f32).to_bits() != value.to_bits()) {
                return false;
            }
        }
    }
    true
}

fn painter_backdrop_phases_supported(
    doc: &Document,
    prepared: &HashMap<String, crate::geometry_snapshot::Prepared>,
    legacy_extent: Rect,
    support: &PainterSupport,
) -> bool {
    // Integer-offset outer shadows have no fractional backdrop sampler. Do
    // not impose the separate 32K backdrop domain on their existing proof.
    support.backdrop_outputs.keys().all(|id| {
        let Some(n) = doc.nodes.get(id) else { return false; };
        let Some(p) = prepared.get(id) else { return false; };
        let Some(bounds) = p.fill_bounds else { return false; };
        let Some(fx) = n.backdrop_effect() else { return false; };
        if fx.kind != "background-blur" { return false; }
        let planned = support.stages.as_ref().and_then(|s|s.backdrop_inputs.get(id))
            .copied().unwrap_or(support.extent);
        backdrop_sample_phase_supported(
            crate::coverage::backdrop_box(Some(bounds),legacy_extent),
            crate::coverage::backdrop_box(Some(bounds),planned),
            legacy_extent,support.extent,fx.backdrop_radius()*p.matrix.max_scale(),
        )
    })
}

#[cfg(test)]
mod painter_backdrop_phase_tests {
    use super::*;
    fn ordinary() -> ([f64;4],[f64;4],Rect,Rect) {
        ([0.125,0.25,128.,128.],[31.125,31.25,97.,97.],
            Rect::new(-10,-10,180,180),Rect::new(0,0,150,150))
    }
    #[test]
    fn real_117_coarse_capture_phase_keeps_both_complete_tent_supports() {
        assert!(backdrop_sample_phase_supported(
            [-2355.8828125,964.162109375,4775.,2415.],
            [-1182.8828125,964.162109375,2429.,1242.],
            Rect::new(-2355,-1395,4774,4774),Rect::new(-1797,-837,3658,3658),
            18.39398384094238*64.,
        ));
    }
    #[test]
    fn exact_binary32_phase_bits_do_not_round_or_scale_authored_origins() {
        for (origin,bits) in [(0.,0),(-0.,0),(-17.,0),(0.5,1),(1./512.,9),
            (1./1024.,10),(978.0810546875,10),(-1178.44140625,8),(1./65536.,16)] {
            assert_eq!(backdrop_phase_fraction_bits(origin),Some(bits));
        }
        assert_eq!(backdrop_phase_fraction_bits(f64::from(f32::from_bits(1))),Some(149));
        for origin in [0.1,f64::NAN,f64::INFINITY,f64::NEG_INFINITY] {
            assert!(backdrop_phase_fraction_bits(origin).is_none());
        }
    }
    #[test]
    fn real_117_zoom32_phase_uses_a_stricter_1024_grid_domain() {
        let old: [f64;4] = [-1178.44140625,978.0810546875,2421.,1216.];
        let new: [f64;4] = [-592.44140625,978.0810546875,1249.,630.];
        assert_ne!((old[1]*512.).fract(),0.);
        assert_eq!((old[1]*1024.).fract(),0.);
        assert!(backdrop_sample_phase_supported(old,new,
            Rect::new(-1178,-218,2420,2420),Rect::new(-920,40,1904,1904),
            18.39398384094238*32.));
    }
    #[test]
    fn finer_grids_tighten_global_taps_clamps_and_source_local_ranges() {
        for bits in [10,11,12,16] {
            let limit = f64::from(1_u32 << (24-bits));
            let fraction = 1. / f64::from(1_u32 << bits);
            let origin = limit-18.+fraction;
            let a = Rect::new(limit as i32-30,0,20,32);
            let b = Rect::new(limit as i32-29,0,19,32);
            assert!(backdrop_sample_phase_supported([origin,0.,10.,16.],[origin+1.,0.,9.,16.],a,b,4.25));
            assert!(!backdrop_sample_phase_supported([origin,0.,10.,16.],[origin+1.,0.,9.,16.],a,b,5.));
            let negative = -limit+7.+fraction;
            let a = Rect::new(-limit as i32+1,0,20,32);
            let b = Rect::new(-limit as i32+2,0,19,32);
            assert!(backdrop_sample_phase_supported([negative,0.,10.,16.],[negative+1.,0.,9.,16.],a,b,4.25));
            assert!(!backdrop_sample_phase_supported([negative,0.,10.,16.],[negative+1.,0.,9.,16.],a,b,5.));
            let source = Rect::new(-limit as i32,0,32,32);
            assert!(!backdrop_sample_phase_supported([fraction,0.,16.,16.],[fraction+1.,0.,15.,16.],source,b,3.25),
                "an exact global origin does not prove a distant source subtraction");
        }
        assert!(!backdrop_sample_phase_supported([1./2048.,0.,128.,64.],[31.+1./2048.,0.,97.,64.],
            Rect::new(0,0,10000,64),Rect::new(0,0,150,64),3.25));
        assert!(!backdrop_sample_phase_supported([f64::from(f32::from_bits(1)),0.,16.,16.],
            [f64::from(f32::from_bits(1)),0.,16.,16.],Rect::new(0,0,32,32),Rect::new(0,0,32,32),1.));
    }
    #[test]
    fn finer_admitted_phases_preserve_literal_binary32_bilinear_addresses() {
        for bits in [10,11,12] {
            let fraction = 1. / f64::from(1_u32 << bits);
            for origin in [-127,-31,0,64,1024] {
                let old = f64::from(origin)+fraction;
                let new = old+31.;
                assert!(backdrop_sample_phase_supported([old,old,128.,128.],[new,new,97.,97.],
                    Rect::new(origin-10,origin-10,180,180),Rect::new(origin,origin,150,150),3.25));
                for pixel in origin+40..origin+90 {
                    let p = pixel as f32+0.5;
                    let a = (p-old as f32)-0.5; let b = (p-new as f32)-0.5;
                    assert_eq!((a-a.floor()).to_bits(),(b-b.floor()).to_bits());
                    assert_eq!((a.floor()+old as f32+0.5).to_bits(),(b.floor()+new as f32+0.5).to_bits());
                }
                for pixel in 0..64 {
                    let a = old as f32+(pixel as f32+31.5); let b = new as f32+(pixel as f32+0.5);
                    assert_eq!(a.to_bits(),b.to_bits());
                    let qa = (a-(origin-10) as f32)-0.5; let qb = (b-origin as f32)-0.5;
                    assert_eq!((qa-qa.floor()).to_bits(),(qb-qb.floor()).to_bits());
                }
            }
        }
    }
    #[test]
    fn a_512_grid_alone_does_not_authorize_crossing_global_f32_exponents() {
        let raw = 65535.00390625_f64;
        let cropped = raw+5.;
        assert_eq!((raw*512.).fract(),0.);
        assert_eq!((cropped*512.).fract(),0.);
        assert_eq!(f64::from(raw as f32),raw);
        assert_ne!(f64::from(cropped as f32),cropped);
        assert!(!backdrop_sample_phase_supported(
            [raw,0.,64.,64.],[cropped,0.,59.,64.],
            Rect::new(65530,0,100,100),Rect::new(65540,0,90,90),1.,
        ));
        let (old,mut new,a,b) = ordinary();
        new[0] = 31.+1./1024.;
        assert!(!backdrop_sample_phase_supported(old,new,a,b,4.25));
    }
    #[test]
    fn complete_outer_taps_and_bilinear_neighbours_stay_inside_the_exact_grid_domain() {
        let a = Rect::new(32740,0,20,64);
        let b = Rect::new(32741,0,19,64);
        let old = [32750.,0.,10.,64.];
        let new = [32751.,0.,9.,64.];
        assert!(backdrop_sample_phase_supported(old,new,a,b,4.25));
        // Outward loop-bound conversion at radius five reserves its next tap;
        // the right neighbour then reaches 2^15 and must reject.
        assert!(!backdrop_sample_phase_supported(old,new,a,b,5.));
        assert!(!backdrop_sample_phase_supported(old,new,a,b,5.000000000000001));
        assert!(backdrop_sample_phase_supported([-32760.,0.,10.,64.],[-32759.,0.,9.,64.],
            Rect::new(-32760,0,20,64),Rect::new(-32759,0,19,64),4.25));
        assert!(!backdrop_sample_phase_supported([-32760.,0.,10.,64.],[-32759.,0.,9.,64.],
            Rect::new(-32760,0,20,64),Rect::new(-32759,0,19,64),5.));
    }
    #[test]
    fn source_dimensions_union_and_invalid_metadata_do_not_escape_the_phase_domain() {
        let (old,new,a,b) = ordinary();
        assert!(backdrop_sample_phase_supported(old,new,Rect::new(0,0,8192,64),b,4.25));
        assert!(!backdrop_sample_phase_supported(old,new,Rect::new(0,0,8193,64),b,4.25));
        assert!(!backdrop_sample_phase_supported([0.,0.,8193.,64.],new,a,b,4.25));
        assert!(!backdrop_sample_phase_supported(old,new,Rect::new(-16000,0,8192,64),
            Rect::new(16000,0,8192,64),4.25));
        assert!(!backdrop_sample_phase_supported(old,new,Rect::new(-1_000_000,0,180,180),
            Rect::new(-999969,0,150,150),4.25),
            "small source span does not bound a distant capture's local q");
        for radius in [f64::NAN,f64::INFINITY,-1.] {
            assert!(!backdrop_sample_phase_supported(old,new,a,b,radius));
        }
        let mut invalid = new;invalid[2]=63.5;
        assert!(!backdrop_sample_phase_supported(old,invalid,a,b,4.25));
    }
    #[test]
    fn fine_rotated_phase_changes_the_same_global_bilinear_weight_after_integer_crop() {
        let old = -9.189306259155273_f32;
        let new = 26.810693740844727_f32;
        let q_old = (47.5_f32-old)-0.5;
        let q_new = (47.5_f32-new)-0.5;
        assert_ne!((q_old-q_old.floor()).to_bits(),(q_new-q_new.floor()).to_bits());
        assert!(!backdrop_sample_phase_supported(
            [f64::from(old),11.749897003173828,190.,158.],
            [f64::from(new),18.749897003173828,105.,98.],
            Rect::new(-32,-32,232,209),Rect::new(15,7,128,121),15.640625,
        ));
    }
    #[test]
    fn admitted_coarse_phases_preserve_capture_and_expand_addressing() {
        for origin in [-16000, -127, 0, 1024, 16000] {
            for fraction in [0.,1./512.,0.1171875,0.162109375,0.5] {
                let old = f64::from(origin)+fraction;
                let new = old+31.;
                assert!(backdrop_sample_phase_supported([old,old,128.,128.],[new,new,97.,97.],
                    Rect::new(origin-10,origin-10,180,180),Rect::new(origin,origin,150,150),3.25));
                for pixel in origin+40..origin+90 {
                    let p = pixel as f32+0.5;
                    let a = (p-old as f32)-0.5;
                    let b = (p-new as f32)-0.5;
                    assert_eq!((a-a.floor()).to_bits(),(b-b.floor()).to_bits());
                    assert_eq!((a.floor()+old as f32+0.5).to_bits(),(b.floor()+new as f32+0.5).to_bits());
                }
                for pixel in 0..64 {
                    let a = old as f32+(pixel as f32+31.5);
                    let b = new as f32+(pixel as f32+0.5);
                    assert_eq!(a.to_bits(),b.to_bits());
                    let qa = (a-(origin-10) as f32)-0.5;
                    let qb = (b-origin as f32)-0.5;
                    assert_eq!((qa-qa.floor()).to_bits(),(qb-qb.floor()).to_bits());
                }
            }
        }
    }
}

fn painter_support_extent(
    doc: &Document,
    roots: &[String],
    output: Rect,
    prepared: &HashMap<String, crate::geometry_snapshot::Prepared>,
    prepare_guard: Rect,
    coherent: bool,
    capture_stages: Option<&PainterStages>,
) -> Option<PainterSupport> {
    fn bounded(r: Rect) -> bool {
        !r.empty() && [r.x, r.y, r.right(), r.bottom()].iter()
            .all(|v| i64::from(*v).abs() <= 1_048_576)
    }
    fn contains(outer: Rect, inner: Rect) -> bool {
        outer.intersect(inner) == inner
    }
    fn reach(radius: f64) -> Option<i32> {
        if !radius.is_finite() || radius < 0. || radius > 16_384. { return None; }
        if radius == 0. { return Some(0); }
        // The rational kernel uses binary64 while the shader's loop bound is
        // binary32. Preserve both outer fractional taps and the fractional
        // backdrop-box capture's two bilinear neighbours.
        Some(radius.next_up().max(f64::from((radius as f32).next_up())).ceil() as i32 + 2)
    }
    struct Walk<'a> {
        doc: &'a Document,
        prepared: &'a HashMap<String, crate::geometry_snapshot::Prepared>,
        extent: Rect,
        backdrop_outputs: HashMap<String, Rect>,
        shadow_outputs: HashMap<String, Rect>,
        managed: bool,
        stage_safe: bool,
        node_regions: HashMap<String, Rect>,
        children_inputs: HashMap<String, Rect>,
        post_composites: HashMap<String, Rect>,
        backdrop_inputs: HashMap<String, Rect>,
        capture_stages: Option<&'a PainterStages>,
    }
    impl Walk<'_> {
        fn include(&mut self, r: Rect) -> Option<()> {
            if !bounded(r) { return None; }
            self.extent = self.extent.union(r);
            Some(())
        }
        fn bundle(&mut self, ids: &[String], mut demand: Rect) -> Option<Rect> {
            for id in ids.iter().rev() {
                let n = &self.doc.nodes[id];
                if !n.visible || n.opacity <= 0. { continue; }
                // Missing entries are allowed only for invisible nodes. An
                // incomplete camera cache cannot establish non-contribution.
                let p = self.prepared.get(id)?;
                let relevant = backdrop_output_bounds(n, p).intersect(demand);
                if relevant.empty() { continue; }
                if n.mask || self.doc.mask_child(n).is_some() || n.blend != "normal"
                    || n.fills.iter().any(|paint| paint.visible &&
                        (paint.blend != "normal" || !matches!(paint.kind.as_str(), "solid" | "image")))
                    || n.strokes.iter().any(|stroke| stroke.visible && stroke.width > 0. &&
                        (stroke.paint.blend != "normal" || !matches!(stroke.paint.kind.as_str(), "solid" | "image")))
                    || n.effects.iter().any(|e| e.visible &&
                        (e.gradient_blur.is_some() || !matches!(e.kind.as_str(), "blur" | "background-blur" | "shadow") ||
                            !self.managed && e.kind != "shadow")) {
                    return None;
                }
                // These rectangles describe the complete painter prefix and
                // suffix, not just this node's intersection with the suffix.
                self.post_composites.insert(id.clone(), demand);
                // An effect-bearing container also needs its own pre-effect
                // paint domain. Retain phase-one allocation until that third
                // stage and its material phases have a separate proof.
                if !n.render_children().is_empty() && n.effects.iter().any(|e| e.visible) {
                    self.stage_safe = false;
                }
                let scale = p.matrix.max_scale();
                if !scale.is_finite() || !(1. / 65536. ..=65536.).contains(&scale) { return None; }
                if let Some(shadow) = n.effects.iter().find(|e| e.visible && e.kind == "shadow") {
                    // A zero-spread, isolated outer shadow only reads source
                    // alpha. Outside the leaf's unfiltered geometry it is
                    // exactly zero. Keep the shifted blurred-alpha samples
                    // as well as every nonzero contributing source pixel;
                    // avoid a symmetric halo that also allocates known-zero
                    // rows beyond a large source's edge.
                    if !n.render_children().is_empty() || n.clip || shadow.spread != 0.
                        || n.effects.iter().filter(|e| e.visible).count() != 1 { return None; }
                    let m = p.matrix.0;
                    let dx = m[0]*shadow.x + m[2]*shadow.y;
                    let dy = m[1]*shadow.x + m[3]*shadow.y;
                    if [dx,dy].iter().any(|v| !v.is_finite() || v.fract() != 0.
                        || f64::from(*v as f32) != *v || v.abs() > 1_048_576.) { return None; }
                    let shifted = Rect::new(relevant.x-dx as i32,relevant.y-dy as i32,relevant.w,relevant.h).expand(2);
                    self.include(shifted)?;
                    let source = shifted.expand(reach(shadow.radius*scale)?).intersect(p.bounds.expand(-p.halo));
                    if !source.empty() { self.include(source)?; }
                    self.shadow_outputs.insert(id.clone(), relevant);
                    self.node_regions.insert(id.clone(), if source.empty() {
                        relevant.union(shifted)
                    } else { relevant.union(shifted).union(source) });
                    continue;
                }
                let mut source = relevant;
                // Foreground effects run after the node's fills/children and
                // backdrop. Sum their supports before walking that content.
                for fx in n.effects.iter().rev().filter(|e| e.visible && e.kind == "blur") {
                    source = source.expand(reach(fx.blur_radius() * scale)?);
                    self.include(source)?;
                }
                let content = self.bundle(n.render_children(), source)?;
                self.include(content)?;
                self.node_regions.insert(id.clone(), content);
                if !n.render_children().is_empty() {
                    self.children_inputs.insert(id.clone(), content);
                }
                if let Some(fx) = n.backdrop_effect() {
                    // The renderer captures the current target before fills
                    // and children. A later child backdrop can require this
                    // base throughout its own enlarged prefix rectangle.
                    // Phase four freezes phase three's logical capture limit.
                    // A later backdrop may narrow this node's new demand, but
                    // must not thereby move/re-size this earlier capture.
                    let backdrop = match self.capture_stages {
                        Some(stages) => *stages.backdrop_inputs.get(id)?,
                        None => content.expand(reach(fx.backdrop_radius() * scale)?),
                    };
                    self.backdrop_outputs.insert(id.clone(), content);
                    self.backdrop_inputs.insert(id.clone(), backdrop);
                    let reads = if let Some(stages) = self.capture_stages {
                        // Freeze the old physical RECTANGULAR prefix, not a
                        // set union of logical demands. Later backdrops may
                        // have narrowed this walk's current demand; the old
                        // post domain can still own real edge/corner loads.
                        let previous_prefix = stages.post_composites.get(id)?.union(backdrop);
                        backdrop_capture_reads(previous_prefix,crate::coverage::backdrop_box(p.fill_bounds,backdrop))?
                    } else { backdrop };
                    if !reads.empty() { self.include(reads)?; }
                    // Retain every previous consumer, including neighbours
                    // outside this logical box but inside the old demand.
                    demand = demand.union(reads);
                }
            }
            Some(demand)
        }
    }
    let managed = doc.color_management.is_some();
    // Unmanaged analytic rendering uses three Gaussian boxes. Its support
    // differs from the integrated tent, so this certificate cannot apply.
    if !managed && !coherent || !bounded(output) { return None; }
    let guarded = output.expand(2);
    if !bounded(guarded) { return None; }
    let mut walk = Walk { doc, prepared, extent: guarded,
        backdrop_outputs: HashMap::new(), shadow_outputs: HashMap::new(), managed,
        stage_safe: true, node_regions: HashMap::new(), children_inputs: HashMap::new(),
        post_composites: HashMap::new(), backdrop_inputs: HashMap::new(), capture_stages };
    let prefix = walk.bundle(roots, guarded)?;
    walk.include(prefix)?;
    if capture_stages.is_some() && !walk.stage_safe { return None; }
    contains(prepare_guard, walk.extent).then_some(PainterSupport {
        extent: walk.extent, backdrop_outputs: walk.backdrop_outputs, shadow_outputs: walk.shadow_outputs,
        stages: walk.stage_safe.then_some(PainterStages { root_input: prefix,
            node_regions: walk.node_regions, children_inputs: walk.children_inputs,
            post_composites: walk.post_composites, backdrop_inputs: walk.backdrop_inputs }),
    })
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
    gaussian_regions: bool,
    gaussian_reduction: u32,
    source_filter_fields: bool,
    prune_backdrop_output: bool,
    backdrop_outputs: HashMap<String, Rect>,
    shadow_outputs: HashMap<String, Rect>,
    stages: Option<PainterStages>,
    curves: Vec<f32>,
    area_paths: HashMap<ProgramIdentity, AreaPath>,
    fragments: fragments::FragmentCache,
    fragment_targets: std::collections::HashSet<String>,
    compiled_order: Vec<String>,
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
        let area = self.install_program(Arc::clone(&program))?;
        Ok(GpuPath {
            opaque_rect: crate::coverage::rectangle(contours).and_then(|b| {
                let left=b[0].max(f64::from(program.rect.x)).ceil();let top=b[1].max(f64::from(program.rect.y)).ceil();
                let right=b[2].min(f64::from(program.rect.right())).floor();let bottom=b[3].min(f64::from(program.rect.bottom())).floor();
                (right>left&&bottom>top).then(||Rect::new(left as i32,top as i32,(right-left) as u32,(bottom-top) as u32))
            }).or_else(||{
                if !self.source_filter_fields||program.rect.empty(){return None}
                for r in [program.rect,program.rect.intersect(self.extent)]{
                    if !r.empty()&&constant_contours(contours,even_odd,r)==Some(true){return Some(r)}
                }
                None
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
    fn install_program(&mut self, program:Arc<CachedProgram>)->Result<AreaPath,String>{
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
        Ok(area)
    }
    fn compile_node(
        &mut self,
        id: &str,
        parent: Transform,
        requested: Option<Rect>,
        inherited_outline: bool,
    ) -> Result<Rect, String> {
        crate::render_cancellation::checkpoint()?;
        let n = &self.doc.nodes[id];
        let geometric=inherited_outline || n.mask && n.mask_type.as_deref()==Some("outline");
        let outline=n.outline_mask_node(inherited_outline);
        let n=outline.as_ref().unwrap_or(n);
        if !n.visible {
            return Ok(Rect::default());
        }
        let staged_region = if let Some(stages) = &self.stages {
            let Some(region) = stages.node_regions.get(id) else {
                // The reverse painter proof did not demand this node in any
                // prefix. Wider independent leaf allocations must not revive it.
                return Ok(Rect::default());
            };
            Some(*region)
        } else { None };
        // Keep the immutable owner alive independently of the mutable compiler.
        // Borrowing one entry avoids cloning both per-node stroke vectors.
        let prepared_owner = Arc::clone(&self.prepared);
        let prepared = prepared_owner.get(id);
        if prepared.is_some_and(|p|p.support_culled) {return Ok(Rect::default());}
        if requested.is_some_and(|region| prepared.is_some_and(|p| backdrop_output_bounds(n, p).intersect(region).empty())) {
            return Ok(Rect::default());
        }
        if self.doc.color_management.is_some() && self.profile == crate::fidelity::RasterProfile::FigmaSubpixel
            && requested.is_some_and(|region| prepared.is_some_and(|p|
                integrated_leaf_output_bounds(n, p).is_some_and(|bounds| bounds.intersect(region).empty()))) {
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
        let filter_constant=if self.gaussian_regions {requested.and_then(|region|prepared.and_then(|p|
            source_filter_constant(n,p,region).or_else(||constant_gaussian(n,p,region))))}else{None};
        if filter_constant==Some(false){return Ok(Rect::default())}
        let omit_filter=filter_constant==Some(true) || self.source_filter_fields && requested.is_some_and(|region|
            source_occlusion::covers_own_shadow(self.doc,&self.prepared,n,region));
        let source_filter_field=if self.gaussian_regions&&self.source_filter_fields&&!omit_filter&&
            self.doc.color_management.as_ref().is_some_and(|c|c.document_space==crate::color::ColorSpace::Srgb) {
            match (prepared,requested){(Some(p),Some(region))=>self.filter_planes(n,p,region)?,_=>None}
        }else{None};
        let own_halo = if omit_backdrop||omit_filter {0} else if let Some(f)=&source_filter_field{f.sharp_halo} else if self.doc.color_management.is_some()
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
        let extent = staged_region.unwrap_or_else(|| source_region.unwrap_or(self.extent));
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
        let children=if source_filter_field.as_ref().is_some_and(|f|f.gaussian){&[][..]}else{n.render_children()};
        let start=if self.source_filter_fields && self.stages.is_none() && !geometric {
            source_region.map_or(0,|r|source_occlusion::start(self.doc,&prepared_owner,children,r))
        }else{0};
        let mask=self.doc.mask_child(n).map(|m|m.id.as_str());
        for(index,child)in children.iter().enumerate(){
            if index<start && mask!=Some(child.as_str()){continue}
            let mut b = self.node_with_outline(child, matrix, source_region, geometric)?;
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
        let full_gaussian=if self.gaussian_regions&&!omit_filter&&source_filter_field.is_none() {requested.and_then(|output|gaussian_region_plan(n,matrix,output.intersect(rect)))}else{None};
        let reduced=if source_filter_field.is_none()&&self.gaussian_reduction>1&&self.doc.color_management.as_ref().is_some_and(|c|c.document_space==crate::color::ColorSpace::Srgb) {
            let candidate=if self.gaussian_regions&&!omit_filter {
                requested.and_then(|output|gaussian_region_plan_above(n,matrix,output.intersect(rect),128.))
            }else{None};
            candidate.as_ref().and_then(|plan|reduced_gaussian_source(n,matrix,plan,fill_path,self.gaussian_reduction))
        }else{None};
        let fill_contours = match &reduced {
            Some((_,contours))=>Arc::clone(contours),
            None=>match prepared.as_ref(){Some(p)=>Arc::clone(&p.fill),None=>Arc::new(fill_path.flatten(matrix,0.015625)?)},
        };
        let fill_rect=reduced.as_ref().map_or(rect,|(plan,_)|plan.source);
        let rule =
            if n.kind == "text" || !n.fill_even_odd() {
                "nonzero"
            } else {
                "evenodd"
            };
        let fill = self.area_path(&fill_contours, (id,0), fill_rect, rule == "evenodd",if reduced.is_some(){None}else{prepared.as_ref().map(|p|p.fill_program_bounds)})?;
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
        let packet_children=if source_filter_field.as_ref().is_some_and(|f|f.gaussian&&!f.group_roots.is_empty()){vec![]}else{n.render_children().to_vec()};
        let opaque_coverage = opaque_interior(n, matrix, extent);
        self.compiled_order.push(id.to_owned());
        self.nodes.insert(
            id.to_owned(),
            GpuNode {
                optical_prefix_next: None,
                source_filter_field,
                gaussian_region:reduced.map(|(plan,_)|plan).or(full_gaussian),
                opaque_coverage,
                passthrough: n.passes_backdrop(),
                backdrop_box: crate::coverage::backdrop_box(
                    crate::bounds::path_bounds(fill_path, matrix),
                    self.stages.as_ref().and_then(|s| s.backdrop_inputs.get(id)).copied().unwrap_or(extent),
                ),
                backdrop_output_box: self.backdrop_outputs.get(id).map(|r| r.intersect(rect))
                    .filter(|r| !r.empty())
                    .map(|r| [f64::from(r.x), f64::from(r.y), f64::from(r.w), f64::from(r.h)]),
                shadow_output_box: self.shadow_outputs.get(id).map(|r| r.intersect(rect))
                    .filter(|r| !r.empty())
                    .map(|r| [f64::from(r.x), f64::from(r.y), f64::from(r.w), f64::from(r.h)]),
                children_input_box: self.stages.as_ref().and_then(|s| s.children_inputs.get(id)).copied().map(device_box),
                post_composite_box: self.stages.as_ref().and_then(|s| s.post_composites.get(id)).copied().map(device_box),
                suffix_box: None,
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
                children:packet_children,
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
                        !(omit_backdrop && e.kind == "background-blur") && !omit_filter)
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
        self.compile_gpu_request_value(serde_json::from_str(request).map_err(|e|e.to_string())?)
    }
    pub(crate) fn compile_gpu_request_value(&mut self, mut value:serde_json::Value)->Result<GpuScene,String>{
        let object = value.as_object_mut().ok_or("Render options must be an object")?;
        let neutral_page_group=match object.remove("gpuNeutralPageGroup"){
            None=>false,Some(serde_json::Value::Bool(v))=>v,_=>return Err("Invalid neutral page group policy".into()),
        };
        if neutral_page_group&&(!object.contains_key("gpuRoots")||object.get("rasterProfile").and_then(|v|v.as_str())!=Some("figmaSubpixel")||
            object.get("pixelPreview").is_some_and(|v|!v.is_null())||object.get("animation").is_some_and(|v|!v.is_null())){
            return Err("Neutral group scope requires a static display root request".into());
        }
        if let Some(roots)=object.remove("gpuRoots") {
            let roots:Vec<String>=serde_json::from_value(roots).map_err(|_|"Invalid render roots")?;
            let page=object.get("pageId").and_then(|v|v.as_str()).ok_or("Missing render page")?;
            let mut scoped=self.snapshot_render_roots(page,&roots,neutral_page_group)?;
            return scoped.compile_gpu_request_value(value);
        }
        // Allocation changes remain opt-in until the independent GPU/whole-app
        // gates pass. This is a trusted request policy, never document state.
        let gaussian_regions=match object.remove("gpuGaussianRegions") {
            None=>false,Some(serde_json::Value::Bool(v))=>v,_=>return Err("Invalid Gaussian region policy".into()),
        };
        let gaussian_reduction=match object.remove("gpuGaussianReduction") {
            None=>0,Some(serde_json::Value::Number(v))=>match v.as_u64(){Some(0)=>0,Some(v @ (2|4|8)) if gaussian_regions=>v as u32,_=>return Err("Invalid Gaussian reduction policy".into())},
            _=>return Err("Invalid Gaussian reduction policy".into()),
        };
        let source_filter_fields=match object.remove("gpuSourceFilterFields"){
            None|Some(serde_json::Value::Bool(false))=>false,
            Some(serde_json::Value::Bool(true)) if gaussian_regions=>true,
            _=>return Err("Invalid source shadow field policy".into()),
        };
        let page_background=match object.remove("gpuPageBackground") {
            None=>false,Some(serde_json::Value::Bool(v))=>v,_=>return Err("Invalid page background policy".into()),
        };
        let painter_support = match object.remove("gpuPainterSupport") {
            None => false,
            Some(serde_json::Value::Bool(value)) => value,
            Some(_) => return Err("Invalid GPU painter support policy".into()),
        };
        let capture_reads = match object.remove("gpuPainterCaptureReads") {
            None => false,
            Some(serde_json::Value::Bool(value)) => value,
            Some(_) => return Err("Invalid GPU painter capture-read policy".into()),
        };
        if capture_reads && !painter_support {
            return Err("GPU painter capture reads require painter support".into());
        }
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
        // This stricter allocation candidate has no authority over exports,
        // pixel preview or the ordinary whole-document compile API.
        let capture_reads = capture_reads && !options.raster_profile.is_export() && options.pixel_preview.is_none();
        let mut scene = if let Some(capture) = capture {
            if options.pixel_preview.is_some() || options.raster_profile.is_export() { return Err("Native capture is a canvas operation".into()); }
            self.compile_gpu_region_impl(&options,capture,prepare.or(Some(capture)),true,painter_support,capture_reads,gaussian_regions,gaussian_reduction,source_filter_fields)?
        } else { match region {
            Some(region) => self.compile_gpu_region_impl(&options, region, prepare.or(Some(region)), false, painter_support, capture_reads,gaussian_regions,gaussian_reduction,source_filter_fields),
            None => self.compile_gpu(&options),
        }? };
        if page_background && !scene.transparent && !scene.grid && !scene.checkerboard &&
            !scene.software_raster && scene.resolve.is_none() && scene.presentation.is_none() && options.animation.is_none() {
            // A resolved viewport projection cannot certify what is absent
            // from the full page. Its private context carries the complete
            // owner's support at this exact camera and revision.
            scene.page_paint_rects=if let Some(context)=&self.source_compile_context {
                context.page_paint_rects.clone()
            } else {
                self.complete_page_paint_rects(&options,scene.output.unwrap_or_else(||Rect::new(0,0,scene.width,scene.height)))?
            };
        }
        Ok(scene)
    }

    pub(crate) fn complete_page_paint_rects(&mut self,options:&RenderOptions,output:Rect)->Result<Option<Vec<[f64;4]>>,String> {
        let camera=Transform([options.view.zoom,0.,0.,options.view.zoom,0.,0.]);
        if !self.doc.as_ref().is_some_and(|doc|crate::dirty_region::page_background_can_sample(doc,&options.page_id,
            camera,[options.view.x,options.view.y],output)) {return Ok(None)}
        let key=(self.geo_revision,options.page_id.clone(),options.view.zoom.to_bits(),self.fonts.glyph_origin_quantization());
        if self.page_support.as_ref().is_none_or(|(old,_)|old!=&key) {
            let bounds=self.doc.as_ref().and_then(|doc|crate::dirty_region::page_paint_rects(doc,&options.page_id,&self.fonts,camera));
            crate::render_cancellation::checkpoint()?;
            self.page_support=Some((key,bounds));
        }
        Ok(self.page_support.as_ref().and_then(|(_,bounds)|bounds.as_ref()).map(|bounds|bounds.iter()
            .map(|b|[b[0]+options.view.x,b[1]+options.view.y,b[2]+options.view.x,b[3]+options.view.y]).collect()))
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
            let mut scene = self.compile_gpu_scene(&source, None, None, false, false, false,0,false)?;
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
                for path in n.strokes.iter_mut().map(|s| &mut s.path).chain(
                    n.source_filter_field.iter_mut().flat_map(|f| f.channels_mut().map(|m| &mut m.path))) {
                    path.analytic_rect = None;
                    path.sample_count = Some(4);
                }
            }
            return Ok(scene);
        }
        self.compile_gpu_scene(options, None, None, false, false, false,0,false)
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
        self.compile_gpu_region_impl(options, region, prepare, false, false, false, false,0,false)
    }
    fn compile_gpu_region_impl(&mut self, options: &RenderOptions, region: Rect, prepare: Option<Rect>, capture: bool, painter_support: bool, capture_reads: bool, gaussian_regions:bool, gaussian_reduction:u32,source_filter_fields:bool) -> Result<GpuScene, String> {
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
            let mut scene = self.compile_gpu_scene(&source, Some(source_region), source_prepare, painter_support, capture_reads, false,0,false)?;
            scene.resolve = Some(crate::preview::Presentation {
                width: region.w,
                height: region.h,
                offset_x: 0.,
                offset_y: 0.,
                scale: 0.5,
            });
            scene
        } else {
            self.compile_gpu_scene(&cropped, Some(region), prepare, painter_support, capture_reads, gaussian_regions,gaussian_reduction,source_filter_fields)?
        };
        scene.output = Some(region);
        // Version 8 adds a global output rectangle. Older consumers must reject
        // it rather than silently present a crop at origin zero.
        scene.version = 8;
        Ok(scene)
    }
    pub fn gpu_compile_cache_stats(&self) -> serde_json::Value {
        let mut stats=self.camera_prepare.as_ref().map(|cache|serde_json::json!({"hits":cache.programs.hits,
            "builds":cache.programs.builds,"bytes":cache.programs.bytes+cache.fragments.bytes,"fragmentHits":cache.fragments.hits,"fragmentBuilds":cache.fragments.builds,"entries":cache.programs.len(),
            "preparedNodes":cache.prepared.len(),"pathNodes":self.paths.len(),"prepareReuses":cache.reuses,"retainedNodes":cache.retained_nodes,"textPaths":self.fonts.text_path_cache_stats(),"residentStrokes":self.local_strokes.stats(),"cameraResidency":self.camera_residency.stats()}))
            .unwrap_or_else(||serde_json::json!({"hits":0,"builds":0,"bytes":0,"entries":0}));
        stats["frameScene"]=self.frame_scene.stats();
        stats["worldSupportBytes"]=serde_json::json!(self.world_support.as_ref().map_or(0,|c|c.index.bytes()));
        stats["marginIndexBytes"]=serde_json::json!(self.world_support.as_ref().and_then(|c|c.margin.as_ref()).map_or(0,|m|m.bytes()));
        stats["marginIndexNodes"]=serde_json::json!(self.world_support.as_ref().and_then(|c|c.margin.as_ref()).map_or(0,|m|m.nodes()));
        stats
    }
    pub(crate) fn reserve_render_cache_bytes(&mut self) {
        let frame=self.frame_scene.bytes().saturating_add(self.source_compile_context.as_ref().map_or(0,|c|c.reserved_bytes));
        let support=self.world_support.as_ref().map_or(0,|c|c.bytes());
        if frame.saturating_add(support)>64*1024*1024 {
            if let Some(cache)=self.world_support.as_mut(){
                // Keep only the bounded identity/predicate header. Evicted or
                // declined variable-size indices must not rebuild every tile.
                cache.index=std::sync::Arc::new(crate::world_support::WorldSupport::disabled());
                cache.margin=None;
            }
        }
        self.camera_residency.reserve_frame_resources(frame.saturating_add(self.world_support.as_ref().map_or(0,|c|c.bytes())));
    }
    fn compile_gpu_scene(
        &mut self,
        options: &RenderOptions,
        viewport: Option<Rect>,
        prepare_viewport: Option<Rect>,
        painter_support: bool,
        capture_reads: bool,
        gaussian_regions: bool,
        gaussian_reduction:u32,
        source_filter_fields:bool,
    ) -> Result<GpuScene, String> {
        let gaussian_regions=gaussian_regions&&options.raster_profile==crate::fidelity::RasterProfile::FigmaSubpixel&&options.pixel_preview.is_none()&&options.animation.is_none();
        let source_filter_fields=source_filter_fields&&gaussian_regions&&self.doc.as_ref().is_some_and(|d|
            d.color_management.as_ref().is_some_and(|c|c.document_space==crate::color::ColorSpace::Srgb));
        crate::render_cancellation::checkpoint()?;
        self.resolve_layout()?;
        if self.source_compile_context.as_ref().is_some_and(|c|c.page!=options.page_id||c.camera!=(options.view.x,options.view.y,options.view.zoom)||options.animation.is_some()) {return Err("Stale source compile context".into());}
        let world_revision=if options.animation.is_none(){self.static_scene_revision()}else{None};
        if options.width == 0
            || options.height == 0
            || options.width > 8192
            || options.height > 8192
            || options.width as u64 * options.height as u64 > 8_388_608
            || !(0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&options.view.zoom)
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
        if let Some((revision,quantized,_))=world_revision {
            if !self.world_support.as_ref().is_some_and(|c|c.revision==revision&&c.page==options.page_id&&c.quantized==quantized) {
                // Reserve before allocating: inactive cameras, the prior world
                // index and FrameScene share the original 64 MiB allowance.
                // The active camera retains its existing separate budget.
                self.world_support=None;
                self.camera_residency.reserve_frame_resources(64*1024*1024);
                let allowance=(64*1024*1024_usize).saturating_sub(self.frame_scene.bytes()).saturating_sub(self.source_compile_context.as_ref().map_or(0,|c|c.reserved_bytes));
                let margin=if self.source_compile_context.is_some(){None}else{crate::margin_index::MarginIndex::build(doc,&page.children,allowance)?.map(std::sync::Arc::new)};
                let index=crate::world_support::WorldSupport::build(doc,&page.children,&self.fonts,allowance.saturating_sub(margin.as_ref().map_or(0,|m|m.bytes())))?
                    .unwrap_or_else(crate::world_support::WorldSupport::disabled);
                let properties=self.source_compile_context.as_ref().map(|c|c.properties).unwrap_or_else(||PageProperties::build(doc,&page.children));
                self.world_support=Some(crate::world_support::Cache{revision,page:options.page_id.clone(),quantized,index:std::sync::Arc::new(index),margin,properties});
            }
        }else{self.world_support=None;}
        let world_support=self.world_support.as_ref().map(|c|c.index.clone());
        self.camera_residency.reserve_frame_resources(self.frame_scene.bytes().saturating_add(self.world_support.as_ref().map_or(0,|c|c.bytes())).saturating_add(self.source_compile_context.as_ref().map_or(0,|c|c.reserved_bytes)));
        let properties=self.source_compile_context.as_ref().map(|c|c.properties).or_else(||self.world_support.as_ref().map(|c|c.properties)).unwrap_or_else(||PageProperties::build(doc,&page.children));
        let margin_index=self.world_support.as_ref().and_then(|c|c.margin.clone());
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
        let cached_metadata=self.camera_prepare.as_ref().filter(|cache| {
            cache.key.0==self.geo_revision&&cache.key.1==options.page_id&&cache.key.2==(options.view.x,options.view.y,options.view.zoom)
                &&cache.key.4==compatible&&cache.key.5==options.animation
        }).and_then(|cache|cache.metadata);
        let metadata=if let Some(cached)=cached_metadata{cached}else{
            let indexed=if let Some(context)=&self.source_compile_context{Some(context.padding)}else if let Some(index)=&margin_index{index.padding(doc,camera)?}else{None};
            let padding=indexed.unwrap_or_else(||page.children.iter().map(|id|margin(doc,id,camera)).max().unwrap_or(0));
            CameraMetadata{padding,backdrop_chain:properties.backdrop_chain,foreground_only:properties.foreground_only,
                noise_guard:properties.noise_extra.map(|extra|padding.saturating_add(extra))}
        };
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
        // Source storage can aggregate many small valid paths in one visible
        // tile. Use the existing 32 MiB packet lane rather than repeatedly
        // splitting at the ordinary 8 MiB aggregate threshold. Individual
        // programs and the actual GPU storage-buffer limits stay independent.
        let large_packet = crate::capacity::native_source_storage() || options.interactive_effects || viewport.w > 514 || viewport.h > 514;
        // The prepare guard defaults to this call's own viewport; a request may
        // widen it to the union of all its crops so the flattened geometry is
        // retained once per camera. Flattening is guard-dependent, so the
        // retained map is not what the tile publishes. `tile_guard` is the
        // guard `prepare=None` would use for this viewport.
        let zoom_extent=if properties.has_zoom{Some(crate::zoom_support::scene_guard_active(doc,&page.children,camera,viewport,&self.fonts)?)}else{None};
        let base_prepare=prepare_viewport.unwrap_or(viewport);
        let zoom_prepare=if !properties.has_zoom||base_prepare==viewport{zoom_extent}else{Some(crate::zoom_support::scene_guard_active(doc,&page.children,camera,base_prepare,&self.fonts)?)};
        let prepare_guard=zoom_prepare.map_or(base_prepare.expand(padding),|z|z.union(base_prepare.expand(padding)));
        let tile_guard=zoom_extent.map_or_else(||viewport.expand(padding),|z|z.union(viewport.expand(padding)));
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
                crate::geometry_snapshot::prepare_node_geometry_indexed(
                    root,
                    camera,
                    (doc, &self.fonts, prepare_guard, compatible),
                    &mut self.paths,
                    &mut self.local_strokes,
                    Arc::make_mut(&mut prepared),
                    &mut segments,
                    world_support.as_deref(),
                )?;
            }
            if let Some(key) = &cache_key {
                if partial {
                    let cache = self.camera_prepare.as_mut().unwrap();
                    cache.prepared = prepared.clone(); cache.metadata = Some(metadata); cache.incomplete = false;
                } else {
                    self.camera_prepare = Some(CameraPrepare {
                        key: key.clone(), prepared: prepared.clone(), programs: ProgramCache::default(), program_guard: None, fragments: fragments::FragmentCache::default(),
                        metadata: Some(metadata), reuses: 0, incomplete: false, retained_nodes: 0, incremental:false,
                    });
                }
            }
        }
        let built_guard=self.camera_prepare.as_ref().map(|cache|{
            let (x,y,w,h)=cache.key.3; Rect::new(x,y,w,h)
        }).unwrap_or(prepare_guard);
        if built_guard!=tile_guard {
            // Chord replacement outside the retained guard changes flattened
            // bounds. Publishing those bounds makes a real FIG node rect follow
            // the union instead of the tile. Rebuild only the emitted map.
            let mut local=HashMap::new();
            let mut tile_segments=0usize;
            for root in &page.children {
                crate::geometry_snapshot::prepare_node_geometry_indexed(
                    root,camera,(doc,&self.fonts,tile_guard,compatible),
                    &mut self.paths,&mut self.local_strokes,&mut local,&mut tile_segments,
                    world_support.as_deref(),
                )?;
            }
            prepared=Arc::new(local);
        }
        if has_region && !regional_foreground && doc.color_management.is_some() && metadata.noise_guard.is_none() {
            regional_foreground = page.children.iter().all(|id|
                foreground_region_supported(doc, id, viewport, &prepared, crate::fidelity::coherent_samples(doc, options),
                    options.raster_profile==crate::fidelity::RasterProfile::FigmaSubpixel,gaussian_regions,source_filter_fields));
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
            if regional_foreground {
                viewport.expand(2)
            } else {
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
                viewport.expand(halo)
            }
        };
        // Radial source planning already includes painter/backdrop dependencies.
        // Drawing padding is not an allocation or sampling requirement.
        let extent=zoom_extent.unwrap_or(extent);
        let painter_support = if painter_support && has_region && !regional_foreground {
            // A retained camera entry can own a wider, complete geometry
            // window than this request. Use that window only when it owns the
            // exact prepared map consumed below. Otherwise keep this request's
            // proven preparation guard; do not infer missing geometry.
            let support_guard = self.camera_prepare.as_ref()
                .filter(|cache| !cache.incomplete && Arc::ptr_eq(&cache.prepared, &prepared))
                .map(|cache| { let (x,y,w,h) = cache.key.3; Rect::new(x,y,w,h) })
                .unwrap_or(tile_guard);
            // A complete sibling chain can require MORE than the legacy tree
            // maximum. Adopting only smaller certificates would silently keep
            // the old under-supported crop. The unchanged surface cap below
            // still applies to every admitted complete certificate.
            let coherent = options.raster_profile != crate::fidelity::RasterProfile::Analytic;
            let phase_three = painter_support_extent(doc, &page.children, viewport, &prepared, support_guard,
                coherent, None)
                .filter(|support| painter_backdrop_phases_supported(doc, &prepared, extent, support));
            phase_three.map(|previous| {
                if !capture_reads { return previous; }
                let Some(stages) = previous.stages.as_ref() else { return previous; };
                // The frozen logical limits own capture origins/dimensions.
                // A failed stage/geometry/phase proof keeps the already proven
                // phase-three certificate, never a mixture of the two plans.
                painter_support_extent(doc, &page.children, viewport, &prepared, support_guard,
                    coherent, Some(stages))
                    .filter(|support| support.stages.is_some() &&
                        painter_backdrop_phases_supported(doc, &prepared, extent, support))
                    .unwrap_or(previous)
            })
        } else { None };
        let extent = painter_support.as_ref().map_or(extent, |support| support.extent);
        if extent.pixels() > 16_777_216 {
            return Err("GPU surface budget exceeded".into());
        }
        let emission_guard=(tile_guard.x,tile_guard.y,tile_guard.w,tile_guard.h);
        let programs = if cache_key.is_some() {
            self.camera_prepare.as_mut().map(|cache|{
                if cache.program_guard!=Some(emission_guard) {
                    cache.programs=ProgramCache::default();
                    cache.program_guard=Some(emission_guard);
                }
                std::mem::take(&mut cache.programs)
            }).unwrap_or_default()
        } else { ProgramCache::default() };
        let PainterSupport { backdrop_outputs, shadow_outputs, stages, .. } = painter_support.unwrap_or_else(||
            PainterSupport { extent, backdrop_outputs: HashMap::new(), shadow_outputs: HashMap::new(), stages: None });
        let root_input_box = stages.as_ref().map(|s| device_box(s.root_input));
        // Retained interaction geometry proves exact dirty subtrees. Keep a
        // non-overlapping frontier, never one duplicated snapshot per ancestor.
        // Painter-stage demand changes depend on siblings and retain full compilation.
        let retain_fragments=(self.camera_prepare.as_ref().is_some_and(|cache|cache.incremental)||self.interaction_transform_revision.as_ref().is_some_and(|(_,next,_)|*next==self.geo_revision))
            && options.animation.is_none() && stages.is_none() && backdrop_outputs.is_empty() && shadow_outputs.is_empty();
        let mut fragments=self.camera_prepare.as_mut().map(|c|std::mem::take(&mut c.fragments)).unwrap_or_default();
        let policy=serde_json::to_string(&(options,viewport,extent,regional_foreground,backdrop_chain,gaussian_regions,gaussian_reduction,source_filter_fields)).map_err(|e|e.to_string())?;
        if !retain_fragments||fragments.policy!=policy {fragments.clear();}
        fragments.policy=policy;
        let fragment_targets=if retain_fragments {page.children.iter().flat_map(|id|{
            let n=&doc.nodes[id];if n.render_children().is_empty(){vec![id.clone()]}else{n.render_children().to_vec()}
        }).collect()}else{Default::default()};
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
            gaussian_regions,
            gaussian_reduction,
            source_filter_fields,
            prune_backdrop_output: backdrop_chain,
            backdrop_outputs,
            shadow_outputs,
            stages,
            curves: Vec::new(),
            area_paths: HashMap::new(),
            fragments, fragment_targets, compiled_order:Vec::new(),
            programs,
            nodes: BTreeMap::new(),
            vertices: Vec::new(),
        };
        for root in &page.children {
            compiler.node(root, camera, regional_foreground.then_some(viewport))?;
        }
        if cache_key.is_some() {
            if let Some(cache) = self.camera_prepare.as_mut() {
                cache.programs = compiler.programs;
                cache.program_guard=Some(emission_guard);
                cache.fragments=compiler.fragments;
            }
        }
        let mut nodes = compiler.nodes;
        if let Some(context)=&self.source_compile_context {if let Some(stage)=nodes.get_mut(&context.stage){stage.children=(*context.stage_children).clone();}}

        if has_region && doc.color_management.is_some() && !options.interactive_effects
            && options.raster_profile == crate::fidelity::RasterProfile::FigmaSubpixel && root_input_box.is_none() {
            suffix::annotate(&mut nodes, &page.children, viewport, extent);
        }
        let coherent_samples=crate::fidelity::coherent_samples(doc, options);
        if options.raster_profile != crate::fidelity::RasterProfile::Analytic {
            let mut has_glass=false;
            for n in nodes.values_mut() {
                has_glass |= n.glass_shape.is_some() && n.effects.iter().any(|fx|fx.visible && fx.glass.is_some());
                n.fill.analytic_rect = None;
                n.fill.sample_count = Some(4);
                for path in n.strokes.iter_mut().map(|s| &mut s.path).chain(
                    n.source_filter_field.iter_mut().flat_map(|f| f.channels_mut().map(|m| &mut m.path))) {
                    path.analytic_rect = None;
                    path.sample_count = Some(4);
                }
            }
            // Apply this contextual omission after restoring any immutable
            // fragments. Moving the foreground lens must restore the rear one.
            if coherent_samples && has_glass {
                let mut pairs = Vec::new();
                let lists=std::iter::once(&page.children).chain(nodes.keys().filter_map(|id|doc.nodes.get(id)).map(|n|&n.children));
                for siblings in lists {
                    for pair in siblings.windows(2) {
                        let Some(lower)=nodes.get(&pair[0]) else {continue};
                        let Some(upper)=nodes.get(&pair[1]) else {continue};
                        if lower.rect.intersect(upper.rect).empty() || crate::scene::selected_backdrop(&upper.effects).is_none() {continue;}
                        let n=&doc.nodes[&pair[0]];
                        if let Some(front)=crate::optics::next_glass_consumer(doc,n,Some(&pair[1])) {
                            pairs.push((pair[0].clone(),pair[1].clone(),crate::optics::same_glass_coverage(n,front)));
                        }
                    }
                }
                for (id,next,concealed) in pairs {
                    let n=nodes.get_mut(&id).expect("compiled optical leaf");
                    if concealed {
                        n.effects.retain(|fx|fx.kind!="glass" || !fx.visible);
                        n.capture_replay=None;
                    }
                    n.optical_prefix_next=Some(next.clone());
                    if let Some(front)=nodes.get_mut(&next) {front.capture_replay=None;}
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
                let field_paints=n.source_filter_field.iter().flat_map(|field|
                    field.channels().filter_map(|mask|mask.paint.as_ref()));
                for p in n.fills.iter().chain(n.strokes.iter().map(|s| &s.paint)).chain(field_paints) {
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
            dense_paint:None,
            page_paint_rects: None,
            software_raster: options.raster_profile.is_software() && doc.color_management.is_none(),
            output: None,
            root_input_box,
            float_compositing: doc.color_management.is_some()
                || options.raster_profile == crate::fidelity::RasterProfile::Analytic,
            color_management: doc.color_management,
            colors,
            backdrop_samples: options.raster_profile != crate::fidelity::RasterProfile::Analytic
                && self.source_compile_context.as_ref().map_or_else(||crate::fidelity::has_backdrop(doc, options),|c|c.backdrop),
            coherent_samples,
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
    fn page_background_support_is_unculled_and_camera_revision_fenced() {
        let mut doc=document();
        doc["nodes"]["frame"]["clip"]=json!(false);
        doc["nodes"]["moving"]["transform"]=json!([1,0,0,1,-900,30]);
        let mut engine=Engine::new();engine.load_document(&doc.to_string()).unwrap();
        let mut options=json!({"pageId":"p","width":64,"height":64,"view":{"x":0,"y":0,"zoom":2},
            "grid":false,"transparent":false,"rasterProfile":"figmaSubpixel","gpuPageBackground":true,"gpuViewport":{"x":500000,"y":0,"w":64,"h":64}});
        let first=engine.compile_gpu_request(&options.to_string()).unwrap().page_paint_rects.unwrap();
        // Child outside the frame and another offscreen root both participate.
        assert_eq!(first.len(),2);assert!(first[0][0] < -1700.);assert!(first[1][2]>2000.);
        options["view"]["x"]=json!(17);options["view"]["y"]=json!(-9);
        let moved=engine.compile_gpu_request(&options.to_string()).unwrap().page_paint_rects.unwrap();
        for (a,b) in first.iter().zip(&moved){assert_eq!(*b,[a[0]+17.,a[1]-9.,a[2]+17.,a[3]-9.]);}
        doc["nodes"]["fixed"]["transform"]=json!([1,0,0,1,2000,120]);
        engine.load_document(&doc.to_string()).unwrap();
        let changed=engine.compile_gpu_request(&options.to_string()).unwrap().page_paint_rects.unwrap();
        assert!(changed[1][0]>3900.);
        options["transparent"]=json!(true);
        assert!(engine.compile_gpu_request(&options.to_string()).unwrap().page_paint_rects.is_none());
        options["transparent"]=json!(false);options["grid"]=json!(true);
        assert!(engine.compile_gpu_request(&options.to_string()).unwrap().page_paint_rects.is_none());
    }
    #[test]
    fn render_root_scope_matches_hidden_document_without_mutating_source() {
        for profile in ["analytic","figmaSubpixel"] {
            let doc=document();let mut engine=Engine::new();engine.load_document(&doc.to_string()).unwrap();
            let options=json!({"pageId":"p","width":128,"height":128,"view":{"x":3.125,"y":-2.25,"zoom":0.5},
                "transparent":true,"grid":false,"rasterProfile":profile});
            let before=engine.compile_gpu_request(&options.to_string()).unwrap().into_packet().unwrap();
            let mut selected=options.clone();selected["gpuRoots"]=json!(["frame"]);
            let actual=engine.compile_gpu_request(&selected.to_string()).unwrap().into_packet().unwrap();
            let mut hidden=doc.clone();hidden["nodes"]["fixed"]["visible"]=json!(false);
            let mut reference=Engine::new();reference.load_document(&hidden.to_string()).unwrap();
            assert_eq!(actual,reference.compile_gpu_request(&options.to_string()).unwrap().into_packet().unwrap());
            assert_eq!(before,engine.compile_gpu_request(&options.to_string()).unwrap().into_packet().unwrap());
            selected["gpuRoots"]=json!(["moving"]);assert!(engine.compile_gpu_request(&selected.to_string()).is_err());
            selected["gpuRoots"]=json!(["frame","frame"]);assert!(engine.compile_gpu_request(&selected.to_string()).is_err());
        }
    }
    #[test]
    fn neutral_group_scope_is_opt_in_and_keeps_world_geometry_and_source_intact(){
        let mut doc=document();doc["pages"][0]["children"]=json!(["frame"]);
        doc["nodes"]["frame"]["kind"]=json!("group");doc["nodes"]["frame"]["blend"]=json!("normal");
        doc["nodes"]["frame"]["clip"]=json!(false);doc["nodes"]["frame"]["fills"]=json!([]);doc["nodes"]["frame"]["effects"]=json!([]);
        doc["nodes"]["frame"]["children"]=json!(["moving","sibling","fixed"]);
        let mut engine=Engine::new();engine.load_document(&doc.to_string()).unwrap();
        let options=json!({"pageId":"p","width":128,"height":128,"view":{"x":3.125,"y":-2.25,"zoom":0.5},"transparent":true,"grid":false,"rasterProfile":"figmaSubpixel"});
        let before=engine.compile_gpu_request(&options.to_string()).unwrap();
        let pose=before.nodes["moving"].matrix;let packet=before.into_packet().unwrap();
        let mut selected=options.clone();selected["gpuRoots"]=json!(["moving"]);
        assert!(engine.compile_gpu_request(&selected.to_string()).is_err());
        selected["gpuNeutralPageGroup"]=json!(true);
        let actual=engine.compile_gpu_request(&selected.to_string()).unwrap();assert_eq!(actual.nodes["moving"].matrix,pose);
        let mut hidden=doc.clone();hidden["nodes"]["fixed"]["visible"]=json!(false);hidden["nodes"]["sibling"]["visible"]=json!(false);
        let mut reference=Engine::new();reference.load_document(&hidden.to_string()).unwrap();
        assert_eq!(actual.into_packet().unwrap(),reference.compile_gpu_request(&options.to_string()).unwrap().into_packet().unwrap());
        assert_eq!(packet,engine.compile_gpu_request(&options.to_string()).unwrap().into_packet().unwrap());
        for field in ["clip","opacity","fills","effects"]{
            let mut changed=doc.clone();changed["nodes"]["frame"][field]=match field{
                "clip"=>json!(true),"opacity"=>json!(0.5),"fills"=>json!([{"kind":"solid","color":"#ffffff"}]),
                _=>json!([{"kind":"blur","radius":2,"color":"#000000"}]),
            };
            engine.load_document(&changed.to_string()).unwrap();assert!(engine.compile_gpu_request(&selected.to_string()).is_err());
        }
        let mut masked=doc.clone();masked["nodes"]["fixed"]["mask"]=json!(true);engine.load_document(&masked.to_string()).unwrap();
        assert!(engine.compile_gpu_request(&selected.to_string()).is_err());
        engine.load_document(&doc.to_string()).unwrap();selected["rasterProfile"]=json!("analytic");
        assert!(engine.compile_gpu_request(&selected.to_string()).is_err());
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

#[cfg(test)]
mod resolved_camera_regressions {
 use super::*;
 use serde_json::json;
 #[test]
 fn resize_preserves_unaffected_programs_and_matches_fresh_compile(){
  let value=json!({"schemaVersion":16,"id":"d","name":"retention","pages":[{"id":"p","name":"p","background":"#ffffff","children":["a","b"]}],"nodes":{
   "a":{"id":"a","kind":"ellipse","width":40,"height":40,"fills":[{"kind":"solid","color":"#ff0000"}]},
   "b":{"id":"b","kind":"ellipse","width":40,"height":40,"transform":[1,0,0,1,500,0],"fills":[{"kind":"solid","color":"#00ff00"}]}}});
  let mut engine=Engine::new();engine.load_document(&value.to_string()).unwrap();
  let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
  let first=engine.compile_gpu_region(&options,Rect::new(0,0,128,128),None).unwrap().into_packet().unwrap();
  let old=engine.camera_prepare.as_ref().unwrap().prepared["a"].fill.clone();
  let mut after:crate::scene::Document=serde_json::from_value(value).unwrap();after.nodes.get_mut("b").unwrap().width=50.;
  let patch=crate::editing::DocumentPatch{nodes:std::collections::BTreeMap::from([("b".into(),Some(after.nodes["b"].clone()))]),fields:Default::default()};
  engine.apply_document_patch_with_damage(&patch).unwrap();
  let second=engine.compile_gpu_region(&options,Rect::new(0,0,128,128),None).unwrap().into_packet().unwrap();
  assert_eq!(first,second);
  assert!(Arc::ptr_eq(&old,&engine.camera_prepare.as_ref().unwrap().prepared["a"].fill));
  assert!(engine.gpu_compile_cache_stats()["hits"].as_u64().unwrap()>0);
  let mut reference=Engine::new();reference.load_document(&serde_json::to_string(&after).unwrap()).unwrap();
  assert_eq!(second,reference.compile_gpu_region(&options,Rect::new(0,0,128,128),None).unwrap().into_packet().unwrap());
  // Visible geometry still invalidates and updates its sampled pixels/program.
  after.nodes.get_mut("a").unwrap().width=70.;
  let patch=crate::editing::DocumentPatch{nodes:std::collections::BTreeMap::from([("a".into(),Some(after.nodes["a"].clone()))]),fields:Default::default()};engine.apply_document_patch_with_damage(&patch).unwrap();
  let changed=engine.compile_gpu_region(&options,Rect::new(0,0,128,128),None).unwrap().into_packet().unwrap();
  reference.load_document(&serde_json::to_string(&after).unwrap()).unwrap();
  assert_ne!(changed,second);assert_eq!(changed,reference.compile_gpu_region(&options,Rect::new(0,0,128,128),None).unwrap().into_packet().unwrap());
 }
}

#[cfg(test)]
mod integrated_leaf_culling_tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (Node, crate::geometry_snapshot::Prepared) {
        let node:Node=serde_json::from_value(json!({"id":"shadow","kind":"rectangle","width":120,"height":68,
            "fills":[{"kind":"solid","color":"#fff"}],
            "effects":[{"kind":"shadow","radius":35,"x":10,"y":15,"spread":0,"color":"#fff"}]})).unwrap();
        let fill=Rect::new(-2985,-10325,7691,4330);
        let prepared=crate::geometry_snapshot::Prepared{support_culled:false,fill_bounds:None,matrix:Transform([64.,0.,0.,64.,0.,0.]),
            fill:Arc::new(Vec::new()),fill_program_bounds:fill,strokes:Vec::new(),stroke_program_bounds:Vec::new(),
            bounds:fill.expand(6080),halo:6080,segments:0};
        (node,prepared)
    }
    #[test]
    fn topology_3200_offscreen_shadow_does_not_reach_the_tile() {
        let (n,p)=fixture();let tile=Rect::new(0,-300,514,514);
        assert!(!p.bounds.intersect(tile).empty());
        let exact=integrated_leaf_output_bounds(&n,&p).unwrap();
        assert!(exact.intersect(tile).empty());
        // A crop which actually receives the shadow must remain demanded.
        assert!(!exact.intersect(Rect::new(0,-4000,514,514)).empty());
    }
    #[test]
    fn unsupported_effects_and_geometry_keep_the_conservative_path() {
        let (n,p)=fixture();
        for kind in ["inner-shadow","background-blur","glass","texture"] {
            let mut other=n.clone();other.effects[0].kind=kind.into();
            assert!(integrated_leaf_output_bounds(&other,&p).is_none());
        }
        let mut other=n.clone();other.effects.push(n.effects[0].clone());
        assert!(integrated_leaf_output_bounds(&other,&p).is_none());
        let mut other=n.clone();other.effects[0].spread=1.;
        assert!(integrated_leaf_output_bounds(&other,&p).is_none());
        let mut other=n.clone();other.children.push("child".into());
        assert!(integrated_leaf_output_bounds(&other,&p).is_none());
        let mut other=n.clone();other.fills[0].kind="linear".into();
        assert!(integrated_leaf_output_bounds(&other,&p).is_none());
        let mut far=p.clone();far.fill_program_bounds=Rect::new(1_048_576,0,10,10);
        assert!(integrated_leaf_output_bounds(&n,&far).is_none());
    }
    #[test]
    fn fractional_radius_and_rotated_offsets_keep_all_tent_and_bilinear_taps() {
        let (mut n,mut p)=fixture();p.matrix=Transform([0.,2.,-3.,0.,0.,0.]);
        p.fill_program_bounds=Rect::new(-100,-100,200,200);n.effects[0].radius=3.1;
        let support=integrated_leaf_output_bounds(&n,&p).unwrap();
        for x in [-100,99] {for y in [-100,99] {for dx in -11..=11 {for dy in -11..=11 {
            assert!(support.index(x+dx-45,y+dy+20).is_some());
        }}}}
    }
}

#[cfg(test)]
mod page_predicate_cache_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cached_presence_tracks_page_effect_visibility_and_document_mutation() {
        let mut d:Document=serde_json::from_value(json!({"schemaVersion":20,"id":"cache","name":"cache",
            "colorManagement":crate::color::ColorSettings::default(),
            "pages":[{"id":"p","name":"p","background":"#ffffff","children":["a"]},{"id":"q","name":"q","background":"#ffffff","children":["b"]}],
            "nodes":{"a":{"id":"a","kind":"rectangle","width":128,"height":128,"fills":[{"kind":"solid","color":"#123456"}]},
                "b":{"id":"b","kind":"rectangle","width":128,"height":128,"fills":[{"kind":"solid","color":"#fedcba"}]}}
        })).unwrap();
        let mut actual=Engine::new();actual.load_document(&serde_json::to_string(&d).unwrap()).unwrap();
        for mode in 0..5 {
            d.nodes.get_mut("a").unwrap().effects=match mode {
                1|2=>serde_json::from_value(json!([{"kind":"zoom-blur","color":"#000000","visible":mode==1,"zoomBlur":{"amount":10,"center":[4,4]}}])).unwrap(),
                3=>serde_json::from_value(json!([{"kind":"gaussian-blur","color":"#000000","radius":3.75}])).unwrap(),
                _=>vec![],
            };
            d.nodes.get_mut("b").unwrap().effects=if mode==4{serde_json::from_value(json!([{"kind":"background-blur","color":"#000000","radius":2.25}])).unwrap()}else{vec![]};
            actual.apply_document_patch(&serde_json::from_value(json!({"nodes":{"a":d.nodes["a"],"b":d.nodes["b"]},"fields":{}})).unwrap()).unwrap();
            for page in ["p","q","p"] {for scale in [1.,1.25]{
                let options=json!({"pageId":page,"width":64,"height":64,"view":{"x":0.25,"y":-0.375,"zoom":scale},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":16,"h":16}}).to_string();
                let a=actual.compile_gpu_request(&options).unwrap();
                let properties=actual.world_support.as_ref().unwrap().properties;
                assert_eq!(properties.has_zoom,page=="p"&&mode==1);
                assert_eq!(properties.backdrop_chain,page=="q"&&mode==4);
                let mut fresh=Engine::new();fresh.load_document(&serde_json::to_string(&d).unwrap()).unwrap();let b=fresh.compile_gpu_request(&options).unwrap();
                // Canonical JSON retains numeric spelling/sign rather than
                // Value's numeric equality; program arrays remain included.
                assert_eq!(serde_json::to_string(&serde_json::to_value(a).unwrap()).unwrap(),serde_json::to_string(&serde_json::to_value(b).unwrap()).unwrap(),"mode {mode}, page {page}, scale {scale}");
            }}
        }
    }
}


#[cfg(test)] mod streamed_gaussian_tests {
    use super::*;
    use serde_json::json;
    fn document()->Document {
        serde_json::from_value(json!({"schemaVersion":20,"id":"large-blur","name":"large-blur","colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
            "pages":[{"id":"p","name":"p","children":["ellipse"],"background":"#ffffff"}],"nodes":{"ellipse":{"id":"ellipse","kind":"ellipse","width":477.1432495117188,"height":264.1494750976562,
            "fills":[{"kind":"solid","color":"#59aeff"}],"effects":[{"kind":"gaussian-blur","radius":10.77823925018311,"color":"#000000"}]}}})).unwrap()
    }
    #[test] fn wide_gaussian_streams_source_under_original_intermediate_budget(){
        let d=document();let mut e=Engine::new();e.load_document(&serde_json::to_string(&d).unwrap()).unwrap();
        let mut r=json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-2000.,"zoom":64.},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":514,"h":514}});
        assert!(e.compile_gpu_request(&r.to_string()).is_err());r["gpuGaussianRegions"]=json!(true);
        let scene=e.compile_gpu_request(&r.to_string()).unwrap();let plan=scene.nodes["ellipse"].gaussian_region.as_ref().unwrap();
        assert!(scene.extent.pixels()<1_000_000);assert!(plan.source.pixels()>16_777_216);
        assert!(u64::from(plan.source.w-2*plan.radii[0])*u64::from(plan.source.h)<=16_777_216);
        assert_eq!(plan.radii,crate::effects::gaussian_box_radii_region(10.77823925018311*64.).unwrap());
        assert!(crate::effects::gaussian_box_radii(10.77823925018311*64.).is_err());
        assert!(crate::rational_filter::RationalKernel::uniform_box(plan.radii[0]).is_err());
        assert!(crate::rational_filter::RationalKernel::regional_box(plan.radii[0]).is_ok());
        r["view"]["y"]=json!(-8000.);
        let interior=e.compile_gpu_request(&r.to_string()).unwrap();
        assert!(interior.nodes["ellipse"].gaussian_region.is_none());
        assert!(interior.nodes["ellipse"].effects.is_empty());
        assert!(interior.nodes["ellipse"].rect.pixels()<1_000_000);
        assert_eq!(e.doc.as_ref().unwrap().nodes["ellipse"].effects.len(),1,"authored effect stays intact");
    }
    #[test] fn reduced_gaussian_keeps_native_output_and_only_admits_broad_convex_sdr_sources(){
        let d=document();let original=serde_json::to_string(&d).unwrap();let mut e=Engine::new();e.load_document(&original).unwrap();
        let mut r=json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-2000.,"zoom":64.},"rasterProfile":"figmaSubpixel",
            "gpuViewport":{"x":0,"y":0,"w":514,"h":514},"gpuGaussianRegions":true});
        // Factor 2 would exceed this recipe's unchanged 4M source-pixel cap.
        r["gpuGaussianReduction"]=json!(2);
        assert_eq!(e.compile_gpu_request(&r.to_string()).unwrap().nodes["ellipse"].gaussian_region.as_ref().unwrap().factor,None);
        for factor in [4,8] {
            r["gpuGaussianReduction"]=json!(factor);
            let scene=e.compile_gpu_request(&r.to_string()).unwrap();let node=&scene.nodes["ellipse"];let plan=node.gaussian_region.as_ref().unwrap();
            assert_eq!(plan.factor,Some(factor));assert_eq!(plan.full_output,Some(Rect::new(0,0,514,514)));
            assert!(plan.source.pixels()<=4_194_304);assert!(!node.fill.rect.empty());
            assert_eq!(node.fill.rect.intersect(plan.source),node.fill.rect);
            assert_eq!(node.effects[0].radius,d.nodes["ellipse"].effects[0].radius);
            assert_eq!(serde_json::to_string(e.doc.as_ref().unwrap()).unwrap(),original);
        }
        for invalid in [json!(1),json!(3),json!(-1),json!(true)]{r["gpuGaussianReduction"]=invalid;assert!(e.compile_gpu_request(&r.to_string()).is_err());}
        let mut hdr=d.clone();hdr.nodes.get_mut("ellipse").unwrap().fills[0].color="color(srgb-linear 2 0 0)".into();
        e.load_document(&serde_json::to_string(&hdr).unwrap()).unwrap();r["gpuGaussianReduction"]=json!(4);
        assert_eq!(e.compile_gpu_request(&r.to_string()).unwrap().nodes["ellipse"].gaussian_region.as_ref().unwrap().factor,None);
        let n=&d.nodes["ellipse"];let matrix=Transform([64.,0.,0.,64.,0.,0.]);let plan=gaussian_region_plan(n,matrix,Rect::new(0,0,32,32)).unwrap();
        let mut thin=n.clone();thin.width=1.;let paths=thin.paths().unwrap();assert!(reduced_gaussian_source(&thin,matrix,&plan,&paths.0,4).is_none());
    }
    #[test] fn wide_image_gaussian_preserves_source_support_and_never_uses_a_reduced_image_grid(){
        use base64::Engine as _;
        let mut png=Vec::new();
        {
            let mut encoder=png::Encoder::new(&mut png,2,2);
            encoder.set_color(png::ColorType::Rgba);encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&[255,0,0,255,0,255,0,127,0,0,255,63,255,255,255,0]).unwrap();
        }
        let uri=format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png));
        let mut d=document();
        let n=d.nodes.get_mut("ellipse").unwrap();
        n.fills[0].kind="image".into();n.fills[0].image=Some(uri.into());
        n.transform=Transform([-1.,0.,0.,1.,477.1432495117188,0.]);
        let original=serde_json::to_string(&d).unwrap();
        let mut e=Engine::new();e.load_document(&original).unwrap();
        let mut r=json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-2000.,"zoom":64.},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":514,"h":514}});
        assert!(e.compile_gpu_request(&r.to_string()).is_err());
        r["gpuGaussianRegions"]=json!(true);r["gpuGaussianReduction"]=json!(8);
        let scene=e.compile_gpu_request(&r.to_string()).unwrap();
        let node=&scene.nodes["ellipse"];let plan=node.gaussian_region.as_ref().unwrap();
        assert_eq!(plan.factor,None);assert_eq!(node.fills[0].kind,"image");
        assert_eq!(plan.radii,crate::effects::gaussian_box_radii_region(d.nodes["ellipse"].effects[0].radius*64.).unwrap());
        assert!(scene.extent.pixels()<1_000_000);assert!(plan.source.pixels()>16_777_216);
        r["view"]["y"]=json!(-8000.);
        let interior=e.compile_gpu_request(&r.to_string()).unwrap();
        assert!(interior.nodes["ellipse"].gaussian_region.is_some(),"constant geometry cannot prove constant image colour");
        assert_eq!(interior.nodes["ellipse"].effects[0].kind,"gaussian-blur");
        assert_eq!(serde_json::to_string(e.authored_document().unwrap()).unwrap(),original);
    }
    #[test] fn dependent_and_oversized_streams_do_not_inherit_new_admission(){
        let d=document();let n=&d.nodes["ellipse"];let m=Transform([64.,0.,0.,64.,0.,0.]);let output=Rect::new(0,0,514,514);
        assert!(gaussian_region_plan(n,m,output).is_some());
        let mut masked=n.clone();masked.mask=true;assert!(gaussian_region_plan(&masked,m,output).is_none());
        let mut clipped=n.clone();clipped.clip=true;assert!(gaussian_region_plan(&clipped,m,output).is_none());
        assert!(gaussian_region_plan(n,Transform([128.,0.,0.,128.,0.,0.]),output).is_none());
        assert!(gaussian_region_plan(n,m,Rect::new(0,0,1024,1024)).is_none());
        assert!(gaussian_region_plan(n,m,Rect::new(1_048_000,0,514,514)).is_none());
    }
    #[test] fn imported_closed_ellipse_network_uses_reduced_gaussian(){
        let n:Node=serde_json::from_str(include_str!("../../../../testing/verification-interaction-layout-20261030/topology-gaussian-leaf.json")).unwrap();
        let matrix=Transform([64.,0.,0.,64.,729000.,425000.]);
        let plan=gaussian_region_plan(&n,matrix,Rect::new(729087,425471,514,514)).unwrap();
        let path=n.paths().unwrap().0;
        assert!(reduced_gaussian_source(&n,matrix,&plan,&path,4).is_some());
    }
    #[test] fn medium_gaussian_reduction_declines_thin_sources_without_changing_the_original_plan(){
        let mut d=document();d.nodes.get_mut("ellipse").unwrap().effects[0].radius=4.619245529174805;
        let mut e=Engine::new();e.load_document(&serde_json::to_string(&d).unwrap()).unwrap();
        let mut options=json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-200.,"zoom":64.},"rasterProfile":"figmaSubpixel",
            "gpuViewport":{"x":0,"y":0,"w":514,"h":514},"gpuGaussianRegions":true});
        assert!(e.compile_gpu_request(&options.to_string()).unwrap().nodes["ellipse"].gaussian_region.is_none());
        options["gpuGaussianReduction"]=json!(4);
        assert_eq!(e.compile_gpu_request(&options.to_string()).unwrap().nodes["ellipse"].gaussian_region.as_ref().unwrap().factor,Some(4));
        d.nodes.get_mut("ellipse").unwrap().width=0.5;
        e.load_document(&serde_json::to_string(&d).unwrap()).unwrap();options["view"]["x"]=json!(0.);
        assert!(e.compile_gpu_request(&options.to_string()).unwrap().nodes["ellipse"].gaussian_region.is_none());
    }
    #[test]
    fn source_filter_crop_keeps_the_shadow_and_native_sharp_geometry_separate(){
        let mut d=document();let n=d.nodes.get_mut("ellipse").unwrap();
        n.effects[0].kind="inner-shadow".into();n.effects[0].radius=60.;
        n.fills[0].opacity=0.9;
        let mut engine=Engine::new();let authored=serde_json::to_string(&d).unwrap();engine.load_document(&authored).unwrap();
        let mut request=json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-200.,"zoom":64.},
            "rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":514,"h":514},"gpuGaussianRegions":true,"gpuSourceFilterFields":true});
        let plan=engine.compile_gpu_request(&request.to_string()).unwrap();
        let node=&plan.nodes["ellipse"];let field=node.source_filter_field.as_ref().unwrap();
        assert!(field.factor>1&&field.input.pixels()<=524288&&!field.masks.is_empty());
        assert!(node.rect.w<1024&&node.rect.h<1024);assert_eq!(node.effects[0].radius,60.);
        assert_eq!(serde_json::to_string(engine.doc.as_ref().unwrap()).unwrap(),authored);
        request["gpuSourceFilterFields"]=json!(false);
        if let Ok(reference)=engine.compile_gpu_request(&request.to_string()){
            assert!(reference.nodes.values().all(|n|n.source_filter_field.is_none()));
        }
    }
    #[test]
    fn overlapping_soft_children_keep_their_separate_gaussians_in_painter_order() {
        let mut doc = document();
        let mut group = doc.nodes["ellipse"].clone();
        group.id = "group".into();
        group.kind = "group".into();
        group.fills.clear();
        group.children = vec!["ellipse".into(), "second".into()];
        group.effects[0].radius = 8.24;
        let mut second = doc.nodes["ellipse"].clone();
        second.id = "second".into();
        second.fills[0].color = "color(srgb 1 0 0.125 / 0.53)".into();
        second.effects[0].radius = 6.;
        doc.pages[0].children = vec![group.id.clone()];
        doc.nodes.insert(group.id.clone(), group);
        doc.nodes.insert(second.id.clone(), second);
        let mut engine = Engine::new();
        engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
        let options = json!({"pageId":"p","width":514,"height":514,
            "view":{"x":-15000.,"y":-200.,"zoom":64.},"rasterProfile":"figmaSubpixel",
            "gpuViewport":{"x":0,"y":0,"w":514,"h":514},"gpuGaussianRegions":true,"gpuSourceFilterFields":true});
        let scene = engine.compile_gpu_request(&options.to_string()).unwrap();
        let field = scene.nodes["group"].source_filter_field.as_ref().unwrap();
        assert!(field.gaussian && field.input.pixels() <= 524288);
        assert_eq!(field.group_roots, ["ellipse", "second"]);
        assert!(scene.nodes["group"].children.is_empty());
        assert!(scene.nodes["second"].matrix.max_scale()<64.);
        assert_eq!(scene.nodes["second"].effects[0].radius,6.);
        assert_eq!(scene.nodes["second"].fills[0].color,"color(srgb 1 0 0.125 / 0.53)");
        assert!(scene.colors.contains_key("color(srgb 1 0 0.125 / 0.53)"));
        assert_eq!(scene.nodes["second"].fill.sample_count,Some(4));
    }
    #[test]
    fn a_group_shadow_samples_the_small_silhouette_and_draws_its_native_child() {
        let mut doc=document();
        let mut group=doc.nodes["ellipse"].clone();
        group.id="shadow-group".into();group.kind="group".into();group.fills.clear();
        group.children=vec!["ellipse".into()];group.effects[0].kind="shadow".into();group.effects[0].radius=5.;
        group.effects[0].x=4.;
        let child=doc.nodes.get_mut("ellipse").unwrap();child.effects.clear();child.fills[0].opacity=0.6;
        doc.pages[0].children=vec![group.id.clone()];doc.nodes.insert(group.id.clone(),group);
        let mut engine=Engine::new();engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
        let req=json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-200.,"zoom":64.},
            "rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":514,"h":514},
            "gpuGaussianRegions":true,"gpuSourceFilterFields":true});
        let scene=engine.compile_gpu_request(&req.to_string()).unwrap();let parent=&scene.nodes["shadow-group"];
        let field=parent.source_filter_field.as_ref().unwrap();
        assert!(!field.gaussian && field.factor>1 && field.sharp_halo==0);
        assert_eq!(parent.children, ["ellipse"]);
        assert_eq!(scene.nodes["ellipse"].matrix.max_scale(),64.);
        assert_eq!(field.group_roots.len(),1);
        assert_eq!(scene.nodes[&field.group_roots[0]].matrix.max_scale(),64./f64::from(field.factor));
        assert_eq!(engine.doc.as_ref().unwrap().nodes.len(),2);
    }
    #[test]
    fn pointwise_colour_controls_do_not_widen_a_siblings_source_shadow() {
        let mut doc = document();
        let mut adjusted = doc.nodes["ellipse"].clone();
        adjusted.id = "adjusted".into();
        adjusted.effects[0].kind = "color-controls".into();
        adjusted.effects[0].radius = 0.;
        adjusted.effects[0].color_controls = Some(crate::color_controls::ColorControls {
            brightness: 0.1, ..Default::default()
        });
        doc.pages[0].children.push(adjusted.id.clone());
        doc.nodes.insert(adjusted.id.clone(), adjusted);
        let node = doc.nodes.get_mut("ellipse").unwrap();
        node.effects[0].kind = "shadow".into();
        node.effects[0].radius = 60.;
        let mut engine = Engine::new();
        engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
        let req = json!({"pageId":"p","width":514,"height":514,"view":{"x":-15000.,"y":-200.,"zoom":64.},
            "rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":514,"h":514},
            "gpuGaussianRegions":true,"gpuSourceFilterFields":true});
        let scene = engine.compile_gpu_request(&req.to_string()).unwrap();
        assert!(scene.extent.pixels() < 1_000_000);
        assert!(scene.nodes["ellipse"].source_filter_field.is_some());
        assert_eq!(scene.nodes["adjusted"].effects[0].kind, "color-controls");
    }
    #[test]
    fn source_filter_stacks_preserve_order_and_reject_dependent_translucent_masks() {
        let mut doc = document();
        let node = doc.nodes.get_mut("ellipse").unwrap();
        let mut shadow = node.effects[0].clone();
        shadow.kind = "inner-shadow".into();
        shadow.radius = 8.;
        node.effects = vec![shadow.clone(), shadow.clone()];
        node.effects[0].spread = 2.;
        node.effects[1].radius = 15.;
        let request = json!({"pageId":"p","width":514,"height":514,
            "view":{"x":-15000.,"y":-200.,"zoom":64.},"rasterProfile":"figmaSubpixel",
            "gpuViewport":{"x":0,"y":0,"w":514,"h":514},"gpuGaussianRegions":true,"gpuSourceFilterFields":true});
        let compile = |doc: &Document| {
            let mut engine = Engine::new();
            engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
            engine.compile_gpu_request(&request.to_string())
        };
        let scene = compile(&doc).unwrap();
        let field = scene.nodes["ellipse"].source_filter_field.as_ref().unwrap();
        assert_eq!((field.effect_index, field.additional[0].effect_index), (0, 1));
        assert_eq!(field.additional.len(), 1);
        doc.nodes.get_mut("ellipse").unwrap().fills[0].opacity = 0.5;
        let node = &doc.nodes["ellipse"];
        assert!(!source_filter::eligible(node, Transform([64.,0.,0.,64.,0.,0.]), Rect::new(0,0,514,514)));

        let node = doc.nodes.get_mut("ellipse").unwrap();
        node.effects[0].spread = 0.;
        node.effects[0].radius = 0.;
        node.effects[0].x = 3.;
        node.effects[1].kind = "shadow".into();
        let scene = compile(&doc).unwrap();
        let field = scene.nodes["ellipse"].source_filter_field.as_ref().unwrap();
        assert_eq!(field.effect_index, 1);
        assert!(field.additional.is_empty() && field.sharp_halo >= 192);

        doc.nodes.get_mut("ellipse").unwrap().effects[1].kind = "gaussian-blur".into();
        let scene = compile(&doc).unwrap();
        let field = scene.nodes["ellipse"].source_filter_field.as_ref().unwrap();
        assert!(field.gaussian && field.effect_index == 1 && field.sharp_halo == 0);
    }
    #[test]
    fn diagonal_contours_certify_only_the_side_with_constant_winding(){
        let poly=crate::path::Contour{closed:true,points:vec![Point::new(0.,0.),Point::new(2000.,2000.),Point::new(2000.,0.)]};
        assert_eq!(constant_contours(std::slice::from_ref(&poly),false,Rect::new(1200,100,16,16)),Some(true));
        assert_eq!(constant_contours(std::slice::from_ref(&poly),false,Rect::new(100,1200,16,16)),Some(false));
        assert_eq!(constant_contours(&[poly],false,Rect::new(400,399,16,16)),None);
    }
}
