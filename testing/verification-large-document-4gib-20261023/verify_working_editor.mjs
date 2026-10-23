// Run with Bun: actual native source service + existing Editor/WASM, no GUI claim.
import {Editor} from '../../frontend/design-client/src/engine.ts'
import {initializePicking,prepareDocumentJsonForEditing} from '../../frontend/design-client/src/kernel/picking.ts'
import {paint} from '../../frontend/design-client/src/model.ts'
import {Sidecar} from '../../frontend/design-desktop/src/sidecar.mjs'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const [binary,input]=process.argv.slice(2);assert(binary&&input)
const root=await mkdtemp(path.join(tmpdir(),'futureox-working-editor-'));const client=new Sidecar(path.resolve(binary),path.join(root,'cache'));let editor
try{
 await initializePicking({wasm:new Uint8Array(await Bun.file('frontend/design-client/public/kernel/design_kernel_bg.wasm').arrayBuffer()),font:new Uint8Array(await Bun.file('frontend/design-client/public/fonts/NotoSansSC.ttf').arrayBuffer())})
 let status=await client.request('large.open',{path:path.resolve(input),documentId:randomUUID(),sessionEpoch:1})
 const request=()=>({owner:status.owner,expectedRevision:status.revision})
 const rows=await client.request('large.children',{...request(),query:'矩形 33',limit:100})
 const row=rows.items.find(r=>r.id==='3D2E8E3B-3B43-4978-987E-03D6BB354BA2');assert(row)
 const read=await client.request('large.read',{...request(),key:row.key})
 const json=read.json.replace('"name":"矩形 33"','"name":"拓扑-本机JSON校验"');assert.notEqual(json,read.json)
 status=await client.request('large.apply',{...request(),key:row.key,json,expectedHash:read.hash,requestId:randomUUID()})
 const projection=await client.request('large.project',{...request(),key:row.key,workingDocumentId:randomUUID()})
 editor=new Editor(prepareDocumentJsonForEditing(projection.json));editor.set({selection:[row.id]})
 editor.updateProperties([row.id],n=>{n.width=180;n.fills.push(paint('#1a4ddd'))})
 assert.equal(editor.state.doc.nodes[row.id].width,180,editor.state.message)
 editor.undo();assert.equal(editor.state.doc.nodes[row.id].width,140)
 editor.redo();assert.equal(editor.state.doc.nodes[row.id].width,180)
 status=await client.request('large.commitCanvas',{...request(),key:row.key,json:JSON.stringify(editor.authoredDocument),requestId:randomUUID()})
 const after=await client.request('large.read',{...request(),key:row.key});const props=JSON.parse(after.json)
 assert.equal(props.frame.width,180);assert(props.style.fills.some(f=>f.isEnabled===true));assert(props.style.fills.some(f=>f.isEnabled===false))
 const output=path.join(root,'working.sketch');await client.request('large.export',{...request(),path:output,requestId:randomUUID()})
 const checked=spawnSync('python3',['testing/verification-large-document-4gib-20261023/verify_export.py',input,output,'--report','native-editor-export-verification.json'],{encoding:'utf8'});assert.equal(checked.status,0,checked.stderr)
 await writeFile('testing/verification-large-document-4gib-20261023/working-editor-result.json',JSON.stringify({passed:true,scope:'real native service + Editor/WASM; graphics/UI not simulated as pixels',sourceObjects:status.indexedObjects,revision:status.revision,width:props.frame.width,paintCount:props.style.fills.length},null,2)+'\n')
 console.log(checked.stdout)
}finally{editor?.dispose();await client.stop();await rm(root,{recursive:true,force:true})}
