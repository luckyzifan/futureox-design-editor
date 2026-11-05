//! Disposable navigation pixels for the immutable, copied archive. The detailed
//! index, edit ordinals, save history and exact scene are never derived from these.
use super::{OpeningRequest, Owner, Result, issue, projection};
use base64::Engine as _;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
mod cache;
mod catalog;
use catalog::{Catalog, read_at};
pub(super) use catalog::{Page, Part, read_page};

#[derive(Default)]
pub(super) struct Opening {
    current: Mutex<Option<(Owner, Arc<Job>)>>,
}
#[derive(Default)]
struct State {
    catalog: Option<Arc<Catalog>>,
    jobs: Vec<usize>,
    images: Vec<(usize, String)>,
    bytes: usize,
    page: Option<String>,
    selected: Option<usize>,
    viewport: Option<super::canvas_layout::Box2>,
    viewport_density:Option<f64>,
    viewport_anchor:Option<[f64;2]>,
    finished: bool,
    admitted: bool,
    rendered: usize,
    // Keep only failed ordinals here. Successful images can be regenerated
    // if the user revisits a region after its bounded window was evicted.
    detail_attempts:HashSet<usize>,
    detail_base:usize,
    base_active:usize,
    service_side:Option<u32>,
    detail_busy:bool,
    details:Vec<(usize,String)>,
    cache_hit: bool,
    saved_images: usize,
    saved_details:usize,
    first_material: Option<usize>,
    material_snapshot: Option<(usize, Value)>,
}
#[derive(Default)]
struct Job {
    cancelled: AtomicBool,
    state: Mutex<State>,
    admission: Condvar,
}

impl State {
    fn detail_end(&self)->usize{self.detail_base+self.details.len()}
    fn install_detail(&mut self,index:usize,png:String){
        if self.details.len()==DETAIL_WINDOW{
            self.details.remove(0);
            self.detail_base+=1;
        }
        self.details.push((index,png));
    }
}
impl Opening {
    pub(super) fn clear(&self, owner: Option<&Owner>) {
        let mut slot = self.current.lock().unwrap();
        if slot
            .as_ref()
            .is_some_and(|(id, _)| owner.is_none_or(|o| o == id))
        {
            if let Some((_, job)) = slot.take() {
                let _state = job.state.lock().unwrap();
                job.cancelled.store(true, Ordering::Release);
                job.admission.notify_all();
            }
        }
    }
    pub(super) fn admitted(&self, owner: &Owner) {
        if let Some((_, job)) = self
            .current
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(id, _)| id == owner)
        {
            job.state.lock().unwrap().admitted = true;
            job.admission.notify_all();
        }
    }

    pub(super) fn restore(&self, owner: Owner, root: &Path, hash: &str) -> bool {
        let Some((catalog, images, details)) = cache::location(root, hash).and_then(|p| cache::read(&p))
        else {
            return false;
        };
        let complete = images.len() == catalog.items.len();
        let saved_images = images.len();
        let bytes = images.iter().map(|(_, png)| png.len()).sum();
        *self.current.lock().unwrap() = Some((
            owner,
            Arc::new(Job {
                cancelled: AtomicBool::new(false),
                admission: Condvar::new(),
                state: Mutex::new(State {
                    catalog: Some(Arc::new(catalog)),
                    images,
                    finished: complete,
                    saved_images,
                    saved_details:details.len(),details,
                    bytes,
                    cache_hit: true,
                    ..State::default()
                }),
            }),
        ));
        complete
    }
    pub(super) fn resume_indexed(&self,session:&super::Session,hash:&str,cancel:&AtomicBool)->Result<()>{
        if session.revision!=0||session.format!="sketch"{return Ok(());}
        let layout=super::canvas_layout::build(session,cancel)?;
        let pages=catalog::indexed_pages(session,layout,cancel)?;
        let parts=session.parts.iter().map(|p|Part{name:p.name.clone(),file:p.file.clone(),bytes:p.base_bytes}).collect();
        self.start(session.owner.clone(),session.directory.clone(),parts,pages,hash,session.name.clone());
        Ok(())
    }
    pub(super) fn start(
        &self,
        owner: Owner,
        dir: PathBuf,
        parts: Vec<Part>,
        pages: Vec<Page>,
        hash: &str,
        name: String,
    ) {
        // A verified partial cache may already have published its ordinals to
        // this owner. Append missing results to that same publication stream.
        let mut slot = self.current.lock().unwrap();
        let job = if let Some((_, job)) = slot.as_ref().filter(|(id, _)| *id == owner) {
            job.clone()
        } else {
            let job = Arc::new(Job::default());
            *slot = Some((owner.clone(), job.clone()));
            job
        };
        drop(slot);
        let running = job.clone();
        let cache = dir.parent().and_then(|root| cache::location(root, hash));
        if std::thread::Builder::new()
            .name("source page thumbnails".into())
            .spawn(move || {
                let _ = run(&running, &dir, &parts, pages, cache.as_deref(), &owner, &name);
                let saved = {
                    let mut state = running.state.lock().unwrap();
                    state.finished = true;
                    state.service_side=None;
                    // Persist only after the detailed index and source receipt succeeded.
                    let state = running
                        .admission
                        .wait_while(state, |s| {
                            !s.admitted && !running.cancelled.load(Ordering::Acquire)
                        })
                        .unwrap();
                    if state.admitted && (state.images.len()>state.saved_images||state.detail_end()>state.saved_details) {
                        cache
                            .as_ref()
                            .and_then(|path| cache::snapshot(path, &state))
                    } else {
                        None
                    }
                };
                if let (Some(path), Some(saved)) = (cache, saved) {
                    let _ = cache::write(&path, saved);
                }
            })
            .is_err()
        {
            job.state.lock().unwrap().finished = true;
        }
    }
    pub(super) fn read(&self, r: &OpeningRequest) -> Result<Value> {
        let slot = self.current.lock().map_err(issue)?;
        let Some((_, job)) = slot
            .as_ref()
            .filter(|(owner, _)| owner == &r.owner && r.expected_revision == 0)
        else {
            return Ok(json!({"phase":"absent"}));
        };
        let mut s = job.state.lock().map_err(issue)?;
        let Some(c) = s.catalog.clone() else {
            return Ok(json!({"phase":if s.finished{"unavailable"}else{"pending"}}));
        };
        if r.offset > c.items.len() || r.cursor > s.images.len() {
            return Err(issue("Invalid preview cursor"));
        }
        if let Some(id) = &r.page_id {
            if !c.pages.iter().any(|(v, _, _)| v == id) {
                return Err(issue("Unknown preview page"));
            }
        }
        if let Some(n) = r.material {
            if n >= c.items.len() {
                return Err(issue("Unknown preview material"));
            }
        }
        if r.viewport.is_some_and(|b| {
            ![b.x, b.y, b.width, b.height, b.x + b.width, b.y + b.height]
                .iter()
                .all(|v| v.is_finite())
                || b.width <= 0.
                || b.height <= 0.
        }) {
            return Err(issue("Invalid opening viewport"));
        }
        if r.viewport_density.is_some_and(|n|!n.is_finite()||n<=0.||n>65536.||r.viewport.is_none()){
            return Err(issue("Invalid opening viewport density"));
        }
        if r.viewport_anchor.is_some_and(|[x,y]|!x.is_finite()||!y.is_finite()||r.viewport.is_none()){
            return Err(issue("Invalid opening viewport anchor"));
        }
        if s.page != r.page_id || s.selected != r.material || s.viewport != r.viewport ||
            s.viewport_density!=r.viewport_density || s.viewport_anchor!=r.viewport_anchor {
            s.viewport_density=r.viewport_density;s.viewport_anchor=r.viewport_anchor;
            s.viewport = r.viewport;
            s.page = r.page_id.clone();
            s.selected = r.material;
            job.admission.notify_all();
        }
        if r.detail_cursor>s.detail_end(){return Err(issue("Invalid detail preview cursor"));}
        let detail_cursor=r.detail_cursor.max(s.detail_base);
        let end = (r.offset + 128).min(c.items.len());
        let mut bytes = 0;
        let mut images = Vec::new();
        for (ordinal, data) in &s.images[r.cursor..] {
            if bytes + data.len() > MAX_THUMB_ENCODED || images.len() >= 32 {
                break;
            }
            bytes += data.len();
            images.push(json!({"index":ordinal,"png":data}))
        }
        let cursor = r.cursor + images.len();
        let detail=if images.is_empty()&&r.offset==c.items.len(){s.details.get(detail_cursor-s.detail_base)
            .map(|(index,png)|json!({"index":index,"png":png}))}else{None};
        let next_detail=detail_cursor+usize::from(detail.is_some());
        let detail_pending=s.service_side.is_some_and(|side|s.detail_busy||
            (s.selected.is_none()&&next_viewport_detail(&s,&c,side).is_some()));
        Ok(
            json!({"phase":"available","owner":r.owner,"revision":0,"bounds":c.bounds,"total":c.items.len(),
            "pages":if r.offset==0{Some(&c.pages)}else{None},"offset":r.offset,"items":&c.items[r.offset..end],"nextOffset":end,
             "materialSnapshot":s.material_snapshot.as_ref().filter(|(i,_)|Some(*i)==r.material&&!s.admitted).map(|(_,snapshot)|snapshot),
            "indexing":!s.admitted,"detailBase":s.detail_base,"nextDetailCursor":next_detail,"detailPending":detail_pending,
            "moreDetails":next_detail<s.detail_end(),"detail":detail,"cacheHit":s.cache_hit,"rendered":s.rendered,"cursor":cursor,"moreImages":cursor<s.images.len(),"images":images,"finished":s.finished && cursor==s.images.len()}),
        )
    }
}

// Count the actual aspect-fitted texels, including the small materials
// rendered at their original size. The IPC batch still fits in 192 KiB.
pub(super) const MAX_THUMB_SIDE:u32=176;
pub(super) const MAX_THUMB_ENCODED:usize=192*1024;
fn catalogue_side(items:&[super::canvas_layout::Item])->u32 {
    let mut low=1;
    let mut high=MAX_THUMB_SIDE;
    while low<high {
        let side=(low+high).div_ceil(2);
        let pixels:u64=items.iter().map(|item|{
            let w=item.source.width.max(1.0);
            let h=item.source.height.max(1.0);
            let scale=(side as f64/w.max(h)).min(1.0);
            (w*scale).ceil() as u64*(h*scale).ceil() as u64
        }).sum();
        if pixels<=8_388_608/4 { low=side; } else { high=side-1; }
    }
    low
}

// Only one of the two existing thumbnail workers refines artboards. Spend
// that slot on visible artwork which the initial catalogue cannot resolve.
const DETAIL_WINDOW:usize=16;
fn next_viewport_detail(s:&State,c:&Catalog,side:u32)->Option<usize>{
    let viewport=s.viewport?;
    if viewport.width*viewport.height>=c.bounds.width*c.bounds.height*0.5{return None;}
    let [x,y]=s.viewport_anchor.filter(|[x,y]|*x>=viewport.x&&*x<=viewport.x+viewport.width&&*y>=viewport.y&&*y<=viewport.y+viewport.height)
        .unwrap_or([viewport.x+viewport.width/2.,viewport.y+viewport.height/2.]);
    let mut ranked:Vec<_>=s.images.iter().filter_map(|(index,_)|{
        let item=c.items.get(*index)?;
        if s.detail_attempts.contains(index)||s.page.as_ref().is_some_and(|page|page!=&item.page_id)||
            item.bytes>64*1024*1024{return None;}
        let b=item.placed;
        let width=(viewport.x+viewport.width).min(b.x+b.width)-viewport.x.max(b.x);
        let height=(viewport.y+viewport.height).min(b.y+b.height)-viewport.y.max(b.y);
        let fraction=width*height/(viewport.width*viewport.height);
        let projected=s.viewport_density.map_or_else(||(b.width/viewport.width).max(b.height/viewport.height)*1280.,|scale|b.width.max(b.height)*scale);
        if width<=0.||height<=0.||fraction<1./96.||projected<=f64::from(side)*1.25{return None;}
        let dx=(b.x-x).max(x-b.x-b.width).max(0.)/viewport.width;
        let dy=(b.y-y).max(y-b.y-b.height).max(0.)/viewport.height;
        Some((*index,dx.hypot(dy),fraction/(1.+item.bytes as f64/(8.*1024.*1024.))))
    }).collect();
    ranked.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(b.2.total_cmp(&a.2)).then(a.0.cmp(&b.0)));
    // Rank before excluding resident images, otherwise a crowded stationary
    // view can cycle a seventeenth board through the same sixteen slots.
    ranked.into_iter().take(DETAIL_WINDOW).map(|(i,_,_)|i)
        .find(|i|!s.details.iter().any(|(cached,_)|cached==i))
}

fn ordered(c: &Catalog) -> Vec<usize> {
    let mut by_page = vec![Vec::new(); c.pages.len()];
    let pages: HashMap<_, _> = c
        .pages
        .iter()
        .enumerate()
        .map(|(i, (id, _, _))| (id.as_str(), i))
        .collect();
    for (i, item) in c.items.iter().enumerate() {
        by_page[pages[item.page_id.as_str()]].push(i)
    }
    for group in &mut by_page {
        group.sort_by(|a, b| {
            let score = |i: usize| {
                let t = &c.items[i];
                let substantial = t.source.width >= 16. && t.source.height >= 16.;
                let board = matches!(t.kind.as_str(), "artboard" | "symbolMaster");
                let first = substantial && board && t.bytes <= 3 * 1024 * 1024;
                // Prefer photographs/boards that cover a visible part of the page,
                // while keeping a single giant conversion off the initial critical path.
                let coverage = t.source.width * t.source.height / (8192. + t.bytes as f64).sqrt();
                (first, coverage)
            };
            let (fa, va) = score(*a);
            let (fb, vb) = score(*b);
            fb.cmp(&fa).then_with(|| vb.total_cmp(&va)).then(a.cmp(b))
        });
    }
    let mut order = Vec::with_capacity(c.items.len());
    for n in 0..by_page.iter().map(Vec::len).max().unwrap_or(0) {
        for group in &by_page {
            if let Some(i) = group.get(n) {
                order.push(*i)
            }
        }
    }
    order
}
fn run(
    job: &Arc<Job>,
    dir: &Path,
    parts: &[Part],
    pages: Vec<Page>,
    cache: Option<&Path>,
    owner: &Owner,
    name: &str,
) -> Result<()> {
    let c = Arc::new(catalog::assemble(pages)?);
    {
        let mut s = job.state.lock().map_err(issue)?;
        if s.catalog.as_ref().is_some_and(|saved| {
            saved.pages != c.pages
                || saved.bounds != c.bounds
                || saved.items.len() != c.items.len()
                || saved
                    .items
                    .iter()
                    .zip(&c.items)
                    .any(|(a, b)| a.id != b.id || a.page_id != b.page_id || a.placed != b.placed)
        }) {
            s.catalog = None;
            s.images.clear();
            return Err(issue("Cached preview catalogue mismatch"));
        }
        let ready: HashSet<_> = s.images.iter().map(|(index, _)| *index).collect();
        s.jobs = ordered(&c)
            .into_iter()
            .filter(|i| !ready.contains(i))
            .collect();
        s.catalog = Some(c.clone());
    }
    let doc = parts
        .iter()
        .find(|p| p.name == "document.json" && p.bytes <= 16 * 1024 * 1024)
        .ok_or_else(|| issue("Source metadata unavailable"))?;
    let raw_metadata=fs::read(dir.join(&doc.file)).map_err(issue)?;
    let document: Value = serde_json::from_slice(&raw_metadata).map_err(issue)?;
    let independent_metadata=raw_metadata.len() as u64<=futureox_design_kernel::large_json::MAX_FRAGMENT_BYTES &&
        futureox_design_kernel::large_json::validate_fragment(&raw_metadata).is_ok();
    drop(raw_metadata);
    let exe = std::env::current_exe().map_err(issue)?;
    let font = exe
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| issue("Missing font directory"))?
        .join("fonts/NotoSansSC.ttf");
    let font = fs::read(font).map_err(issue)?;
    let masters: HashMap<&str, usize> = c
        .roots
        .iter()
        .enumerate()
        .filter(|(i, _)| c.items[*i].kind == "symbolMaster")
        .filter_map(|(i, r)| r.symbol.as_deref().map(|key| (key, i)))
        .collect();
    let side = catalogue_side(&c.items);
    job.state.lock().unwrap().service_side=Some(side);
    let archive = dir.join("source");
    let render = |i: usize, engine: &mut futureox_design_kernel::Engine, detail:bool| -> Result<String> {
        let root = read_at(dir, parts, &c.roots[i])?;
        let (mut symbols, mut images) = projection::preview_dependencies(&root);
        let mut dependencies = BTreeMap::new();
        let mut visited = HashSet::new();
        let mut bytes = c.roots[i].len;
        while let Some(id) = symbols.iter().next().cloned() {
            symbols.remove(&id);
            if !visited.insert(id.clone()) {
                continue;
            }
            if visited.len() > 512 || job.cancelled.load(Ordering::Relaxed) {
                return Err(issue("Thumbnail dependencies unavailable"));
            }
            if let Some(&n) = masters.get(id.as_str()) {
                bytes = bytes.saturating_add(c.roots[n].len);
                if bytes > 64 * 1024 * 1024 {
                    return Err(issue("Thumbnail dependencies exceed window"));
                }
                let v = read_at(dir, parts, &c.roots[n])?;
                let (refs, assets) = projection::preview_dependencies(&v);
                symbols.extend(refs);
                images.extend(assets);
                dependencies.insert(id, v);
            }
        }
        let (doc, _) =
            projection::import_source_roots(vec![root], dependencies, images, &document, &archive)?;
        let page = doc.pages[0].id.clone();
        let b = c.items[i].source;
        let guard = job.clone();
        let img = futureox_design_kernel::render_cancellation::with_probe(
            move || guard.cancelled.load(Ordering::Acquire),
            || {
                let bounds=[b.x,b.y,b.width.max(1.),b.height.max(1.)];
                if detail{futureox_design_kernel::navigation_image::render_opening_material(engine,doc,page,bounds)}
                else{futureox_design_kernel::navigation_image::render_fit(engine,doc,page,bounds,side)}
            },
        )
        .map_err(issue)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(img.png))
    };
    // A cancelled source can still be leaving its bounded conversion. Do not
    // start a third conversion if a new file is opened during that handoff.
    static SLOTS: [Mutex<()>; 2] = [Mutex::new(()), Mutex::new(())];
    std::thread::scope(|threads| {
        for (lane,slot) in SLOTS.iter().enumerate() {
            let render=&render;let c=&c;let font=&font;let document=&document;
            threads.spawn(move || {
                let mut engine = None;
                loop {
                    if job.cancelled.load(Ordering::Acquire) {
                        return;
                    }
                    let (i,material,detail) = {
                        let mut s = job.state.lock().unwrap();
                        loop {
                            if job.cancelled.load(Ordering::Acquire) { return; }
                            if independent_metadata && !s.admitted && s.first_material.is_none() {
                                if let Some(i) = s.selected {
                                    s.first_material = Some(i);
                                    break (i,true,false);
                                }
                            }
                            if s.selected.is_none() && !s.detail_busy {
                                if let Some(i)=next_viewport_detail(&s,&c,side){
                                    s.detail_busy=true;break (i,false,true);
                                }
                            }
                            if s.jobs.is_empty() && s.base_active==0{
                                s.finished=true;
                                if s.admitted&&lane!=0{return;}
                            }
                            let visible = |i: usize| {
                                let item = &c.items[i];
                                let b = item.placed;
                                s.page.as_ref().is_none_or(|page| &item.page_id == page)
                                    && s.viewport.is_none_or(|v| {
                                        b.x < v.x + v.width
                                            && b.x + b.width > v.x
                                            && b.y < v.y + v.height
                                            && b.y + b.height > v.y
                                    })
                            };
                            let requested = s
                                .selected
                                .filter(|i| visible(*i))
                                .and_then(|id| s.jobs.iter().position(|i| *i == id));
                            let index =
                                requested.or_else(|| s.jobs.iter().position(|i| visible(*i)));
                            if let Some(n) = index {
                                s.rendered += 1;s.base_active+=1;
                                break (s.jobs.remove(n),false,false);
                            }
                            // Unseen pages stay on disk until the user visits them.
                            // A change of page, a material click or closing the file wakes the worker.
                            if let Some(path) =
                                cache.filter(|_| s.admitted && (s.images.len()>s.saved_images||s.detail_end()>s.saved_details))
                            {
                                let saved = cache::snapshot(path, &s);
                                s.saved_images = s.images.len();s.saved_details=s.detail_end();
                                drop(s);
                                if let Some(saved) = saved {
                                    let _ = cache::write(path, saved);
                                }
                                s = job.state.lock().unwrap();
                                continue;
                            }
                            engine=None;
                            s = job.admission.wait(s).unwrap();
                        }
                    };
                    // Idle coordinators own no painter or global conversion slot.
                    let _lease=slot.lock().unwrap();
                    if job.cancelled.load(Ordering::Acquire){return;}
                    if material {
                        if let Ok(Some(snapshot))=selected_snapshot(c,i,parts,dir,owner,name,document,&job.cancelled) {
                            let mut s=job.state.lock().unwrap();
                            if !job.cancelled.load(Ordering::Acquire) && !s.admitted && s.selected==Some(i) {
                                s.material_snapshot=Some((i,snapshot));
                            } else if let Some(path)=snapshot["path"].as_str() {
                                let _=fs::remove_file(path);
                            }
                        }
                        continue;
                    }
                    // A selected native scene does not use the thumbnail
                    // painter. Load its font once, when this slot first paints.
                    if engine.is_none() {
                        let mut painter = futureox_design_kernel::Engine::new();
                        if painter.load_font(font).is_err(){
                            let mut s=job.state.lock().unwrap();
                            if detail{s.detail_busy=false;s.detail_attempts.insert(i);}else{s.base_active-=1;}
                            job.admission.notify_all();
                            return;
                        }
                        engine = Some(painter);
                    }
                    let pixels=render(i,engine.as_mut().unwrap(),detail);
                    if detail{
                        let mut state=job.state.lock().unwrap();
                        state.detail_busy=false;
                        if !job.cancelled.load(Ordering::Acquire){
                            match pixels{
                                Ok(png) if png.len()<=360_000 => state.install_detail(i,png),
                                _=>{state.detail_attempts.insert(i);}
                            }
                        }
                        job.admission.notify_all();
                        continue;
                    }
                    let mut s=job.state.lock().unwrap();
                    s.base_active-=1;
                    job.admission.notify_all();
                    if let Ok(png) = pixels {
                        if !job.cancelled.load(Ordering::Relaxed)
                            && png.len() <= MAX_THUMB_ENCODED && s.bytes + png.len() <= 24 * 1024 * 1024
                        {
                            s.bytes += png.len();
                            s.images.push((i, png));
                        }
                    }
                }
            });
        }
    });
    Ok(())
}

/// Only a self-contained, fully validated material from the immutable CRC-checked
/// archive can be displayed while the separate editing index is being built.
fn selected_snapshot(c:&Catalog, i:usize, parts:&[Part], dir:&Path, owner:&Owner, name:&str,
    metadata:&Value, cancel:&AtomicBool) -> Result<Option<Value>> {
    use super::{canvas_layout,canvas_snapshot,digest};
    use futureox_design_kernel::{fidelity::RasterProfile,large_json,scene_store};
    let root=&c.roots[i];
    if root.len>large_json::MAX_FRAGMENT_BYTES || projection::legacy_refs_enabled() { return Ok(None); }
    let bytes=catalog::bytes_at(dir,parts,root)?;
    large_json::validate_fragment(&bytes).map_err(issue)?;
    let value:Value=serde_json::from_slice(&bytes).map_err(issue)?;
    let item=&c.items[i];
    if value["do_objectID"].as_str()!=Some(item.id.as_str()) || value["_class"].as_str()!=Some(item.kind.as_str()) ||
        c.items.iter().filter(|r|r.id==item.id).count()!=1 { return Ok(None) }
    let (symbols,images)=projection::preview_dependencies(&value);
    if !symbols.is_empty() || cancel.load(Ordering::Acquire) {return Ok(None)}
    let (mut doc,mut warnings)=projection::import_source_roots(vec![value],BTreeMap::new(),images,metadata,&dir.join("source"))?;
    if let Some(system)=&mut doc.design_system {system.sketch_containers.clear();}
    let layout=canvas_layout::Layout {revision:0,bounds:c.bounds,items:vec![item.clone()]};
    let (doc,stage_id)=canvas_snapshot::place_materials(doc,&owner.document_id,name,&layout)?;
    warnings.sort();warnings.dedup();
    let scope=digest(item.key.as_bytes());
    let generation=format!("{}:{}:0-{scope}",owner.document_id,owner.session_epoch);
    let path=dir.join(format!("canvas-native-0-{scope}.scene"));
    let next=dir.join("opening-material.next");
    let result=(||{
        let store=scene_store::write(&next,&generation,&doc,&warnings,cancel).map_err(issue)?;
        super::check_cancel(cancel).map_err(issue)?;
        fs::rename(&next,&path).map_err(issue)?;
        Ok(canvas_snapshot::snapshot_descriptor(&canvas_snapshot::Snapshot{
            scope:Some(scope),revision:0,path,store,page_id:doc.pages[0].id.clone(),stage_id,
            nodes:doc.nodes.len(),roots:1,bounds:c.bounds,warnings,
            raster_profile:doc.raster_profile.unwrap_or(RasterProfile::Analytic),
            color_managed:doc.color_management.is_some(),navigation:None,
        },owner))
    })();
    if result.is_err(){let _=fs::remove_file(next);}
    result.map(Some)
}

#[cfg(test)]
pub(super) fn selected_snapshot_for_test(s:&super::Session,id:&str,cancel:&AtomicBool)->Result<Option<Value>> {
    let mut parts=Vec::new();
    let mut pages=Vec::new();
    for p in &s.parts {
        if p.name.starts_with("pages/") {
            let input=std::io::BufReader::new(fs::File::open(s.directory.join(&p.file)).map_err(issue)?);
            pages.push(read_page(input,parts.len(),cancel)?);
        }
        parts.push(Part{name:p.name.clone(),file:p.file.clone(),bytes:p.base_bytes});
    }
    let c=catalog::assemble(pages)?;
    let i=c.items.iter().position(|item|item.id==id).ok_or_else(||issue("Missing test material"))?;
    let header=parts.iter().find(|p|p.name=="document.json").ok_or_else(||issue("Missing test header"))?;
    let metadata=serde_json::from_slice(&fs::read(s.directory.join(&header.file)).map_err(issue)?).map_err(issue)?;
    selected_snapshot(&c,i,&parts,&s.directory,&s.owner,&s.name,&metadata,cancel)
}

// Only a locally generated descriptor ever enters this state. Retain its
// file through the open/index handoff and remove it when this owner retires.
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(state)=self.state.get_mut() {
            if let Some((_,snapshot))=state.material_snapshot.take() {
                if let Some(path)=snapshot["path"].as_str(){let _=fs::remove_file(path);}
            }
        }
    }
}

impl Drop for Opening {
    fn drop(&mut self) {
        self.clear(None)
    }
}

#[cfg(test)]
mod overview_tests{
    use super::*;
    use super::super::canvas_layout::{Box2,Item};
    fn item(i:usize,x:f64,side:f64)->Item{
        let b=Box2{x,y:0.,width:side,height:side};
        Item{key:format!("p:{i}"),id:i.to_string(),name:i.to_string(),kind:"artboard".into(),
            page_id:"p".into(),page_name:"p".into(),source:b,placed:b,bytes:10000}
    }
    #[test]
    fn aspect_fitted_catalogue_keeps_its_actual_pixel_budget(){
        let items:Vec<_>=(0..300).map(|i|item(i,i as f64*1600.,if i%6==0{1500.}else{12.})).collect();
        let side=catalogue_side(&items);
        assert!(side>96);
        let actual:u64=items.iter().map(|i|(i.source.width.min(f64::from(side)).ceil() as u64).pow(2)).sum();
        assert!(actual<=8_388_608/4);
    }
    #[test]
    fn a_new_viewport_can_refine_after_the_first_sixteen_boards(){
        let items=(0..32).map(|i|item(i,520.*i as f64,500.)).collect();
        let c=Catalog{items,roots:vec![],pages:vec![],bounds:Box2{x:0.,y:0.,width:18_000.,height:1000.}};
        let mut s=State{viewport:Some(Box2{x:520.*20.,y:0.,width:1100.,height:600.}),images:(0..32).map(|i|(i,String::new())).collect(),..Default::default()};
        for i in 0..DETAIL_WINDOW{s.install_detail(i,String::new());}
        let next=next_viewport_detail(&s,&c,160).unwrap();
        assert!(next==20||next==21);
        s.install_detail(next,String::new());
        assert_eq!(s.details.len(),DETAIL_WINDOW);assert_eq!(s.detail_base,1);assert_eq!(s.detail_end(),17);
        assert!(!s.details.iter().any(|(i,_)|*i==0));
    }
    #[test]
    fn free_zoom_prioritizes_multiple_visible_decoded_items_once(){
        let items=vec![item(0,0.,500.),item(1,520.,520.),item(2,3000.,700.)];
        let bounds=Box2{x:0.,y:0.,width:4000.,height:3000.};
        let c=Catalog{items,roots:vec![],pages:vec![],bounds};
        let mut s=State{viewport:Some(bounds),images:vec![(0,String::new()),(1,String::new()),(2,String::new())],..Default::default()};
        assert_eq!(next_viewport_detail(&s,&c,160),None);
        s.viewport=Some(Box2{x:0.,y:0.,width:1200.,height:800.});
        let first=next_viewport_detail(&s,&c,160).unwrap();s.detail_attempts.insert(first);
        let second=next_viewport_detail(&s,&c,160).unwrap();s.detail_attempts.insert(second);
        assert_eq!(s.detail_attempts,HashSet::from([0,1]));
        assert_eq!(next_viewport_detail(&s,&c,160),None);
    }
}
