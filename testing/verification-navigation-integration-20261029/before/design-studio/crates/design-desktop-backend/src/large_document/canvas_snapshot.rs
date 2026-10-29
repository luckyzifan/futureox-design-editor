//! A native, full-source indexed canvas. Node records stay on disk and must never be
//! returned as a giant renderer string or mistaken for an editable workset.
use super::*;
use futureox_design_kernel::{fidelity::RasterProfile, scene::Document};

pub(super) struct Snapshot {
    pub revision: u64, pub path: PathBuf, pub store: futureox_design_kernel::scene_store::Descriptor,
    pub page_id: String, pub stage_id: String, pub nodes: usize, pub roots: usize,
    pub bounds: canvas_layout::Box2, pub warnings: Vec<String>,
    pub raster_profile: RasterProfile,
    pub color_managed: bool,
}

fn stage_id(s: &Session, document: &Document) -> String {
    for nonce in 0u64.. {
        let hash = digest(format!("source-canvas:{}:{nonce}", s.owner.document_id).as_bytes());
        let id = format!("{}-{}-5{}-a{}-{}", &hash[..8], &hash[8..12], &hash[13..16], &hash[17..20], &hash[20..32]);
        if !document.nodes.contains_key(&id) && document.pages.iter().all(|page|page.id!=id) { return id; }
    }
    unreachable!("all UUID-sized source identities exhausted")
}

pub(super) fn build(s: &Session, layout: &canvas_layout::Layout, cancel: &AtomicBool) -> Result<(Document, String, Vec<String>)> {
    if layout.revision != s.revision { return Err(issue("Source canvas layout is stale")); }
    let context = projection::SketchContext::new(s)?;
    let mut full: Option<Document> = None;
    let mut warnings = std::collections::BTreeSet::new();
    for item in &layout.items {
        check_cancel(cancel).map_err(issue)?;
        let (p,n) = location(s, Some(&item.key))?;
        let (doc, notes) = window_cache::convert(s,p,n,cancel,&context)?;
        warnings.extend(notes);
        if let Some(full) = &mut full { scene::merge_window(full,doc)?; } else { full=Some(doc); }
    }
    let mut document = full.ok_or_else(||issue("The source has no drawable canvas objects"))?;
    // Merge dependency masters at their original transforms first. Only then
    // translate displayed roots, so a visible master and its references retain
    // one source identity rather than conflicting duplicate geometry.
    let roots: Vec<_> = layout.items.iter().map(|item|item.id.clone()).collect();
    let visible: HashSet<_> = roots.iter().cloned().collect();
    if document.pages[0].children.iter().cloned().collect::<HashSet<_>>() != visible || document.pages[0].children.len()!=roots.len() {
        return Err(issue("Converted source canvas roots do not match the complete catalogue"));
    }
    for item in &layout.items {
        let node = document.nodes.get_mut(&item.id).ok_or_else(||issue("Source canvas object disappeared during conversion"))?;
        node.transform.0[4] += item.placed.x-item.source.x;
        node.transform.0[5] += item.placed.y-item.source.y;
        if !node.transform.0.iter().all(|v|v.is_finite()) { return Err(issue("Source canvas transform is not representable")); }
    }
    let id = stage_id(s,&document);
    let mut stage = futureox_design_kernel::facet::sample_node(&id,"frame");
    stage.name = s.name.clone(); stage.transform = futureox_design_kernel::math::Transform::default();
    stage.width = layout.bounds.width; stage.height = layout.bounds.height;
    stage.fills.clear(); stage.strokes.clear(); stage.effects.clear(); stage.clip = false;
    stage.blend="pass-through".into();
    stage.children = roots;
    document.nodes.insert(id.clone(),stage);
    document.id=s.owner.document_id.clone(); document.name=s.name.clone();
    document.pages[0].name=s.name.clone(); document.pages[0].children=vec![id.clone()];
    for page in document.pages.iter_mut().skip(1) {page.children.retain(|id|!visible.contains(id));}
    document.raster_profile = Some(if document.color_management.is_some(){RasterProfile::Figma}else{RasterProfile::Analytic});
    document.validate_native_source().map_err(issue)?;
    Ok((document,id,warnings.into_iter().collect()))
}

pub(super) fn prepare(s: &mut Session, cancel: &AtomicBool) -> Result<Value> {
    if s.canvas_snapshot.as_ref().is_none_or(|snapshot|snapshot.revision!=s.revision) {
        let layout=canvas_layout::build(s,cancel)?;
        let (document,stage_id,warnings)=build(s,&layout,cancel)?;
        let path=s.directory.join(format!("canvas-native-{}.scene",s.revision));
        let next=s.directory.join("canvas-native.next");
        let result=(||{
            let generation=format!("{}:{}:{}",s.owner.document_id,s.owner.session_epoch,s.revision);
            let store=futureox_design_kernel::scene_store::write(&next,&generation,&document,&warnings,cancel).map_err(issue)?;
            check_cancel(cancel).map_err(issue)?;
            fs::rename(&next,&path).map_err(issue)?;
            Ok(Snapshot{revision:s.revision,path,store,page_id:document.pages[0].id.clone(),stage_id,
                nodes:document.nodes.len(),roots:layout.items.len(),bounds:layout.bounds,warnings,raster_profile:document.raster_profile.unwrap_or(RasterProfile::Analytic),color_managed:document.color_management.is_some()})
        })();
        if result.is_err(){let _=fs::remove_file(&next);}
        let snapshot=result?;
        if let Some(previous)=s.canvas_snapshot.replace(snapshot) {let _=fs::remove_file(previous.path);}
        s.canvas_layout=Some(layout);
    }
    let snapshot=s.canvas_snapshot.as_ref().unwrap();
    // This path is host-only. The preload must expose an owner-bound opaque
    // capability, never forward this native filesystem descriptor to UI code.
    Ok(json!({"owner":s.owner,"revision":s.revision,"path":snapshot.path,"bytes":snapshot.store.bytes,"store":snapshot.store,
        "pageId":snapshot.page_id,"stageId":snapshot.stage_id,"nodes":snapshot.nodes,"roots":snapshot.roots,
        "bounds":snapshot.bounds,"warnings":snapshot.warnings,"rasterProfile":snapshot.raster_profile,"colorManaged":snapshot.color_managed}))
}
