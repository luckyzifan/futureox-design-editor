//! Read-only native Sketch admission. Only trusted host dialogs may supply paths.
pub(crate) use crate::sketch_file::InspectRequest;
use crate::sketch_file::load_session;
use crate::sketch_preview::{Preview, preview};
use futureox_design_kernel::sketch::{Layer, Owner};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inspection {
    pub owner: Owner,
    pub page_count: usize,
    pub layer_count: usize,
    pub editable: bool,
    pub renderable: bool,
    pub preview: Preview,
}
fn count(layer: &Layer) -> usize {
    1 + layer.children().iter().map(count).sum::<usize>()
}
pub(crate) fn inspect(request: InspectRequest, cancel: &AtomicBool) -> Result<Inspection, String> {
    let session = load_session(request, cancel)?;
    let page_count = session.document().pages().len();
    let layer_count = session
        .document()
        .pages()
        .iter()
        .map(|page| count(page.root()))
        .sum();
    let preview = preview(&session, session.document().pages()[0].root().id());
    if cancel.load(Ordering::Acquire) {
        return Err("Sketch inspection cancelled".into());
    }
    Ok(Inspection {
        owner: session.owner().clone(),
        page_count,
        layer_count,
        editable: false,
        renderable: false,
        preview,
    })
}
