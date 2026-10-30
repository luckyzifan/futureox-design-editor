import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge } from './desktop'

const sessions: DesktopSession[] = []
const ok = { status: 'ok' } as const
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers() })

// This regression deliberately uses only APIs already present in shipped 565,
// so the same test can independently demonstrate the original lost-dirty state.
test.each(['versioned-same-root', 'replacement-owner', 'reentrant-session'] as const)(
  'synchronous adoption listener %s cannot claim the persisted baseline',
  async mutation => {
    vi.useFakeTimers()
    const target = blank('Saved content'), editor = new Editor(blank())
    const savedJson = JSON.stringify(target), submitted: string[] = []
    const encode = vi.fn(async (document: unknown) => JSON.stringify(document))
    const bridge = {
      version: 1,
      documentCodec: Object.freeze({ encoding: 'json-stringify-v1', encode, decode: async (json: string) => JSON.parse(json) }),
      workspace: {
        list: async () => ({ ...ok, documents: [] }),
        open: async () => ({ ...ok, id: target.id, name: target.name, revision: 1, hash: 'saved', deleted: false, updatedAt: 1, documentJson: savedJson }),
        commit: async ({ documentJson }: { documentJson: string }) => {
          submitted.push(documentJson)
          const document = JSON.parse(documentJson)
          return { ...ok, id: document.id, name: document.name, revision: 2, hash: 'edited', deleted: false, updatedAt: 2 }
        },
      },
      readRecovery: async () => ({ status: 'cancelled' }),
      clearRecovery: async () => ok,
      writeRecovery: async () => ok,
      setDirty: async () => {},
    } as unknown as DesktopBridge
    const session = new DesktopSession(bridge, editor, async () => 'cancel')
    sessions.push(session)
    await session.start()
    let handled = false
    const unsubscribe = editor.subscribe(() => {
      if (handled || editor.state.doc.id !== target.id) return
      handled = true
      const owner = editor.state.doc, version = editor.state.version
      if (mutation === 'versioned-same-root') {
        owner.name = 'Changed synchronously'
        editor.set({ version: version + 1 })
      } else if (mutation === 'replacement-owner') {
        // A different root is not proof of the prepared bytes, even if a
        // defensive integration forgets to advance its public revision.
        editor.set({ doc: { ...owner, name: 'Changed synchronously' } })
      } else {
        // Keep owner and final public revision equal to isolate the independent
        // editor-session fence. A nested load must still invalidate the proof.
        owner.name = 'Changed synchronously'
        editor.load(blank('Nested load'))
        editor.set({ doc: owner, page: owner.pages[0].id, version })
      }
    })
    try {
      expect(await session.openWorkspace(target.id)).toBe(true)
      expect(handled).toBe(true); expect(editor.state.doc.name).toBe('Changed synchronously')
      expect(session.dirty).toBe(true)
      const state = session as unknown as { baselineGeneration: number | null; baselineJson: string | null; baselineDocument?: unknown; updateRecovery(): Promise<void> }
      expect(state.baselineGeneration).toBeNull(); expect(state.baselineJson).toBeNull(); expect(state.baselineDocument).toBeUndefined()
      expect(encode).not.toHaveBeenCalled()
      await state.updateRecovery()
      expect(encode).toHaveBeenCalledTimes(1); expect(submitted).toHaveLength(1)
      expect(JSON.parse(submitted[0]).name).toBe('Changed synchronously')
      expect(session.dirty).toBe(false)
    } finally { unsubscribe() }
  },
)
