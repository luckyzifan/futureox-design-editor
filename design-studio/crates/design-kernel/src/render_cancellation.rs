//! Stateless render preparation may stop between bounded units of work.
//! The caller retains the physical request fence until this scope returns.
use std::cell::RefCell;
thread_local! { static PROBE: RefCell<Option<Box<dyn Fn() -> bool>>> = RefCell::new(None); }
pub fn checkpoint() -> Result<(), String> {
    if PROBE.with(|probe| probe.borrow().as_ref().is_some_and(|probe| probe())) {
        Err("PREVIEW_CANCELLED".into())
    } else { Ok(()) }
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
}
