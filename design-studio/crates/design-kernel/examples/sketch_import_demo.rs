//! Import a real .sketch bundle and print structural stats.
fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: sketch_import_demo <file.sketch>");
    let bytes = std::fs::read(&path).expect("read");
    let report = futureox_design_kernel::interop::import_sketch_report(&bytes).expect("import + validate");
    let doc = report.document;
    let mut by_kind = std::collections::BTreeMap::new();
    let mut fills = 0usize;
    let mut texts = 0usize;
    for node in doc.nodes.values() {
        *by_kind.entry(node.kind.clone()).or_insert(0usize) += 1;
        fills += node.fills.len();
        if node.kind == "text" && !node.text.is_empty() {
            texts += 1;
        }
    }
    println!("文档: {} | 页: {}", doc.name, doc.pages.len());
    println!("共享内核校验通过 | 兼容性警告类别: {}", report.warnings.len());
    println!(
        "节点总数: {} | 填充: {} | 文本层: {}",
        doc.nodes.values().count(),
        fills,
        texts
    );
    for (k, v) in by_kind {
        println!("  {k}: {v}");
    }
}
