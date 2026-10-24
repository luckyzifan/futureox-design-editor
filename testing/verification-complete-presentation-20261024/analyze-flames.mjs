import{readFile,writeFile}from'node:fs/promises'
import{createRequire}from'node:module'
import path from'node:path'
const root=process.cwd(),out=path.resolve(process.argv[2]),identity={host:process.argv[3]},dir=out,manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'))
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{TraceMap,originalPositionFor}=require('@jridgewell/trace-mapping'),maps=new Map(),summaries=[],parts=[]
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')
async function label(frame){
 let file;try{file=path.basename(new URL(frame.url).pathname)}catch{}
 if(file?.endsWith('.js')){
  if(!maps.has(file)){try{maps.set(file,new TraceMap(JSON.parse(await readFile(path.join(identity.host,'dist/renderer/assets',file+'.map'),'utf8'))))}catch{maps.set(file,null)}}
  const map=maps.get(file)
  if(map&&frame.lineNumber>=0){const found=originalPositionFor(map,{line:frame.lineNumber+1,column:frame.columnNumber});if(found.source)return `${found.name||frame.functionName||'(anonymous)'} · ${found.source.replace(/^.*\/src\//,'src/')}:${found.line}`}
 }
 return (frame.functionName||'(anonymous)')+(file?' · '+file+':'+(frame.lineNumber+1):'')
}
for(const row of manifest.results){if(!row.file)continue
 const profile=JSON.parse(await readFile(path.join(dir,row.file),'utf8')),nodes=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map(),labels=new Map(),totals=new Map()
 for(const n of profile.nodes){labels.set(n.id,await label(n.callFrame));for(const id of n.children||[])parents.set(id,n.id)}
 const tree={name:'active samples',ms:0,children:new Map()},rootNode=profile.nodes[0].id;let wall=0,idle=0
 for(let i=0;i<profile.samples.length;i++){
  const ms=(profile.timeDeltas[i]||0)/1000,id=profile.samples[i],name=nodes.get(id)?.callFrame.functionName;wall+=ms
  if(['(idle)','(program)','(root)'].includes(name)){idle+=ms;continue}
  const stack=[];let at=id;while(at&&at!==rootNode){stack.push(labels.get(at));at=parents.get(at)}stack.reverse()
  let branch=tree;branch.ms+=ms
  for(const name of stack){if(!branch.children.has(name))branch.children.set(name,{name,ms:0,children:new Map()});branch=branch.children.get(name);branch.ms+=ms;const v=totals.get(name)||{name,selfMs:0,inclusiveMs:0};v.inclusiveMs+=ms;totals.set(name,v)}
  const own=totals.get(labels.get(id));if(own)own.selfMs+=ms
 }
 const rectangles=[];let maxDepth=0
 function draw(node,x,w,depth){maxDepth=Math.max(maxDepth,depth);if(w<.2)return;const hash=[...node.name].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0,0),color=`hsl(${20+hash%45} 80% ${58+hash%20}%)`
  rectangles.push(`<g><title>${escape(node.name)} — ${node.ms.toFixed(2)} ms</title><rect x="${x}" y="${depth*23}" width="${w}" height="21" fill="${color}" stroke="white"/><text x="${x+3}" y="${depth*23+15}" font-size="11">${escape(w>70?node.name.slice(0,Math.floor(w/6)):'')}</text></g>`)
  let cursor=x;for(const child of [...node.children.values()].sort((a,b)=>b.ms-a.ms)){const width=w*child.ms/node.ms;draw(child,cursor,width,depth+1);cursor+=width}
 }
 draw(tree,0,1400,0)
 const summary={thread:row.target.title||row.target.type,sampledWallMs:wall,idleOrUnassignedMs:idle,activeSampleMs:tree.ms,focus:[...totals.values()].filter(v=>/src\/(Canvas|Layers|Inspector|fields|ViewControls|engine|kernel\/picking|components|LargeDocumentWorkspace|document-patch)/.test(v.name)).sort((a,b)=>b.inclusiveMs-a.inclusiveMs).slice(0,30),topSelf:[...totals.values()].sort((a,b)=>b.selfMs-a.selfMs).slice(0,25)};summaries.push(summary)
 parts.push(`<h2>${summary.thread}</h2><p>采样墙钟 ${wall.toFixed(1)} ms；idle/program ${idle.toFixed(1)} ms；图中活跃采样 ${tree.ms.toFixed(1)} ms。悬停查看函数与源码位置。</p><div style="overflow:auto"><svg width="1400" height="${(maxDepth+1)*23}" xmlns="http://www.w3.org/2000/svg">${rectangles.join('')}</svg></div>`)
}
await writeFile(path.join(out,'flame-summary.json'),JSON.stringify(summaries,null,2))
await writeFile(path.join(out,'flames.html'),`<!doctype html><meta charset="utf-8"><title>真实工作负载 CPU 火焰图</title><style>body{font:15px system-ui;margin:32px;color:#20252d}h1{font-size:24px}svg text{pointer-events:none}p{max-width:1100px;line-height:1.6}</style><h1>真实工作负载：CPU 采样火焰图</h1><p>同一独立进程，以实际鼠标/键盘操作采样。采样改变耗时，不能代替无 profiler 延迟 A/B；native Rust 与 GPU 执行不在 V8 栈内。inclusive 时间包含子调用，不可逐项相加。program 为未归属采样时间，不能全部解释为 idle；采样不是实际调用次数。范围和场景见同目录 manifest。</p>${parts.join('')}`)
console.log(JSON.stringify(summaries.map(s=>({...s,topSelf:s.topSelf.slice(0,8)}))))
