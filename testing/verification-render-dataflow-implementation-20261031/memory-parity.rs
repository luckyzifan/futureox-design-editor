use futureox_design_kernel::{scene::Node, scene_store::{Descriptor,Reader}};
use std::{path::Path,sync::atomic::AtomicBool,io::Read};
#[cfg(measure_alloc)]
#[path="../analysis-render-dataflow-20261031/allocation_metrics.rs"] mod allocation_metrics;
#[cfg(measure_alloc)]
#[global_allocator] static ALLOCATOR:allocation_metrics::CountingSystem=allocation_metrics::CountingSystem;
fn main(){
 let file=std::env::args().nth(1).expect("Frozen descriptor required");
 let manifest=std::fs::read_to_string(file).unwrap();let lines:Vec<_>=manifest.lines().collect();
 let mut footer_hash=[0u8;32];for(i,b)in footer_hash.iter_mut().enumerate(){*b=u8::from_str_radix(&lines[5][i*2..i*2+2],16).unwrap()}
 let descriptor=Descriptor{generation:lines[1].into(),document_id:lines[2].into(),nodes:lines[3].parse().unwrap(),bytes:lines[4].parse().unwrap(),footer_hash};
 let cancel=AtomicBool::new(false);
 #[cfg(measure_alloc)] let before=allocation_metrics::live();
 #[cfg(measure_alloc)] allocation_metrics::reset_peak();
 let started=std::time::Instant::now();
 let (doc,warnings)=Reader::open(Path::new(lines[0]),&descriptor,&cancel).unwrap().into_document(&cancel).unwrap();
 let load_ms=started.elapsed().as_secs_f64()*1000.;
 #[cfg(measure_alloc)] let loaded=allocation_metrics::live();
 #[cfg(measure_alloc)] let load_peak=allocation_metrics::peak();
 println!("{{\"nodes\":{},\"node_size\":{},\"load_ms\":{}}}",doc.nodes.len(),std::mem::size_of::<Node>(),load_ms);
 #[cfg(measure_alloc)]{
  let before_clone=allocation_metrics::live();allocation_metrics::reset_peak();
  let copy=std::hint::black_box(doc.clone());let cloned=allocation_metrics::live();let copy_peak=allocation_metrics::peak();
  assert_eq!(copy.nodes.len(),doc.nodes.len());drop(copy);
  println!("{{\"requested_live_load_delta\":{},\"requested_load_peak_delta\":{},\"requested_clone_delta\":{},\"requested_clone_peak_delta\":{}}}",loaded-before,load_peak-before,cloned-before_clone,copy_peak-before_clone);
 }
 #[cfg(not(measure_alloc))]
 for round in 0..3{let started=std::time::Instant::now();let copy=std::hint::black_box(doc.clone());let clone_ms=started.elapsed().as_secs_f64()*1000.;assert_eq!(copy.nodes.len(),doc.nodes.len());drop(copy);println!("{{\"round\":{round},\"clone_ms\":{clone_ms}}}");}
 if let Some(output)=std::env::args().nth(2){
  let output=Path::new(&output);assert!(!output.exists(),"Do not overwrite evidence");
  let actual=futureox_design_kernel::scene_store::write(output,&descriptor.generation,&doc,&warnings,&cancel).unwrap();assert_eq!(actual,descriptor);
  let mut a=std::fs::File::open(lines[0]).unwrap();let mut b=std::fs::File::open(output).unwrap();let mut aa=vec![0u8;1024*1024];let mut bb=aa.clone();
  loop{let count=a.read(&mut aa).unwrap();b.read_exact(&mut bb[..count]).unwrap();assert_eq!(&aa[..count],&bb[..count]);if count==0{assert_eq!(b.read(&mut bb).unwrap(),0);break}}
  println!("{{\"complete_store_bytes_equal\":true,\"descriptor_equal\":true,\"bytes\":{}}}",actual.bytes);
  std::fs::remove_file(output).unwrap();
 }
}
