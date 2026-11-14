//! Stateless render preparation may stop between bounded units of work.
//! The caller retains the physical request fence until this scope returns.
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
thread_local! {
    static PROBE: RefCell<Option<Box<dyn Fn() -> bool>>> = RefCell::new(None);
    // Worker threads cannot see the caller's probe. A parallel tile batch
    // publishes one flag here so an in-flight tile stops at its next checkpoint.
    static SHARED: RefCell<Option<Arc<AtomicBool>>> = RefCell::new(None);
}
pub fn checkpoint() -> Result<(), String> {
    let shared = SHARED.with(|slot| slot.borrow().as_ref().is_some_and(|flag| flag.load(Ordering::Acquire)));
    if shared || PROBE.with(|probe| probe.borrow().as_ref().is_some_and(|probe| probe())) {
        Err("PREVIEW_CANCELLED".into())
    } else { Ok(()) }
}

/// Install `flag` on this thread until the guard drops. The parallel tile
/// batch sets the flag when the calling thread's probe fires.
pub struct SharedCancelGuard { previous: Option<Arc<AtomicBool>> }
impl SharedCancelGuard {
    pub fn bind(flag: Arc<AtomicBool>) -> Self {
        Self { previous: SHARED.with(|slot| slot.borrow_mut().replace(flag)) }
    }
}
impl Drop for SharedCancelGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        SHARED.with(|slot| *slot.borrow_mut() = previous);
    }
}
pub fn with_probe<T>(probe: impl Fn() -> bool + 'static, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<Box<dyn Fn() -> bool>>);
    impl Drop for Restore { fn drop(&mut self) { PROBE.with(|slot| *slot.borrow_mut() = self.0.take()); } }
    let _restore = Restore(PROBE.with(|slot| slot.replace(Some(Box::new(probe)))));
    work()
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn cancellation_is_scoped_and_nested_consumers_restore_their_owner() {
        with_probe(|| true, || {
            assert_eq!(checkpoint().unwrap_err(), "PREVIEW_CANCELLED");
            with_probe(|| false, || assert!(checkpoint().is_ok()));
            assert!(checkpoint().is_err());
        });
        assert!(checkpoint().is_ok());
    }
    #[test] fn shared_cancel_stops_this_thread_without_replacing_the_probe() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let flag = Arc::new(AtomicBool::new(false));
        let guard = SharedCancelGuard::bind(Arc::clone(&flag));
        assert!(checkpoint().is_ok());
        flag.store(true, Ordering::Release);
        assert_eq!(checkpoint().unwrap_err(), "PREVIEW_CANCELLED");
        drop(guard);
        assert!(checkpoint().is_ok());
    }
}
