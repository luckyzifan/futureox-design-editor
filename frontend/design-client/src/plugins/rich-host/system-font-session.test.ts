import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../../engine'
import { blank } from '../../model'
import { createPluginSession } from './session'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.dispose() })

// Session-level checks for the system-font side channel behind loadFontAsync:
// the pending job hand-off, the font.import envelope handling, and the family
// alias that later fontName writes resolve against.
describe('system font session', () => {
  const face = { id: 'sys-1', family: 'Editor Sans', style: 'Regular', index: 0, weight: 400, italic: false }
  const ttf = () => readFileSync(new URL('../../../public/fonts/NotoSansSC.ttf', import.meta.url))

  function session(systemFonts?: Parameters<typeof createPluginSession>[1]['systemFonts']) {
    const editor = new Editor(blank('System fonts'))
    editors.push(editor)
    return { editor, session: createPluginSession(editor, { name: 't', pluginId: 't', uiHtml: null, systemFonts }) }
  }

  it('returns a pending job only when a catalog is available', () => {
    const withCatalog = session({ list: async () => [face], read: async () => null })
    expect(withCatalog.session.call('loadFont', { family: 'Editor Sans', style: 'Regular' })).toEqual({ pending: 'font-1' })
    const withoutCatalog = session(undefined)
    expect(() => withoutCatalog.session.call('loadFont', { family: 'Editor Sans', style: 'Regular' }))
      .toThrowError(/not loaded in this document/)
  })

  it('imports catalog bytes through font.import and resolves the family alias', () => {
    const { editor, session: value } = session({ list: async () => [face], read: async () => null })
    expect(value.call('loadFont', { family: 'Editor Sans', style: 'Regular' })).toEqual({ pending: 'font-1' })
    const job = value.takeFontJobs()
    expect(job?.family).toBe('Editor Sans')
    const imported = value.importSystemFont(job!, ttf().toString('base64'), face)
    expect(imported.id).toBe('font:sys:editor-sans-regular')
    expect(Object.keys(editor.state.doc.fonts ?? {})).toEqual(['font:sys:editor-sans-regular'])
    expect(value.call('loadFont', { family: 'Editor Sans', style: 'Regular' })).toEqual({ loaded: true })
  })

  it('matches faces by family with named-style, weight, then nearest-weight fallback', () => {
    const { session: value } = session(undefined)
    const faces = [
      { id: 'a', family: 'Editor Sans', style: 'Light', index: 0, weight: 300, italic: false },
      { id: 'b', family: 'Editor Sans', style: 'Bold', index: 0, weight: 700, italic: false },
      { id: 'c', family: 'Editor Sans', style: 'Regular', index: 0, weight: 400, italic: false },
      { id: 'i', family: 'Editor Sans', style: 'Italic', index: 0, weight: 400, italic: true },
      { id: 'other', family: 'Other Sans', style: 'Regular', index: 0, weight: 400, italic: false },
    ]
    expect(value.matchSystemFont(faces, 'editor sans', 'Regular')?.id).toBe('c')
    expect(value.matchSystemFont(faces, 'Editor Sans', 'Bold')?.id).toBe('b')
    expect(value.matchSystemFont(faces, 'Editor Sans', 'Semi Bold')?.id).toBe('b')
    expect(value.matchSystemFont(faces, 'Editor Sans', 'Thin')?.id).toBe('a')
    expect(value.matchSystemFont(faces, 'Editor Sans', 'Italic')).toBeNull()
    expect(value.matchSystemFont(faces, 'Missing Sans', 'Regular')).toBeNull()
  })
})
