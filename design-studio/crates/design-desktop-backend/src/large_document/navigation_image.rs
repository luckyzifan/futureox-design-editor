//! The exact store owns the document until publication. Its disposable
//! display copy can then seed otherwise empty regions of the source canvas.
use super::*;
use base64::Engine as _;
use std::sync::{
    Arc, OnceLock, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

type Completion = Arc<OnceLock<Option<Value>>>;
struct Work {bytes:u64,run:Option<Box<dyn FnOnce()+Send>>,result:Completion}
impl Drop for Work {
    fn drop(&mut self){let _=self.result.set(None);}
}
struct Queue {running_bytes:u64,next:Option<Work>}
static QUEUE:Mutex<Queue>=Mutex::new(Queue{running_bytes:0,next:None});

fn enqueue(work:Work,material:bool,budget:u64)->bool {
    let mut queue=QUEUE.lock().unwrap_or_else(|e|e.into_inner());
    if queue.running_bytes!=0 {
        if !material||queue.running_bytes.saturating_add(work.bytes)>budget{return false;}
        queue.next=Some(work);
        return true;
    }
    queue.running_bytes=work.bytes;
    let spawned=std::thread::Builder::new().name("source navigation image".into()).spawn(move||{
        let mut work=work;
        loop {
            if let Some(run)=work.run.take(){let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));}
            drop(work);
            let mut q=QUEUE.lock().unwrap_or_else(|e|e.into_inner());
            let Some(next)=q.next.take() else {q.running_bytes=0;return};
            q.running_bytes=next.bytes;work=next;
        }
    });
    if spawned.is_err(){queue.running_bytes=0;return false;}
    true
}

pub(super) struct NavigationImage {
    cancel: Arc<AtomicBool>,
    result: Completion,
}
impl Drop for NavigationImage {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}
impl NavigationImage {
    pub(super) fn start(
        document: futureox_design_kernel::scene::Document,
        page: String,
        bounds: canvas_layout::Box2,
        store_bytes: u64,
        material_window:bool,
    ) -> Option<Self> {
        // This is an allowance for one optional concurrent copy, not a limit
        // on the original document, its authoritative snapshot or exports.
        let budget=(384*1024*1024).min(futureox_design_kernel::capacity::memory_budget_bytes()/4);
        if (!material_window&&document.nodes.len()<20_000)||store_bytes==0||store_bytes>budget||
            std::env::var("CORE_SOURCE_OVERVIEW").as_deref()==Ok("0"){return None;}
        let cancel = Arc::new(AtomicBool::new(false));
        let result = Arc::new(OnceLock::new());
        let interrupted = cancel.clone();
        let completion=result.clone();
        let run=move||{
                if interrupted.load(Ordering::Acquire){return;}
                let started = Instant::now();
                let render = || {
                    // Same packaged fallback font used by design-prepare.
                    let executable = std::env::current_exe().ok()?;
                    let font = executable.parent()?.parent()?.join("fonts/NotoSansSC.ttf");
                    if fs::metadata(&font).ok()?.len() > 48 * 1024 * 1024 {
                        return None;
                    }
                    let font = fs::read(font).ok()?;
                    let image = futureox_design_kernel::render_cancellation::with_probe(
                        move || {
                            interrupted.load(Ordering::Acquire)
                                || started.elapsed() >= Duration::from_secs(30)
                        },
                        || {
                            let world=[bounds.x,bounds.y,bounds.width,bounds.height];
                            if material_window{
                                let mut engine=futureox_design_kernel::Engine::new();engine.load_font(&font)?;
                                futureox_design_kernel::navigation_image::render_overview_window(&mut engine,document,page,world)
                            }else{futureox_design_kernel::navigation_image::render(document,page,world,&font)}
                        },
                    )
                    .ok()?;
                    Some(
                        json!({"bounds":bounds,"width":image.width,"height":image.height,"scale":image.scale,
                    "png":base64::engine::general_purpose::STANDARD.encode(image.png)}),
                    )
                };
                let _=completion.set(render());
        };
        if !enqueue(Work{bytes:store_bytes,result:result.clone(),run:Some(Box::new(run))},material_window,budget){return None;}
        Some(Self { cancel, result })
    }
    pub(super) fn pending(&self)->bool {self.result.get().is_none()}
    pub(super) fn poll(&self) -> Value {
        match self.result.get() {
            Some(Some(image)) => json!({"phase":"ready","image":image}),
            None => json!({"phase":"pending"}),
            Some(None) => json!({"phase":"unavailable"}),
        }
    }
}
