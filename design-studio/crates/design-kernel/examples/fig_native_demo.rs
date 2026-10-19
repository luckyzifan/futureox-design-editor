//! Native (no-helper) .fig import stats.
fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: fig_native_demo <file.fig>");
    let bytes = std::fs::read(&path).unwrap();
    match futureox_design_kernel::fig::import_fig_native(&bytes) {
        Ok(doc) => {
            let mut by_kind = std::collections::BTreeMap::new();
            for n in doc.nodes.values() {
                *by_kind.entry(n.kind.clone()).or_insert(0usize) += 1;
            }
            let texts: usize = doc
                .nodes
                .values()
                .filter(|n| n.kind == "text" && !n.text.is_empty())
                .count();
            let networks: usize = doc
                .nodes
                .values()
                .filter(|n| {
                    n.network
                        .as_ref()
                        .map(|x| !x.vertices.is_empty())
                        .unwrap_or(false)
                })
                .count();
            let edges: usize = doc
                .nodes
                .values()
                .filter_map(|n| n.network.as_ref())
                .map(|x| x.edges.len())
                .sum();
            let instances: usize = doc.nodes.values().filter(|n| n.instance.is_some()).count();
            let override_fields: usize = doc
                .nodes
                .values()
                .filter_map(|n| n.instance.as_ref())
                .map(|i| i.overrides.values().map(|f| f.len()).sum::<usize>())
                .sum();
            println!(
                "原生导入: 页 {} | 节点 {} | 文本 {} | 图像填充 {} | 矢量网络 {}({}边) | 实例 {}(override字段 {})",
                doc.pages.len(),
                doc.nodes.len(),
                texts,
                doc.nodes
                    .values()
                    .map(|n| n.fills.iter().filter(|f| f.kind == "image").count())
                    .sum::<usize>(),
                networks,
                edges,
                instances,
                override_fields
            );
            for (k, v) in by_kind {
                println!("  {k}: {v}");
            }
            if std::env::var("FIG_DUMP_NODES").is_ok() {
                for n in doc.nodes.values().take(4) {
                    println!(
                        "NODE {} {:?} {:?} w={} h={} t={:?} fills={:?} mask={} clip={}",
                        n.id,
                        n.kind,
                        n.name,
                        n.width,
                        n.height,
                        n.transform.0,
                        n.fills
                            .iter()
                            .map(|f| (f.kind.clone(), f.color.clone()))
                            .collect::<Vec<_>>(),
                        n.mask,
                        n.clip
                    );
                }
                let _ = &doc.validate();
                println!("validate: {:?}", doc.validate().err());
            }
        }
        Err(e) => {
            println!("失败: {e}");
            if std::env::var("FIG_DEBUG").is_ok() {
                let files = futureox_design_kernel::interop::read_zip_public(&bytes).unwrap();
                let canvas = &files["canvas.fig"];
                match futureox_design_kernel::fig::decode_canvas(canvas) {
                    Ok(v) => println!(
                        "根: {:?} | 键: {:?}",
                        v,
                        v.as_object().map(|m| m.keys().collect::<Vec<_>>())
                    ),
                    Err(e2) => println!("decode err: {e2}"),
                }
            }
        }
    }
}
// debug helper: FIG_DEBUG=1 prints root message keys
