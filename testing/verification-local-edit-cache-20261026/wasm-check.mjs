import {readFile,writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const root=process.argv[2],out=new URL('./wasm-check.json',import.meta.url)
const file=root+'/frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm',bytes=await readFile(file)
const kernel=await import(pathToFileURL(root+'/frontend/design-client/src/generated/design-kernel/design_kernel.js'))
await kernel.default({module_or_path:bytes})
const options=JSON.stringify({pageId:'p',width:256,height:128,view:{x:0,y:0,zoom:1}})
const base={schemaVersion:16,id:'wasm-local',name:'wasm-local',colorManagement:{documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000},
  pages:[{id:'p',name:'p',background:'#ffffff',children:['stack','far']}],nodes:{
    stack:{id:'stack',kind:'frame',width:120,height:80,transform:[1,0,0,1,10,10],children:['a','b'],layout:{mode:'horizontal',gap:10}},
    a:{id:'a',kind:'rectangle',width:30,height:30,transform:[1,0,0,1,9000,9000],fills:[{kind:'solid',color:'color(srgb-linear 8 -8 0.125 / 0.5)'}]},
    b:{id:'b',kind:'rectangle',width:30,height:30,fills:[{kind:'solid',color:'#00ff00'}]},
    far:{id:'far',kind:'rectangle',width:40,height:40,transform:[1,0,0,1,180,10],fills:[{kind:'solid',color:'#0000ff'}]}}}
const rows=[]
for(const mask of [false,true]){
  const doc=structuredClone(base)
  if(mask){delete doc.nodes.stack.layout;doc.nodes.a.transform=[1,0,0,1,0,0];doc.nodes.a.mask=true}
  const live=new kernel.VectorEngine(),fresh=new kernel.VectorEngine()
  try{
    live.load_document(JSON.stringify(doc));live.render_linear(options)
    const next=structuredClone(doc);next.nodes.a.opacity=0.5
    const damage=JSON.parse(live.apply_document_patch_with_damage(JSON.stringify({fields:{},nodes:{a:next.nodes.a}})))
    assert.equal(damage.full,false)
    fresh.load_document(JSON.stringify(next))
    const actual=live.render_linear(options),expected=fresh.render_linear(options)
    assert.deepEqual(new Uint8Array(actual.buffer,actual.byteOffset,actual.byteLength),new Uint8Array(expected.buffer,expected.byteOffset,expected.byteLength))
    rows.push({case:mask?'nested-mask':'resolved-layout-material',damage,floatWords:actual.length,exact:true})
  }finally{live.free();fresh.free()}
}
await writeFile(out,JSON.stringify({status:'passed',wasmSha256:createHash('sha256').update(bytes).digest('hex'),rows},null,2)+'\n')
console.log('actual WASM: 2 exact incremental/fresh float cases passed')
