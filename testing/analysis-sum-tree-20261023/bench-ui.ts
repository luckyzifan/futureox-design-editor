// Isolated CPU probes. No Editor, DOM, GPU, import, or mutation timing is included.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { LayerRowsCache, layerTreeRows } from '../../frontend/design-client/src/layer-tree'
import { certifyLayerTransition } from '../../frontend/design-client/src/layer-row-transition'
import { layerSelection } from '../../frontend/design-client/src/layer-selection'

let sink: unknown
const samples: any[] = []
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function fixture(n: number, shape: string): any {
  const nodes: any = {root: {id:'root', name:'Root', children:[]}}
  for (let i=0;i<n;i++) {
    const id=`n${i}`; nodes[id]={id,name:`Layer ${i}`,children:[]}
    const parent=shape==='wide'||i===0?'root':`n${Math.floor((i-1)/4)}`
    nodes[parent].children.push(id)
  }
  return {id:`synthetic-${shape}-${n}`,nodes,pages:[{id:'p',children:['root']}]}
}
function timed(name: string, fn: () => unknown, iterations: number) {
  const start=performance.now()
  for(let i=0;i<iterations;i++) sink=fn()
  return (performance.now()-start)/iterations
}
function run(label: string, doc: any) {
  const page=doc.pages[0].id, empty=new Set<string>()
  const rows=layerTreeRows(doc,page,empty,''), n=rows.length
  const rank=new Map(rows.map((r,i)=>[r.id,i]))
  // Find a small subtree, and calculate its known contiguous visible range outside timing.
  let at=Math.floor(n/3), remove=0
  for(let i=1;i<n;i++) {
    let end=i+1; while(end<n&&rows[end].depth>rows[i].depth) end++
    if(end-i>=16&&end-i<=128) { at=i;remove=end-i-1;break }
  }
  if(!remove) { at=0;remove=n-1 }
  const folded=new Set([rows[at].id])
  const expected=layerTreeRows(doc,page,folded,'')
  const splice=()=>rows.slice(0,at+1).concat(rows.slice(at+1+remove))
  if(JSON.stringify(splice())!==JSON.stringify(expected)) throw Error('splice oracle mismatch')
  const leaf=rows.at(-1)!.id
  const edited={...doc,nodes:{...doc.nodes,[leaf]:{...doc.nodes[leaf],opacity:.314}}}
  certifyLayerTransition(doc,edited,{[leaf]:edited.nodes[leaf]})
  certifyLayerTransition(edited,doc,{[leaf]:doc.nodes[leaf]})
  const certified=new LayerRowsCache(); certified.read(doc,page,empty,''); let c=0
  const uncA={...doc},uncB={...edited}, fallback=new LayerRowsCache(); fallback.read(uncA,page,empty,''); let u=0
  const foldCache=new LayerRowsCache(); foldCache.read(doc,page,empty,''); let f=0
  const target=rows[Math.floor(n*.9)].id, anchor=rows[Math.max(0,Math.floor(n*.9)-40)].id
  const query=label.startsWith('real')?(doc.nodes[target].name||'').slice(0,2):'Layer 17'
  const jobs: [string,()=>unknown,number][] = [
    ['rebuild.all',()=>layerTreeRows(doc,page,empty,''),20],
    ['rebuild.search',()=>layerTreeRows(doc,page,empty,query),10],
    ['cache.certified.property',()=>certified.read(++c%2?edited:doc,page,empty,''),2000],
    ['cache.uncertified.property',()=>fallback.read(++u%2?uncB:uncA,page,empty,''),10],
    ['cache.toggle.branch',()=>foldCache.read(doc,page,++f%2?folded:empty,''),20],
    ['array.collapse.knownRange',splice,20],
    ['select.current.single',()=>layerSelection(rows.map(r=>r.id),[],target,null),100],
    ['select.current.range40',()=>layerSelection(rows.map(r=>r.id),[],target,anchor,{range:true}),100],
    ['rank.build',()=>new Map(rows.map((r,i)=>[r.id,i])),10],
    ['rank.lookup',()=>rank.get(target),5000],
    ['viewport.slice40',()=>rows.slice(Math.floor(n/2),Math.floor(n/2)+40),1000],
  ]
  for(const [name,fn] of jobs) timed(name,fn,10)
  const data=new Map(jobs.map(([name])=>[name,[] as number[]]))
  // Alternate ordering across 21 rounds; each entry is a batch-average per operation.
  for(let round=0;round<21;round++) for(const [name,fn,iterations] of round%2?[...jobs].reverse():jobs)
    data.get(name)!.push(timed(name,fn,iterations))
  for(const [name,values] of data) {
    const sorted=[...values].sort((a,b)=>a-b)
    samples.push({fixture:label,totalNodes:Object.keys(doc.nodes).length,visibleRows:n,collapsedRows:remove,operation:name,
      p50_ms:sorted[10],p95_batch_ms:sorted[19],samples_ms:values})
  }
  if(certified.stats.builds!==1||certified.stats.nodeChecks!==0) throw Error('certified path missed')
}
const realPath='testing/verification-render-low-latency-20261021/real117-repro/document.json'
const raw=readFileSync(realPath,'utf8')
run('real117',JSON.parse(raw))
run('synthetic-wide-20000',fixture(20000,'wide'))
run('synthetic-balanced-20000',fixture(20000,'balanced'))
run('synthetic-balanced-100000',fixture(100000,'balanced'))
const sourceFiles=['frontend/design-client/src/layer-tree.ts','frontend/design-client/src/layer-row-transition.ts','frontend/design-client/src/layer-selection.ts']
const result={runtime:process.version,engine:typeof Bun==='undefined'?'Node/V8':'Bun/JSC',cpu:os.cpus()[0].model,
  fixture:{path:realPath,sha256:hash(raw)},sources:Object.fromEntries(sourceFiles.map(p=>[p,hash(readFileSync(p,'utf8'))])),
  note:'CPU-only, prebuilt documents; p95 is of batch means, not per-input tail latency. No sum_tree code is used in this JS probe.',samples}
writeFileSync(process.argv[2]||'/tmp/sum-tree-ui-results.json',JSON.stringify(result,null,2))
console.log(JSON.stringify(samples.map(({samples_ms,...s})=>s),null,2))
if(!sink) throw Error('unconsumed result')
