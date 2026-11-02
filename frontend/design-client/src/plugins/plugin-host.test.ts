import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { pluginCoverageCounts } from './coverage'
import { runGuestScript, type PluginHostHandler } from './guest'
import { bundleFromTextFiles, bundleFromZip, parsePluginManifest, zipPluginFiles } from './manifest'
import { readPluginMessage, readPluginUiOptions, wrapPluginUi } from './messages'
import { blank, validateDocument } from '../model'
import { applyPluginPatch, materializeNode } from './patch'
import { runSandboxed } from './runtime'
import { createMemoryPluginStorage } from './storage'

const pageId = '22222222-2222-4222-8222-222222222222'
const nodeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function hostRecording(): { ops: { op: string; payload: Record<string, unknown> }[]; handler: PluginHostHandler } {
  const ops: { op: string; payload: Record<string, unknown> }[] = []
  const handler: PluginHostHandler = (op, payload) => {
    ops.push({ op, payload })
    if (op === 'meta') return { pluginId: 'futureox.sample', command: 'run', editorType: 'figma' }
    if (op === 'getPage') return { id: pageId, name: 'Page 1', type: 'PAGE' }
    if (op === 'create') return { id: nodeId, type: payload.type }
    if (op === 'get') {
      if (payload.prop === 'type') return payload.id === pageId ? 'PAGE' : 'RECTANGLE'
      if (payload.prop === 'parent') return { id: pageId, type: 'PAGE' }
      if (payload.prop === 'selection') return []
      if (payload.prop === 'children') return []
      return null
    }
    if (op === 'list') return []
    if (op === 'clone') return { id: nodeId, type: 'RECTANGLE' }
    if (op === 'group' || op === 'ungroup') return op === 'group' ? { id: nodeId, type: 'GROUP' } : []
    return null
  }
  return { ops, handler }
}

describe('figma plugin host', () => {
  test('manifest rejects FigJam-only packages and paths outside the folder', () => {
    expect(parsePluginManifest(JSON.stringify({ name: 'Labels', id: 'futureox.sample', api: '1.0.0', main: 'code.js', editorType: ['figma'] })).menu[0].command).toBe('run')
    expect(() => parsePluginManifest(JSON.stringify({ name: 'Jam', id: 'jam.only', main: 'code.js', editorType: ['figjam'] }))).toThrow(/FigJam/)
    expect(() => parsePluginManifest(JSON.stringify({ name: 'Escape', id: 'escape', main: '../secret.js', editorType: ['figma'] }))).toThrow(/inside/)
  })

  test('zip packages keep only the manifest, main, and ui', () => {
    const zip = zipPluginFiles({
      'Labeled/manifest.json': JSON.stringify({ name: 'Labeled frames', id: 'futureox.sample.labeled-frames', api: '1.0.0', main: 'code.js', ui: 'ui.html', editorType: ['figma'] }),
      'Labeled/code.js': 'figma.closePlugin("zip")',
      'Labeled/ui.html': '<p>Hello</p>',
      'Labeled/extra.js': 'ignored',
    })
    const bundle = bundleFromZip(zip)
    expect(bundle.manifest.main).toBe('code.js')
    expect(bundle.code).toContain('closePlugin')
    expect(bundle.ui).toBe('<p>Hello</p>')
    expect(bundle.manifest.networkAccess.granted).toBe(false)
  })

  test('ui messages stay JSON and the frame blocks network', () => {
    expect(wrapPluginUi('<p>Hi</p>')).toContain("default-src 'none'")
    expect(readPluginMessage({ pluginMessage: { type: 'create', count: 2 } })?.pluginMessage).toEqual({ type: 'create', count: 2 })
    expect(readPluginMessage({ other: true })).toBeUndefined()
    expect(readPluginUiOptions('<b></b>', { width: 10, height: 9000 }).width).toBe(80)
    expect(() => readPluginMessage({ pluginMessage: 'x'.repeat(70_000) })).toThrow(/64 KiB/)
  })

  test('clientStorage is per plugin and rejects oversized values', () => {
    const storage = createMemoryPluginStorage()
    storage.set('futureox.sample', 'label', { text: 'Futureox' })
    expect(storage.get('futureox.sample', 'label')).toEqual({ text: 'Futureox' })
    expect(storage.get('other.plugin', 'label')).toBeUndefined()
    storage.delete('futureox.sample', 'label')
    expect(storage.keys('futureox.sample')).toEqual([])
    expect(() => storage.set('futureox.sample', 'big', 'x'.repeat(200_000))).toThrow(/100 KiB/)
  })

  test('a Rust node patch is admitted by the document validator', () => {
    const document = blank('Plugin')
    document.schemaVersion = 2
    const page = document.pages[0].id
    applyPluginPatch(document, {
      pageId: page,
      selection: [nodeId],
      schemaVersion: 2,
      nodes: {
        [nodeId]: {
          id: nodeId, kind: 'rectangle', name: 'Label', transform: [1, 0, 0, 1, 12, 24], width: 120, height: 40,
          fills: [{ kind: 'solid', color: '#ff0000', opacity: 1, visible: true, angle: 0, stops: [], fit: 'cover', blend: 'normal' }],
          pluginData: { 'futureox.sample': { label: 'Futureox' } },
        },
      },
      removed: [],
      pageChildren: { [page]: [nodeId] },
      addedPages: [],
      removedPages: [],
      pageNames: {},
      documentName: null,
    })
    expect(validateDocument(document).nodes[nodeId]).toMatchObject({ name: 'Label', width: 120, pluginData: { 'futureox.sample': { label: 'Futureox' } } })
    expect(materializeNode({ id: nodeId, kind: 'star', width: 10, height: 10 }).innerRadius).toBe(0.45)
  })

  test('the guest figma API records create, resize, selection, and close', async () => {
    const { ops, handler } = hostRecording()
    await runGuestScript(`
      const rect = figma.createRectangle()
      rect.resize(120, 40)
      rect.name = 'Label'
      rect.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]
      figma.currentPage.selection = [rect]
      figma.closePlugin('done')
    `, handler)
    expect(ops.map(entry => entry.op)).toEqual(expect.arrayContaining(['create', 'resize', 'set', 'close']))
    expect(ops.find(entry => entry.op === 'resize')?.payload).toMatchObject({ width: 120, height: 40 })
    expect(ops.find(entry => entry.op === 'set' && entry.payload.prop === 'selection')?.payload.value).toEqual([nodeId])
  })

  test('QuickJS sandbox runs the same prelude and cannot see the host global', async () => {
    const seen: string[] = []
    await runSandboxed(`
      if (typeof document !== 'undefined' || typeof require !== 'undefined') throw new Error('sandbox leaked a host global')
      const rect = figma.createRectangle()
      rect.name = 'Sandboxed'
      figma.notify('sandboxed')
      figma.closePlugin('ok')
    `, (op, payload) => {
      seen.push(op)
      if (op === 'meta') return { pluginId: 'sandbox.test', command: 'run' }
      if (op === 'getPage') return { id: pageId, name: 'Page 1' }
      if (op === 'create') return { id: nodeId, type: 'RECTANGLE' }
      if (op === 'get' && payload.prop === 'type') return 'RECTANGLE'
      if (op === 'get') return null
      return null
    })
    expect(seen).toEqual(expect.arrayContaining(['create', 'notify', 'close']))
  })

  test('the checked-in sample runs through the guest bridge', async () => {
    const root = new URL('../../plugins/labeled-rectangles/', import.meta.url)
    const bundle = bundleFromTextFiles(['manifest.json', 'code.js', 'ui.html'].map(name => ({
      name, text: readFileSync(new URL(name, root), 'utf8'),
    })))
    const { ops, handler } = hostRecording()
    await runGuestScript(bundle.code, (op, payload) => {
      if (op === 'storageGet') return null
      if (op === 'get' && payload.prop === 'type' && payload.id !== pageId) return 'FRAME'
      return handler(op, payload)
    }, bundle.ui)
    expect(ops.filter(entry => entry.op === 'create' && entry.payload.type === 'FRAME')).toHaveLength(3)
    expect(ops.some(entry => entry.op === 'showUI')).toBe(true)
    expect(ops.some(entry => entry.op === 'storageSet')).toBe(true)
    expect(bundle.ui).toContain('pluginMessage')
  })

  test('coverage counts stay attached to the matrix', () => {
    expect(pluginCoverageCounts()).toEqual({ supported: 35, partial: 14, unsupported: 13 })
  })
})
