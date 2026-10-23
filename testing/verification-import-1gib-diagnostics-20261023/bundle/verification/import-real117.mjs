import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const [js,wp,input,expectedWasm,output]=process.argv.slice(2);assert.ok(output,'Usage: node import-real117.mjs bindings.js kernel.wasm 117.sketch expectedWasmSHA256 result.json');const mode='source-matched-caller-build',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const wasm=fs.readFileSync(wp);assert.equal(sha(wasm),expectedWasm);const mod=await import(pathToFileURL(js));await mod.default({module_or_path:wasm});assert.equal(typeof mod.import_sketch_json,'function');
const bytes=fs.readFileSync(input);assert.equal(bytes.length,5013257);assert.equal(sha(bytes),'d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70');
const begin=performance.now(),raw=mod.import_sketch_json(bytes),r=JSON.parse(raw),d=r.document??r;
assert.ok(d.nodes&&Array.isArray(d.pages));const ids=new Set(Object.keys(d.nodes));assert.equal(ids.size+d.pages.length,753);assert.equal(d.pages.length,1);
let edges=0;for(const [id,n] of Object.entries(d.nodes)){assert.equal(n.id,id);for(const child of n.children??[]){assert.ok(ids.has(child));edges++;}}for(const p of d.pages)for(const id of p.children)assert.ok(ids.has(id));
const result={mode,wasmSha256:sha(wasm),inputSha256:sha(bytes),inputBytes:bytes.length,outputSha256:sha(raw),outputBytes:Buffer.byteLength(raw),pages:d.pages.length,nodes:ids.size,childReferences:edges,importWallMs:performance.now()-begin,reportKeys:Object.keys(r),negative:[]};
for(const [name,bad] of [['notZip',Buffer.from('not a zip')],['truncated',bytes.subarray(0,100)]]){let error;try{mod.import_sketch_json(bad)}catch(e){error=String(e)}assert.ok(error);result.negative.push({name,error});}
fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
