import { afterEach, expect, test } from 'vitest'
import { Editor, type EditorEditEvent } from './engine'
import { blank, node } from './model'
import { ColorEditSession } from './color-edit-session'
import { registerPendingEdit } from './pending-edits'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()) })
function fixture() {
  const document = blank('Original'), first = node('rectangle'), second = node('rectangle', 100, 0), third = node('rectangle', 200, 0)
  document.nodes = { [first.id]: first, [second.id]: second, [third.id]: third }
  document.pages[0].children = [first.id, second.id, third.id]
  const nextPage = { ...document.pages[0], id: crypto.randomUUID(), name: 'Second page', children: [] as string[] }
  document.pages.push(nextPage)
  const editor = new Editor(document)
  editors.push(editor)
  editor.select([first.id])
  const session = ColorEditSession.open(editor, { kind: 'solid-fill', nodeId: first.id,
    fillIndex: 0, fillId: first.fills[0].id })!
  return { editor, session, first, second, third, nextPage }
}

test.each(['selection', 'page'] as const)('normal color commit admits its pending %s navigation despite replacing the document root', navigation => {
  const f = fixture(), before = f.editor.authoredDocument, version = f.editor.state.version
  expect(f.session.update({ color: '#abcdef' })).toBe('preview')
  if (navigation === 'selection') f.editor.set({ selection: [f.second.id] })
  else f.editor.set({ page: f.nextPage.id, selection: [] })
  expect(f.editor.propertyPreviewActive).toBe(false)
  expect(f.editor.state.version).toBe(version + 1)
  expect(f.editor.state.doc.nodes[f.first.id].fills[0].color).toBe('#abcdef')
  expect(f.editor.state.page).toBe(navigation === 'page' ? f.nextPage.id : before.pages[0].id)
  expect(f.editor.state.selection).toEqual(navigation === 'selection' ? [f.second.id] : [])
  f.editor.undo()
  expect(f.editor.state.doc).toBe(before)
})

test('an unchanged color session permits navigation without creating a revision or undo entry', () => {
  const f = fixture(), before = f.editor.state.doc, version = f.editor.state.version
  f.editor.set({ selection: [f.second.id] })
  expect(f.editor.state.doc).toBe(before)
  expect(f.editor.state.version).toBe(version)
  expect(f.editor.state.selection).toEqual([f.second.id])
  expect(f.editor.canUndo).toBe(false)
})

test.each([
  { navigation: 'selection', replacement: 'new-id-load' },
  { navigation: 'selection', replacement: 'same-id-load' },
  { navigation: 'page', replacement: 'new-id-load' },
  { navigation: 'page', replacement: 'same-id-load' },
  { navigation: 'selection', replacement: 'same-version-root' },
] as const)('$navigation navigation cannot cross a synchronous $replacement subscriber during color commit', ({ navigation, replacement }) => {
  const f = fixture(), original = f.editor.authoredDocument, version = f.editor.state.version
  f.session.update({ color: '#abcdef' })
  let entered = false, adopted: Editor['state'] | undefined
  const unsubscribe = f.editor.subscribe(() => {
    if (entered || f.editor.propertyPreviewActive || f.editor.state.version !== version + 1) return
    entered = true
    // Preserve all target IDs in the same-ID case. Existence checks alone must
    // not permit an old intent to navigate a newly loaded editing session.
    const next = structuredClone(original)
    next.name = 'Subscriber document'
    if (replacement === 'new-id-load') next.id = crypto.randomUUID()
    if (replacement === 'same-version-root')
      f.editor.set({ doc: next, page: next.pages[0].id, selection: [f.third.id] })
    else {
      expect(f.editor.load(next)).toBe(true)
      f.editor.select([f.third.id])
    }
    adopted = f.editor.state
  })
  try {
    if (navigation === 'selection') f.editor.set({ selection: [f.second.id] })
    else f.editor.set({ page: f.nextPage.id, selection: [] })
    expect(entered).toBe(true)
    expect(f.editor.state).toBe(adopted)
    expect(f.editor.state.doc.name).toBe('Subscriber document')
    expect(f.editor.state.page).toBe(original.pages[0].id)
    expect(f.editor.state.selection).toEqual([f.third.id])
  } finally { unsubscribe() }
})

test('a same-ID nested load cannot revive the old navigation by restoring its root and public revision', () => {
  const f = fixture(), version = f.editor.state.version
  f.session.update({ color: '#abcdef' })
  let entered = false, adopted: Editor['state'] | undefined
  const unsubscribe = f.editor.subscribe(() => {
    if (entered || f.editor.propertyPreviewActive || f.editor.state.version !== version + 1) return
    entered = true
    const document = f.editor.state.doc, revision = f.editor.state.version
    expect(f.editor.load(structuredClone(document))).toBe(true)
    f.editor.set({ doc: document, page: document.pages[0].id, selection: [f.first.id], version: revision })
    adopted = f.editor.state
  })
  try {
    f.editor.set({ selection: [f.second.id] })
    expect(entered).toBe(true)
    expect(f.editor.state).toBe(adopted)
    expect(f.editor.state.selection).toEqual([f.first.id])
  } finally { unsubscribe() }
})

test.each(['same-root-revision', 'newer-selection', 'newer-page'] as const)('pending navigation preserves a subscriber %s update', change => {
  const f = fixture(), version = f.editor.state.version
  f.session.update({ color: '#abcdef' })
  let entered = false, published: Editor['state'] | undefined
  const unsubscribe = f.editor.subscribe(() => {
    if (entered || f.editor.propertyPreviewActive || f.editor.state.version !== version + 1) return
    entered = true
    if (change === 'same-root-revision') {
      f.editor.state.doc.name = 'Versioned subscriber update'
      f.editor.set({ version: f.editor.state.version + 1 })
    } else if (change === 'newer-selection') f.editor.select([f.third.id])
    else f.editor.set({ page: f.nextPage.id, selection: [] })
    published = f.editor.state
  })
  try {
    f.editor.set({ selection: [f.second.id] })
    expect(entered).toBe(true)
    expect(f.editor.state).toBe(published)
    expect(f.editor.state.selection).not.toEqual([f.second.id])
  } finally { unsubscribe() }
})

test('a later pending-input callback cannot carry settled navigation into a newly loaded document', () => {
  const f = fixture(), replacement = blank('Pending input adopted another document')
  f.session.update({ color: '#abcdef' })
  let entered = false, adopted: Editor['state'] | undefined
  const unregister = registerPendingEdit(f.editor, {
    dirty: () => !entered && !f.editor.propertyPreviewActive,
    commit: () => {
      entered = true
      expect(f.editor.load(replacement)).toBe(true)
      adopted = f.editor.state
      return true
    },
  })
  try {
    f.editor.set({ page: f.nextPage.id, selection: [] })
    expect(entered).toBe(true)
    expect(f.editor.state).toBe(adopted)
    expect(f.editor.state.page).toBe(replacement.pages[0].id)
  } finally { unregister() }
})

test('a subscriber opening a newer color lease retains ownership over old pending navigation', () => {
  const f = fixture(), version = f.editor.state.version
  f.session.update({ color: '#abcdef' })
  let entered = false, newer!: ColorEditSession
  const unsubscribe = f.editor.subscribe(() => {
    if (entered || f.editor.propertyPreviewActive || f.editor.state.version !== version + 1) return
    entered = true
    newer = ColorEditSession.open(f.editor, { kind: 'solid-fill', nodeId: f.first.id,
      fillIndex: 0, fillId: f.editor.state.doc.nodes[f.first.id].fills[0].id })!
  })
  try {
    f.editor.set({ selection: [f.second.id] })
    expect(entered).toBe(true)
    expect(newer.active).toBe(true)
    expect(f.editor.state.selection).toEqual([f.first.id])
  } finally { unsubscribe(); newer?.cancel() }
})

test.each(['missing-page', 'missing-selection'] as const)('settled color cannot authorize an invalid %s target', target => {
  const f = fixture(), page = f.editor.state.page, selection = f.editor.state.selection
  f.session.update({ color: '#abcdef' })
  if (target === 'missing-page') f.editor.set({ page: 'missing-page', selection: [] })
  else f.editor.set({ selection: ['missing-node'] })
  expect(f.editor.state.page).toBe(page)
  expect(f.editor.state.selection).toEqual(selection)
  expect(f.editor.state.doc.nodes[f.first.id].fills[0].color).toBe('#abcdef')
})

test.each(['different-id', 'same-id'] as const)('color audit retains its committed owner after a synchronous %s document load', replacementKind => {
  const f = fixture(), documentId = f.editor.state.doc.id, session = f.editor.sessionGeneration, revision = f.editor.state.version
  const replacement = blank('Loaded by color commit subscriber')
  if (replacementKind === 'same-id') replacement.id = documentId
  const events: EditorEditEvent[] = [], order: string[] = []
  let entered = false
  const unsubscribeEdits = f.editor.subscribeEdits(event => { events.push(event); order.push('audit') })
  const unsubscribe = f.editor.subscribe(() => {
    if (entered || f.editor.propertyPreviewActive || f.editor.state.version !== revision + 1) return
    entered = true
    expect(f.editor.load(replacement)).toBe(true)
    order.push('replacement adopted')
  })
  try {
    f.session.update({ color: '#abcdef' })
    expect(f.session.commit()).toBe(true)
    expect(entered).toBe(true)
    expect(f.editor.state.doc.id).toBe(replacement.id)
    expect(f.editor.sessionGeneration).toBe(session + 1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ documentId, session, revision: revision + 1, source: 'user', kind: 'edit' })
    expect(order).toEqual(['replacement adopted', 'audit'])
  } finally { unsubscribe(); unsubscribeEdits() }
})
