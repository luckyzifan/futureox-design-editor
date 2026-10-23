import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LayerRowsCache, layerTreeRows } from '../../frontend/design-client/src/layer-tree'
const root=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);let sink:unknown
const { IndexTreeModel }=await import(path.join(root,'bundles/tree/tree-entry.js'))
const { fuzzyScore }=await import(path.join(root,'bundles/fuzzy/fuzzy-entry.js'))
const { Throttler, Delayer, Limiter }=await import(path.join(root,'bundles/async/async-entry.js'))
const { DisposableStore, toDisposable }=await import(path.join(root,'bundles/lifecycle/lifecycle-entry.js'))
const results:any[]=[]
function measure(label:string,jobs:[string,()=>unknown,number][],rounds=15){
 const samples=new Map(jobs.map(([name])=>[name,[] as number[]]))
 for(const [,fn] of jobs)for(let i=0;i<5;i++)sink=fn()
 for(let r=0;r<rounds;r++)for(const [name,fn,count] of r%2?[...jobs].reverse():jobs){const start=performance.now();for(let i=0;i<count;i++)sink=fn();samples.get(name)!.push((performance.now()-start)/count)}
 for(const [name,values] of samples){const sorted=[...values].sort((a,b)=>a-b);results.push({case:label,operation:name,p50_ms:sorted[Math.floor(rounds/2)],samples_ms:values})}
}
function fixture(n:number){const nodes:any={root:{id:'root',name:'Root',children:[]}};for(let i=0;i<n;i++){const id=`n${i}`;nodes[id]={id,name:`Layer ${i}`,children:[]};nodes[i===0?'root':`n${Math.floor((i-1)/4)}`].children.push(id)}return {id:'d',nodes,pages:[{id:'p',children:['root']}]}}
const actual=JSON.parse(fs.readFileSync('testing/verification-render-low-latency-20261021/real117-repro/document.json','utf8'))
for(const [label,doc] of [['real117',actual],['balanced20000',fixture(20000)],['balanced100000',fixture(100000)]] as const){
 const page=doc.pages[0].id,empty=new Set<string>(),rows=layerTreeRows(doc,page,empty,'');let target=rows[0].id
 for(let i=1;i<rows.length;i++){let end=i+1;while(end<rows.length&&rows[end].depth>rows[i].depth)end++;if(end-i>=16&&end-i<=128){target=rows[i].id;break}}
 const locations=new Map<string,number[]>()
 const children=(ids:string[],at:number[]=[]):any[]=>[...ids].reverse().map((id,i)=>{const location=[...at,i];locations.set(id,location);return {element:id,children:children(doc.nodes[id].children,location)}})
 const elements=children(doc.pages[0].children),location=locations.get(target),folded=new Set([target])
 const model=new IndexTreeModel('probe','phantom'),rendered:any[]=[]
 model.onDidSpliceRenderedNodes((e:any)=>rendered.splice(e.start,e.deleteCount,...e.elements))
 model.splice([0],0,elements)
 const project=()=>rendered.map(r=>({id:r.element,depth:r.depth-1,context:false}))
 assert.deepEqual(project(),rows);model.setCollapsed(location,true);assert.deepEqual(project(),layerTreeRows(doc,page,folded,''));model.setCollapsed(location,false);assert.deepEqual(project(),rows)
 const cache=new LayerRowsCache();cache.read(doc,page,empty,'');let a=0,b=0,c=0
 const start=rows.findIndex(row=>row.id===target)+1;let end=start;while(end<rows.length&&rows[end].depth>rows[start-1].depth)end++
 const segment=rows.slice(start,end),simple=[...rows]
 simple.splice(start,segment.length);assert.deepEqual(simple,layerTreeRows(doc,page,folded,''));simple.splice(start,0,...segment);assert.deepEqual(simple,rows)
 measure(label,[['current.collapse-expand',()=>cache.read(doc,page,++a%2?folded:empty,''),20],['vscode.collapse-expand.known-path',()=>{model.setCollapsed(location,!!(++b%2));return rendered.length},20],['array.collapse-expand.known-range',()=>{++c%2?simple.splice(start,segment.length):simple.splice(start,0,...segment);return simple.length},20],['vscode.rank.known-path',()=>model.getListIndex(location),100]])
}
if(process.argv.includes('--tree-only')){fs.writeFileSync(path.join(out,'tree-comparison.json'),JSON.stringify({runtime:process.version,note:'Known path/range and prebuilt tree. Array case retains a cached descendant segment. Mutable presentation arrays; not React integration.',results},null,2));console.log(JSON.stringify(results.map(({samples_ms,...s})=>s)));process.exit(0)}
const words=Array.from({length:20000},(_,i)=>`Design Component Button Primary ${i}`)
const lowers=words.map(s=>s.toLowerCase()),q='button'
measure('search20000',[['substring.prepared-names',()=>lowers.filter(s=>s.includes(q)),20],['fuzzyScore.prepared-names',()=>{let n=0;for(let i=0;i<words.length;i++)if(fuzzyScore(q,q,0,words[i],lowers[i],0))n++;return n},20]])
assert.equal(fuzzyScore('btn','btn',0,'Button','button',0)!==undefined,true)
// Native source-extracted family/allParents, with exact body hashes checked below.
const geo=fs.readFileSync('frontend/design-client/src/geometry.ts','utf8'),comp=fs.readFileSync('frontend/design-client/src/components.ts','utf8')
const gp=geo.match(/export function allParents\(d: DesignDocument\): Map<string, string> \{([\s\S]*?)\n\}/)!
const fp=comp.match(/export function family\(d: DesignDocument, componentId: string\) \{([\s\S]*?)\n\}/)!
assert(gp&&fp)
const allParents=new Function('d',gp[1].replace('new Map<string, string>()','new Map()')) as (d:any)=>Map<string,string>
const family=new Function('allParents',`return function(d,componentId){${fp[1]}}`)(allParents)
for(const [n,c] of [[2000,100],[20000,200]]){
 const doc:any=fixture(n);doc.nodes.root.componentSet={};for(let i=0;i<c;i++)doc.nodes[`n${i}`].component={variants:{}}
 const baseline=()=>Object.values(doc.nodes).filter((node:any)=>node.component&&!node.instanceOrigin&&`${node.name} ${family(doc,node.id)?.name||''}`.toLowerCase().includes('layer'))
 const once=()=>{const parents=allParents(doc);return Object.values(doc.nodes).filter((node:any)=>{const parent=parents.get(node.id),owner=parent&&doc.nodes[parent]?.componentSet?doc.nodes[parent]:undefined;return node.component&&!node.instanceOrigin&&`${node.name} ${owner?.name||''}`.toLowerCase().includes('layer')})}
 assert.deepEqual(baseline(),once());measure(`assets-${n}nodes-${c}components`,[['current.filter',baseline,1],['shared-parent-map.filter',once,1]],7)
}
const behavior:any={}
const throttler=new Throttler(),ran:number[]=[];let release!:()=>void
const gate=new Promise<void>(r=>release=r)
const promises=Array.from({length:100},(_,i)=>throttler.queue(async()=>{ran.push(i);if(i===0)await gate;return i}));release();await Promise.all(promises);assert.deepEqual(ran,[0,99]);throttler.dispose();behavior.throttler={requests:100,executed:ran}
const delayer=new Delayer(0);let count=0;await Promise.all(Array.from({length:100},(_,i)=>delayer.trigger(()=>{count++;return i})));assert.equal(count,1);delayer.dispose();behavior.delayer={requests:100,executed:count}
const limiter=new Limiter(1);let finish!:()=>void;const hold=new Promise<void>(r=>finish=r);const running=limiter.queue(()=>hold);let settled=false;const queued=limiter.queue(async()=>2).then(()=>settled=true,()=>settled=true);limiter.clear();finish();await running;await Promise.resolve();assert.equal(settled,false);limiter.dispose();behavior.limiterClear={queuedPromiseSettled:settled,note:'Dropped queued factory is not rejected by clear; unsuitable as a drop-in request cancellation contract.'};void queued
let disposed=0;const store=new DisposableStore();store.add(toDisposable(()=>disposed++));store.dispose();store.dispose();assert.equal(disposed,1);behavior.disposableStore={doubleDisposeCalls:disposed}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
fs.writeFileSync(path.join(out,'probe-results.json'),JSON.stringify({runtime:process.version,rounds:'15; assets 7',note:'CPU-only local probes; known paths/prebuilt models; excludes React, DOM, editor transactions and GPU; search semantics differ.',extractedSourceSha256:{allParents:hash(gp[0]),family:hash(fp[0])},results,behavior},null,2))
console.log(JSON.stringify({results:results.map(({samples_ms,...s})=>s),behavior},null,2))
