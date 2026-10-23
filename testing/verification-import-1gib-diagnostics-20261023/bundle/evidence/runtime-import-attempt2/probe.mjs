import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const B='/workspace/shared/native-import-policy-20261023T0129Z',mode=process.argv[2],sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const root='/tmp/canvas-hourly-backend-only-20261022T1830Z/source/frontend/design-client';
const js=mode==='new'?B+'/full-wasm/generated/design_kernel.js':root+'/src/generated/design-kernel/design_kernel.js';
const wp=mode==='new'?B+'/full-wasm/generated/design_kernel_bg.wasm':root+'/public/kernel/design_kernel_bg.wasm';
const wasm=fs.readFileSync(wp);assert.equal(sha(wasm),mode==='new'?'09ff44d26dbd365a7551a9de56d135c21fb44b387d8f11a51b155887f84d9b28':'e7940afed3992ac586e34d3fc2816e23c77265992645524c0ef20e001b953613');
const mod=await import(pathToFileURL(js));await mod.default({module_or_path:wasm});assert.equal(typeof mod.import_sketch_json,'function');
const bytes=fs.readFileSync('/workspace/shared/design-real-file-20261020/117.sketch');assert.equal(bytes.length,5013257);assert.equal(sha(bytes),'d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70');
const begin=performance.now(),raw=mod.import_sketch_json(bytes),r=JSON.parse(raw),d=r.document??r;
assert.ok(d.nodes&&Array.isArray(d.pages));const ids=new Set(Object.keys(d.nodes));assert.equal(ids.size,753);assert.equal(d.pages.length,1);
let edges=0;for(const [id,n] of Object.entries(d.nodes)){assert.equal(n.id,id);for(const child of n.children??[]){assert.ok(ids.has(child));edges++;}}for(const p of d.pages)for(const id of p.children)assert.ok(ids.has(id));
const result={mode,wasmSha256:sha(wasm),inputSha256:sha(bytes),inputBytes:bytes.length,outputSha256:sha(raw),outputBytes:Buffer.byteLength(raw),pages:d.pages.length,nodes:ids.size,childReferences:edges,importWallMs:performance.now()-begin,reportKeys:Object.keys(r),negative:[]};
for(const [name,bad] of [['notZip',Buffer.from('not a zip')],['truncated',bytes.subarray(0,100)]]){let error;try{mod.import_sketch_json(bad)}catch(e){error=String(e)}assert.ok(error);result.negative.push({name,error});}
fs.writeFileSync(B+'/runtime-import/'+mode+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
