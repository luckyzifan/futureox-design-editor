//! Native source acquisition. A demand is a revision-bound set of authored
//! records, not a smaller Document. Cold records remain present in the source.
//! The current complete render consumer can coexist with these reads while
//! the renderer's global margin/capture state is migrated separately.
use crate::{
    Engine,
    font::Fonts,
    math::{Rect, Transform},
    scene::{Document, Node},
    scene_store::{Descriptor, ReadStats, Reader},
    world_support::WorldSupport,
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Scene demand cancelled".into())
    } else {
        crate::render_cancellation::checkpoint()
    }
}
fn neutral_stage(n: &Node) -> bool {
    n.kind == "frame"
        && !n.clip
        && !n.mask
        && n.visible
        && n.opacity == 1.
        && n.transform == Transform::default()
        && n.blend == "pass-through"
        && n.fills.is_empty()
        && n.strokes.is_empty()
        && n.effects.is_empty()
        && n.layout.is_none()
        && n.sizing.is_none()
        && n.constraints.is_none()
        && n.instance.is_none()
        && n.component.is_none()
        && n.repeat.is_none()
        && n.boolean_operation.is_none()
        && n.connector.is_none()
        && n.vector_brush.is_none()
        && n.text_path.is_none()
        && n.path_offset == 0.
        && n.derived_path.is_none()
        && n.network.is_none()
        && n.vector_geometry.is_none()
}
struct Unit {
    nodes: Vec<String>,
    dependencies: BTreeSet<usize>,
    backdrop: bool,
}

/// Built against one immutable source and one resolved font/layout state.
/// Private fields prevent callers from supplying layout hints as optical proof.
pub struct Catalog {
    descriptor: Descriptor,
    owners: BTreeMap<String, usize>,
    units: Vec<Unit>,
    roots: Vec<(String, usize)>,
    stage: String,
    support: WorldSupport,
    complete_only: bool,
    stage_size: [f64; 2],
    page_support_known:bool,
}
pub struct Demand {
    catalog: Arc<Catalog>,
    units: BTreeSet<usize>,
    visible: Vec<String>,
    prefix_roots: usize,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemandStats {
    pub total_nodes: usize,
    pub required_nodes: usize,
    pub visible_roots: usize,
    pub painter_prefix_roots: usize,
    pub dependency_units: usize,
}

/// Explicitly distinguishes an existing cold record from an absent identity.
pub enum Lookup<'a> {
    Loaded(&'a Node),
    Cold,
    Absent,
}
pub struct LoadedDemand {
    demand: LoadedAuthority,
    nodes: BTreeMap<String, Node>,
    reads: ReadStats,
}
enum LoadedAuthority {
    Planned(Demand),
    #[cfg(feature="mapped-source-snapshot")]
    Mapped{directory:Arc<crate::scene_store::archive::Directory>,stats:DemandStats,visible:Vec<String>},
}
impl LoadedDemand {
    pub fn lookup(&self, id: &str) -> Lookup<'_> {
        match self.nodes.get(id) {
            Some(n) => Lookup::Loaded(n),
            None if match &self.demand {
                LoadedAuthority::Planned(demand)=>demand.catalog.owners.contains_key(id),
                #[cfg(feature="mapped-source-snapshot")]
                LoadedAuthority::Mapped{directory,..}=>directory.contains(id),
            } => Lookup::Cold,
            None => Lookup::Absent,
        }
    }
    pub fn nodes(&self) -> &BTreeMap<String, Node> {
        &self.nodes
    }
    pub fn stats(&self) -> DemandStats {
        match &self.demand {LoadedAuthority::Planned(demand)=>demand.stats(),
            #[cfg(feature="mapped-source-snapshot")]
            LoadedAuthority::Mapped{stats,..}=>stats.clone()}
    }
    pub fn reads(&self) -> ReadStats {
        self.reads
    }
    pub fn visible_roots(&self) -> &[String] {
        match &self.demand {LoadedAuthority::Planned(demand)=>&demand.visible,
            #[cfg(feature="mapped-source-snapshot")]
            LoadedAuthority::Mapped{visible,..}=>visible}
    }
    #[cfg(feature="mapped-source-snapshot")]
    pub(crate) fn mapped(directory:Arc<crate::scene_store::archive::Directory>,selection:&crate::scene_store::archive::Selection,
        nodes:BTreeMap<String,Node>,reads:ReadStats)->Self {
        let visible=directory.visible_roots(selection);
        let stats=DemandStats{total_nodes:directory.total_nodes(),required_nodes:nodes.len(),visible_roots:visible.len(),
            painter_prefix_roots:selection.prefix_roots,dependency_units:selection.units.len()+1};
        Self{demand:LoadedAuthority::Mapped{directory,stats,visible},nodes,reads}
    }
}

fn references(
    value: &serde_json::Value,
    nodes: &crate::scene::DocumentNodes,
    out: &mut BTreeSet<String>,
) {
    match value {
        serde_json::Value::String(s) if nodes.contains_key(s) => {
            out.insert(s.clone());
        }
        serde_json::Value::Array(a) => {
            for v in a {
                references(v, nodes, out);
            }
        }
        serde_json::Value::Object(o) => {
            for (k, v) in o {
                if nodes.contains_key(k) {
                    out.insert(k.clone());
                }
                references(v, nodes, out);
            }
        }
        _ => (),
    }
}
fn node_references(node: &Node, document: &Document) -> Result<BTreeSet<String>, String> {
    let mut refs = BTreeSet::new();
    if let Some(instance) = &node.instance {
        refs.insert(instance.component_id.clone());
        refs.extend(instance.slot_contents.values().flatten().cloned());
        // Includes component swaps in nested overrides/property values. Only
        // these small semantic fields are visited, never image/path payloads.
        references(
            &serde_json::to_value(instance).map_err(|e| e.to_string())?,
            &document.nodes,
            &mut refs,
        );
    }
    if let Some(component) = &node.component {
        references(
            &serde_json::to_value(component).map_err(|e| e.to_string())?,
            &document.nodes,
            &mut refs,
        );
    }
    if let Some(connector) = &node.connector {
        refs.extend(
            [&connector.from, &connector.to]
                .into_iter()
                .filter_map(|e| e.node_id.clone()),
        );
    }
    if let Some(origin) = &node.instance_origin {
        references(
            &serde_json::to_value(origin).map_err(|e| e.to_string())?,
            &document.nodes,
            &mut refs,
        );
    }
    if refs.iter().any(|id| !document.nodes.contains_key(id)) {
        return Err("Missing scene demand dependency".into());
    }
    Ok(refs)
}
fn reads_painter(n: &Node) -> bool {
    n.mask
        || !matches!(n.blend.as_str(), "normal" | "pass-through")
        || n.effects.iter().any(|e| {
            e.visible
                && (!matches!(
                    e.kind.as_str(),
                    "blur"
                        | "shadow"
                        | "inner-shadow"
                        | "gaussian-blur"
                        | "motion-blur"
                        | "color-controls"
                ) || e.glass.is_some()
                    || e.texture.is_some()
                    || e.gradient_blur.is_some())
        })
}
impl Catalog {
    pub fn open(
        path: &Path,
        descriptor: &Descriptor,
        stage: &str,
        fonts: &Fonts,
        cancel: &AtomicBool,
    ) -> Result<Arc<Self>, String> {
        let (document, _) = Reader::open(path, descriptor, cancel)
            .and_then(|r| r.into_document(cancel))
            .map_err(|e| e.to_string())?;
        Self::build(&document, descriptor, stage, fonts, cancel)
    }
    /// This first catalog builder intentionally resolves the complete source
    /// once. Incremental catalog publication is a later module; layout boxes
    /// from the import directory are not used to discard records here.
    fn build(
        document: &Document,
        descriptor: &Descriptor,
        stage: &str,
        fonts: &Fonts,
        cancel: &AtomicBool,
    ) -> Result<Arc<Self>, String> {
        crate::capacity::with_source_storage_scope(true, || {
            let mut engine = Engine::new();
            engine.fonts = fonts.clone();
            engine.load_source_document(document.clone())?;
            engine.resolve_layout()?;
            Self::from_engine(&engine, descriptor, stage, cancel, 64 * 1024 * 1024)
        })
    }
    pub(crate) fn from_engine(
        engine: &Engine,
        descriptor: &Descriptor,
        stage: &str,
        cancel: &AtomicBool,
        budget: usize,
    ) -> Result<Arc<Self>, String> {
        let document = engine
            .authored_document()
            .ok_or("Missing source authority")?;
        let resolved = engine.doc.as_ref().ok_or("Missing resolved source")?;
        let fonts = &engine.fonts;
        check(cancel)?;
        if document.id != descriptor.document_id || document.nodes.len() as u64 != descriptor.nodes
        {
            return Err("Scene demand source identity mismatch".into());
        }
        let root = document.nodes.get(stage).ok_or("Missing source stage")?;
        if document.pages.first().is_none_or(|p| p.children != [stage]) || !neutral_stage(root) {
            return Err("Scene demand requires the neutral source stage".into());
        }
        let mut support = WorldSupport::build_output(resolved, &[stage.to_owned()], fonts, budget)?
            .unwrap_or_else(WorldSupport::disabled);
        support.retain_roots(&root.children);
        let mut parents = HashMap::new();
        for n in document.nodes.values() {
            for id in &n.children {
                if !document.nodes.contains_key(id)
                    || parents.insert(id.clone(), n.id.clone()).is_some()
                {
                    return Err("Invalid source dependency tree".into());
                }
            }
        }
        let mut unit_roots = root.children.clone();
        unit_roots.extend(
            document
                .nodes
                .keys()
                .filter(|id| id.as_str() != stage && !parents.contains_key(*id))
                .cloned(),
        );
        let mut units = Vec::new();
        let mut owners = BTreeMap::new();
        for id in unit_roots {
            check(cancel)?;
            let unit = units.len();
            let mut ids = Vec::new();
            let mut stack = vec![id];
            while let Some(id) = stack.pop() {
                check(cancel)?;
                if id == stage || owners.insert(id.clone(), unit).is_some() {
                    return Err("Overlapping source demand units".into());
                }
                stack.extend(document.nodes[&id].children.iter().rev().cloned());
                ids.push(id);
            }
            units.push(Unit {
                nodes: ids,
                dependencies: BTreeSet::new(),
                backdrop: false,
            });
        }
        owners.insert(stage.to_owned(), units.len());
        units.push(Unit {
            nodes: vec![stage.to_owned()],
            dependencies: BTreeSet::new(),
            backdrop: false,
        });
        if owners.len() != document.nodes.len() {
            return Err("Unreachable source dependency cycle".into());
        }
        for (id, n) in &document.nodes {
            check(cancel)?;
            if id == stage {
                continue;
            }
            let own = owners[id];
            for dependency in node_references(n, document)? {
                units[own].dependencies.insert(owners[&dependency]);
            }
        }
        // Use resolved descendants: generated instance children can carry
        // a backdrop that is absent from the authored instance shell.
        for id in &root.children {
            let unit = owners[id];
            let mut stack = vec![id.as_str()];
            while let Some(id) = stack.pop() {
                check(cancel)?;
                let n = resolved
                    .nodes
                    .get(id)
                    .ok_or("Resolved source root disappeared")?;
                units[unit].backdrop |= reads_painter(n);
                if let Some(instance) = &n.instance {
                    if let Some(owner) = owners.get(&instance.component_id) {
                        units[unit].dependencies.insert(*owner);
                    }
                }
                stack.extend(n.render_children().iter().map(String::as_str));
            }
        }
        let roots = root
            .children
            .iter()
            .map(|id| (id.clone(), owners[id]))
            .collect();
        // Animation/global interaction references are not a partial scene
        // contract. Preserve complete acquisition until separately planned.
        let resolved_stage = &resolved.nodes[stage];
        let changed_stage =
            !neutral_stage(resolved_stage) || resolved_stage.children != root.children;
        let complete_only = changed_stage
            || !document.animations.is_empty()
            || document.prototype.is_some()
            || !document.reviews.is_empty()
            || root.children.iter().any(|id| resolved.nodes[id].mask);
        Ok(Arc::new(Self {
            descriptor: descriptor.clone(),
            owners,
            units,
            roots,
            stage: stage.into(),
            support,
            complete_only,
            stage_size: [resolved_stage.width, resolved_stage.height],
            page_support_known:crate::dirty_region::page_paint_support_known(resolved),
        }))
    }

    /// Complete revision-owned output support, reprojected without rebuilding
    /// paths/fonts on every camera. Rare unknown islands use the original
    /// device-space oracle; cold/missing nodes are never treated as empty.
    pub(crate) fn page_paint_rects(&self,document:&Document,fonts:&Fonts,camera:Transform)->Option<Vec<[f64;4]>> {
        if !self.page_support_known||self.roots.len()>4096{return None}
        let mut rects=Vec::with_capacity(self.roots.len());
        for (id,_) in &self.roots {
            crate::render_cancellation::checkpoint().ok()?;
            match self.support.paint_bounds(id,camera) {
                Some(Some(bounds))=>rects.push(bounds),Some(None)=>(),
                None=>rects.push(crate::dirty_region::root_paint_rect(document,id,fonts,camera)?),
            }
        }
        Some(rects)
    }

    pub fn viewport(
        self: &Arc<Self>,
        camera: Transform,
        viewport: Rect,
        cancel: &AtomicBool,
    ) -> Result<Demand, String> {
        check(cancel)?;
        let m = camera.0;
        if m.iter().any(|v| !v.is_finite())
            || m[1] != 0.
            || m[2] != 0.
            || m[0] != m[3]
            || !(0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&m[0])
            || viewport.w == 0
            || viewport.h == 0
            || [(viewport.x, viewport.w), (viewport.y, viewport.h)]
                .iter()
                .any(|(origin, size)| {
                    i32::try_from(*size)
                        .ok()
                        .and_then(|size| origin.checked_add(size))
                        .is_none()
                })
        {
            return Err("Invalid source demand viewport".into());
        }
        let visible = self
            .roots
            .iter()
            .filter(|(id, _)| self.complete_only || !self.support.culls(id, camera, viewport))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        self.plan(visible, cancel, true)
    }
    /// Explicit navigation/inspection acquires whole owning units, including
    /// hidden masters, parent layout/mode context and dependency subtrees.
    pub fn objects(
        self: &Arc<Self>,
        ids: &[String],
        cancel: &AtomicBool,
    ) -> Result<Demand, String> {
        self.plan(ids.to_vec(), cancel, true)
    }
    fn plan(
        self: &Arc<Self>,
        visible: Vec<String>,
        cancel: &AtomicBool,
        painter_prefix: bool,
    ) -> Result<Demand, String> {
        let mut units = BTreeSet::from([self.owners[&self.stage]]);
        let mut pending = visible
            .iter()
            .map(|id| {
                self.owners
                    .get(id)
                    .copied()
                    .ok_or_else(|| "Missing demanded source object".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if self.complete_only || visible.contains(&self.stage) {
            pending.extend(0..self.units.len());
        }
        let mut prefix_roots = 0;
        // Dependency expansion and painter-prefix expansion share one work
        // queue, so references that reveal another backdrop also close it.
        while let Some(unit) = pending.pop() {
            check(cancel)?;
            if !units.insert(unit) {
                continue;
            }
            pending.extend(self.units[unit].dependencies.iter().copied());
            if painter_prefix && self.units[unit].backdrop {
                if let Some(rank) = self.roots.iter().position(|(_, u)| *u == unit) {
                    if rank > prefix_roots {
                        pending.extend(self.roots[prefix_roots..rank].iter().map(|(_, u)| *u));
                        prefix_roots = rank;
                    }
                }
            }
        }
        Ok(Demand {
            catalog: self.clone(),
            units,
            visible,
            prefix_roots,
        })
    }
}
impl Catalog {
    pub(crate) fn compile_supported(&self) -> bool {
        !self.complete_only
    }
    pub(crate) fn viewport_for_compile(
        self: &Arc<Self>,
        camera: Transform,
        guard: Rect,
        cancel: &AtomicBool,
    ) -> Result<Demand, String> {
        // A compile candidate is not an authored acquisition grant. On this
        // legacy, non-export path all painter reads clamp to the actual scene
        // extent. The packet gate re-queries that complete extent before any
        // resource IDs are published. Every intersecting producer, regardless
        // of painter position, and every unknown-output root is included.
        let visible = self.viewport(camera, guard, cancel)?.visible;
        let mut demand = self.plan(visible, cancel, false)?;
        // Roots that are not contained in the neutral stage can still paint
        // into it. Unknown bounds stay in the closure. A root whose support
        // is a known miss of this guard cannot move the compiled extent, so
        // resolving it only repeats the same 10k-node context on every tile.
        // The post-plan query calls this again with the published extent and
        // picks up a root the moment that extent reaches it.
        let m = camera.0;
        let body = Rect::new(
            (m[4].ceil() + 4.) as i32,
            (m[5].ceil() + 4.) as i32,
            (self.stage_size[0] * m[0] - 8.).max(0.) as u32,
            (self.stage_size[1] * m[0] - 8.).max(0.) as u32,
        );
        for (id, unit) in &self.roots {
            if self.support.contained_in(id, camera, body) || self.support.culls(id, camera, guard) {
                continue;
            }
            demand.units.insert(*unit);
        }
        Ok(demand)
    }
}
impl Demand {
    pub(crate) fn unit_key(&self) -> Vec<usize> {
        self.units.iter().copied().collect()
    }
    pub(crate) fn resolved_nodes(
        &self,
        source: &Document,
    ) -> Result<BTreeMap<String, Node>, String> {
        let mut nodes = BTreeMap::new();
        for unit in &self.units {
            let root = &self.catalog.units[*unit].nodes[0];
            if root == &self.catalog.stage {
                continue;
            }
            let mut stack = vec![root.as_str()];
            while let Some(id) = stack.pop() {
                crate::render_cancellation::checkpoint()?;
                if nodes.contains_key(id) {
                    continue;
                }
                let n = source
                    .nodes
                    .get(id)
                    .ok_or("Missing resolved demand record")?;
                stack.extend(n.children.iter().map(String::as_str));
                nodes.insert(id.to_owned(), n.clone());
            }
        }
        let mut stage = source.nodes[&self.catalog.stage].clone();
        stage
            .children
            .retain(|id| self.units.contains(&self.catalog.owners[id]));
        nodes.insert(stage.id.clone(), stage);
        Ok(nodes)
    }
    pub fn stats(&self) -> DemandStats {
        DemandStats {
            total_nodes: self.catalog.owners.len(),
            required_nodes: self
                .units
                .iter()
                .map(|u| self.catalog.units[*u].nodes.len())
                .sum(),
            visible_roots: self.visible.len(),
            painter_prefix_roots: self.prefix_roots,
            dependency_units: self.units.len(),
        }
    }
    /// Atomic publication: cancellation, missing data and a changed generation
    /// return an error, never a successful partial set of requested records.
    pub fn load(
        self,
        path: &Path,
        descriptor: &Descriptor,
        cancel: &AtomicBool,
    ) -> Result<LoadedDemand, String> {
        check(cancel)?;
        if descriptor != &self.catalog.descriptor {
            return Err("Stale scene demand generation".into());
        }
        let mut reader = Reader::open(path, descriptor, cancel).map_err(|e| e.to_string())?;
        let mut nodes = BTreeMap::new();
        if self.stats().required_nodes == self.catalog.owners.len() {
            nodes = reader.read_all_nodes(cancel).map_err(|e| e.to_string())?;
        } else {
            for unit in &self.units {
                for id in &self.catalog.units[*unit].nodes {
                    check(cancel)?;
                    let node = reader
                        .read_node(id, cancel)
                        .map_err(|e| e.to_string())?
                        .ok_or("Missing demanded scene record")?;
                    nodes.insert(id.clone(), node);
                }
            }
        }
        check(cancel)?;
        Ok(LoadedDemand {
            demand: LoadedAuthority::Planned(self),
            nodes,
            reads: reader.stats(),
        })
    }
}

#[cfg(test)]
mod tests;
