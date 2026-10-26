import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import path from 'node:path'
const root=process.cwd(),require=createRequire(path.join(root,'frontend/design-client/package.json'))
const {TraceMap,originalPositionFor}=require('@jridgewell/trace-mapping')
const directory=process.argv[2],assets=process.argv[3]||'/Users/Apple/project/design-kernel/frontend/design-desktop/dist/renderer/assets',maps=new Map(),results=[]
const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'))
for(const item of manifest.results){
 if(!item.file)continue
 const p=JSON.parse(await readFile(path.join(directory,item.file),'utf8')),nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map(),labels=new Map(),self=new Map(),inclusive=new Map();let negative=0
 for(const node of p.nodes){for(const child of node.children||[])parents.set(child,node.id)
  const f=node.callFrame;let original
  try{const base=path.basename(new URL(f.url).pathname);if(!maps.has(base))maps.set(base,new TraceMap(JSON.parse(await readFile(path.join(assets,base+'.map'),'utf8'))));original=originalPositionFor(maps.get(base),{line:f.lineNumber+1,column:f.columnNumber})}catch{}
  labels.set(node.id,{name:original?.name||f.functionName||'(anonymous)',source:original?.source||f.url,line:original?.line||f.lineNumber+1,column:original?.column||f.columnNumber})
 }
 for(let i=0;i<(p.samples||[]).length;i++){const ms=p.timeDeltas[i]/1000;if(ms<0){negative++;continue}const id=p.samples[i];self.set(id,(self.get(id)||0)+ms);let at=id;while(at!==undefined){inclusive.set(at,(inclusive.get(at)||0)+ms);at=parents.get(at)}}
 const summarize=counts=>[...counts].map(([id,ms])=>({id,ms,...labels.get(id)})).sort((a,b)=>b.ms-a.ms)
 const row={target:item.target,negative,exclusive:summarize(self).slice(0,35),inclusive:summarize(inclusive).slice(0,40)};results.push(row)
 console.log(JSON.stringify({target:item.target,exclusive:row.exclusive.slice(0,15),inclusive:row.inclusive.slice(0,15)}))
}
await writeFile(path.join(directory,'summary.json'),JSON.stringify(results,null,2)+'\n')
