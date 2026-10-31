import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
const root=process.cwd(),file=process.argv[2],req=createRequire(path.join(root,'frontend/design-client/package.json'))
const {TraceMap,originalPositionFor}=req('@jridgewell/trace-mapping')
const wasmNames=JSON.parse(await fs.readFile(path.join(root,'testing/investigation-fig-pan-drag-20261031/wasm-function-names.json'),'utf8'))
const profile=JSON.parse(await fs.readFile(file,'utf8')),nodes=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map(),maps=new Map(),labels=new Map(),self=new Map(),inclusive=new Map()
for(const n of profile.nodes)for(const id of n.children||[])parents.set(id,n.id)
for(const n of profile.nodes){const f=n.callFrame;let label=f.functionName||'(anonymous)';const wasm=/^wasm-function\[(\d+)\]$/.exec(label);if(wasm&&wasmNames[wasm[1]])label=wasmNames[wasm[1]].replace(/::h[0-9a-f]+$/,'')
 if(f.url.startsWith('design-app://')){const rel=new URL(f.url).pathname;let map=maps.get(rel)
  if(map===undefined){try{map=new TraceMap(JSON.parse(await fs.readFile(path.join(root,'frontend/design-desktop/dist/renderer',rel+'.map'),'utf8')))}catch{map=null}maps.set(rel,map)}
  if(map){const p=originalPositionFor(map,{line:f.lineNumber+1,column:f.columnNumber});label=`${p.source}:${p.line}:${p.column} ${p.name||label}`}
 }
 labels.set(n.id,label)
}
for(let i=0;i<profile.samples.length;i++){let id=profile.samples[i],ms=profile.timeDeltas[i]/1000;const label=labels.get(id);self.set(label,(self.get(label)||0)+ms)
 const seen=new Set();while(id!==undefined){const key=labels.get(id);if(!seen.has(key)){inclusive.set(key,(inclusive.get(key)||0)+ms);seen.add(key)}id=parents.get(id)}
}
const sorted=map=>[...map].sort((a,b)=>b[1]-a[1]).map(([source,ms])=>({source,ms}))
const result={totalMs:(profile.endTime-profile.startTime)/1000,self:sorted(self).slice(0,40),inclusive:sorted(inclusive).slice(0,60)}
await fs.writeFile(path.join(path.dirname(file),'profile-summary-named.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify({totalMs:result.totalMs,inclusive:result.inclusive.slice(0,25)},null,2))
