import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto'
const root=process.cwd(),input=process.argv[2],output=process.argv[3]
const wasm=await readFile(root+'/frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm'),kernel=await import(root+'/frontend/design-client/src/generated/design-kernel/design_kernel.js')
await kernel.default({module_or_path:await WebAssembly.compile(wasm)});kernel.configure_document_capacity(1619542016)
const raw=await readFile(input,'utf8'),document=JSON.parse(raw),engine=new kernel.VectorEngine();engine.load_font(new Uint8Array(await readFile(root+'/frontend/design-client/public/fonts/NotoSansSC.ttf')))
const json=JSON.stringify(document),changes=JSON.parse(engine.resolve_components_full(json)),nodes={...document.nodes,...changes.nodes}
for(const id of changes.removed)delete nodes[id]
for(const n of Object.values(changes.nodes))for(const key of ['network','vectorGeometry','layout','sizing','constraints','component','instance','instanceOrigin','componentKey'])if(n[key]===null)delete n[key]
const bytes=v=>v===undefined?0:Buffer.byteLength(JSON.stringify(v)),delta={}
for(const[id,n]of Object.entries(changes.nodes)){const old=document.nodes[id]||{};for(const key of new Set([...Object.keys(old),...Object.keys(n)])){const difference=bytes(n[key])-bytes(old[key]);if(difference)delta[key]=(delta[key]||0)+difference}}
const result={scope:'isolated existing Rust derivation, not renderer performance',sourceSha256:createHash('sha256').update(raw).digest('hex'),wasmSha256:createHash('sha256').update(wasm).digest('hex'),rawBytes:Buffer.byteLength(raw),normalizedBytes:Buffer.byteLength(json),derivedBytes:bytes({...document,nodes}),beforeNodes:Object.keys(document.nodes).length,afterNodes:Object.keys(nodes).length,changedNodes:Object.keys(changes.nodes).length,removedNodes:changes.removed.length,fieldByteDelta:Object.fromEntries(Object.entries(delta).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])))}
engine.free();await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
