//! A native, full-source indexed canvas. Node records stay on disk and must never be
//! returned as a giant renderer string or mistaken for an editable workset.
use super::*;
use futureox_design_kernel::{fidelity::RasterProfile, scene::Document, scene_store::ValidatedSource};

pub(super) struct Snapshot {
    pub scope: Option<String>,
    pub revision: u64, pub path: PathBuf, pub store: futureox_design_kernel::scene_store::Descriptor,
    pub page_id: String, pub stage_id: String, pub nodes: usize, pub roots: usize,
    pub bounds: canvas_layout::Box2, pub warnings: Vec<String>,
    pub raster_profile: RasterProfile,
    pub color_managed: bool,
    pub navigation: Option<navigation_image::NavigationImage>,
}

/// Only immutable stores for previously requested material scopes are kept.
/// The active host capability and the renderer's GPU ownership are separate.
#[derive(Default)]
pub(super) struct RecentMaterials(std::collections::VecDeque<(Snapshot,std::time::SystemTime)>);
impl RecentMaterials {
    const BYTES:u64=64*1024*1024;
    pub(super) fn clear(&mut self) {
        for (item,_) in self.0.drain(..) { let _=fs::remove_file(item.path); }
    }
    fn park(&mut self, mut item:Snapshot, revision:u64) {
        if item.navigation.as_ref().is_some_and(|image|image.pending()){item.navigation=None;}
        let stamp=fs::symlink_metadata(&item.path).ok().filter(|m|m.is_file() && m.len()==item.store.bytes)
            .and_then(|m|m.modified().ok());
        if let Some(stamp)=stamp && item.scope.is_some() && item.revision==revision && item.store.bytes<=Self::BYTES {
            while self.0.len()>=8 || self.0.iter().map(|(s,_)|s.store.bytes).sum::<u64>()+item.store.bytes>Self::BYTES {
                if let Some((old,_))=self.0.pop_front(){let _=fs::remove_file(old.path);}
            }
            self.0.push_back((item,stamp));
        } else { let _=fs::remove_file(item.path); }
    }
    fn take(&mut self, scope:&str, revision:u64, cancel:&AtomicBool)->Result<Option<Snapshot>> {
        let Some(at)=self.0.iter().position(|(s,_)| s.scope.as_deref()==Some(scope) && s.revision==revision) else {return Ok(None)};
        let (s,stamp)=&self.0[at];
        let valid=fs::symlink_metadata(&s.path).is_ok_and(|m|m.is_file() && m.len()==s.store.bytes && m.modified().ok()==Some(*stamp)) &&
            futureox_design_kernel::scene_store::Reader::open(&s.path,&s.store,cancel).is_ok();
        check_cancel(cancel).map_err(issue)?;
        let (s,_)=self.0.remove(at).expect("retained material index");
        if valid {Ok(Some(s))} else {let _=fs::remove_file(s.path);Ok(None)}
    }
}
impl Drop for RecentMaterials { fn drop(&mut self){self.clear();} }

fn stage_id(document_id: &str, document: &Document) -> String {
    for nonce in 0u64.. {
        let hash = digest(format!("source-canvas:{document_id}:{nonce}").as_bytes());
        let id = format!("{}-{}-5{}-a{}-{}", &hash[..8], &hash[8..12], &hash[13..16], &hash[17..20], &hash[20..32]);
        if !document.nodes.contains_key(&id) && document.pages.iter().all(|page|page.id!=id) { return id; }
    }
    unreachable!("all UUID-sized source identities exhausted")
}

fn append_batch(s:&Session,batch:&[(usize,usize)],cancel:&AtomicBool,context:&projection::SketchContext,
    full:&mut Option<Document>,warnings:&mut std::collections::BTreeSet<String>,render_only:bool)->Result<()> {
    check_cancel(cancel).map_err(issue)?;
    match projection::sketch_batch_in(s,batch,64*1024*1024,cancel,context) {
        Ok((mut doc,notes))=>{
            // Export provenance stays in the immutable source and editable
            // windows. The full-source display store never exports or edits
            // this copy, and no renderer consumes sketch_containers. Avoid
            // merging/serializing/decoding hundreds of MB of opaque receipts.
            if render_only {if let Some(system)=&mut doc.design_system {system.sketch_containers.clear();}}
            warnings.extend(notes);if let Some(full)=full {scene::merge_window(full,doc)?;}else{*full=Some(doc);}Ok(())}
        // A batch cannot relax existing image/dependency/window admission.
        // Split conservatively; a failing original singleton still fails.
        Err(_) if batch.len()>1=>{
            check_cancel(cancel).map_err(issue)?;
            let mid=batch.len()/2;
            append_batch(s,&batch[..mid],cancel,context,full,warnings,render_only)?;
            append_batch(s,&batch[mid..],cancel,context,full,warnings,render_only)
        }
        Err(error)=>Err(error),
    }
}

#[cfg(test)]
pub(super) fn build(s: &Session, layout: &canvas_layout::Layout, cancel: &AtomicBool) -> Result<(Document, String, Vec<String>)> {
    build_inner(s,layout,cancel,false).map(|(doc, id, notes)| (doc.into_document(), id, notes))
}
/// Run `map` on at most `slots` workers and hand each result to `accept` in
/// input order. A finished later item refills a free slot while an older item
/// is still running; `accept` still waits for that older item. `admit` can
/// stop the refill. A worker panic becomes `panic` instead of an unlocked join.
fn for_each_ordered<T, R, E, F, A, G, P>(items: Vec<T>, slots: usize, map: F, mut accept: A, mut admit: G, panic: P) -> std::result::Result<(), E>
where
    T: Send, R: Send, E: Send,
    F: Fn(T) -> std::result::Result<R, E> + Sync,
    A: FnMut(R) -> std::result::Result<(), E>,
    G: FnMut() -> std::result::Result<(), E>,
    P: Fn() -> E,
{
    if items.is_empty() { return Ok(()); }
    let slots = slots.max(1);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let map = &map;
    std::thread::scope(|scope| -> std::result::Result<(), E> {
        let mut rest = items.into_iter();
        let mut inflight: std::collections::VecDeque<std::thread::ScopedJoinHandle<std::result::Result<R, E>>> = std::collections::VecDeque::new();
        loop {
            while inflight.iter().filter(|job| !job.is_finished()).count() < slots {
                let Some(item) = rest.next() else { break };
                admit()?;
                let tx = tx.clone();
                inflight.push_back(scope.spawn(move || {
                    struct Notify(std::sync::mpsc::Sender<()>);
                    impl Drop for Notify { fn drop(&mut self) { let _ = self.0.send(()); } }
                    let _notify = Notify(tx);
                    map(item)
                }));
            }
            let Some(front) = inflight.front() else { break };
            if !front.is_finished() {
                admit()?;
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
                }
                if !inflight.front().is_some_and(|job| job.is_finished()) { continue; }
            }
            let finished = inflight.pop_front().expect("ordered conversion front");
            admit()?;
            match finished.join() {
                Ok(Ok(value)) => accept(value)?,
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(panic()),
            }
        }
        Ok(())
    })
}

fn build_inner(s: &Session, layout: &canvas_layout::Layout, cancel: &AtomicBool, render_only:bool) -> Result<(ValidatedSource, String, Vec<String>)> {
    if layout.revision != s.revision { return Err(issue("Source canvas layout is stale")); }
    let context = projection::SketchContext::new(s)?;
    let mut full: Option<Document> = None;
    let mut warnings = std::collections::BTreeSet::new();
    let mut batches=Vec::new();let mut batch=Vec::new();let mut batch_bytes=0u64;
    for item in &layout.items {
        check_cancel(cancel).map_err(issue)?;
        let (p,n)=location(s,Some(&item.key))?;
        let bytes=s.parts[p].index.entries[n].span.len();
        if !batch.is_empty() && batch_bytes.saturating_add(bytes)>8*1024*1024 {
            batches.push(std::mem::take(&mut batch));batch_bytes=0;
        }
        batch.push((p,n));batch_bytes=batch_bytes.saturating_add(bytes);
    }
    if !batch.is_empty(){batches.push(batch);}
    let mut geometry_pool=futureox_design_kernel::vector_geometry::GeometryPool::default();
    // At most two independent CPU conversions. Results merge in source order,
    // but a slow oldest batch must not leave the other slot idle: any finished
    // batch refills that slot before the oldest one is joined.
    let convert=|batch:&[(usize,usize)]| {
        if batch.len()==1 {
            // Singleton batches share the material-viewer cache. A full-source
            // snapshot that revisits one already converted root does not parse
            // that archive window again. Multi-root batches keep shared symbol
            // admission and are not reconstructed from singleton caches.
            let (p,n)=batch[0];
            let (mut document,warnings)=window_cache::convert(s,p,n,cancel,&context)?;
            if render_only {if let Some(system)=&mut document.design_system{system.sketch_containers.clear();}}
            return Ok((document,warnings.into_iter().collect()));
        }
        let mut document=None;let mut notes=std::collections::BTreeSet::new();
        s.snapshot_account.source_batches.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        append_batch(s,batch,cancel,&context,&mut document,&mut notes,render_only)?;
        Ok::<_,BackendError>((document.ok_or_else(||issue("Empty source batch"))?,notes))
    };
    for_each_ordered(batches, 2, |batch| convert(&batch), |result| {
        let (mut document, notes) = result;
        warnings.extend(notes);
        for node in document.nodes.values_mut(){if let Some(geometry)=&mut node.vector_geometry{geometry_pool.intern(geometry);}}
        if let Some(full)=&mut full {scene::merge_window(full,document)?;} else {full=Some(document);}
        Ok(())
    }, || check_cancel(cancel).map_err(issue), || issue("Source conversion worker failed"))?;
    let document = full.ok_or_else(||issue("The source has no drawable canvas objects"))?;
    let (document,id)=place_materials(document,&s.owner.document_id,&s.name,layout)?;
    Ok((document,id,warnings.into_iter().collect()))
}

pub(super) fn place_materials(mut document:Document, document_id:&str, name:&str, layout:&canvas_layout::Layout)
    -> Result<(ValidatedSource,String)> {
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
    let id = stage_id(document_id,&document);
    let mut stage = futureox_design_kernel::facet::sample_node(&id,"frame");
    stage.name = name.to_owned(); stage.transform = futureox_design_kernel::math::Transform::default();
    stage.width = layout.bounds.width; stage.height = layout.bounds.height;
    stage.fills.clear(); stage.strokes.clear(); stage.effects.clear(); stage.clip = false;
    stage.blend="pass-through".into();
    stage.children = roots;
    document.nodes.insert(id.clone(),stage);
    document.id=document_id.to_owned(); document.name=name.to_owned();
    document.pages[0].name=name.to_owned(); document.pages[0].children=vec![id.clone()];
    for page in document.pages.iter_mut().skip(1) {page.children.retain(|id|!visible.contains(id));}
    document.raster_profile = Some(if document.color_management.is_some(){RasterProfile::Figma}else{RasterProfile::Analytic});
    Ok((ValidatedSource::new(document).map_err(issue)?, id))
}

#[cfg(test)]
pub(super) fn build_individual(s: &Session, layout: &canvas_layout::Layout, cancel: &AtomicBool) -> Result<(Document, String, Vec<String>)> {
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
    let id = stage_id(&s.owner.document_id,&document);
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

#[derive(Debug, Default)]
pub(super) struct Account {
    pub descriptor_hits: u64,
    pub builds: u64,
    pub layout_reuses: u64,
    pub layout_builds: u64,
    pub scene_writes: u64,
    /// Multi-root archive batches. Singleton roots use the window cache instead.
    pub source_batches: std::sync::atomic::AtomicU64,
}

pub(super) fn prepare(s: &mut Session, cancel: &AtomicBool, navigation_preview:bool, material_keys:Option<&[String]>,navigation_window:Option<canvas_layout::Box2>) -> Result<Value> {
    let keys=material_keys.map(|keys| {
        let mut keys=keys.to_vec();keys.sort();
        if keys.is_empty() || keys.len()>32 || keys.windows(2).any(|v|v[0]==v[1]) ||
           keys.iter().any(|key|key.len()>64 || !key.bytes().all(|b|b.is_ascii_digit()||b==b':')) {
            return Err(issue("Invalid material detail scope"));
        }
        Ok(keys)
    }).transpose()?;
    if let Some(b)=navigation_window && (keys.is_none()||![b.x,b.y,b.width,b.height,b.x+b.width,b.y+b.height].iter().all(|v|v.is_finite())||b.width<=0.||b.height<=0.) {
        return Err(issue("Invalid material navigation window"));
    }
    let scope=keys.as_ref().map(|v|digest(v.join(",").as_bytes()));
    if s.canvas_snapshot.as_ref().is_none_or(|snapshot|snapshot.revision!=s.revision || snapshot.scope!=scope) {
        check_cancel(cancel).map_err(issue)?;
        if let Some(key)=scope.as_deref() && let Some(cached)=s.recent_materials.take(key,s.revision,cancel)? {
            if let Some(old)=s.canvas_snapshot.replace(cached) {s.recent_materials.park(old,s.revision);}
            s.snapshot_account.descriptor_hits += 1;
            return Ok(snapshot_descriptor(s.canvas_snapshot.as_ref().unwrap(),&s.owner));
        }
        let layout=match &s.canvas_layout {
            Some(layout) if layout.revision==s.revision => {
                s.snapshot_account.layout_reuses += 1;
                layout.clone()
            }
            _ => {
                let layout = canvas_layout::build(s,cancel)?;
                s.snapshot_account.layout_builds += 1;
                layout
            }
        };
        // Placement and source order always come from the full revision catalogue.
        // Only the explicitly requested roots and their real dependencies are converted.
        let selected=keys.as_ref().map(|keys|{
            let items:Vec<_>=layout.items.iter().filter(|row| keys.binary_search(&row.key).is_ok()).cloned().collect();
            if items.len()!=keys.len(){return Err(issue("Unknown source material in detail scope"));}
            Ok(canvas_layout::Layout{revision:layout.revision,bounds:layout.bounds,items})
        }).transpose()?;
        let work=selected.as_ref().unwrap_or(&layout);
        let (document,stage_id,warnings)=build_inner(s,work,cancel,true)?;
        let suffix=scope.as_ref().map(|v|format!("-{v}")).unwrap_or_default();
        let path=s.directory.join(format!("canvas-native-{}{suffix}.scene",s.revision));
        let next=s.directory.join("canvas-native.next");
        let result=(||{
            let generation=format!("{}:{}:{}{suffix}",s.owner.document_id,s.owner.session_epoch,s.revision);
            let write=||document.write(&next,&generation,&warnings,cancel);
            let store=match write(){
                Err(error) if error.kind()==std::io::ErrorKind::StorageFull && !s.recent_materials.0.is_empty()=>{
                    s.recent_materials.clear();check_cancel(cancel).map_err(issue)?;write().map_err(issue)?
                }
                result=>result.map_err(issue)?,
            };
            check_cancel(cancel).map_err(issue)?;
            fs::rename(&next,&path).map_err(issue)?;
            let mut snapshot=Snapshot{scope:scope.clone(),revision:s.revision,path,store,page_id:document.pages[0].id.clone(),stage_id,
                nodes:document.nodes.len(),roots:work.items.len(),bounds:layout.bounds,warnings,raster_profile:document.raster_profile.unwrap_or(RasterProfile::Analytic),color_managed:document.color_management.is_some(),navigation:None};
            if let Some(window)=navigation_window{
                let margin=32.;
                let left=work.items.iter().map(|i|i.placed.x-margin).fold(f64::INFINITY,f64::min).max(window.x).max(layout.bounds.x);
                let top=work.items.iter().map(|i|i.placed.y-margin).fold(f64::INFINITY,f64::min).max(window.y).max(layout.bounds.y);
                let right=work.items.iter().map(|i|i.placed.x+i.placed.width+margin).fold(f64::NEG_INFINITY,f64::max).min(window.x+window.width).min(layout.bounds.x+layout.bounds.width);
                let bottom=work.items.iter().map(|i|i.placed.y+i.placed.height+margin).fold(f64::NEG_INFINITY,f64::max).min(window.y+window.height).min(layout.bounds.y+layout.bounds.height);
                if right>left&&bottom>top {
                    let region=canvas_layout::Box2{x:left,y:top,width:right-left,height:bottom-top};
                    snapshot.navigation=navigation_image::NavigationImage::start(document.into_document(),snapshot.page_id.clone(),region,snapshot.store.bytes,true);
                }
            }else if navigation_preview && scope.is_none() {
                snapshot.navigation=navigation_image::NavigationImage::start(document.into_document(),snapshot.page_id.clone(),snapshot.bounds,snapshot.store.bytes,false);
            }
            s.snapshot_account.scene_writes += 1;
            Ok(snapshot)
        })();
        if result.is_err(){let _=fs::remove_file(&next);}
        let snapshot=result?;
        if let Some(previous)=s.canvas_snapshot.replace(snapshot) {s.recent_materials.park(previous,s.revision);}
        s.canvas_layout=Some(layout);
        s.snapshot_account.builds += 1;
    } else {
        s.snapshot_account.descriptor_hits += 1;
    }
    let snapshot=s.canvas_snapshot.as_ref().unwrap();
    Ok(snapshot_descriptor(snapshot,&s.owner))
}

pub(super) fn snapshot_descriptor(snapshot:&Snapshot,owner:&Owner)->Value {
    // This path is host-only. The preload must expose an owner-bound opaque
    // capability, never forward this native filesystem descriptor to UI code.
    json!({"owner":owner,"revision":snapshot.revision,"path":snapshot.path,"bytes":snapshot.store.bytes,"store":snapshot.store,
        "scope":snapshot.scope,"pageId":snapshot.page_id,"stageId":snapshot.stage_id,"nodes":snapshot.nodes,"roots":snapshot.roots,
        "bounds":snapshot.bounds,"warnings":snapshot.warnings,"rasterProfile":snapshot.raster_profile,"colorManaged":snapshot.color_managed})
}

#[cfg(test)]
mod ordered_conversion_tests {
    use super::for_each_ordered;
    use std::sync::{Arc, Condvar, Mutex, atomic::{AtomicUsize, Ordering}};
    use std::time::{Duration, Instant};

    #[test]
    fn a_slow_oldest_batch_refills_the_second_slot_and_merges_in_order() {
        let started = Arc::new(Mutex::new(Vec::<u8>::new()));
        let accepted = Arc::new(Mutex::new(Vec::<u8>::new()));
        let current = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let started_job = started.clone();
        let accepted_job = accepted.clone();
        let current_job = current.clone();
        let peak_job = peak.clone();
        let release_job = release.clone();
        let worker = std::thread::spawn(move || {
            for_each_ordered(vec![0u8, 1, 2, 3], 2, move |item| {
                started_job.lock().expect("start list").push(item);
                let now = current_job.fetch_add(1, Ordering::SeqCst) + 1;
                peak_job.fetch_max(now, Ordering::SeqCst);
                if item == 0 {
                    let (lock, cv) = &*release_job;
                    let mut go = lock.lock().expect("release");
                    while !*go { go = cv.wait(go).expect("release wait"); }
                }
                current_job.fetch_sub(1, Ordering::SeqCst);
                Ok::<_, String>(item)
            }, |item| {
                accepted_job.lock().expect("accept list").push(item);
                Ok(())
            }, || Ok(()), || "worker panicked".into())
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut saw_refilled = false;
        while Instant::now() < deadline {
            if started.lock().expect("start list").contains(&2) { saw_refilled = true; break; }
            std::thread::sleep(Duration::from_millis(5));
        }
        {
            let (lock, cv) = &*release;
            *lock.lock().expect("release") = true;
            cv.notify_all();
        }
        let result = worker.join().expect("scheduler thread");
        assert!(saw_refilled, "second slot stayed idle behind the oldest batch; started={:?}", started.lock().unwrap());
        result.expect("ordered conversion");
        assert_eq!(*accepted.lock().unwrap(), vec![0, 1, 2, 3]);
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= 2 && peak >= 2, "conversion slots peaked at {peak}");
    }
}
