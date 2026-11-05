//! Validated rkyv directory over the unchanged authenticated source payload.
//! Only index bytes are mapped. The mapping is anonymous, privately populated,
//! then made read-only: an external truncate/write cannot invalidate Rust refs.
use super::*;
use memmap2::{Mmap, MmapMut};
use rkyv::{Archive, Serialize as ArchiveSerialize};
pub(crate) const INDEX_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Archive, ArchiveSerialize)]
struct Entry {
    id: String,
    key_offset: u64,
    key_bytes: u64,
    value_offset: u64,
    value_bytes: u64,
    key_hash: [u8; 32],
    value_hash: [u8; 32],
}
#[derive(Archive, ArchiveSerialize)]
struct Unit {
    records: Vec<u64>,
    proof_known: bool,
    proof: [u64; 15],
    solid: bool,
    painter: bool,
}
#[derive(Archive, ArchiveSerialize)]
struct Index {
    version: u32,
    document_id: String,
    generation: String,
    header: Vec<u8>,
    entries: Vec<Entry>,
    units: Vec<Unit>,
    roots: Vec<u64>,
    stage: u64,
    stage_size: [u64; 2],
    eligible: bool,
}

// The checked reference borrows the same private, read-only mapping for its
// lifetime. Looking up an entry never repeats rkyv validation.
#[ouroboros::self_referencing]
struct CheckedIndex {
    mapping: Mmap,
    #[borrows(mapping)]
    archive: &'this ArchivedIndex,
}
pub(crate) struct Directory {
    checked: CheckedIndex,
    orphans: Vec<usize>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Selection {
    pub units: Vec<usize>,
    pub required_nodes: usize,
    pub cold_nodes: usize,
    pub cold_solid: bool,
    pub visible: Vec<usize>,
    pub prefix_roots: usize,
}
impl Directory {
    pub(super) fn open(
        file: &File,
        envelope: &super::archive_envelope::Envelope,
        cancel: &AtomicBool,
    ) -> io::Result<Option<Arc<Self>>> {
        if !envelope.compatible || envelope.bytes == 0 || envelope.bytes > INDEX_LIMIT as u64 {
            return Ok(None);
        }
        let length = usize::try_from(envelope.bytes)
            .map_err(|_| invalid("Archive directory cannot be addressed"))?;
        // Safe anonymous mmap, not an unsafe mapping of an externally mutable
        // file. Authenticate the exact private bytes before validating rkyv.
        let mut bytes = MmapMut::map_anon(length)?;
        let mut input = RangeReader {
            file,
            position: envelope.offset,
            end: sum(envelope.offset, envelope.bytes)?,
        };
        let mut hash = Sha256::new();
        for chunk in bytes.chunks_mut(64 * 1024) {
            check(cancel)?;
            input.read_exact(chunk)?;
            hash.update(&*chunk);
        }
        if <[u8; 32]>::from(hash.finalize()) != envelope.hash {
            return Err(invalid("Archive directory hash changed"));
        }
        let checked = CheckedIndex::try_new(bytes.make_read_only()?, |mapping| {
            rkyv::access::<ArchivedIndex, rkyv::rancor::Error>(mapping).map_err(io::Error::other)
        })?;
        let index = checked.borrow_archive();
        if index.version.to_native() != 2
            || index.document_id.as_str() != envelope.base.document_id
            || index.generation.as_str() != envelope.base.generation
            || index.entries.len() as u64 != envelope.base.nodes
            || index.stage.to_native() >= envelope.base.nodes
        {
            return Err(invalid("Archive directory identity changed"));
        }
        if index.header.len() > 1024 * 1024 {
            return Err(invalid("Archive render header exceeds index allowance"));
        }
        let header: Document =
            serde_json::from_slice(index.header.as_slice()).map_err(io::Error::other)?;
        if header.id != envelope.base.document_id
            || !header.nodes.is_empty()
            || header.pages.len() != 1
            || header.pages[0].children
                != [index.entries[index.stage.to_native() as usize].id.as_str()]
        {
            return Err(invalid("Invalid archive render header"));
        }
        let mut previous: Option<&str> = None;
        for entry in index.entries.iter() {
            check(cancel)?;
            let id = entry.id.as_str();
            if previous.is_some_and(|old| old >= id)
                || sha(id.as_bytes()) != entry.key_hash
                || entry.key_bytes.to_native() != id.len() as u64
                || entry.value_bytes.to_native() == 0
                || sum(entry.key_offset.to_native(), entry.key_bytes.to_native())?
                    != entry.value_offset.to_native()
                || sum(
                    entry.value_offset.to_native(),
                    entry.value_bytes.to_native(),
                )? > envelope.base.bytes - FOOTER_BYTES
            {
                return Err(invalid("Invalid archive record locator"));
            }
            previous = Some(id);
        }
        let mut seen = vec![false; index.entries.len()];
        seen[index.stage.to_native() as usize] = true;
        for unit in index.units.iter() {
            for record in unit.records.iter() {
                check(cancel)?;
                let record = usize::try_from(record.to_native())
                    .map_err(|_| invalid("Archive ordinal overflow"))?;
                if record >= seen.len() || std::mem::replace(&mut seen[record], true) {
                    return Err(invalid("Overlapping archive units"));
                }
            }
        }
        if seen.iter().any(|present| !*present) {
            return Err(invalid("Incomplete archive directory"));
        }
        let mut roots = HashSet::new();
        for root in index.roots.iter() {
            let raw = root.to_native();
            if raw >= index.units.len() as u64 {
                return Err(invalid("Invalid archive root ordinal"));
            }
            let root = raw as usize;
            if root >= index.units.len()
                || index.units[root].records.is_empty()
                || !roots.insert(root)
            {
                return Err(invalid("Invalid archive root unit"));
            }
        }
        let orphans = (0..index.units.len())
            .filter(|id| !roots.contains(id))
            .collect();
        check(cancel)?;
        Ok(Some(Arc::new(Self { checked, orphans })))
    }
    fn index(&self) -> &ArchivedIndex {
        self.checked.borrow_archive()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.mapped_bytes()
            .saturating_add(
                self.orphans
                    .capacity()
                    .saturating_mul(std::mem::size_of::<usize>()),
            )
            .saturating_add(128)
    }
    pub(crate) fn mapped_bytes(&self) -> usize {
        self.checked.borrow_mapping().len()
    }
    pub(crate) fn eligible(&self) -> bool {
        self.index().eligible
    }
    pub(crate) fn can_reduce(&self) -> bool {
        self.index().eligible
            && self
                .index()
                .roots
                .iter()
                .any(|id| self.index().units[id.to_native() as usize].proof_known)
    }
    pub(crate) fn header(&self) -> io::Result<Document> {
        serde_json::from_slice(self.index().header.as_slice()).map_err(io::Error::other)
    }
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.ordinal(id).is_some()
    }
    fn ordinal(&self, id: &str) -> Option<usize> {
        self.index()
            .entries
            .as_slice()
            .binary_search_by(|entry| entry.id.as_str().cmp(id))
            .ok()
    }
    pub(super) fn row(&self, id: &str) -> Option<Row> {
        self.ordinal(id).map(|at| self.row_at(at))
    }
    fn row_at(&self, at: usize) -> Row {
        let entry = &self.index().entries[at];
        Row {
            key_offset: entry.key_offset.to_native(),
            key_bytes: entry.key_bytes.to_native(),
            value_offset: entry.value_offset.to_native(),
            value_bytes: entry.value_bytes.to_native(),
            key_hash: entry.key_hash,
            value_hash: entry.value_hash,
        }
    }
    pub(crate) fn stage(&self) -> &str {
        self.index().entries[self.index().stage.to_native() as usize]
            .id
            .as_str()
    }
    pub(crate) fn children(&self) -> Vec<String> {
        let index = self.index();
        index
            .roots
            .iter()
            .map(|root| {
                index.entries
                    [index.units[root.to_native() as usize].records[0].to_native() as usize]
                    .id
                    .as_str()
                    .to_owned()
            })
            .collect()
    }
    pub(crate) fn total_nodes(&self) -> usize {
        self.index().entries.len()
    }
    pub(crate) fn record_ids(&self, selection: &Selection) -> Vec<String> {
        let index = self.index();
        let mut ids = Vec::with_capacity(selection.required_nodes);
        ids.push(self.stage().into());
        for unit in &selection.units {
            ids.extend(index.units[*unit].records.iter().map(|id| {
                index.entries[id.to_native() as usize]
                    .id
                    .as_str()
                    .to_owned()
            }));
        }
        ids
    }
    pub(crate) fn selected_roots(&self, selection: &Selection) -> Vec<String> {
        let index = self.index();
        index
            .roots
            .iter()
            .filter(|id| {
                selection
                    .units
                    .binary_search(&(id.to_native() as usize))
                    .is_ok()
            })
            .map(|id| {
                index.entries[index.units[id.to_native() as usize].records[0].to_native() as usize]
                    .id
                    .as_str()
                    .to_owned()
            })
            .collect()
    }
    pub(crate) fn visible_roots(&self, selection: &Selection) -> Vec<String> {
        let index = self.index();
        selection
            .visible
            .iter()
            .map(|id| {
                index.entries[index.units[*id].records[0].to_native() as usize]
                    .id
                    .as_str()
                    .to_owned()
            })
            .collect()
    }
    pub(crate) fn select_authored(
        &self,
        camera: crate::math::Transform,
        viewport: crate::math::Rect,
        cancel: &AtomicBool,
    ) -> io::Result<Option<Selection>> {
        let Some(mut selection) = self.select(camera, viewport, cancel)? else {
            return Ok(None);
        };
        let index = self.index();
        let mut prefix = None;
        for (rank, id) in index.roots.iter().enumerate() {
            let id = id.to_native() as usize;
            if index.units[id].painter && selection.units.binary_search(&id).is_ok() {
                prefix = Some(rank);
            }
        }
        if let Some(rank) = prefix {
            selection.prefix_roots = rank;
            selection.units.extend(
                index
                    .roots
                    .iter()
                    .take(rank + 1)
                    .map(|id| id.to_native() as usize),
            );
            selection.units.sort_unstable();
            selection.units.dedup();
            selection.required_nodes = 1 + self
                .orphans
                .iter()
                .map(|id| index.units[*id].records.len())
                .sum::<usize>();
            selection.cold_nodes = 0;
            selection.cold_solid = true;
            for id in index.roots.iter() {
                check(cancel)?;
                let id = id.to_native() as usize;
                let unit = &index.units[id];
                if selection.units.binary_search(&id).is_ok() {
                    selection.required_nodes += unit.records.len();
                } else {
                    selection.cold_nodes += unit.records.len();
                    selection.cold_solid &= unit.solid;
                }
            }
        }
        Ok(Some(selection))
    }
    pub(crate) fn select(
        &self,
        camera: crate::math::Transform,
        viewport: crate::math::Rect,
        cancel: &AtomicBool,
    ) -> io::Result<Option<Selection>> {
        let index = self.index();
        if !index.eligible {
            return Ok(None);
        }
        if viewport.empty()
            || [(viewport.x, viewport.w), (viewport.y, viewport.h)]
                .iter()
                .any(|(at, size)| {
                    i32::try_from(*size)
                        .ok()
                        .and_then(|size| at.checked_add(size))
                        .is_none()
                })
        {
            return Err(invalid("Invalid archive viewport"));
        }
        let m = camera.0;
        if m.iter().any(|v| !v.is_finite())
            || m[1] != 0.
            || m[2] != 0.
            || m[0] != m[3]
            || !(0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&m[0])
        {
            return Err(invalid("Invalid archive camera"));
        }
        let stage = [
            f64::from_bits(index.stage_size[0].to_native()),
            f64::from_bits(index.stage_size[1].to_native()),
        ];
        let body = crate::math::Rect::new(
            (m[4].ceil() + 4.) as i32,
            (m[5].ceil() + 4.) as i32,
            (stage[0] * m[0] - 8.).max(0.) as u32,
            (stage[1] * m[0] - 8.).max(0.) as u32,
        );
        let body = [
            body.x as f64,
            body.y as f64,
            body.x as f64 + body.w as f64,
            body.y as f64 + body.h as f64,
        ];
        let view = [
            viewport.x as f64,
            viewport.y as f64,
            viewport.right() as f64,
            viewport.bottom() as f64,
        ];
        // Disconnected records still participate in global validation/layout
        // and generated-ID collision checks. They remain semantic dependencies.
        let mut units = self.orphans.clone();
        let mut required = 1 + self
            .orphans
            .iter()
            .map(|id| index.units[*id].records.len())
            .sum::<usize>();
        let mut cold = 0usize;
        let mut solid = true;
        let mut visible = Vec::new();
        for unit_id in index.roots.iter() {
            check(cancel)?;
            let unit_id = unit_id.to_native() as usize;
            let unit = &index.units[unit_id];
            let bounds = unit
                .proof_known
                .then(|| {
                    crate::world_support::source_root_bounds(
                        std::array::from_fn(|i| unit.proof[i].to_native()),
                        camera,
                    )
                })
                .flatten();
            let intersects = match bounds {
                Some(None) => false,
                Some(Some(b)) => {
                    b[2] >= view[0] && b[0] <= view[2] && b[3] >= view[1] && b[1] <= view[3]
                }
                None => true,
            };
            if intersects {
                visible.push(unit_id);
            }
            let omit = match bounds {
                Some(None) => true,
                Some(Some(b)) => {
                    !intersects
                        && b[0] >= body[0]
                        && b[1] >= body[1]
                        && b[2] <= body[2]
                        && b[3] <= body[3]
                }
                None => false,
            };
            if omit {
                cold = cold.saturating_add(unit.records.len());
                solid &= unit.solid;
            } else {
                required = required
                    .checked_add(unit.records.len())
                    .ok_or_else(|| invalid("Archive demand overflow"))?;
                units.push(unit_id);
            }
        }
        units.sort_unstable();
        Ok(Some(Selection {
            units,
            required_nodes: required,
            cold_nodes: cold,
            cold_solid: solid,
            visible,
            prefix_roots: 0,
        }))
    }
}
fn independent(n: &Node) -> bool {
    n.component.is_none()
        && !n.component_set
        && n.component_key.is_none()
        && n.instance.is_none()
        && n.instance_origin.is_none()
        && n.repeat.is_none()
        && n.connector.is_none()
        && n.text_path.is_none()
        && n.vector_brush.is_none()
        && n.boolean_operation.is_none()
        && n.board.is_none()
}
fn cold(n: &Node) -> bool {
    independent(n)
        && n.effects.is_empty()
        && !n.mask
        && matches!(n.blend.as_str(), "normal" | "pass-through")
        && n.bindings.is_empty()
        && n.style_refs.is_empty()
        && n.variable_modes.is_empty()
        && n.text_runs.is_empty()
        && n.kind != "text"
        && n.layout.is_none()
        && n.sizing.is_none()
        && n.constraints.is_none()
        && n.derived_path.is_none()
        && (0.01..=1e7).contains(&n.width)
        && (0.01..=1e7).contains(&n.height)
}
fn neutral(n: &Node) -> bool {
    n.kind == "frame"
        && n.transform == crate::math::Transform::default()
        && n.visible
        && !n.clip
        && !n.mask
        && n.opacity == 1.
        && n.blend == "pass-through"
        && n.fills.is_empty()
        && n.strokes.is_empty()
        && n.effects.is_empty()
        && n.layout.is_none()
        && n.sizing.is_none()
        && n.constraints.is_none()
        && n.network.is_none()
        && n.vector_geometry.is_none()
        && n.derived_path.is_none()
        && n.path_offset == 0.
        && n.bindings.is_empty()
        && n.style_refs.is_empty()
        && n.variable_modes.is_empty()
        && independent(n)
}

pub(super) fn append(
    path: &Path,
    base: Descriptor,
    source: SourceToWrite<'_>,
    cancel: &AtomicBool,
) -> io::Result<Descriptor> {
    check(cancel)?;
    let document = source.checked_document()?;
    // This optional directory has its own bound; declining it never rejects a
    // large source or removes the existing complete loader.
    let root_count = document
        .pages
        .first()
        .and_then(|p| p.children.first())
        .and_then(|id| document.nodes.get(id))
        .map_or(0, |n| n.children.len());
    let estimate = document
        .nodes
        .keys()
        .try_fold(root_count.saturating_mul(128), |n, id| {
            n.checked_add(id.len().saturating_add(152))
        })
        .unwrap_or(usize::MAX);
    if estimate > INDEX_LIMIT {
        return Ok(base);
    }
    let Some(page) = document.pages.first().filter(|_| document.pages.len() == 1) else {
        return Ok(base);
    };
    let Some(stage_id) = page.children.first().filter(|_| page.children.len() == 1) else {
        return Ok(base);
    };
    let Some(stage) = document.nodes.get(stage_id).filter(|n| neutral(n)) else {
        return Ok(base);
    };
    let ordinals: BTreeMap<&str, u64> = document
        .nodes
        .keys()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as u64))
        .collect();
    let parents: HashSet<&str> = document
        .nodes
        .values()
        .flat_map(|n| n.children.iter().map(String::as_str))
        .collect();
    let mut units = Vec::new();
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    let main_roots: HashSet<&str> = stage.children.iter().map(String::as_str).collect();
    let root_ids = stage.children.iter().map(String::as_str).chain(
        document
            .nodes
            .keys()
            .map(String::as_str)
            .filter(|id| *id != stage_id && !parents.contains(id)),
    );
    for id in root_ids {
        check(cancel)?;
        let mut records = Vec::new();
        let mut stack = vec![id];
        let mut pure = true;
        let mut solid = true;
        let mut painter = false;
        while let Some(id) = stack.pop() {
            check(cancel)?;
            if !seen.insert(id) {
                return Err(invalid("Overlapping source units"));
            }
            let n = &document.nodes[id];
            records.push(ordinals[id]);
            stack.extend(n.children.iter().rev().map(String::as_str));
            pure &= cold(n);
            painter |= n.mask
                || !matches!(n.blend.as_str(), "normal" | "pass-through")
                || n.effects.iter().any(|e| e.visible);
            solid &= n.fills.iter().all(|p| !p.visible || p.kind == "solid")
                && n.strokes
                    .iter()
                    .all(|s| !s.visible || s.width <= 0. || s.paint.kind == "solid");
        }
        let is_root = main_roots.contains(id);
        if is_root {
            roots.push(units.len() as u64);
        }
        // Reuse the kernel's complete geometric support, not merely the
        // visible clip rectangle: clipped-off geometry can still determine
        // the legacy compiler's global capture/extent domain.
        let proof = if is_root && pure {
            crate::world_support::WorldSupport::build_source_roots(
                document,
                stage_id,
                &[id.to_owned()],
                INDEX_LIMIT,
                cancel,
            )
            .map_err(invalid_owned)?
            .and_then(|support| support.root_words(id))
        } else {
            None
        };
        units.push(Unit {
            records,
            proof_known: proof.is_some(),
            proof: proof.unwrap_or([0; 15]),
            solid,
            painter,
        });
    }
    if seen.len() + 1 != document.nodes.len() {
        return Err(invalid("Unreachable source units"));
    }
    let legacy = Reader::open(path, &base, cancel)?;
    let mut entries = Vec::with_capacity(document.nodes.len());
    let mut rows = BufReader::new(RangeReader {
        file: &legacy.file,
        position: legacy.index_offset,
        end: legacy.tree_offset,
    });
    let mut fold = MerkleFold::new();
    for id in document.nodes.keys() {
        check(cancel)?;
        let mut bytes = [0u8; 96];
        rows.read_exact(&mut bytes)?;
        fold.push(sha(&bytes));
        let row = Row::decode(bytes);
        if row.key_hash != sha(id.as_bytes()) {
            return Err(invalid("Source index key changed"));
        }
        entries.push(Entry {
            id: id.clone(),
            key_offset: row.key_offset,
            key_bytes: row.key_bytes,
            value_offset: row.value_offset,
            value_bytes: row.value_bytes,
            key_hash: row.key_hash,
            value_hash: row.value_hash,
        });
    }
    for _ in legacy.nodes..legacy.leaf_base {
        fold.push([0; 32]);
    }
    if fold.root() != Some(legacy.index_root) {
        return Err(invalid("Source index changed during migration"));
    }
    drop(rows);
    // This small render header is not a complete/editable Document. Full
    // metadata (including fonts/provenance) remains authenticated in the prefix.
    let header = Document {
        fd_compatibility: None,
        reviews: vec![],
        design_system: None,
        prototype: None,
        schema_version: document.schema_version,
        color_management: document.color_management,
        raster_profile: document.raster_profile,
        id: document.id.clone(),
        name: document.name.clone(),
        pages: document.pages.clone(),
        nodes: Default::default(),
        fonts: BTreeMap::new(),
        animations: vec![],
    };
    let eligible = document.animations.is_empty()
        && document.prototype.is_none()
        && document.reviews.is_empty()
        && document.nodes.values().all(independent)
        && (0.01..=1e7).contains(&stage.width)
        && (0.01..=1e7).contains(&stage.height)
        && stage.children.iter().all(|id| !document.nodes[id].mask);
    let index = Index {
        version: 2,
        document_id: document.id.clone(),
        generation: base.generation.clone(),
        header: serde_json::to_vec(&header).map_err(io::Error::other)?,
        entries,
        units,
        roots,
        stage: ordinals[stage_id.as_str()],
        stage_size: [stage.width.to_bits(), stage.height.to_bits()],
        eligible,
    };
    let bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&index).map_err(io::Error::other)?;
    if bytes.len() > INDEX_LIMIT {
        return Ok(base);
    }
    let hash = sha(&bytes);
    let footer = super::archive_envelope::footer(&base, base.bytes, bytes.len() as u64, hash);
    let mut file = OpenOptions::new().append(true).open(path)?;
    for chunk in bytes.chunks(64 * 1024) {
        check(cancel)?;
        file.write_all(chunk)?;
    }
    check(cancel)?;
    file.write_all(&footer)?;
    file.sync_all()?;
    Ok(Descriptor {
        bytes: sum(
            sum(base.bytes, bytes.len() as u64)?,
            super::archive_envelope::FOOTER,
        )?,
        footer_hash: sha(&footer),
        ..base
    })
}
