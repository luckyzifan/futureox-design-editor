//! The exact store owns the document until publication. Its disposable
//! display copy can then seed otherwise empty regions of the source canvas.
use super::*;
use base64::Engine as _;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

static BUSY: AtomicBool = AtomicBool::new(false);
type Completion = Arc<OnceLock<Option<Value>>>;

struct Job(Completion);
impl Drop for Job {
    fn drop(&mut self) {
        // Failure, cancellation and panic all terminate polling. A completed
        // image remains published since OnceLock cannot replace its value.
        let _ = self.0.set(None);
        BUSY.store(false, Ordering::Release);
    }
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
    ) -> Option<Self> {
        // This is an allowance for one optional concurrent copy, not a limit
        // on the original document, its authoritative snapshot or exports.
        if document.nodes.len() < 20_000
            || store_bytes > 384 * 1024 * 1024
            // Leave the dominant share of the trusted host budget to the
            // foreground render and acquisition of the complete document.
            || store_bytes > futureox_design_kernel::capacity::memory_budget_bytes() / 4
            || std::env::var("CORE_SOURCE_OVERVIEW").as_deref() == Ok("0")
            || BUSY
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let result = Arc::new(OnceLock::new());
        let interrupted = cancel.clone();
        let completion = Job(result.clone());
        let spawned = std::thread::Builder::new()
            .name("source navigation image".into())
            .spawn(move || {
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
                            futureox_design_kernel::navigation_image::render(
                                document,
                                page,
                                [bounds.x, bounds.y, bounds.width, bounds.height],
                                &font,
                            )
                        },
                    )
                    .ok()?;
                    Some(
                        json!({"width":image.width,"height":image.height,"scale":image.scale,
                    "png":base64::engine::general_purpose::STANDARD.encode(image.png)}),
                    )
                };
                let _ = completion.0.set(render());
                drop(completion);
            });
        spawned.ok()?;
        Some(Self { cancel, result })
    }
    pub(super) fn poll(&self) -> Value {
        match self.result.get() {
            Some(Some(image)) => json!({"phase":"ready","image":image}),
            None => json!({"phase":"pending"}),
            Some(None) => json!({"phase":"unavailable"}),
        }
    }
}
