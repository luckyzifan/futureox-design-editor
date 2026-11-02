import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, paint } from '../model'
import { commitPluginResult, pluginEditLabel, snapshotFromEditor } from './commit'
import { pluginApiCoverage, pluginCoverageCounts } from './coverage'
import { PluginApiError } from './errors'
import { parsePluginManifest } from './manifest'
import { executePluginSource } from './run'
import { samplePlugin } from './sample-plugin'
import { createPluginSession } from './session'

const editors: Editor[] = []
afterEach(() => { while (editors.length) editors.pop()?.dispose() })

function open() {
  const editor = new Editor(blank())
  editors.push(editor)
  return editor
}

async function run(editor: Editor, source: string, html = '', plugin = { id: 'plugin.test', name: 'Test', command: 'run' }) {
  const snapshot = snapshotFromEditor(editor)
  const session = createPluginSession(snapshot, plugin)
  await executePluginSource(session, source, html)
  const turn = session.exportTurn()
  const result = commitPluginResult(editor, pluginEditLabel(plugin.name), { documentId: snapshot.documentId, revision: snapshot.revision }, turn)
  return { session, turn, result, editor }
}

describe('figma plugin host', () => {
  test('sample plugin creates labeled rectangles and keeps sticky notes and the current tool', async () => {
    const editor = open()
    let stickyNodeId = ''
    const stickyEdit = editor.change('便签', doc => {
      const sticky = node('frame', 12, 18, 200, 160)
      sticky.board = { kind: 'sticky' }
      sticky.fills = [paint('#fff3a3')]
      const text = node('text', 8, 8, 180, 120)
      text.text = '写下想法'
      text.fontSize = 24
      sticky.children = [text.id]
      doc.nodes[sticky.id] = sticky
      doc.nodes[text.id] = text
      doc.pages[0].children.push(sticky.id)
      stickyNodeId = sticky.id
    })
    expect(stickyEdit?.status).toBe('committed')
    editor.set({ tool: 'sticky' })
    const before = editor.state.version
    const { result } = await run(editor, samplePlugin.mainSource, samplePlugin.uiHtml, { id: 'futureox.sample.labeled-rectangles', name: 'Labeled rectangles', command: 'run' })
    expect(result.status).toBe('committed')
    expect(editor.state.tool).toBe('sticky')
    expect(editor.state.version).toBe(before + 1)
    const sticky = editor.state.doc.nodes[stickyNodeId]
    expect(sticky.fills[0].color).toBe('#fff3a3')
    expect(editor.state.doc.nodes[sticky.children[0]].text).toBe('写下想法')
    const labels = Object.values(editor.state.doc.nodes).filter(item => item.kind === 'rectangle' && item.name === 'Label')
    expect(labels).toHaveLength(3)
    expect(labels.map(item => [item.width, item.height, item.transform[4]])).toEqual([[160, 96, 32], [160, 96, 212], [160, 96, 392]])
    const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
    expect(labels[0].fills[0].color).toBe(`#${channel(52 / 255)}${channel(89 / 255)}${channel(212 / 255)}`)
    expect(Object.values(editor.state.doc.nodes).filter(item => item.kind === 'text' && item.text === 'Label')).toHaveLength(3)
    expect(editor.state.selection).toHaveLength(6)
    expect(editor.state.message).toContain('Created 3 labels')
    editor.undo()
    expect(Object.values(editor.state.doc.nodes).some(item => item.name === 'Label')).toBe(false)
    expect(editor.state.doc.nodes[sticky.id].board?.kind).toBe('sticky')
    expect(editor.state.doc.nodes[sticky.children[0]].text).toBe('写下想法')
  })

  test('ui messages add another label and closePlugin ends the session', async () => {
    const editor = open()
    const snapshot = snapshotFromEditor(editor)
    const session = createPluginSession(snapshot, { id: 'futureox.sample.labeled-rectangles', name: 'Labeled rectangles', command: 'run' })
    await executePluginSource(session, samplePlugin.mainSource, samplePlugin.uiHtml)
    const first = session.exportTurn()
    expect(commitPluginResult(editor, '插件 Labeled rectangles', { documentId: snapshot.documentId, revision: snapshot.revision }, first).status).toBe('committed')
    expect(first.ui?.title).toBe('Labeled rectangles')
    await session.deliver({ type: 'create', label: 'Note', count: 1 })
    const second = session.exportTurn()
    expect(commitPluginResult(editor, '插件 Labeled rectangles', { documentId: editor.state.doc.id, revision: editor.state.version }, second).status).toBe('committed')
    expect(Object.values(editor.state.doc.nodes).filter(item => item.name === 'Note')).toHaveLength(1)
    await session.deliver({ type: 'cancel' })
    expect(session.exportTurn().closed).toBe(true)
  })

  test('rejects a stale document and unsupported or unloaded text writes', async () => {
    const editor = open()
    const snapshot = snapshotFromEditor(editor)
    const session = createPluginSession(snapshot, { id: 'plugin.test', name: 'Test', command: 'run' })
    const rect = session.figma.createRectangle()
    rect.name = 'Kept'
    const text = session.figma.createText()
    expect(() => { text.characters = 'Hi' }).toThrow(PluginApiError)
    await session.figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
    text.characters = 'Hi'
    text.setPluginData('source', 'figma')
    expect(text.getPluginData('source')).toBe('figma')
    expect(text.getPluginData('missing')).toBe('')
    rect.rotation = 90
    expect(rect.rotation).toBeCloseTo(90)
    expect(rect.relativeTransform[0][1]).toBeCloseTo(-1)
    rect.cornerRadius = 8
    const turn = session.exportTurn()
    expect(commitPluginResult(editor, '插件 Test', { documentId: snapshot.documentId, revision: snapshot.revision - 1 }, turn).status).toBe('rejected')
    expect(Object.values(editor.state.doc.nodes)).toHaveLength(0)
    expect(commitPluginResult(editor, '插件 Test', { documentId: snapshot.documentId, revision: snapshot.revision }, turn).status).toBe('committed')
    const kept = Object.values(editor.state.doc.nodes).find(item => item.name === 'Kept')!
    expect(kept.radii).toEqual([8, 8, 8, 8])
    expect(kept.cornerRadius ?? 0).toBe(0)
    const written = Object.values(editor.state.doc.nodes).find(item => item.kind === 'text' && item.text === 'Hi')!
    expect(written.bindings?.[`figmaPlugin:${encodeURIComponent('plugin.test')}:${encodeURIComponent('source')}`]).toBe('figma')
    expect(editor.state.doc.schemaVersion).toBeGreaterThanOrEqual(4)
    expect(() => (session.figma as unknown as { variables: { getVariableById(): void } }).variables.getVariableById()).toThrow(PluginApiError)
    expect(() => (session.figma as unknown as { createComponent(): void }).createComponent()).toThrow(/does not implement figma.createComponent/)
  })

  test('groups siblings in parent-local coordinates', async () => {
    const editor = open()
    await run(editor, `
      const a = figma.createRectangle(); a.resize(40, 20); a.x = 10; a.y = 30
      const b = figma.createRectangle(); b.resize(20, 10); b.x = 70; b.y = 50
      const grouped = figma.group([a, b], figma.currentPage)
      grouped.name = 'Pair'
    `)
    const grouped = Object.values(editor.state.doc.nodes).find(item => item.name === 'Pair')!
    expect(grouped.kind).toBe('group')
    expect(grouped.transform.slice(4)).toEqual([10, 30])
    expect(grouped.width).toBe(80)
    expect(grouped.height).toBe(30)
    expect(grouped.children).toHaveLength(2)
    expect(editor.state.doc.pages[0].children).toEqual([grouped.id])
  })

  test('manifest accepts the sample and refuses traversal or FigJam-only plugins', () => {
    const parsed = parsePluginManifest(samplePlugin.manifestText)
    expect(parsed.manifest).toMatchObject({ id: 'futureox.sample.labeled-rectangles', main: 'code.js', ui: 'ui.html' })
    expect(parsed.warnings.join(' ')).toContain('networkAccess')
    expect(samplePlugin.mainSource).toBe(readFileSync(new URL('../../plugins/labeled-rectangles/code.js', import.meta.url), 'utf8'))
    expect(() => parsePluginManifest('{"name":"A","id":"a","api":"1","main":"../code.js"}')).toThrow(PluginApiError)
    expect(() => parsePluginManifest('{"name":"A","id":"a","api":"1","main":"code.js","editorType":["figjam"]}')).toThrow(/editorType/)
  })

  test('coverage matrix is unique and documented', () => {
    const names = pluginApiCoverage.map(entry => entry.api)
    expect(new Set(names).size).toBe(names.length)
    expect(pluginCoverageCounts()).toEqual({
      supported: pluginApiCoverage.filter(entry => entry.status === 'supported').length,
      partial: pluginApiCoverage.filter(entry => entry.status === 'partial').length,
      unsupported: pluginApiCoverage.filter(entry => entry.status === 'unsupported').length,
    })
    const doc = readFileSync(new URL('../../../../docs/FIGMA_PLUGIN_HOST.md', import.meta.url), 'utf8')
    for (const entry of pluginApiCoverage) expect(doc).toContain(`\`${entry.api}\` | ${entry.status} |`)
    expect(doc).toContain('labeled-rectangles')
    expect(doc).toContain('Plugins')
    expect(doc).toContain('does not execute plugin code')
  })
})
