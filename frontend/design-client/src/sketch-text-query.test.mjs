import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { SketchSessionHost } from '../../design-desktop/src/sketch-session.mjs'
import { SketchTextQuery } from './sketch-text-query.ts'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const targets = (p) => ({ status: 'ok', owner: p.owner, revision: p.expectedRevision, instanceId: p.instanceId, targets: [{ targetPath: 'A', layerId: 'A' }, { targetPath: 'N/B', layerId: 'B' }] })
const value = p => ({ status: 'ok', owner: p.owner, revision: p.expectedRevision, instanceId: p.instanceId, targetPath: p.targetPath, explicitText: '', masterText: '主组件😀' })
test('native text queries use fixed read-only routes and discard late context/path/stopped responses', async () => {
  let native, late, api; const calls = [], win = { isDestroyed: () => false }
  const host = new SketchSessionHost(async (method, p) => {
    calls.push(method)
    if (method === 'sketch.session.open') return native = { owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: p.documentId, session_epoch: p.sessionEpoch }, active: true, revision: 0, savedRevision: 0, dirty: false, saveUncertain: false, undoCount: 0, redoCount: 0, layers: [], layersTruncated: false, persistence: 'memory-only-unsaved' }
    if (method === 'sketch.session.status') return native
    if (method === 'sketch.session.textTargets') return targets(p)
    assert.equal(method, 'sketch.session.textValue'); late = deferred(); return late.promise
  }, { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/native.sketch'] }) }, () => win)
  vm.runInNewContext(await readFile(new URL('../../design-desktop/src/preload.cjs', import.meta.url), 'utf8'), { process: { argv: [] }, require: () => ({ contextBridge: { exposeInMainWorld: (_, v) => { api = v } }, ipcRenderer: { invoke: (channel, p) => {
    const routes = { 'design-desktop:sketch-session-open': () => host.open(), 'design-desktop:sketch-session-text-targets': () => host.textTargets(p), 'design-desktop:sketch-session-text-value': () => host.textValue(p) }
    assert.ok(routes[channel], channel); return routes[channel]()
  } } }) })
  const opened = await api.sketchSession.open(), req = { owner: opened.owner, expectedRevision: 0, instanceId: 'I' }
  assert.equal((await api.sketchSession.textTargets(req)).targets.length, 2)
  const count = calls.length
  for (const patch of [{ path: '/injected' }, { expectedRevision: 1 }, { owner: { ...req.owner, session_epoch: 2 } }]) await assert.rejects(api.sketchSession.textTargets({ ...req, ...patch }))
  assert.equal(calls.length, count)
  const pending = api.sketchSession.textValue({ ...req, targetPath: 'A' })
  native = { ...native, revision: 1, dirty: true, undoCount: 1 }; await host.status({ owner: req.owner })
  late.resolve(value({ ...req, targetPath: 'A' })); await assert.rejects(pending, /stale/)

  const queue = []
  const bridge = { textTargets: p => { const d = deferred(); queue.push({ p, d, kind: 'targets' }); return d.promise }, textValue: p => { const d = deferred(); queue.push({ p, d, kind: 'value' }); return d.promise } }
  const q = new SketchTextQuery(bridge)
  const first = q.load(req.owner, 0, 'I'), old = queue.shift()
  const currentOwner = { ...req.owner, session_epoch: 2 }
  const second = q.load(currentOwner, 3, 'J'), fresh = queue.shift()
  fresh.d.resolve(targets(fresh.p)); await second
  old.d.resolve({ ...targets(old.p), targets: [{ targetPath: 'OLD', layerId: 'OLD' }] }); await first
  assert.equal(q.getSnapshot().targets[0].targetPath, 'A')
  const a = q.selectPath('A'), qa = queue.shift(), b = q.selectPath('N/B'), qb = queue.shift()
  qb.d.resolve(value(qb.p)); await b; qa.d.resolve(value(qa.p)); await a
  assert.equal(q.getSnapshot().value.targetPath, 'N/B'); assert.equal(q.getSnapshot().value.explicitText, '')
  const wrong = q.selectPath('A'), qw = queue.shift(); qw.d.resolve({ ...value(qw.p), owner: req.owner }); await wrong
  assert.equal(q.getSnapshot().value, null); assert.match(q.getSnapshot().error, /stale/)
  const stale = q.selectPath('A'), qs = queue.shift(); qs.d.resolve({ ...value(qs.p), revision: 2 }); await stale
  assert.equal(q.getSnapshot().value, null)
  const foreignPath = q.selectPath('A'), qp = queue.shift(); qp.d.resolve({ ...value(qp.p), targetPath: 'N/B' }); await foreignPath
  assert.equal(q.getSnapshot().value, null)
  const retiring = q.selectPath('A'), qr = queue.shift(), stopped = q.getSnapshot(); q.stop(); qr.d.resolve(value(qr.p)); await retiring
  assert.equal(q.getSnapshot(), stopped, 'unmounted controller never accepts late result')
  const restart = q.load(currentOwner, 4, 'J'), qrestart = queue.shift(); qrestart.d.resolve(targets(qrestart.p)); await restart
  const absent = q.selectPath('A'), qabsent = queue.shift(); qabsent.d.resolve({ ...value(qabsent.p), explicitText: null, masterText: '' }); await absent
  assert.equal(q.getSnapshot().value.explicitText, null); assert.equal(q.getSnapshot().value.masterText, '')
  assert.ok(calls.every(m => !m.includes('setText') && !m.includes('rename')), 'discovery never issues a mutation')
})
