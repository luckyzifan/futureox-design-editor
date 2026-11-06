//! Import a .sketch file, optionally keep only chosen top-level kinds,
//! re-export, and report fidelity stats.
use futureox_design_kernel::scene::Node;

fn collect_subtree(
    id: &str,
    nodes: &futureox_design_kernel::scene::DocumentNodes,
    out: &mut std::collections::BTreeMap<String, Node>,
) {
    if let Some(n) = nodes.get(id) {
        let mut n = n.clone();
        for c in &n.children {
            collect_subtree(c, nodes, out);
        }
        n.children.retain(|c| out.contains_key(c));
        out.insert(id.into(), n);
    }
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: <in.sketch> <out.sketch> [kinds...]");
    let out_path = std::env::args().nth(2).expect("out path");
    let args: Vec<String> = std::env::args().skip(3).filter(|a| a != "--bake").collect();
    let top_n: Option<usize> = args
        .first()
        .and_then(|a| a.strip_prefix("top:"))
        .and_then(|v| v.parse().ok());
    let only_i: Option<usize> = args
        .first()
        .and_then(|a| a.strip_prefix("only:"))
        .and_then(|v| v.parse().ok());
    let child_i: Option<usize> = args
        .first()
        .and_then(|a| a.strip_prefix("child:"))
        .and_then(|v| v.parse().ok());
    let child_n: Option<usize> = args
        .first()
        .and_then(|a| a.strip_prefix("childn:"))
        .and_then(|v| v.parse().ok());
    let kinds: Vec<String> = if top_n.is_some() {
        Vec::new()
    } else {
        args.clone()
    };
    let bytes = std::fs::read(&path).unwrap();
    let doc = futureox_design_kernel::interop::import_any(&bytes).expect("import");

    let doc = if child_i.is_some() || child_n.is_some() {
        let mut doc = doc;
        let mut new_nodes = std::collections::BTreeMap::new();
        let mut pages = doc.pages.clone();
        for page in pages.iter_mut() {
            // 顶层唯一容器的 children 上过滤
            let top = page.children.first().cloned();
            if let Some(top_id) = top {
                let top_node = doc.nodes.get(&top_id).cloned();
                if let Some(mut tn) = top_node {
                    if let Some(i) = child_i {
                        if let Some(k) = tn.children.get(i).cloned() {
                            tn.children = vec![k];
                        }
                    } else if let Some(n) = child_n {
                        tn.children.truncate(n);
                    }
                    let new_top = tn.clone();
                    for c in &tn.children {
                        collect_subtree(c, &doc.nodes, &mut new_nodes);
                    }
                    collect_subtree(
                        &top_id,
                        &{
                            let mut m = doc.nodes.clone();
                            m.insert(top_id.clone(), tn.clone());
                            m
                        },
                        &mut new_nodes,
                    );
                    // 简化:直接重建
                    new_nodes.clear();
                    let mut with_top = doc.nodes.clone();
                    with_top.insert(top_id.clone(), tn.clone());
                    let mut pn = doc.nodes.get(&page.id).cloned().unwrap();
                    pn.children = vec![top_id.clone()];
                    new_nodes.insert(page.id.clone(), pn);
                    collect_subtree(&top_id, &with_top, &mut new_nodes);
                    let _ = new_top;
                }
            }
        }
        doc.nodes = new_nodes.into();
        doc.pages = pages;
        doc
    } else if let Some(i) = only_i {
        eprintln!(
            "[filter] page children: {:?}",
            doc.pages.first().map(|p| p.children.len())
        );
        let mut doc = doc;
        let mut new_nodes = std::collections::BTreeMap::new();
        let mut pages = doc.pages.clone();
        for page in pages.iter_mut() {
            if let Some(keep) = page.children.get(i).cloned() {
                page.children = vec![keep];
            }
            let mut pn = doc.nodes.get(&page.id).cloned().unwrap();
            pn.children = page.children.clone();
            new_nodes.insert(page.id.clone(), pn);
            for c in &page.children {
                collect_subtree(c, &doc.nodes, &mut new_nodes);
            }
        }
        doc.nodes = new_nodes.into();
        doc.pages = pages;
        doc
    } else if let Some(n) = top_n {
        let mut doc = doc;
        let mut new_nodes = std::collections::BTreeMap::new();
        let mut pages = doc.pages.clone();
        for page in pages.iter_mut() {
            page.children.truncate(n);
            let mut pn = doc.nodes.get(&page.id).cloned().unwrap();
            pn.children = page.children.clone();
            new_nodes.insert(page.id.clone(), pn);
            for c in &page.children {
                collect_subtree(c, &doc.nodes, &mut new_nodes);
            }
        }
        doc.nodes = new_nodes.into();
        doc.pages = pages;
        doc
    } else if kinds.is_empty() {
        doc
    } else {
        let mut doc = doc;
        let mut new_nodes = std::collections::BTreeMap::new();
        let mut pages = doc.pages.clone();
        for page in pages.iter_mut() {
            page.children.retain(|c| {
                doc.nodes
                    .get(c)
                    .map(|n| kinds.contains(&n.kind))
                    .unwrap_or(false)
            });
            let mut pn = doc.nodes.get(&page.id).cloned().unwrap();
            pn.children = page.children.clone();
            new_nodes.insert(page.id.clone(), pn);
            for c in &page.children {
                collect_subtree(c, &doc.nodes, &mut new_nodes);
            }
        }
        doc.nodes = new_nodes.into();
        doc.pages = pages;
        doc
    };

    let bake = std::env::args().any(|a| a == "--bake");
    let (exported, baked) = if bake {
        futureox_design_kernel::interop::export_sketch_baked(&doc).expect("export")
    } else {
        (futureox_design_kernel::interop::export_sketch(&doc).expect("export"), 0)
    };
    if bake {
        eprintln!("[bake] baked {baked} leaf vector nodes");
    }
    std::fs::write(&out_path, &exported).unwrap();
    let back = futureox_design_kernel::interop::import_sketch(&exported).expect("reimport");
    let texts: usize = back
        .nodes
        .values()
        .filter(|n| n.kind == "text" && !n.text.is_empty())
        .count();
    println!(
        "roundtrip: 节点 {} -> {} | 文本 {} | 页 {} | {} bytes",
        doc.nodes.len(),
        back.nodes.len(),
        texts,
        back.pages.len(),
        exported.len()
    );
}
