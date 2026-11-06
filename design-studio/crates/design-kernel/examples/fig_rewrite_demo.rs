//! Rewrite a .fig through the codec: decode → re-encode the message against
//! the file's own embedded schema → verify the trees match and the rewritten
//! bundle imports to the same document.
fn main() {
    let path = std::env::args().nth(1).expect("usage: <in.fig> [out.fig]");
    let out_path = std::env::args().nth(2);
    let bytes = std::fs::read(&path).unwrap();
    let (before, _, _) = futureox_design_kernel::fig::read_fig(&bytes).unwrap();
    let rewritten = futureox_design_kernel::fig::rewrite_fig(&bytes).unwrap();
    if let Some(out) = out_path {
        std::fs::write(out, &rewritten).unwrap();
    }
    let (after, _, _) = futureox_design_kernel::fig::read_fig(&rewritten).unwrap();
    let equal = serde_json::to_string(&before).unwrap() == serde_json::to_string(&after).unwrap();
    let doc_before = futureox_design_kernel::fig::import_fig_native(&bytes).unwrap();
    let doc_after = futureox_design_kernel::fig::import_fig_native(&rewritten).unwrap();
    let doc_equal =
        serde_json::to_string(&doc_before).unwrap() == serde_json::to_string(&doc_after).unwrap();
    println!(
        "rewrite: {} bytes -> {} bytes | 树一致: {} | 文档一致: {} | 节点 {} -> {} | 页 {} -> {}",
        bytes.len(),
        rewritten.len(),
        equal,
        doc_equal,
        doc_before.nodes.len(),
        doc_after.nodes.len(),
        doc_before.pages.len(),
        doc_after.pages.len(),
    );
}
