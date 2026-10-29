import {createRequire} from 'node:module'
import {readFileSync,writeFileSync} from 'node:fs'
const require=createRequire(new URL('../../frontend/design-client/package.json',import.meta.url))
const {compileSchema,decodeBinarySchema}=require('kiwi-schema'),{unzipSync,zipSync,inflateSync,deflateSync}=require('fflate')
const original=unzipSync(readFileSync(new URL('../fixtures/design/figma-materials-native-2026-10-08.fig',import.meta.url)))['canvas.fig']
const length=new DataView(original.buffer,original.byteOffset,original.byteLength).getUint32(12,true),schemaPart=original.slice(16,16+length)
const schema=decodeBinarySchema(inflateSync(schemaPart)),encoder=compileSchema(schema)
const guid=localID=>({sessionID:1,localID}),rgb=(r,g,b,a=1)=>({r,g,b,a}),solid=(c,extra={})=>({type:'SOLID',color:c,...extra})
const nodes=[{guid:guid(1),type:'DOCUMENT',documentColorProfile:'SRGB'}, {guid:guid(2),type:'CANVAS',name:'Contract',parentIndex:{guid:guid(1),position:'a'}}]
function add(id,name,props={}) {nodes.push({guid:guid(id),type:'RECTANGLE',name,parentIndex:{guid:guid(2),position:String.fromCharCode(65+id)},size:{x:40,y:24},fillPaints:[solid(rgb(1,0,0))],...props})}
add(3,'Disabled gradient',{blendMode:'PASS_THROUGH',fillPaints:[{type:'GRADIENT_LINEAR',visible:false,opacity:.5,blendMode:'LINEAR_BURN',stops:[{position:0,color:rgb(.125,.25,.5,.125)},{position:1,color:rgb(1,1,1,.75)}]}]})
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'))
for(const [index,mode] of ['STRETCH','FIT','FILL','TILE'].entries())add(4+index,mode,{fillPaints:[{type:'IMAGE',image:index%2?{hash:new Uint8Array([10,255])}:{dataBlob:0},imageScaleMode:mode}]})
add(8,'XOR',{type:'BOOLEAN_OPERATION',booleanOperation:'XOR'})
add(9,'Operand A',{parentIndex:{guid:guid(8),position:'a'}});add(10,'Operand B',{parentIndex:{guid:guid(8),position:'b'},transform:{m00:1,m01:0,m02:20,m10:0,m11:1,m12:0}})
add(11,'Zero line',{type:'LINE',size:{x:40,y:0},fillPaints:[],strokePaints:[solid(rgb(0,0,0))],strokeWeight:0})
add(12,'Master',{type:'SYMBOL',componentPropDefs:[{id:guid(100),name:'Shown',type:'BOOL',initialValue:{boolValue:true}},{id:guid(101),name:'Label',type:'TEXT',initialValue:{textValue:{characters:'Default'}}}]})
add(13,'Template text',{type:'TEXT',textData:{characters:'Original'},parentIndex:{guid:guid(12),position:'a'},componentPropRefs:[{defID:guid(100),componentPropNodeField:'VISIBLE'},{defID:guid(101),componentPropNodeField:'TEXT_DATA'}]})
add(14,'Instance',{type:'INSTANCE',symbolData:{symbolID:guid(12)},componentPropAssignments:[{defID:guid(100),value:{boolValue:false}},{defID:guid(101),value:{textValue:{characters:'Edited'}}}]})
const message=encoder.encodeMessage({nodeChanges:nodes,blobs:[{bytes:png}]}),parts=[schemaPart,deflateSync(message)]
const bytes=new Uint8Array(12+parts.reduce((n,p)=>n+4+p.length,0)),view=new DataView(bytes.buffer);bytes.set(new TextEncoder().encode('fig-kiwi'));view.setUint32(8,106,true)
let offset=12;for(const part of parts){view.setUint32(offset,part.length,true);bytes.set(part,offset+4);offset+=part.length+4}
writeFileSync(new URL('../fixtures/design/fig-interop-v106.fig',import.meta.url),zipSync({'canvas.fig':bytes,'images/0aff':png}))
writeFileSync(new URL('v106-corpus-source.json',import.meta.url),JSON.stringify({nodeChanges:nodes},null,2)+'\n')
