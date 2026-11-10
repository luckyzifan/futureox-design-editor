import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MessageChannel } from 'node:worker_threads'
import { RenderFailureAttempts, markRenderFailure, renderFailureFields } from './render-failure-telemetry.ts'
import { renderErrorWithBudget } from './render-diagnostics.ts'
import { markFailureAllocation, sanitizeFailureAllocation } from '../../../design-desktop/src/render-failure-allocation.mjs'
import { createRenderDiagnostics, sanitizeFields, sanitizeBatch } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'

test('fallback boundary is distinct from original Error origin and survives scalar transport',()=>{
  const attempts=new RenderFailureAttempts(), original=markRenderFailure(new Error('private'),
    {failureStage:12,failureOriginCode:6,failureBuildKind:5})
  assert.throws(()=>attempts.run(12,()=>{throw original}),error=>error===original)
  assert.throws(()=>attempts.run(11,()=>{throw original}),error=>error===original)
  assert.equal(attempts.fields().lastFailureBoundaryStage,11)
  assert.equal(attempts.fields().lastFailureStage,12)
  assert.equal(attempts.fields().lastFailureThrownKind,1)
  const wrapped=renderErrorWithBudget(original,'private wrapper')
  const fields=sanitizeFields({...renderFailureFields(wrapped),...attempts.fields()})
  assert.equal(fields.failureOriginCode,6);assert.equal(fields.failureBuildKind,5)
  assert.equal(fields.lastFailureBoundaryStage,11);assert(!JSON.stringify(fields).includes('private'))
})

test('V2 dictionary binds actual source and every static literal matches without prefix classification', async()=>{
  const dictionary=JSON.parse(await readFile(new URL('../../../../docs/RENDER_FAILURE_DICTIONARY_V2.json',import.meta.url),'utf8'))
  const source=await readFile(new URL('./render-failure-telemetry.ts',import.meta.url))
  assert.equal(dictionary.version,2);assert.equal(dictionary.sourceSha256,createHash('sha256').update(source).digest('hex'))
  const text=source.toString()
  const known=text.slice(text.indexOf('const known:'), text.indexOf('const codes'))
  const literals=[...known.matchAll(/\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g)].map(match=>({
    exactMessage:match[2], category:Number(match[3]), code:Number(match[4]) }))
  assert.ok(literals.length>0)
  const byMessage=new Map(dictionary.exactMessages.map(item=>[item.exactMessage, item]))
  assert.equal(byMessage.size, dictionary.exactMessages.length)
  assert.equal(byMessage.size, literals.length)
  const categories=new Map()
  for(const literal of literals){
    const item=byMessage.get(literal.exactMessage)
    assert.ok(item, literal.exactMessage)
    assert.equal(item.category, literal.category, literal.exactMessage)
    assert.equal(item.code, literal.code, literal.exactMessage)
    if(categories.has(item.code)) assert.equal(categories.get(item.code), item.category, literal.exactMessage)
    else categories.set(item.code, item.category)
  }
  for(const item of dictionary.exactMessages){
    for(const value of [item.exactMessage,new Error(item.exactMessage)]){
      const fields=renderFailureFields(value)
      assert.equal(fields.failureCode,item.code);assert.equal(fields.failureCategory,item.category)
    }
    assert.equal(renderFailureFields('private-prefix '+item.exactMessage).failureCode,0)
  }
})

test('allocation snapshot rejects getters, inherited values, strings and overflows',()=>{
  let calls=0;const input={failureAllocationSnapshotVersion:1}
  Object.defineProperty(input,'failureLedgerTotalBytes',{get(){calls++;throw Error('private')}})
  assert.deepEqual(sanitizeFailureAllocation(input),{failureAllocationSnapshotVersion:1});assert.equal(calls,0)
  assert.deepEqual(sanitizeFailureAllocation(Object.create({failureAllocationSnapshotVersion:1,failureAllocationKind:1})),{})
  for(const bad of [-1,1.5,NaN,Infinity,17179869185,'1',{},true])
    assert(!('failureLedgerTotalBytes' in sanitizeFailureAllocation({failureAllocationSnapshotVersion:1,failureLedgerTotalBytes:bad})))
  assert(!('failureAllocationKind' in sanitizeFields({failureAllocationSnapshotVersion:1,failureAllocationKind:13})))
})

test('allocation kind and ledger survive actual worker-style message and main sanitizer without raw text',async()=>{
  const source={failureAllocationSnapshotVersion:1,failureAllocationKind:2,failureBuildKind:3,
    failureLedgerTotalBytes:1073741824,failureLedgerBusyCount:7}
  const error=markFailureAllocation(renderErrorWithBudget('GPU 表面内存预算超限',undefined,
    {requestedBytes:16,workingBytes:1073741824,budgetBytes:1073741824}),source)
  source.failureLedgerBusyCount=0
  const wrapped=renderErrorWithBudget(error,'PREVIEW_BUDGET: private')
  const {port1,port2}=new MessageChannel()
  try{
    const received=new Promise(resolve=>port2.once('message',resolve))
    port1.postMessage({...renderFailureFields(wrapped),requestId:130,privateText:'private'})
    const wire=await received,rows=[]
    const recorder=createRenderDiagnostics({enabled:true,detail:true,session:1,sink:row=>rows.push(row)})
    recorder.record('error',sanitizeFields(wire));recorder.flush();recorder.close()
    const row=sanitizeBatch(rows)[0]
    assert.equal(row.failureAllocationKind,2);assert.equal(row.failureBuildKind,3)
    assert.equal(row.failureLedgerBusyCount,7);assert.equal(row.requestId,130)
    assert(!JSON.stringify(row).includes('private'))
  }finally{port1.close();port2.close()}
})
