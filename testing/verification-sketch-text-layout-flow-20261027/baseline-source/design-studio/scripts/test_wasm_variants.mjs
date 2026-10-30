import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const folders=[process.env.DESIGN_SCALAR_BINDINGS,process.env.DESIGN_SIMD_BINDINGS]
if(folders.some(p=>!p))throw Error('Set DESIGN_SCALAR_BINDINGS and DESIGN_SIMD_BINDINGS to isolated build-web.py outputs')
const variants=await Promise.all(folders.map(async folder=>{
  const bytes=await readFile(resolve(folder,'design_kernel_bg.wasm'))
  const compiled=await WebAssembly.compile(bytes)
  const binding=await import(pathToFileURL(resolve(folder,'design_kernel.js')).href)
  await binding.default({module_or_path:compiled})
  return {binding,compiled}
}))
const sameWords=(a,b)=>assert.deepEqual(new Uint32Array(a.buffer,a.byteOffset,a.length),new Uint32Array(b.buffer,b.byteOffset,b.length))
const font=await readFile(new URL('../../frontend/design-client/public/fonts/NotoSansSC.ttf',import.meta.url))
const fill=color=>({kind:'solid',color,opacity:1,visible:true,blend:'normal'})
function document(effect){
  const front={id:'f',kind:'rectangle',width:31.375,height:25.625,transform:[1,0,0,1,9.125,6.375],radii:[5,5,5,5],opacity:.7,blend:'multiply',fills:[fill('#ee6655')],effects:effect?[{color:"#000000",opacity:1,x:0,y:0,spread:0,amount:0,...effect}]:[]}
  return {schemaVersion:5,id:'unit',name:'exact SIMD unit',pages:[{id:'p',name:'p',background:'#f2f2f2',children:['b','f','t']}],nodes:{
    b:{id:'b',kind:'rectangle',width:64,height:48,fills:[{...fill('#224466'),kind:'linear',angle:25,stops:[{offset:0,color:'#224466',opacity:1},{offset:1,color:'#88ccaa',opacity:.5}]}]},
    f:front,t:{id:'t',kind:'text',text:'A中ffi',fontSize:12,width:58,height:20,transform:[1,0,0,1,2.375,25.125],fills:[fill('#112233')]}}}
}
function engines(doc){return variants.map(({binding})=>{const engine=new binding.VectorEngine();engine.load_font(font);engine.load_document(JSON.stringify(doc));return engine})}
test('SIMD feature is isolated; optional name stripping preserves usable modules',()=>{
  const features=variants.map(v=>WebAssembly.Module.customSections(v.compiled,'target_features').map(b=>new TextDecoder().decode(b)).join(''))
  assert.equal(features[0].includes('simd128'),false);assert.equal(features[1].includes('simd128'),true)
  for(const v of variants)assert.equal(WebAssembly.Module.customSections(v.compiled,'name').length,0)
})
for(const profile of ['analytic','figmaSubpixel','figmaSoftware'])test(`scalar/SIMD exact pixels and coverage packets: ${profile}`,()=>{
  const effects=[undefined,{kind:'background-blur',radius:3,visible:true},{kind:'glass',radius:3,visible:true,glass:{lightIntensity:.5,lightAngle:45,refraction:.5,depth:8,dispersion:.3}}]
  for(const effect of effects){const pair=engines(document(effect));try{
    for(const zoom of [.6,1,1.25]){
      const options=JSON.stringify({pageId:'p',width:64,height:48,view:{x:.375,y:-.125,zoom},grid:false,transparent:false,rasterProfile:profile})
      assert.deepEqual(pair[0].render_rgba(options),pair[1].render_rgba(options))
      if(profile!=='figmaSoftware')assert.deepEqual(pair[0].compile_gpu_packet(options),pair[1].compile_gpu_packet(options))
    }
  }finally{for(const engine of pair)engine.free()}}
})
test('SDR color conversions preserve every float/output byte across build variants',()=>{
  const settings=JSON.stringify({documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000})
  const values=new Float32Array([.1,.2,.3,.5,0,0,0,0,1.2,-.125,.75,1,-0,.0031308,.04045,1])
  assert.deepEqual(variants[0].binding.color_encode_rgba8(values,settings),variants[1].binding.color_encode_rgba8(values,settings))
  for(const space of ['srgb','display-p3','rec2020','a98-rgb','prophoto-rgb'])sameWords(variants[0].binding.color_encode_display(values,settings,space),variants[1].binding.color_encode_display(values,settings,space))
})
