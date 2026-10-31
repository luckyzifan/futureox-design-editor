import { expect, test, vi } from 'vitest'
import { CpuStage, createCpuStageDiagnostics, measureCpuStage } from './cpu-stage-diagnostics'
import { createRenderDiagnostics, sanitizeFields } from '../../design-desktop/src/render-terminal-diagnostics.mjs'

test('nested synchronous stages preserve values, errors, action owner and restore scope', () => {
  let time = 0
  const rows: Record<string, number>[] = []
  const trace = createCpuStageDiagnostics(true, row => rows.push(row), () => time)
  const value = trace.run(CpuStage.pointerMove, () => {
    time = 3
    return measureCpuStage(CpuStage.preview, () => { time = 11; return 42 })
  }, 17, 4.5)
  expect(value).toBe(42)
  expect(rows.map(row => [row.cpuStageCode, row.cpuPhase])).toEqual([[2, 1], [10, 1], [10, 2], [2, 2]])
  expect(rows[1]).toMatchObject({ cpuParentSpanId: rows[0].cpuSpanId, actionId: 17 })
  expect(rows[0].cpuWaitMs).toBe(4.5)
  expect(rows[2].cpuDurationMs).toBe(8)
  expect(rows[3].cpuDurationMs).toBe(11)
  const error = Error('private document text')
  expect(() => trace.run(CpuStage.commit, () => { throw error })).toThrow(error)
  expect(rows.at(-1)?.cpuOutcome).toBe(0)
  const length = rows.length
  expect(measureCpuStage(CpuStage.serialize, () => 7)).toBe(7)
  expect(rows).toHaveLength(length)
  expect(JSON.stringify(rows)).not.toContain('private')
})

test('disabled tracing never reads its clock or sink; broken sinks never reject work', () => {
  const sink = vi.fn(() => { throw Error('sink unavailable') }), now = vi.fn(() => { throw Error('clock unused') })
  const off = createCpuStageDiagnostics(false, sink, now)
  expect(off.run(CpuStage.preview, () => 9)).toBe(9)
  expect(now).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled()
  expect(createCpuStageDiagnostics(true, sink, () => 1).run(CpuStage.commit, () => 12)).toBe(12)
})

test('admission and nesting are bounded without starving later gestures', () => {
  let time = 0, calls = 0
  const rows: Record<string, number>[] = []
  const trace = createCpuStageDiagnostics(true, row => rows.push(row), () => time)
  for (let i = 0; i < 500; i++) trace.run(CpuStage.pointerQueue, () => calls++)
  expect(calls).toBe(500); expect(rows).toHaveLength(256)
  time = 1001
  trace.run(CpuStage.pointerMove, () => 1, 22)
  expect(rows.at(-2)).toMatchObject({ actionId: 22, cpuSkipped: 372, cpuPhase: 1 })
  const recurse = (n: number): number => n ? measureCpuStage(CpuStage.preview, () => recurse(n - 1)) : 1
  expect(trace.run(CpuStage.pointerMove, () => recurse(200))).toBe(1)
  expect(rows.filter(row => row.cpuPhase === 1)).toHaveLength(145)
  expect(rows.filter(row => row.cpuPhase === 2)).toHaveLength(145)
})

test('terminal accepts only fixed scalar stage/timestamp fields and preserves sub-millisecond durations', () => {
  expect(sanitizeFields({ cpuSpanId: 1, cpuParentSpanId: 0, cpuStageCode: 37, cpuPhase: 2, cpuDurationMs: 1.25,
    bridgeBoundaryAt: 1792684066326.5, bridgeDeliveryMs: 2076.5, document: 'private', payload: {} })).toEqual({
      cpuSpanId: 1, cpuParentSpanId: 0, cpuStageCode: 37, cpuPhase: 2, cpuDurationMs: 1.25,
      bridgeBoundaryAt: 1792684066326.5, bridgeDeliveryMs: 2076.5,
    })
  for (const key of ['cpuSpanId', 'cpuStageCode', 'cpuPhase', 'cpuDurationMs', 'bridgeBoundaryAt', 'bridgeDeliveryMs'])
    for (const value of [NaN, Infinity, -1, '7', {}]) expect(sanitizeFields({ [key]: value })).toEqual({})
  expect(sanitizeFields({ cpuStageCode: 38, cpuPhase: 3, cpuSpanId: 1.2, cpuDurationMs: 120001, bridgeDeliveryMs: 120001 })).toEqual({})
  const rows: any[] = []
  const terminal = createRenderDiagnostics({ enabled: true, detail: true, sink: row => rows.push(row) })
  for (let i = 0; i < 700; i++) terminal.record('cpu-stage', { cpuSpanId: i + 1, cpuStageCode: 2, cpuPhase: 1 })
  terminal.flush()
  expect(rows.filter(row => row.event === 'cpu-stage')).toHaveLength(512)
  expect(rows.find(row => row.event === 'summary')?.dropped).toBe(188)
  terminal.close()
})

test('actual Editor preview and commit emit nested layout/native/history spans without changing authored undo', async () => {
  const { Editor } = await import('./engine')
  const { blank, node } = await import('./model')
  const { canvasActions } = await import('./canvas-action-diagnostics')
  vi.stubGlobal('window', { coreDesktop: { renderDiagnostics: true, renderDiagnosticsDetail: true } })
  const messages: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation(value => messages.push(String(value)))
  const doc = blank(), shape = node('vector', 0, 0, 100, 100), child = node('rectangle', 5, 5, 20, 20), second = node('rectangle', 15, 5, 20, 20)
  doc.schemaVersion = 15
  shape.booleanOperation = 'union'; shape.children = [child.id, second.id]
  doc.nodes[shape.id] = shape; doc.nodes[child.id] = child; doc.nodes[second.id] = second; doc.pages[0].children = [shape.id]
  const editor = new Editor(doc)
  try {
    editor.select([child.id]); editor.begin('缩放图层')
    const before = editor.state.doc.nodes[child.id].width
    expect(editor.preview({ [child.id]: { width: before + 9 } })).toBe(true)
    expect(editor.commit()?.status).toBe('committed')
    expect(editor.state.doc.nodes[child.id].width).toBe(before + 9)
    editor.undo(); expect(editor.state.doc.nodes[child.id].width).toBe(before)
    editor.redo(); expect(editor.state.doc.nodes[child.id].width).toBe(before + 9)
    canvasActions(editor).close()
    const rows = messages.filter(line => line.startsWith('[render-diag] ')).flatMap(line => {
      const row = JSON.parse(line.slice('[render-diag] '.length)); return row.batch || [row]
    }).filter(row => row.event === 'cpu-stage')
    const stages = new Set(rows.filter(row => row.cpuPhase === 2).map(row => row.cpuStageCode))
    // The derived-preview lane prepares inside the Rust-backed layout span;
    // it does not execute the older JS previewPrepare branch.
    for (const stage of [CpuStage.preview, CpuStage.previewLayout, CpuStage.serialize,
      CpuStage.resolveComponents, CpuStage.parse, CpuStage.commit, CpuStage.commitValidate, CpuStage.commitHistory, CpuStage.historyApply])
      expect(stages.has(stage), `missing actual stage ${stage}`).toBe(true)
    expect(rows.every(row => row.actionOwner > 0 && Number.isInteger(row.actionSession))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(child.id)
  } finally { editor.dispose(); log.mockRestore(); vi.unstubAllGlobals() }
})


test('invalid clocks never prevent work or replace its original exception', () => {
  const error = Error('operation failure'), clockError = Error('clock failure')
  for (const failureAt of [1, 2]) {
    let calls = 0
    const rows: Record<string, number>[] = []
    const trace = createCpuStageDiagnostics(true, row => rows.push(row), () => {
      if (++calls === failureAt) throw clockError
      return 1
    })
    expect(() => trace.run(CpuStage.commit, () => { throw error })).toThrow(error)
    expect(rows.some(row => !Number.isFinite(row.cpuDurationMs) && Object.hasOwn(row, 'cpuDurationMs'))).toBe(false)
  }
  const trace = createCpuStageDiagnostics(true, () => {}, () => NaN)
  expect(trace.run(CpuStage.preview, () => 42)).toBe(42)
})
