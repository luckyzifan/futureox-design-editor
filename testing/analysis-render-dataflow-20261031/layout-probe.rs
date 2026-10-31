use futureox_design_kernel::{scene, gpu, layout, math, blend, vector_geometry, font, path};
use std::mem::{size_of, align_of, offset_of};
#[cfg(audit_alloc)] mod allocation_metrics;
#[cfg(audit_alloc)] #[global_allocator] static ALLOCATOR: allocation_metrics::CountingSystem = allocation_metrics::CountingSystem;
macro_rules! ty { ($t:ty) => { println!("{{\"type\":\"{}\",\"size\":{},\"align\":{}}}", stringify!($t),size_of::<$t>(),align_of::<$t>()); } }
macro_rules! field { ($t:ty,$f:ident) => { println!("{{\"field\":\"{}::{}\",\"offset\":{}}}",stringify!($t),stringify!($f),offset_of!($t,$f)); } }
fn main() {
    ty!(scene::Document);ty!(scene::Node);ty!(scene::Paint);ty!(scene::Stroke);ty!(scene::Effect);
    ty!(scene::Network);ty!(scene::GlassParameters);ty!(scene::GradientBlurParameters);
    ty!(layout::Layout);ty!(layout::Sizing);ty!(layout::Constraints);ty!(font::TextStyle);
    ty!(math::Transform);ty!(math::Point);ty!(math::Rect);ty!(blend::Pixel);ty!(blend::Surface);
    ty!(gpu::GpuNode);ty!(gpu::GpuPaint);ty!(gpu::GpuPath);ty!(vector_geometry::VectorGeometry);
    ty!(vector_geometry::Curve);ty!(path::Command);ty!(scene::Vertex);ty!(scene::Edge);
    ty!(Option<String>);ty!(Option<std::sync::Arc<path::Path>>);
    ty!(String);ty!(Vec<scene::Node>);ty!(Option<layout::Layout>);ty!(Option<font::TextStyle>);
    field!(scene::Node,id);field!(scene::Node,kind);field!(scene::Node,transform);field!(scene::Node,visible);
    field!(scene::Node,children);field!(scene::Node,fills);field!(scene::Node,effects);field!(scene::Node,text_style);
    field!(scene::Node,layout);field!(scene::Node,vector_geometry);
    let sample=futureox_design_kernel::facet::sample_node("audit","rectangle");
    println!("{{\"field_size\":\"repeat\",\"bytes\":{}}}",std::mem::size_of_val(&sample.repeat));
    println!("{{\"field_size\":\"vector_brush\",\"bytes\":{}}}",std::mem::size_of_val(&sample.vector_brush));
    println!("{{\"field_size\":\"guides\",\"bytes\":{}}}",std::mem::size_of_val(&sample.guides));
    println!("{{\"field_size\":\"text_path\",\"bytes\":{}}}",std::mem::size_of_val(&sample.text_path));
    println!("{{\"field_size\":\"path_offset\",\"bytes\":{}}}",std::mem::size_of_val(&sample.path_offset));
    println!("{{\"field_size\":\"connector\",\"bytes\":{}}}",std::mem::size_of_val(&sample.connector));
    println!("{{\"field_size\":\"board\",\"bytes\":{}}}",std::mem::size_of_val(&sample.board));
    println!("{{\"field_size\":\"layout_grid\",\"bytes\":{}}}",std::mem::size_of_val(&sample.layout_grid));
    println!("{{\"field_size\":\"export_settings\",\"bytes\":{}}}",std::mem::size_of_val(&sample.export_settings));
    println!("{{\"field_size\":\"arc\",\"bytes\":{}}}",std::mem::size_of_val(&sample.arc));
    println!("{{\"field_size\":\"corner_radius\",\"bytes\":{}}}",std::mem::size_of_val(&sample.corner_radius));
    println!("{{\"field_size\":\"constrain_proportions\",\"bytes\":{}}}",std::mem::size_of_val(&sample.constrain_proportions));
    println!("{{\"field_size\":\"boolean_operation\",\"bytes\":{}}}",std::mem::size_of_val(&sample.boolean_operation));
    println!("{{\"field_size\":\"bindings\",\"bytes\":{}}}",std::mem::size_of_val(&sample.bindings));
    println!("{{\"field_size\":\"variable_modes\",\"bytes\":{}}}",std::mem::size_of_val(&sample.variable_modes));
    println!("{{\"field_size\":\"style_refs\",\"bytes\":{}}}",std::mem::size_of_val(&sample.style_refs));
    println!("{{\"field_size\":\"mask_type\",\"bytes\":{}}}",std::mem::size_of_val(&sample.mask_type));
    println!("{{\"field_size\":\"id\",\"bytes\":{}}}",std::mem::size_of_val(&sample.id));
    println!("{{\"field_size\":\"kind\",\"bytes\":{}}}",std::mem::size_of_val(&sample.kind));
    println!("{{\"field_size\":\"name\",\"bytes\":{}}}",std::mem::size_of_val(&sample.name));
    println!("{{\"field_size\":\"transform\",\"bytes\":{}}}",std::mem::size_of_val(&sample.transform));
    println!("{{\"field_size\":\"width\",\"bytes\":{}}}",std::mem::size_of_val(&sample.width));
    println!("{{\"field_size\":\"height\",\"bytes\":{}}}",std::mem::size_of_val(&sample.height));
    println!("{{\"field_size\":\"children\",\"bytes\":{}}}",std::mem::size_of_val(&sample.children));
    println!("{{\"field_size\":\"visible\",\"bytes\":{}}}",std::mem::size_of_val(&sample.visible));
    println!("{{\"field_size\":\"locked\",\"bytes\":{}}}",std::mem::size_of_val(&sample.locked));
    println!("{{\"field_size\":\"opacity\",\"bytes\":{}}}",std::mem::size_of_val(&sample.opacity));
    println!("{{\"field_size\":\"blend\",\"bytes\":{}}}",std::mem::size_of_val(&sample.blend));
    println!("{{\"field_size\":\"fills\",\"bytes\":{}}}",std::mem::size_of_val(&sample.fills));
    println!("{{\"field_size\":\"strokes\",\"bytes\":{}}}",std::mem::size_of_val(&sample.strokes));
    println!("{{\"field_size\":\"effects\",\"bytes\":{}}}",std::mem::size_of_val(&sample.effects));
    println!("{{\"field_size\":\"radii\",\"bytes\":{}}}",std::mem::size_of_val(&sample.radii));
    println!("{{\"field_size\":\"smoothing\",\"bytes\":{}}}",std::mem::size_of_val(&sample.smoothing));
    println!("{{\"field_size\":\"clip\",\"bytes\":{}}}",std::mem::size_of_val(&sample.clip));
    println!("{{\"field_size\":\"mask\",\"bytes\":{}}}",std::mem::size_of_val(&sample.mask));
    println!("{{\"field_size\":\"points\",\"bytes\":{}}}",std::mem::size_of_val(&sample.points));
    println!("{{\"field_size\":\"inner_radius\",\"bytes\":{}}}",std::mem::size_of_val(&sample.inner_radius));
    println!("{{\"field_size\":\"network\",\"bytes\":{}}}",std::mem::size_of_val(&sample.network));
    println!("{{\"field_size\":\"vector_geometry\",\"bytes\":{}}}",std::mem::size_of_val(&sample.vector_geometry));
    println!("{{\"field_size\":\"text\",\"bytes\":{}}}",std::mem::size_of_val(&sample.text));
    println!("{{\"field_size\":\"font_size\",\"bytes\":{}}}",std::mem::size_of_val(&sample.font_size));
    println!("{{\"field_size\":\"text_style\",\"bytes\":{}}}",std::mem::size_of_val(&sample.text_style));
    println!("{{\"field_size\":\"text_runs\",\"bytes\":{}}}",std::mem::size_of_val(&sample.text_runs));
    println!("{{\"field_size\":\"layout\",\"bytes\":{}}}",std::mem::size_of_val(&sample.layout));
    println!("{{\"field_size\":\"sizing\",\"bytes\":{}}}",std::mem::size_of_val(&sample.sizing));
    println!("{{\"field_size\":\"constraints\",\"bytes\":{}}}",std::mem::size_of_val(&sample.constraints));
    println!("{{\"field_size\":\"component\",\"bytes\":{}}}",std::mem::size_of_val(&sample.component));
    println!("{{\"field_size\":\"component_set\",\"bytes\":{}}}",std::mem::size_of_val(&sample.component_set));
    println!("{{\"field_size\":\"component_key\",\"bytes\":{}}}",std::mem::size_of_val(&sample.component_key));
    println!("{{\"field_size\":\"instance\",\"bytes\":{}}}",std::mem::size_of_val(&sample.instance));
    println!("{{\"field_size\":\"instance_origin\",\"bytes\":{}}}",std::mem::size_of_val(&sample.instance_origin));
    if let Some(manifest) = std::env::args().nth(1) { inventory(&manifest); }
}
fn inventory(manifest: &str) {
    use futureox_design_kernel::scene_store::{Descriptor,Reader};
    use std::{collections::{BTreeMap,HashSet},sync::{Arc,atomic::AtomicBool},path::Path};
    let text=std::fs::read_to_string(manifest).unwrap();let lines:Vec<_>=text.lines().collect();
    let mut footer_hash=[0u8;32];for(i,b)in footer_hash.iter_mut().enumerate(){*b=u8::from_str_radix(&lines[5][i*2..i*2+2],16).unwrap()}
    let descriptor=Descriptor{generation:lines[1].into(),document_id:lines[2].into(),nodes:lines[3].parse().unwrap(),bytes:lines[4].parse().unwrap(),footer_hash};
    #[cfg(audit_alloc)] let before_load = allocation_metrics::live();
    let (mut doc,warnings)=Reader::open(Path::new(lines[0]),&descriptor,&AtomicBool::new(false)).unwrap().into_document(&AtomicBool::new(false)).unwrap();
    #[cfg(not(audit_alloc))] let _=warnings;
    #[cfg(audit_alloc)] {
        let loaded=allocation_metrics::live();
        let count=doc.nodes.len();
        allocation_metrics::reset_peak();
        doc.nodes=std::mem::take(&mut doc.nodes).into_iter().collect();
        assert_eq!(doc.nodes.len(),count);
        let packed=allocation_metrics::live();
        let peak=allocation_metrics::peak();
        println!("{{\"rust_requested_live_after_load_delta\":{},\"rust_requested_live_after_sorted_recollect_delta\":{},\"container_requested_bytes_reduction\":{},\"rust_requested_live_recollect_peak_delta\":{}}}",
            loaded-before_load,packed-before_load,loaded-packed,peak-before_load);
        let paint_spare:usize=doc.nodes.values().map(|n|(n.fills.capacity()-n.fills.len())*size_of::<scene::Paint>()+
            (n.strokes.capacity()-n.strokes.len())*size_of::<scene::Stroke>()+(n.effects.capacity()-n.effects.len())*size_of::<scene::Effect>()).sum();
        for node in doc.nodes.values_mut() { node.fills.shrink_to_fit();node.strokes.shrink_to_fit();node.effects.shrink_to_fit(); }
        let trimmed=allocation_metrics::live();
        println!("{{\"paint_stroke_effect_spare_capacity_bytes\":{},\"requested_live_after_vector_trim_delta\":{},\"vector_trim_requested_bytes_reduction\":{}}}",
            paint_spare,trimmed-before_load,packed-trimmed);
        if std::env::args().any(|a|a=="--verify-repack") {
            let output=Path::new(manifest).with_file_name("compacted.scene");
            let actual=futureox_design_kernel::scene_store::write(&output,&descriptor.generation,&doc,&warnings,&AtomicBool::new(false)).unwrap();
            assert_eq!(actual,descriptor,"all authenticated metadata/node/geometry/index bytes must agree");
            println!("{{\"repacked_descriptor_equal\":true,\"bytes\":{}}}",actual.bytes);
            std::fs::remove_file(output).unwrap();
        }
    }
    if std::env::args().any(|a|a=="--clone-bench") {
        assert_eq!(doc.nodes.len(),124447,"frozen inventory only");
        for round in 0..3 {
            let started=std::time::Instant::now();let copied=std::hint::black_box(doc.clone());
            let clone_ms=started.elapsed().as_secs_f64()*1000.;
            assert_eq!(std::hint::black_box(copied.nodes.len()),doc.nodes.len());
            let started=std::time::Instant::now();drop(copied);let drop_ms=started.elapsed().as_secs_f64()*1000.;
            println!("{{\"clone_round\":{},\"clone_ms\":{},\"drop_ms\":{}}}",round,clone_ms,drop_ms);
        }
    }
    let mut counts=BTreeMap::<&str,usize>::new();let mut kinds=BTreeMap::<&str,usize>::new();let mut effects=BTreeMap::<&str,usize>::new();
    let mut geometries=HashSet::new();let mut images=HashSet::new();let mut curves=[0usize;5];
    let mut referenced_geometry_bytes=0usize;let mut geometry_bytes=0usize;let mut image_bytes=0usize;let mut network_bytes=0usize;let mut graph_id_bytes=0usize;
    for node in doc.nodes.values() {
        *kinds.entry(&node.kind).or_default()+=1;
        for effect in node.effects.iter().filter(|e|e.visible){*effects.entry(&effect.kind).or_default()+=1;}
        for(key,present)in[("text_style",node.text_style.is_some()),("layout",node.layout.is_some()),("sizing",node.sizing.is_some()),
            ("constraints",node.constraints.is_some()),("instance",node.instance.is_some()),("component",node.component.is_some()),
            ("network",node.network.is_some()),("vector_geometry",node.vector_geometry.is_some()),("effects",!node.effects.is_empty()),
            ("text_runs",!node.text_runs.is_empty())] {if present{*counts.entry(key).or_default()+=1;}}
        for(key,n)in[("paint_count",node.fills.len()),("stroke_count",node.strokes.len()),("effect_count",node.effects.len()),("child_refs",node.children.len()),
            ("paint_capacity",node.fills.capacity()),("stroke_capacity",node.strokes.capacity()),("effect_capacity",node.effects.capacity())] {
            *counts.entry(key).or_default()+=n;
        }
        if let Some(network)=&node.network {
            *counts.entry("vertices").or_default()+=network.vertices.len();
            *counts.entry("edges").or_default()+=network.edges.len();
            network_bytes+=network.vertices.capacity()*size_of::<scene::Vertex>()+network.edges.capacity()*size_of::<scene::Edge>();
            graph_id_bytes+=network.vertices.iter().map(|v|v.id.len()).sum::<usize>()+network.edges.iter().map(|e|e.id.len()+e.from.len()+e.to.len()).sum::<usize>();
        }
        for paint in node.fills.iter().chain(node.strokes.iter().map(|s|&s.paint)) {
            if let Some(image)=&paint.image {if images.insert(image.as_ptr() as usize){image_bytes+=image.len();}}
        }
        if let Some(g)=&node.vector_geometry { referenced_geometry_bytes+=(g.fill.len()+g.stroke.as_ref().map_or(0,Vec::len))*size_of::<vector_geometry::Curve>(); if geometries.insert(Arc::as_ptr(g) as usize) {
            let iter=g.fill.iter().chain(g.stroke.iter().flatten());
            for c in iter { let i=match c{vector_geometry::Curve::Move(_)=>0,vector_geometry::Curve::Line(_)=>1,
                vector_geometry::Curve::Quad(_)=>2,vector_geometry::Curve::Cubic(_)=>3,vector_geometry::Curve::Close=>4};curves[i]+=1; }
            geometry_bytes+=(g.fill.capacity()+g.stroke.as_ref().map_or(0,Vec::capacity))*size_of::<vector_geometry::Curve>();
        }}
    }
    println!("{{\"referenced_geometry_curve_bytes_if_unshared\":{}}}",referenced_geometry_bytes);
    println!("{{\"visible_effect_kinds\":{:?}}}",effects);
    println!("{{\"network_capacity_bytes\":{},\"network_graph_id_string_bytes\":{}}}",network_bytes,graph_id_bytes);
    println!("{{\"inventory\":{{\"nodes\":{},\"node_inline_bytes\":{},\"kinds\":{:?},\"fields\":{:?},\"unique_geometries\":{},\"curve_counts_move_line_quad_cubic_close\":{:?},\"geometry_vec_capacity_bytes\":{},\"unique_image_payloads\":{},\"image_string_bytes\":{}}}}}",
        doc.nodes.len(),doc.nodes.len()*size_of::<scene::Node>(),kinds,counts,geometries.len(),curves,geometry_bytes,images.len(),image_bytes);
}
