/** Product localSave/localOpen with actual admission + WASM binfmt.
 * Only IndexedDB is doubled; browser durability is explicitly outside this CPU test. */
import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { emptySystem } from './design-system'
import { localOpen, localSave, SaveCoordinator } from './local-store'
import { addVariableMode, deleteVariable, materializeVariableCell, renameVariableCollection, renameVariableMode, setVariableCell } from './variable-editing'

function storageBoundary() {
  const stores = new Map<string, Map<string, any>>(['documents', 'catalog', 'session', 'revisions'].map(name => [name, new Map()]))
  const key = (value: unknown) => JSON.stringify(value)
  const db = {
    close() {},
    transaction() {
      let pending = 0, finished = false
      const request = (fn: () => unknown) => {
        const r: any = {}; pending++
        queueMicrotask(() => {
          r.result = fn(); r.onsuccess?.(); pending--
          queueMicrotask(() => { if (!pending && !finished) { finished = true; tx.oncomplete?.() } })
        })
        return r
      }
      const tx: any = {
        oncomplete: null, onerror: null, onabort: null,
        abort() { finished = true; tx.onabort?.() },
        objectStore(name: string) {
          const store = stores.get(name)!
          return {
            get: (id: unknown) => request(() => structuredClone(store.get(key(id)))),
            put: (value: any, id?: unknown) => { store.set(key(id ?? [value.documentId, value.revision]), structuredClone(value)) },
            delete: (id: unknown) => store.delete(key(id)),
            getAllKeys: (range: any) => request(() => [...store.keys()].map(id => JSON.parse(id)).filter(id => id[0] === range.lower[0]).sort((a, b) => a[1] - b[1])),
          }
        },
      }
      return tx
    },
  }
  vi.stubGlobal('IDBKeyRange', { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) })
  vi.stubGlobal('indexedDB', { open() { const r: any = {}; queueMicrotask(() => { r.result = db; r.onsuccess?.() }); return r } })
  return stores
}
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); vi.unstubAllGlobals() })

test('localSave, localOpen and SaveCoordinator retain managed edits, aliases and undo as separate revisions', async () => {
  const stores = storageBoundary(), doc = blank('Saved variable document'), layer = node('rectangle', 0, 0, 12, 12)
  doc.schemaVersion = 6; doc.nodes[layer.id] = layer; doc.pages[0].children = [layer.id]
  layer.variableModes = { theme: 'Dark' }; layer.bindings = { width: 'alias' }
  const s = doc.designSystem = emptySystem()
  s.collections.theme = { name: 'Theme', modes: ['Light', 'Dark'], defaultMode: 'Light' }; s.activeModes.theme = 'Light'
  s.variables.size = { name: 'Spacing/size', kind: 'number', collection: 'theme', values: { Light: 12.125, Dark: 91.875 } }
  s.variables.alias = { name: 'Spacing/alias', kind: 'number', collection: 'theme', values: { Light: { alias: 'size' }, Dark: { alias: 'size' } } }
  s.variables.unused = { name: 'Unused', kind: 'string', collection: 'theme', values: { Light: 'light', Dark: 'dark' } }
  const e = new Editor(doc); editors.push(e)
  const first = await localSave(e.state.doc), before = e.state.doc, coordinator = new SaveCoordinator()
  coordinator.open(first, e.state.version)
  e.change('Manage persisted variables', d => {
    renameVariableCollection(d, 'theme', 'Tokens'); renameVariableMode(d, 'theme', 'Dark', 'Night')
    setVariableCell(d, 'size', 'Night', 91.87500000001); materializeVariableCell(d, 'alias', 'Night')
    addVariableMode(d, 'theme', 'Print', 'Night'); deleteVariable(d, 'unused')
  })
  const after = e.state.doc
  coordinator.observe(after, e.state.version); expect(coordinator.dirty).toBe(true)
  await coordinator.save(after, e.state.version); expect(coordinator.dirty).toBe(false)
  const stored = stores.get('documents')!.get(JSON.stringify(doc.id))
  expect(stored.format).toBe(2); expect(stored.bytes).toBeInstanceOf(Uint8Array); expect(stored.bytes.length).toBeGreaterThan(100)
  expect(stored.document).toBeUndefined(); expect(stored.revision).toBe(2)
  const reopened = await localOpen(doc.id)
  expect(reopened?.document).toEqual(after); expect(reopened?.revision).toBe(2)
  const reloaded = new Editor(reopened!.document); editors.push(reloaded)
  expect(reloaded.state.doc).toEqual(after); expect(reloaded.state.doc.nodes[layer.id].width).toBe(91.87500000001)
  e.undo(); expect(e.state.doc).toEqual(before)
  coordinator.observe(e.state.doc, e.state.version); await coordinator.save(e.state.doc, e.state.version)
  expect((await localOpen(doc.id))?.document).toEqual(before)
  expect((await localOpen(doc.id))?.revision).toBe(3)
})
