import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { admitDocument, admitDocumentSync } from './document-admission'
import { validateDocument, type DesignDocument } from './model'
import { Editor } from './engine'
import { localOpen, localSave } from './local-store'
import { decodeDocumentBinary } from './kernel/binfmt'

const fixture = JSON.parse(readFileSync(new URL('../../../design-studio/crates/design-kernel/tests/fixtures/document-admission.json', import.meta.url), 'utf8')) as {
  base: DesignDocument; cases: { name: string; accepted: boolean; patches: { path: string; value: unknown }[] }[]
}
function documentFor(entry: typeof fixture.cases[number]) {
  const document = structuredClone(fixture.base)
  for (const patch of entry.patches) {
    const parts = patch.path.slice(1).split('/')
    let target: any = document
    for (const part of parts.slice(0, -1)) target = target[part]
    target[parts.at(-1)!] = structuredClone(patch.value)
  }
  return document
}
for (const entry of fixture.cases) {
  test(`actual stateless CPU WASM admission matches shared Rust fixture: ${entry.name}`, async () => {
    const document = documentFor(entry), before = JSON.stringify(document)
    if (entry.accepted) {
      const admitted = await admitDocument(document)
      expect(admitted).toEqual(document)
      expect(admitted).not.toBe(document)
      expect(admitDocumentSync(document)).toEqual(document)
    } else {
      await expect(admitDocument(document)).rejects.toBeDefined()
      expect(() => admitDocumentSync(document)).toThrow()
    }
    expect(JSON.stringify(document)).toBe(before)
  })
}

afterEach(() => { vi.unstubAllGlobals() })

test('canonical rejection occurs before IndexedDB opens and before editor/history/session replacement', async () => {
  const invalid = documentFor(fixture.cases.find(value => value.name === 'nonboolean visible')!)
  // This typed-shape gap was not covered by the narrower TS feature matrix.
  expect(validateDocument(invalid)).toBe(invalid)
  const open = vi.fn(() => { throw new Error('Storage must not begin') })
  vi.stubGlobal('indexedDB', { open })
  await expect(localSave(invalid)).rejects.toBeDefined()
  expect(open).not.toHaveBeenCalled()
  const editor = new Editor(structuredClone(fixture.base))
  const before = editor.state.doc, session = editor.sessionGeneration
  expect(() => editor.load(invalid)).toThrow()
  expect(editor.state.doc).toBe(before)
  expect(editor.sessionGeneration).toBe(session)
  expect(editor.canUndo).toBe(false)
})

test('async admission captures the exact snapshot before awaiting module readiness', async () => {
  const document = structuredClone(fixture.base)
  const pending = admitDocument(document)
  document.name = 'Changed while awaiting'
  Object.values(document.nodes)[0].visible = 'invalid' as never
  const admitted = await pending
  expect(admitted.name).toBe(fixture.base.name)
  expect(Object.values(admitted.nodes)[0].visible).toBe(true)
})

// Only the IndexedDB request/transaction boundary is doubled. Admission uses the
// actual packaged CPU WASM and no renderer or GPU API is called by these tests.
function storage(initial?: { document: DesignDocument; revision: number; updatedAt: number }) {
  const writes: Array<{ store: string; value: any; key: string }> = []
  let closed = false
  const database = {
    close() { closed = true },
    transaction() {
      const tx: any = {
        abort: () => queueMicrotask(() => tx.onabort?.()),
        objectStore: (name: string) => ({
          get: () => {
            const request: any = {}
            queueMicrotask(() => {
              request.result = initial ? structuredClone(initial) : undefined
              request.onsuccess?.()
              // Promise continuations may queue writes before transaction completion.
              queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()))
            })
            return request
          },
          put: (value: unknown, key: string) => {
            // Revision snapshots live in their own keyed store; only document and
            // catalog writes are observable through this doubling.
            if (name !== 'revisions') writes.push({ store: name, value: structuredClone(value), key })
          },
          getAllKeys: () => {
            const request: any = {}
            queueMicrotask(() => {
              request.result = []
              request.onsuccess?.()
            })
            return request
          },
          delete: () => {},
        }),
      }
      return tx
    },
  }
  vi.stubGlobal('IDBKeyRange', { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) })
  vi.stubGlobal('indexedDB', { open() {
    const request: any = {}
    queueMicrotask(() => { request.result = database; request.onsuccess?.() })
    return request
  } })
  return { writes, closed: () => closed }
}

test('localSave writes and returns its admitted snapshot even if the caller object changes', async () => {
  const db = storage(), document = structuredClone(fixture.base), id = document.id
  const saving = localSave(document)
  document.id = crypto.randomUUID(); document.name = 'Changed after save request'
  const record = await saving
  expect(record.document.id).toBe(id)
  expect(record.document.name).toBe(fixture.base.name)
  expect(db.writes.map(write => write.key)).toEqual([id, id])
  expect(db.writes[0].value.format).toBe(2)
  expect(decodeDocumentBinary(db.writes[0].value.bytes)).toEqual(record.document)
  expect(db.closed()).toBe(true)
})

test('localOpen closes its transaction then rejects a canonically invalid stored copy without rewriting it', async () => {
  const invalid = documentFor(fixture.cases.find(value => value.name === 'unsafe rich text link')!)
  const record = { document: invalid, revision: 7, updatedAt: 1 }, before = JSON.stringify(record)
  const db = storage(record)
  await expect(localOpen(invalid.id)).rejects.toBeDefined()
  expect(db.closed()).toBe(true)
  expect(db.writes).toEqual([])
  expect(JSON.stringify(record)).toBe(before)
})

test('localOpen admits a valid detached record and preserves its revision', async () => {
  const record = { document: structuredClone(fixture.base), revision: 7, updatedAt: 1 }
  const db = storage(record)
  const opened = await localOpen(record.document.id)
  expect(opened).toEqual(record)
  expect(opened?.document).not.toBe(record.document)
  expect(db.closed()).toBe(true)
  expect(db.writes).toEqual([])
})

test('actual upgrade callback preserves the legacy original through provisional, interrupted and admitted copies', async () => {
  for (const scenario of ['provisional-invalid', 'interrupted-invalid', 'valid']) {
    const legacy = scenario === 'valid' ? structuredClone(fixture.base) :
      documentFor(fixture.cases.find(value => value.name === 'nonboolean visible')!)
    const original = JSON.stringify(legacy)
    const stores = new Map<string, Map<string, unknown>>([['documents', new Map([['current', legacy]])]])
    let upgraded = false, closed = false
    const deletes: string[] = []
    const transaction = () => {
      const tx: any = { objectStore: (name: string) => ({
        get: (key: string) => {
          const request: any = {}
          queueMicrotask(() => {
            request.result = structuredClone(stores.get(name)?.get(key))
            request.onsuccess?.()
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()))
          })
          return request
        },
        put: (value: unknown, key: string) => {
          if (!upgraded && scenario === 'interrupted-invalid') throw new Error('interrupted provisional copy')
          stores.get(name)!.set(key, structuredClone(value))
        },
        delete: (key: string) => { deletes.push(key); stores.get(name)!.delete(key) },
      }) }
      return tx
    }
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string) => { stores.set(name, new Map()) },
      transaction, close: () => { closed = true },
    }
    vi.stubGlobal('indexedDB', { open() {
      const request: any = {}
      queueMicrotask(() => {
        request.result = database
        if (!upgraded) {
          request.transaction = transaction()
          request.onupgradeneeded?.()
          queueMicrotask(() => { upgraded = true; request.onsuccess?.() })
        } else request.onsuccess?.()
      })
      return request
    } })
    if (scenario === 'valid') {
      const opened = await localOpen()
      expect(opened?.document).toEqual(legacy)
      expect(opened?.document).not.toBe(legacy)
    } else await expect(localOpen()).rejects.toBeDefined()
    expect(closed).toBe(true)
    expect(JSON.stringify(stores.get('documents')!.get('current'))).toBe(original)
    expect(deletes).toEqual([])
    expect(stores.get('documents')!.has(legacy.id)).toBe(scenario !== 'interrupted-invalid')
  }
})
