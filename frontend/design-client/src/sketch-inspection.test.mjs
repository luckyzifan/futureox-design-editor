import assert from 'node:assert/strict'
import test from 'node:test'
import { admitSketchInspection, SketchInspectionOwner } from './sketch-inspection.ts'
const value = () => ({ displayName: 'sample.sketch', owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: 'native-1', session_epoch: 1 }, pageCount: 1, layerCount: 2, editable: false, renderable: false })
const editor = () => ({ sessionGeneration: 3, state: { doc: { id: 'current-forma' } } })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('Sketch schema is fail-closed and inspection cannot grant editing/rendering', () => {
  const accepted = admitSketchInspection(value())
  assert.equal(Object.isFrozen(accepted.owner), true)
  for (const change of [ { owner: { ...value().owner, kernel_id: 'figma' } }, { owner: { ...value().owner, document_schema: 'future' } }, { owner: { ...value().owner, session_epoch: 9007199254740992 } }, { editable: true }, { renderable: true }, { displayName: '/private/path' } ])
    assert.throws(() => admitSketchInspection({ ...value(), ...change }))
})
test('inspection identities reject every ASCII control and display names reject NUL or paths', () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const input = value()
    input.owner.document_id = `native${String.fromCharCode(code)}1`
    assert.throws(() => admitSketchInspection(input))
  }
  for (const character of [String.fromCharCode(0), '/', '\\']) {
    assert.throws(() => admitSketchInspection({ ...value(), displayName: `sample${character}.sketch` }))
  }
  for (const document_id of ['native-1', '文档😀', `native${String.fromCharCode(32, 126, 128)}1`]) {
    assert.equal(admitSketchInspection({ ...value(), owner: { ...value().owner, document_id } }).owner.document_id, document_id)
  }
})
test('cancel, newer inspection and reopened same-ID Figma session retire old results', async () => {
  const owner = new SketchInspectionOwner(), current = editor(), gate = deferred()
  const pending = owner.inspect(current, () => gate.promise)
  owner.invalidate(); gate.resolve(value())
  assert.equal(await pending, undefined)
  const older = deferred(), newer = deferred()
  const first = owner.inspect(current, () => older.promise)
  const second = owner.inspect(current, () => newer.promise)
  newer.resolve(value()); assert.equal((await second).owner.kernel_id, 'sketch')
  older.resolve(value()); assert.equal(await first, undefined)
  const reopening = deferred(), request = owner.inspect(current, () => reopening.promise)
  current.sessionGeneration++
  reopening.resolve(value()); assert.equal(await request, undefined)
  assert.deepEqual(current.state.doc, { id: 'current-forma' })
})
test('cancelled native dialog changes no document and disposed requests cannot publish', async () => {
  const owner = new SketchInspectionOwner(), current = editor()
  assert.equal(await owner.inspect(current, async () => null), null)
  const gate = deferred(), pending = owner.inspect(current, () => gate.promise)
  owner.dispose(); gate.resolve(value())
  assert.equal(await pending, undefined)
  assert.deepEqual(current.state.doc, { id: 'current-forma' })
})
