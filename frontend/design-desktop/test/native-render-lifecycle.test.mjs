import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerNativeRender } from '../src/native-render.mjs'

async function fixture(t, stubborn = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'forma-render-owner-'))
  await mkdir(path.join(root, 'bin'))
  const binary = path.join(root, 'bin', `design-render${process.platform === 'win32' ? '.exe' : ''}`)
  await writeFile(binary, `#!${process.execPath}\nimport readline from 'node:readline';\n${stubborn ? "process.on('SIGTERM',()=>{});" : ''}\nreadline.createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.cmd==='load')console.log(JSON.stringify({type:'loaded'}));if(v.cmd==='stats')console.log(JSON.stringify({type:'stats',stats:{pid:process.pid}}));if(v.cmd==='frame'&&!v.options.hang)console.log(JSON.stringify({type:'frame',width:1,height:1,rgba:'AAAAAA==',stats:{}}));});\n`)
  await chmod(binary, 0o700)
  const handlers = new Map(), sender = Object.assign(new EventEmitter(), {id:7})
  const stop = registerNativeRender({handle:(name,fn)=>handlers.set(name,fn)}, {
    resourcesRoot:root, assertSender:event=>assert.equal(event.sender,sender),
  })
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true})})
  const call=(method,...args)=>handlers.get(`native-render:${method}`)({sender},...args)
  const load=async()=>{assert.equal((await call('load','{"id":"owned"}')).ok,true);return (await call('stats')).stats.pid}
  return {sender,call,load,stop}
}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
async function exited(pid) {
  for(let i=0;i<100&&alive(pid);i++)await new Promise(r=>setTimeout(r,25))
  assert.equal(alive(pid),false,'window-owned render child must exit')
}
test('navigation and owner destruction retire native render children and pending frames',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t), first=await f.load()
  f.sender.emit('did-start-navigation',{},'design-app://app/#same',true,true)
  assert.equal((await f.call('stats')).stats.pid,first,'same-document navigation keeps the owner')
  f.sender.emit('did-start-navigation',{},'design-app://app/index.html',false,true)
  await exited(first)
  const second=await f.load();assert.notEqual(second,first)
  const pending=f.call('frame',{hang:true},0)
  f.sender.emit('destroyed')
  assert.match((await pending).error,/Bridge stopped/)
  await exited(second)
  await f.stop();await f.stop()
})
test('shutdown reaps a child which ignores graceful termination',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,true), pid=await f.load()
  await f.stop();await exited(pid)
})
