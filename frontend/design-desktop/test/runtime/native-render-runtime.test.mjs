import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { NativeRenderProcess } from '../../src/native-render.mjs'
const binary=process.env.DESIGN_RENDER_BINARY
// Uses only the explicit CPU backend. No adapter/device/GPU setup is attempted.
const document=JSON.stringify({schemaVersion:1,id:'d',name:'transport-cpu-parity',pages:[{id:'p',name:'p',children:['a','b'],background:'#ffffff'}],nodes:{a:{id:'a',kind:'rectangle',width:64,height:48,fills:[{kind:'solid',color:'#3777e8'}]},b:{id:'b',kind:'ellipse',width:40,height:40,transform:[1,0,0,1,12,4],fills:[{kind:'solid',color:'#c070e0',opacity:.5}]}}})
const stableStats=stats=>Object.fromEntries(Object.entries(stats).filter(([key])=>!['render_ms','last_render_ms'].includes(key)))
test('same-source design-render CPU JSON and FRB1 outputs preserve pixels and stable stats',{skip:!binary&&'Set DESIGN_RENDER_BINARY to the same-source design-render'},async t=>{
 const legacy=new NativeRenderProcess(binary,undefined,'cpu'),raw=new NativeRenderProcess(binary,undefined,'cpu',{protocol:'frb1'})
 t.after(()=>Promise.all([legacy.stop(),raw.stop()]))
 await Promise.all([legacy.load(document),raw.load(document)])
 for(const[width,height,pan]of[[96,64,0],[96,64,0],[137,93,11],[137,93,-3]]){
  const options={pageId:'p',width,height,view:{x:0,y:0,zoom:1},transparent:true}
  const old=await legacy.frame(options,pan),next=await raw.frame(options,pan)
  assert.equal(next.width,old.width);assert.equal(next.height,old.height);assert.equal(next.encoding,'rgba8');assert.equal(next.stats.backend,'cpu')
  assert.deepEqual(next.rgba,new Uint8Array(Buffer.from(old.rgba,'base64')));assert.deepEqual(stableStats(next.stats),stableStats(old.stats));assert.ok(next.rgba.some(byte=>byte!==0))
 }
 await assert.rejects(raw.frame({}),/options|pageId|field/i)
 assert.deepEqual(await raw.stats(),await legacy.stats())
 await Promise.all([legacy.load(document),raw.load(document)])
 const options={pageId:'p',width:33,height:31,view:{x:0,y:0,zoom:1},transparent:true}
 const a=await legacy.frame(options),b=await raw.frame(options);assert.deepEqual(b.rgba,new Uint8Array(Buffer.from(a.rgba,'base64')))
})
test('actual binary rejects unknown protocol before any GPU initialization',{skip:!binary&&'Set DESIGN_RENDER_BINARY'},()=>{
 const result=spawnSync(binary,['--serve','--backend','cpu','--serve-protocol','frb2'],{encoding:'utf8',input:''});assert.notEqual(result.status,0);assert.match(result.stderr,/Unknown native render protocol/);assert.equal(result.stdout,'')
})
