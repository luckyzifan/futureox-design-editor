import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import {createRequire} from 'node:module';
const root=process.cwd(),require=createRequire(path.join(root,'frontend/design-client/package.json'));
const {TraceMap,originalPositionFor}=require('@jridgewell/trace-mapping');
const out=process.argv[2],assetDir=path.join(process.env.DESIGN_DESKTOP_ROOT||path.join(root,'frontend/design-desktop'),'dist/renderer/assets');
let identity;try{identity=JSON.parse(await readFile(path.join(out,'runtime-artifacts.json'),'utf8'))}catch{identity=JSON.parse(await readFile(path.join(out,'../identity-check.json'),'utf8'))}
for(const [relative,expected] of Object.entries(identity.artifacts)){const actual=createHash('sha256').update(await readFile(path.join(root,relative))).digest('hex');if(actual!==expected)throw Error('Runtime/source map identity mismatch: '+relative)}
const maps=new Map();for(const file of await readdir(assetDir))if(file.endsWith('.map'))maps.set(file.slice(0,-4),new TraceMap(JSON.parse(await readFile(path.join(assetDir,file),'utf8'))));
let wasmNames={};try{const symbolIdentity=JSON.parse(await readFile(path.join(root,'testing/verification-render-local-20261020/wasm-symbol-identity.json'),'utf8'));const wasmHash=createHash('sha256').update(await readFile(path.join(root,'frontend/design-client/public/kernel/design_kernel_bg.wasm'))).digest('hex');if(wasmHash!==symbolIdentity.productionSha256)throw Error('WASM symbols mismatch');wasmNames=JSON.parse(await readFile(path.join(root,'testing/verification-render-local-20261020/wasm-names.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const results=[],charts=[];
for(const file of (await readdir(out)).filter(f=>f.endsWith('.cpuprofile')).sort()){
 const p=JSON.parse(await readFile(path.join(out,file),'utf8'));if(!p?.nodes)continue;
 const nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map();for(const n of p.nodes)for(const child of n.children||[])parents.set(child,n.id);
 const labels=new Map(),positions=new Map();for(const n of p.nodes){const f=n.callFrame;let name=f.functionName||'(anonymous)',location=f.url||'';const map=maps.get(path.basename(f.url||''));if(map&&f.lineNumber>=0){const o=originalPositionFor(map,{line:f.lineNumber+1,column:f.columnNumber});if(o.source){location=`${o.source}:${o.line}`;if(o.name)name=o.name}}
 const wasm=name.match(/wasm-function\[(\d+)\]|\$func(\d+)/);if(wasm&&wasmNames[wasm[1]||wasm[2]])name=wasmNames[wasm[1]||wasm[2]];
 labels.set(n.id,name);positions.set(n.id,location);
 }
 const self=new Map(),total=new Map(),stackCache=new Map();let elapsed=0,active=0,idle=0,gc=0,unknown=0;
 const tree={name:'Sampled active CPU',ms:0,children:new Map()};
 for(let i=0;i<(p.samples||[]).length;i++){
  const id=p.samples[i],ms=(p.timeDeltas[i]||0)/1000;elapsed+=ms;const name=labels.get(id)||'(unknown)';self.set(id,(self.get(id)||0)+ms);
  let stack=stackCache.get(id);if(!stack){stack=[];let key=id;while(key&&nodes.has(key)){stack.unshift(key);key=parents.get(key)}stackCache.set(id,stack)}
  for(const key of stack)total.set(key,(total.get(key)||0)+ms);
  if(name==='(idle)'){idle+=ms;continue}if(name==='(program)'){unknown+=ms;continue}if(name==='(garbage collector)')gc+=ms;
  active+=ms;tree.ms+=ms;let t=tree;for(const key of stack){const label=labels.get(key);if(label==='(root)')continue;const loc=positions.get(key);const k=label+' '+loc;if(!t.children.has(k))t.children.set(k,{name:label,location:loc,ms:0,children:new Map()});t=t.children.get(k);t.ms+=ms;}
 }
 const aggregate=(source)=>{const a=new Map();for(const [id,ms]of source){const label=labels.get(id),location=positions.get(id),key=label+' '+location;const row=a.get(key)||{name:label,location,ms:0};row.ms+=ms;a.set(key,row)}return [...a.values()].sort((a,b)=>b.ms-a.ms)};
 const summary={file,samples:p.samples?.length,elapsedMs:elapsed,activeMs:active,idleMs:idle,programMs:unknown,gcMs:gc,topSelf:aggregate(self).slice(0,35),topInclusive:aggregate(total).filter(x=>!['(root)','(idle)','(program)'].includes(x.name)).slice(0,40)};results.push(summary);
 const W=1500,H=24,rects=[];let maxDepth=0;
 function walk(n,x,w,depth){if(w<1)return;maxDepth=Math.max(maxDepth,depth);let hue=0;for(const c of n.name)hue=(hue*31+c.charCodeAt(0))%55;rects.push(`<g><title>${escape(n.name)} — ${n.ms.toFixed(2)} ms\n${escape(n.location||'')}</title><rect x="${x.toFixed(2)}" y="${depth*H}" width="${Math.max(0,w-.5).toFixed(2)}" height="23" fill="hsl(${hue+5} 82% 69%)"/><text x="${(x+3).toFixed(2)}" y="${depth*H+16}" font-size="11">${escape(n.name.replace(/^futureox_design_kernel::/,'kernel::').replace(/::h[0-9a-f]{16}/g,'').slice(0,Math.max(0,Math.floor((w-8)/6))))}</text></g>`);let offset=x;for(const c of [...n.children.values()].sort((a,b)=>b.ms-a.ms)){const cw=w*c.ms/n.ms;walk(c,offset,cw,depth+1);offset+=cw}}
 walk(tree,0,W,0);
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${(maxDepth+1)*H}" style="font-family:monospace">${rects.join('')}</svg>`;
 await writeFile(path.join(out,file.replace('.cpuprofile','.svg')),svg);
 charts.push(`<section><h2>${escape(file)}</h2><p>真实 CDP CPU 样本 ${summary.samples} · 活动栈 ${active.toFixed(1)} ms · idle ${idle.toFixed(1)} ms · program/unattributed ${unknown.toFixed(1)} ms。横向宽度为累计采样耗时；此图排除 idle/program，不是时间线，不能用来量化 GPU 时间。</p><div class="chart">${svg}</div><details><summary>Self time 前 20</summary><table>${summary.topSelf.slice(0,20).map(r=>`<tr><td>${escape(r.name)}</td><td>${r.ms.toFixed(1)} ms</td><td>${escape(r.location)}</td></tr>`).join('')}</table></details></section>`);
}
await writeFile(path.join(out,'cpu-summary.json'),JSON.stringify(results,null,2));
await writeFile(path.join(out,'flamegraphs.html'),`<!doctype html><meta charset="utf-8"><title>Futureox 实测 CPU 火焰图</title><style>body{font:15px system-ui;margin:32px;background:#f5f5f3;color:#202020}h1{font-size:27px}section{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin:24px 0}.chart{max-height:650px;overflow:auto}table{font:12px monospace;width:100%}td{padding:5px;border-bottom:1px solid #ddd}p{color:#555}</style><h1>Futureox · 真实 Electron CPU 火焰图</h1><p>本地 release 构建；主线程与 Worker 分开采样；1 ms 目标间隔；采样及诊断存在开销。悬停色块查看函数和源位置。保留原始 .cpuprofile 可在 DevTools 中打开。名称仍为 wasm-function 的部分尚未解析，不能冒称 Rust 符号。</p>${charts.join('')}`);
console.log(JSON.stringify(results.map(r=>({file:r.file,activeMs:r.activeMs,idleMs:r.idleMs,top:r.topSelf.slice(0,7)})),null,2));
