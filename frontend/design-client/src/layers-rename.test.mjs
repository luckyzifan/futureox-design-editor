import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { commitPendingEdits, registerPendingEdit, hasPendingEdits } from './pending-edits.ts'

const source = readFileSync(new URL('./Layers.tsx', import.meta.url), 'utf8')
const pageListSource = readFileSync(new URL('./PageList.tsx', import.meta.url), 'utf8')
// Stop before the first hook after the callback. The row cache added a hook
// ahead of `rows`; including it would execute React code in this callback VM.
// Keep the actual rename body and every assertion unchanged; no hook/cache mock.
const start = '  function renameIntendedPage(', end = '  const rowCache = useMemo('
assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2)
const callbackSource = source.slice(source.indexOf(start), source.indexOf(end))
assert.doesNotMatch(callbackSource, /\buseMemo\s*\(/)
const script = stripTypeScriptTypes(`${callbackSource}\nrenameIntendedPage`)
function boundary() {
  const listeners = new Set(), prompts = [], changes = [], messages = []
  const editor = {
    sessionGeneration: 1,
    state: { doc: { id: 'same-document', pages: [{ id: 'a', name: 'Page A' }, { id: 'b', name: 'Page B' }], draft: '' }, page: 'a' },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    notify(message) { messages.push(message) },
    change(label, fn) { const next = structuredClone(this.state.doc); fn(next); changes.push(label); this.state.doc = next; for (const listener of [...listeners]) listener() },
  }
  const context = vm.createContext({ editor, renderSession: 1, s: { doc: editor.state.doc }, commitPendingEdits,
    prompt(title, value) { prompts.push({ title, value }); return context.answer() }, answer: () => 'Renamed B',
  })
  const rename = vm.runInContext(script, context)
  return { editor, context, rename, prompts, changes, messages, listeners,
    change(fn) { fn(editor); for (const listener of [...listeners]) listener() },
  }
}

test('actual callback renames intended B while current A remains unchanged', () => {
  const api = boundary(); api.rename('b')
  assert.equal(api.editor.state.doc.pages[0].name, 'Page A')
  assert.equal(api.editor.state.doc.pages[1].name, 'Renamed B')
  assert.equal(api.editor.state.page, 'a')
  assert.equal(api.prompts[0].value, 'Page B')
  assert.equal(api.listeners.size, 0)
  assert.match(source, /<PageList editor=\{editor\} onRename=\{renameIntendedPage\}/)
  assert.match(pageListSource, /onDoubleClick=\{\(\) => onRename\(page.id\)\}/)
})

for (const label of ['invalid draft', 'IME composition']) {
  test(`${label} veto preserves draft and performs no rename or prompt`, () => {
    const api = boundary(), unregister = registerPendingEdit(api.editor, { dirty: () => true, commit: () => false })
    try {
      api.rename('b')
      assert.equal(api.prompts.length, 0); assert.deepEqual(api.changes, [])
      assert.equal(api.editor.state.doc.pages[0].name, 'Page A'); assert.equal(api.editor.state.doc.pages[1].name, 'Page B')
      assert.equal(hasPendingEdits(api.editor), true)
      assert.match(api.messages[0], /当前输入已保留/)
    } finally { unregister() }
  })
}

test('successful draft commit keeps the intended page target', () => {
  const api = boundary(); let dirty = true
  const unregister = registerPendingEdit(api.editor, { dirty: () => dirty, commit() { api.editor.change('draft', doc => { doc.draft = 'committed' }); dirty = false; return true } })
  try {
    api.rename('b')
    assert.equal(api.editor.state.doc.draft, 'committed')
    assert.equal(api.editor.state.doc.pages[1].name, 'Renamed B')
    assert.equal(api.editor.state.doc.pages[0].name, 'Page A')
  } finally { unregister() }
})

for (const transition of ['session ABA', 'page ABA', 'removed/reinserted page']) {
  test(`${transition} during the prompt retires the original rename`, () => {
    const api = boundary()
    api.context.answer = () => {
      if (transition === 'session ABA') api.change(editor => { editor.sessionGeneration++; editor.state.doc = structuredClone(editor.state.doc) })
      if (transition === 'page ABA') { api.change(editor => { editor.state.page = 'b' }); api.change(editor => { editor.state.page = 'a' }) }
      if (transition === 'removed/reinserted page') {
        const target = api.editor.state.doc.pages[1]
        api.change(editor => { editor.state.doc.pages = [editor.state.doc.pages[0]] })
        api.change(editor => { editor.state.doc.pages.push(target) })
      }
      return 'Wrong replacement'
    }
    api.rename('b')
    assert.deepEqual(api.changes, []); assert.equal(api.editor.state.doc.pages[0].name, 'Page A')
    assert.equal(api.editor.state.doc.pages[1].name, 'Page B'); assert.equal(api.listeners.size, 0)
  })
}

test('a draft appearing during the prompt can veto without renaming either page', () => {
  const api = boundary(); let unregister = () => {}
  api.context.answer = () => { unregister = registerPendingEdit(api.editor, { dirty: () => true, commit: () => false }); return 'Wrong name' }
  try { api.rename('b'); assert.deepEqual(api.changes, []); assert.equal(hasPendingEdits(api.editor), true) } finally { unregister() }
})

test('cancelled prompt, removed target and stale rendered session cannot rename', () => {
  const cancel = boundary(); cancel.context.answer = () => null; cancel.rename('b'); assert.deepEqual(cancel.changes, [])
  const removed = boundary(); removed.change(editor => { editor.state.doc.pages.pop() }); removed.rename('b'); assert.deepEqual(removed.prompts, [])
  const stale = boundary(); stale.editor.sessionGeneration++; stale.rename('b'); assert.deepEqual(stale.prompts, [])
})

test('navigation during draft commit is fenced before opening the prompt', () => {
  const api = boundary(); let dirty = true
  const unregister = registerPendingEdit(api.editor, { dirty: () => dirty, commit() {
    dirty = false; api.change(editor => { editor.state.page = 'b' }); api.change(editor => { editor.state.page = 'a' }); return true
  } })
  try { api.rename('b'); assert.deepEqual(api.prompts, []); assert.deepEqual(api.changes, []) } finally { unregister() }
})
