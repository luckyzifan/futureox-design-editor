import { expect, test } from 'vitest'
import { CanvasActionDiagnostics, CanvasAction, ActionSource, ActionOutcome, ActionReason, sanitizeActionFields } from './canvas-action-diagnostics'
import { sanitizeRecord } from '../../design-desktop/src/render-terminal-diagnostics.mjs'
import { actionGeometry, compareActionGeometry } from './canvas-action-geometry'
import { blank, node } from './model'

test('content and geometry never pass action allowlist, including runtime untyped input', () => {
  const fields = sanitizeActionFields({ text: 'PRIVATE', name: 'PRIVATE', path: '/secret', transform: [1,0,0,1,50,60], width: 50, clipboard: 'PRIVATE', targetCount: 2, snapChanged: true, modifiers: 16, geometrySupported: 'yes' })
  expect(fields).toEqual({targetCount: 2, snapChanged: 1})
  const rows: unknown[] = [], trace = new CanvasActionDiagnostics(true, true, row => rows.push(row), () => NaN)
  const id = trace.begin('PRIVATE' as never, 'PRIVATE' as never, {session: NaN, revision: Infinity}, fields)
  trace.finish(id, 'PRIVATE' as never, {session: NaN, revision: Infinity}, 'PRIVATE' as never)
  expect(JSON.stringify(rows)).not.toContain('PRIVATE')
  expect(rows[1]).toMatchObject({actionCode: 0, actionSource: 0, actionOutcome: 7, actionReason: 16, actionDurationMs: 0})
  const record = sanitizeRecord({v:1,session:1,source:'main',seq:1,at:1,event:'canvas-action', ...(rows[1] as object)})
  expect(record).toMatchObject({actionOutcome:7,targetCount:2,snapChanged:1})
  expect(sanitizeRecord(record)).toEqual(record)
})
test('bounded ring/pending and sample aggregation without per-pointer sink calls', () => {
  const rows: unknown[] = [], trace = new CanvasActionDiagnostics(true, true, row => rows.push(row), () => 1, 8)
  for (let i=0;i<100;i++) trace.begin(CanvasAction.move, ActionSource.pointer, {session:0,revision:0})
  expect(trace.snapshot().pending).toBe(8); expect(trace.snapshot().rows).toHaveLength(8)
  const id=trace.begin(CanvasAction.resize,ActionSource.pointer,{session:0,revision:0}), before=rows.length
  for(let i=0;i<10000;i++) trace.sample(id,{proposalChanged:true})
  expect(rows).toHaveLength(before)
  trace.finish(id,ActionOutcome.unchanged,{session:0,revision:0})
  expect(trace.snapshot().rows.at(-1)).toMatchObject({sampleUpdates:10000,proposalChanged:1,actionOutcome:3})
  const last = trace.snapshot().rows.at(-1)!
  expect(last.actionPendingEvicted).toBe(93)
  expect(last.actionRingDropped).toBeGreaterThan(0)
  const terminal = sanitizeRecord({v:1,session:1,source:'main',seq:1,at:1,event:'canvas-action', ...last})
  expect(terminal).toMatchObject({actionPendingEvicted:93,actionRingDropped:last.actionRingDropped})
  expect(sanitizeRecord(terminal)).toEqual(terminal)
  trace.retire(ActionReason.sessionEnd); expect(trace.snapshot().pending).toBe(0)
  for(const capacity of [0,-1,Infinity,513]) expect(()=>new CanvasActionDiagnostics(true,true,()=>{},()=>0,capacity)).toThrow()
})
test('disabled operation tracing performs no clock reads, emits nothing and stores nothing', () => {
  let clocks=0, emissions=0
  const trace=new CanvasActionDiagnostics(false,false,()=>emissions++,()=>++clocks)
  for(let i=0;i<10000;i++) { const id=trace.begin(CanvasAction.move,ActionSource.pointer,{session:0,revision:0}); trace.sample(id,{motionObserved:true}); trace.finish(id,ActionOutcome.observed,{session:0,revision:0}) }
  expect(clocks).toBe(0); expect(emissions).toBe(0); expect(trace.snapshot()).toEqual({pending:0,dropped:0,pendingEvicted:0,rows:[]})
})
test('stale session completion cannot claim commit; no handler-return implicit commit', () => {
  const trace=new CanvasActionDiagnostics(true,true,()=>{})
  const id=trace.begin(CanvasAction.move,ActionSource.pointer,{session:1,revision:5})
  trace.finish(id,ActionOutcome.committed,{session:2,revision:8})
  expect(trace.snapshot().rows.at(-1)).toMatchObject({actionOutcome:4,actionReason:6,actionFinalRevision:undefined})
  const noChange=trace.begin(CanvasAction.selection,ActionSource.pointer,{session:2,revision:8})
  trace.finish(noChange,ActionOutcome.observed,{session:2,revision:8})
  expect(trace.snapshot().rows.at(-1)).toMatchObject({actionOutcome:1,actionFinalRevision:8})
})
test('expected/resolved geometry stays in process and exports only equality/unsupported codes', () => {
  const document=blank(), n=node('rectangle',0,0,100,100); document.nodes[n.id]=n
  const before=actionGeometry(document,[n.id]), changed=actionGeometry(document,[n.id],{[n.id]:{width:101}})
  expect(compareActionGeometry(before,before)).toBe(1); expect(compareActionGeometry(before,changed)).toBe(2)
  expect(compareActionGeometry(actionGeometry(document,[]),changed)).toBe(3)
  expect(actionGeometry(document,Array(17).fill(n.id))).toBeUndefined()
  expect(sanitizeActionFields({proposalResolvedComparison:compareActionGeometry(before,changed),width:101})).toEqual({proposalResolvedComparison:2})
})
