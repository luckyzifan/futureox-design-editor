import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeRenderProcess } from '../../src/native-render.mjs'
const binary=process.env.DESIGN_RENDER_CODEC_FIXTURE
const expected=(width,height)=>Uint8Array.from({length:width*height*4},(_,i)=>(i*13+i%251)&255)
test('production Rust encoder and Node receiver agree across real stdio with legacy parity',{skip:!binary&&'Set DESIGN_RENDER_CODEC_FIXTURE to the same-source CPU codec fixture'},async t=>{
 const old=new NativeRenderProcess(binary,undefined,'cpu'),raw=new NativeRenderProcess(binary,undefined,'cpu',{protocol:'frb1'})
 t.after(()=>Promise.all([old.stop(),raw.stop()]))
 await Promise.all([old.load('{}'),raw.load('{}')])
 for(const[width,height]of[[1,1],[96,64],[513,257],[3840,2160]]){
  const legacy=await old.frame({width,height}),binary=await raw.frame({width,height})
  assert.equal(legacy.encoding,undefined);assert.equal(binary.encoding,'rgba8');assert.equal(binary.width,legacy.width);assert.equal(binary.height,legacy.height);assert.deepEqual(binary.stats,legacy.stats)
  assert.deepEqual(binary.rgba,new Uint8Array(Buffer.from(legacy.rgba,'base64')));assert.deepEqual(binary.rgba,expected(width,height));assert.equal(binary.rgba.buffer.byteLength,width*height*4)
 }
 await assert.rejects(raw.frame({width:0,height:1}),/invalid options/);assert.ok((await raw.stats()).pid)
 const pending=assert.rejects(raw.frame({hang:true}),/Bridge stopped/),queued=assert.rejects(raw.stats(),/Bridge stopped/);await raw.stop();await Promise.all([pending,queued]);assert.equal(raw.pendingBytes,0)
})
test('FRB1 registration preserves owner retirement and rejects unknown opt-in',{skip:!binary&&'Set DESIGN_RENDER_CODEC_FIXTURE'},async t=>{
 const {registerNativeRender}=await import('../../src/native-render.mjs')
 const{EventEmitter}=await import('node:events'),{mkdtemp,mkdir,copyFile,chmod,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{default:path}=await import('node:path')
 const root=await mkdtemp(path.join(tmpdir(),'native-render-binary-owner-'));await mkdir(path.join(root,'bin'));const executable=path.join(root,'bin',`design-render${process.platform==='win32'?'.exe':''}`);await copyFile(binary,executable);await chmod(executable,0o700)
 const previous=process.env.CORE_NATIVE_RENDER_PROTOCOL;process.env.CORE_NATIVE_RENDER_PROTOCOL='frb1'
 const handlers=new Map(),sender=Object.assign(new EventEmitter(),{id:91});const stop=registerNativeRender({handle:(name,fn)=>handlers.set(name,fn)},{resourcesRoot:root,cpuOnly:true,assertSender:event=>assert.equal(event.sender,sender)})
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});if(previous===undefined)delete process.env.CORE_NATIVE_RENDER_PROTOCOL;else process.env.CORE_NATIVE_RENDER_PROTOCOL=previous})
 const call=(name,...args)=>handlers.get('native-render:'+name)({sender},...args)
 assert.equal((await call('load','{}')).ok,true);const frame=await call('frame',{width:1,height:1});assert.equal(frame.ok,true);assert.equal(frame.encoding,'rgba8');assert.deepEqual(frame.rgba,expected(1,1))
 const pending=call('frame',{hang:true});sender.emit('did-start-navigation',{},'design-app://app/index.html',false,true);assert.match((await pending).error,/Bridge stopped/)
 assert.equal((await call('load','{}')).ok,true);sender.emit('destroyed');await stop()
 process.env.CORE_NATIVE_RENDER_PROTOCOL='frb2';const result=await call('load','{}');assert.equal(result.ok,false);assert.match(result.error,/Unknown native render protocol/)
})
