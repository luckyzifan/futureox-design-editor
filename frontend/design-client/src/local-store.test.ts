import { expect, test, vi } from 'vitest'
import { SaveCoordinator, type LocalRecord, type SaveStatus } from './local-store'
import { blank } from './model'

test('an older durable save cannot clear newer dirty state or another document state', async () => {
  const pending: {
    finish: (r: LocalRecord) => void
    doc: ReturnType<typeof blank>
    revision: number
  }[] = []
  const states: SaveStatus[] = []
  const saver = new SaveCoordinator(
    (doc, revision = 0) =>
      new Promise((resolve) => pending.push({ finish: resolve, doc, revision })),
    (s) => states.push(s),
  )
  const a = blank('A'),
    b = { ...a, name: 'B' }
  saver.observe(a, 1)
  const first = saver.save(a, 1)
  await Promise.resolve()
  await Promise.resolve()
  saver.observe(b, 2)
  pending[0].finish({ document: a, revision: 1, updatedAt: 1 })
  await first
  expect(saver.dirty).toBe(true)
  expect(states.at(-1)?.dirty).toBe(true)
  const second = saver.save(b, 2)
  await Promise.resolve()
  await Promise.resolve()
  expect(pending[1].revision).toBe(1)
  const other = blank('other')
  saver.observe(other, 3)
  pending[1].finish({ document: b, revision: 2, updatedAt: 2 })
  await second
  expect(states.at(-1)?.documentId).toBe(other.id)
  expect(saver.dirty).toBe(true)
})
test('failed saves preserve dirty state and a later explicit save can recover', async () => {
  let fail = true
  const saver = new SaveCoordinator(async (document, revision = 0) => {
    if (fail) throw new Error('quota')
    return { document, revision: revision + 1, updatedAt: 0 }
  })
  const doc = blank()
  saver.observe(doc, 1)
  await expect(saver.save(doc, 1)).rejects.toThrow('quota')
  expect(saver.dirty).toBe(true)
  fail = false
  await saver.save(doc, 1)
  expect(saver.dirty).toBe(false)
})

for (const changeId of [false, true]) {
  test(`queued save captures its body and identity before caller mutation (${changeId ? 'new ID' : 'same ID'})`, async () => {
    const writes: { document: ReturnType<typeof blank>; finish: (record: LocalRecord) => void }[] = []
    const saver = new SaveCoordinator((document) => new Promise(resolve => writes.push({ document, finish: resolve })))
    const first = blank('First'), next = blank('Captured next'), id = next.id
    const blocking = saver.save(first, 1)
    const queued = saver.save(next, 1)
    next.name = 'Changed by caller'
    if (changeId) next.id = crypto.randomUUID()
    saver.observe(next, 2)
    await Promise.resolve(); await Promise.resolve()
    writes[0].finish({ document: writes[0].document, revision: 1, updatedAt: 1 })
    await blocking; await Promise.resolve(); await Promise.resolve()
    expect(writes[1].document).not.toBe(next)
    expect(writes[1].document.id).toBe(id)
    expect(writes[1].document.name).toBe('Captured next')
    writes[1].finish({ document: writes[1].document, revision: 1, updatedAt: 1 })
    await queued
    expect(saver.dirty).toBe(true)
  })
}

test('snapshot failure rejects before queueing any commit and does not poison the next save', async () => {
  let writes = 0
  const saver = new SaveCoordinator(async document => {
    writes++
    return { document, revision: 1, updatedAt: 1 }
  })
  const invalid = blank() as ReturnType<typeof blank> & { unsupported?: () => void }
  invalid.unsupported = () => {}
  saver.observe(invalid, 1)
  await expect(saver.save(invalid, 1)).rejects.toBeDefined()
  expect(writes).toBe(0)
  expect(saver.dirty).toBe(true)
  const valid = blank()
  saver.observe(valid, 1)
  await saver.save(valid, 1)
  expect(writes).toBe(1)
  expect(saver.dirty).toBe(false)
})

test('a privately immutable snapshot does not need another structured clone', async () => {
  const { captureImmutable } = await import('./immutable-document')
  const document = captureImmutable(blank('Immutable snapshot'))!
  const clone = vi.spyOn(globalThis, 'structuredClone')
  let saved: ReturnType<typeof blank> | undefined
  const saver = new SaveCoordinator(async snapshot => {
    saved = snapshot
    return { document: snapshot, revision: 1, updatedAt: 1 }
  })
  try {
    saver.observe(document, 1)
    await saver.save(document, 1)
    expect(saved).toBe(document)
    expect(clone).not.toHaveBeenCalled()
  } finally { clone.mockRestore() }
})
