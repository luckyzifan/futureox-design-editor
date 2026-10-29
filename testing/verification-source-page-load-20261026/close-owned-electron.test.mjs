import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {terminateOwnedProcess} from './close-owned-electron.mjs'

test('a test child that ignores SIGTERM is killed and reaped before success',async()=>{
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']})
  await once(child.stdout,'data')
  const result=await terminateOwnedProcess(child,50)
  assert.deepEqual(result,{forced:true,exited:true})
  assert.equal(child.signalCode,'SIGKILL')
  assert.throws(()=>process.kill(child.pid,0))
})

test('an exited owned child needs no signal',async()=>{
  const child=spawn(process.execPath,['-e','process.exit(0)'])
  await once(child,'exit')
  assert.deepEqual(await terminateOwnedProcess(child),{forced:false,exited:true})
})
