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
    finished: bool,
    admitted: bool,
    rendered: usize,
    cache_hit: bool,
    saved_images: usize,
}
#[derive(Default)]
struct Job {
    cancelled: AtomicBool,
    state: Mutex<State>,
    admission: Condvar,
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
        let Some((catalog, images)) = cache::location(root, hash).and_then(|p| cache::read(&p))
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
                    bytes,
                    cache_hit: true,
                    ..State::default()
                }),
            }),
        ));
        complete
    }
    pub(super) fn start(
        &self,
        owner: Owner,
        dir: PathBuf,
        parts: Vec<Part>,
        pages: Vec<Page>,
        hash: &str,
    ) {
        // A verified partial cache may already have published its ordinals to
        // this owner. Append missing results to that same publication stream.
        let mut slot = self.current.lock().unwrap();
        let job = if let Some((_, job)) = slot.as_ref().filter(|(id, _)| *id == owner) {
            job.clone()
        } else {
            let job = Arc::new(Job::default());
            *slot = Some((owner, job.clone()));
            job
        };
        drop(slot);
        let running = job.clone();
        let cache = dir.parent().and_then(|root| cache::location(root, hash));
        if std::thread::Builder::new()
            .name("source page thumbnails".into())
            .spawn(move || {
                let _ = run(&running, &dir, &parts, pages, cache.as_deref());
                let saved = {
                    let mut state = running.state.lock().unwrap();
                    state.finished = true;
                    // Persist only after the detailed index and source receipt succeeded.
                    let state = running
                        .admission
                        .wait_while(state, |s| {
                            !s.admitted && !running.cancelled.load(Ordering::Acquire)
                        })
                        .unwrap();
                    if state.admitted && state.images.len() > state.saved_images {
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
        if s.page != r.page_id || s.selected != r.material || s.viewport != r.viewport {
            s.viewport = r.viewport;
            s.page = r.page_id.clone();
            s.selected = r.material;
            job.admission.notify_all();
        }
        let end = (r.offset + 128).min(c.items.len());
        let mut bytes = 0;
        let mut images = Vec::new();
        for (ordinal, data) in &s.images[r.cursor..] {
            if bytes + data.len() > 192 * 1024 || images.len() >= 32 {
                break;
            }
            bytes += data.len();
            images.push(json!({"index":ordinal,"png":data}))
        }
        let cursor = r.cursor + images.len();
        Ok(
            json!({"phase":"available","owner":r.owner,"revision":0,"bounds":c.bounds,"total":c.items.len(),
            "pages":if r.offset==0{Some(&c.pages)}else{None},"offset":r.offset,"items":&c.items[r.offset..end],"nextOffset":end,
            "cacheHit":s.cache_hit,"rendered":s.rendered,"cursor":cursor,"moreImages":cursor<s.images.len(),"images":images,"finished":s.finished && cursor==s.images.len()}),
        )
    }
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
    let document: Value =
        serde_json::from_slice(&fs::read(dir.join(&doc.file)).map_err(issue)?).map_err(issue)?;
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
    let side = (8_388_608.0 / (4.0 * c.items.len().max(1) as f64))
        .sqrt()
        .floor()
        .clamp(8., 96.) as u32;
    let archive = dir.join("source");
    let render = |i: usize, engine: &mut futureox_design_kernel::Engine| -> Result<String> {
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
                futureox_design_kernel::navigation_image::render_fit(
                    engine,
                    doc,
                    page,
                    [b.x, b.y, b.width.max(1.), b.height.max(1.)],
                    side,
                )
            },
        )
        .map_err(issue)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(img.png))
    };
    // A cancelled source can still be leaving its bounded conversion. Do not
    // start a third conversion if a new file is opened during that handoff.
    static SLOTS: [Mutex<()>; 2] = [Mutex::new(()), Mutex::new(())];
    std::thread::scope(|threads| {
        for slot in &SLOTS {
            threads.spawn(|| {
                let _lease = slot.lock().unwrap();
                let mut engine = futureox_design_kernel::Engine::new();
                if engine.load_font(&font).is_err() {
                    return;
                }
                loop {
                    if job.cancelled.load(Ordering::Acquire) {
                        return;
                    }
                    let i = {
                        let mut s = job.state.lock().unwrap();
                        loop {
                            if job.cancelled.load(Ordering::Acquire) || s.jobs.is_empty() {
                                return;
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
                                s.rendered += 1;
                                break s.jobs.remove(n);
                            }
                            // Unseen pages stay on disk until the user visits them.
                            // A change of page, a material click or closing the file wakes the worker.
                            if let Some(path) =
                                cache.filter(|_| s.admitted && s.images.len() > s.saved_images)
                            {
                                let saved = cache::snapshot(path, &s);
                                s.saved_images = s.images.len();
                                drop(s);
                                if let Some(saved) = saved {
                                    let _ = cache::write(path, saved);
                                }
                                s = job.state.lock().unwrap();
                                continue;
                            }
                            s = job.admission.wait(s).unwrap();
                        }
                    };
                    if let Ok(png) = render(i, &mut engine) {
                        let mut s = job.state.lock().unwrap();
                        if !job.cancelled.load(Ordering::Relaxed)
                            && s.bytes + png.len() <= 24 * 1024 * 1024
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

impl Drop for Opening {
    fn drop(&mut self) {
        self.clear(None)
    }
}
