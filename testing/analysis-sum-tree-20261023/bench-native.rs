// Exact upstream sum_tree algorithms, compact handles, known splice boundaries.
// No UI index discovery, WASM transfer, document validation, or GPU work.
use std::{hint::black_box, sync::Arc, time::Instant};
use sum_tree::{Bias, ContextLessSummary, Item, SumTree, TreeMap};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Row { id:u32, depth:u32 }
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
struct Count(usize);
impl ContextLessSummary for Count {
    fn zero()->Self { Self(0) }
    fn add_summary(&mut self,s:&Self) { self.0+=s.0 }
}
impl Item for Row { type Summary=Count; fn summary(&self,_:())->Count { Count(1) } }
fn splice(tree:&SumTree<Row>,start:usize,end:usize,insert:&SumTree<Row>)->SumTree<Row> {
    let mut cursor=tree.cursor::<Count>(());
    let mut out=cursor.slice(&Count(start),Bias::Right);
    out.append(insert.clone(),());
    cursor.seek(&Count(end),Bias::Right);
    out.append(cursor.suffix(),());out
}
fn tree_window(tree:&SumTree<Row>,start:usize)->Vec<Row> {
    let mut cursor=tree.cursor::<Count>(());cursor.seek(&Count(start),Bias::Right);
    let mut out=Vec::with_capacity(40);
    for _ in 0..40 { if let Some(r)=cursor.item(){out.push(*r);cursor.next()}else{break} } out
}
fn stats(n:usize,name:&str,samples:&[f64]) {
    let mut sorted=samples.to_vec(); sorted.sort_by(f64::total_cmp);
    println!("{{\"rows\":{n},\"operation\":\"{name}\",\"p50_ms\":{},\"p95_batch_ms\":{},\"samples_ms\":{:?}}}",sorted[10],sorted[19],samples);
}
fn main() {
 for n in [752usize,20000,100000] {
    let rows:Vec<Row>=(0..n).map(|i|Row{id:i as u32,depth:1}).collect();
    let tree=SumTree::from_iter(rows.clone(),());let empty=SumTree::new(());
    let start=n/3;let end=start+128.min(n/4);
    let expected:Vec<_>=rows[..start].iter().chain(&rows[end..]).copied().collect();
    assert_eq!(splice(&tree,start,end,&empty).iter().copied().collect::<Vec<_>>(),expected);
    assert_eq!(tree_window(&tree,start),rows[start..start+40]);
    let entries:Vec<_>=(0..n).map(|i|(format!("node-{i:09}"),Arc::new(rows[i]))).collect();
    let im:im::OrdMap<String,Arc<Row>>=entries.iter().cloned().collect();
    let map=TreeMap::from_ordered_entries(entries.clone());let key=entries[start].0.clone();
    let value=Arc::new(Row{id:999999,depth:2});
    let mut im_check=im.clone();im_check.insert(key.clone(),value.clone());
    let mut map_check=map.clone();map_check.insert(key.clone(),value.clone());
    assert_eq!(im_check.get(&key),map_check.get(&key));
    assert_eq!(im.get(&key),map.get(&key));
    let jobs:Vec<(&str,usize,Box<dyn Fn()>)>=vec![
      ("vec.build",100,Box::new(||{black_box(rows.clone());})),
      ("sumtree.build",100,Box::new(||{black_box(SumTree::from_iter(rows.iter().copied(),()));})),
      ("vec.immutable.delete128",1000,Box::new(||{let mut out=Vec::with_capacity(n-(end-start));out.extend_from_slice(&rows[..start]);out.extend_from_slice(&rows[end..]);black_box(out);})),
      ("sumtree.immutable.delete128",1000,Box::new(||{black_box(splice(&tree,start,end,&empty));})),
      ("vec.window40",2000,Box::new(||{black_box(rows[start..start+40].to_vec());})),
      ("sumtree.window40",2000,Box::new(||{black_box(tree_window(&tree,start));})),
      ("im.snapshot.update",1000,Box::new(||{let mut out=im.clone();out.insert(key.clone(),value.clone());black_box(out);})),
      ("sumtree.map.snapshot.update",1000,Box::new(||{let mut out=map.clone();out.insert(key.clone(),value.clone());black_box(out);})),
    ];
    let mut results=vec![Vec::new();jobs.len()];
    for (_,_,job) in &jobs { for _ in 0..20 {job()} }
    for round in 0..21 {
      let order:Vec<_>=if round%2==0{(0..jobs.len()).collect()}else{(0..jobs.len()).rev().collect()};
      for i in order {let (_,reps,job)=&jobs[i];let t=Instant::now();for _ in 0..*reps {job()}results[i].push(t.elapsed().as_secs_f64()*1000.0 / *reps as f64);}
    }
    for (i,(name,_,_)) in jobs.iter().enumerate(){stats(n,name,&results[i])}
 }
}
