import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { samplePluginBundle, sampleUiPluginBundle } from './bundles'
import { pluginApiCoverage } from './coverage'
import { PluginApiError } from './errors'
import { pluginBundleFromFiles } from './load-folder'
import { parsePluginManifest, type PluginBundle } from './manifest'
import { openPlugin } from './runtime'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.dispose() })
function editor() {
  const value = new Editor(blank('Plugin host'))
  editors.push(value)
  return value
}
function bundle(name: string, main: string, ui: string | null = null): PluginBundle {
  return { manifest: parsePluginManifest({ name, id: `${name}.plugin`, api: '1.0.0', main: 'code.js', ...(ui ? { ui: 'ui.html' } : {}), editorType: ['figma'], networkAccess: { allowedDomains: ['none'] } }), main, ui }
}
function nodes(editor: Editor) { return Object.values(editor.state.doc.nodes) }
function named(editor: Editor, name: string) { return nodes(editor).find(node => node.name === name) }

describe('Figma plugin host', () => {
  it('runs the bundled sample against the live document and undo removes it', async () => {
    const current = editor()
    const run = await openPlugin(current, samplePluginBundle())
    const frame = named(current, 'Plugin sample')
    expect(frame?.kind).toBe('frame')
    expect(frame?.width).toBe(320)
    expect(frame?.height).toBe(140)
    expect(frame?.transform.slice(4)).toEqual([72, 64])
    expect(frame?.fills[0].color.toLowerCase()).toBe('#3459d4')
    const text = nodes(current).find(node => node.kind === 'text')
    expect(text?.text).toBe('Futureox')
    expect(text?.fontSize).toBe(28)
    expect(frame?.children).toEqual([text?.id])
    expect(text?.transform.slice(4)).toEqual([24, 48])
    expect(current.state.selection).toEqual([frame?.id])
    expect(run.notifications).toContain('Sample plugin created a frame')
    expect(run.closeMessage).toBe('created')
    expect(run.flushes).toBeGreaterThan(0)
    while (current.canUndo) current.undo()
    expect(current.state.doc.pages[0].children).toEqual([])
    run.close()
  })

  it('keeps the sandbox off the host and rejects an unsupported API with no edit', async () => {
    const current = editor()
    const version = current.state.version
    await expect(openPlugin(current, bundle('Escape', `
      if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof window !== 'undefined') throw new Error('host leaked')
      if (Function('return typeof process')() !== 'undefined') throw new Error('constructor escaped')
      figma.createRectangle()
    `))).resolves.toBeTruthy()
    expect(nodes(current)).toHaveLength(1)
    await expect(openPlugin(current, bundle('Image', `
      if (typeof figma.variables !== 'undefined' || typeof figma.viewport !== 'undefined') throw new Error('unsupported namespace leaked')
      figma.createImage()
    `))).rejects.toMatchObject({ code: 'unsupported_api' })
    expect(current.state.version).toBe(version + 1)
  })

  it('stops at closePlugin and still commits the earlier shape', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Stop', `
      figma.createRectangle().name = 'Kept'
      figma.closePlugin('stop')
      figma.createEllipse()
    `))
    expect(nodes(current).map(node => node.kind)).toEqual(['rectangle'])
    expect(run.closeMessage).toBe('stop')
    run.close()
  })

  it('discards an unflushed edit when the plugin throws', async () => {
    const current = editor()
    const version = current.state.version
    await expect(openPlugin(current, bundle('Boom', `
      const rect = figma.createRectangle()
      rect.name = 'Nope'
      throw new Error('boom')
    `))).rejects.toThrow(/boom/)
    expect(current.state.version).toBe(version)
    expect(nodes(current)).toHaveLength(0)
  })

  it('loads a font that exists and rejects one that does not', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Font', `
      ;(async function () {
        await figma.loadFontAsync({ family: 'Noto Sans SC', style: 'Regular' })
        let failed = false
        try { await figma.loadFontAsync({ family: 'Missing Font', style: 'Regular' }) }
        catch (error) { failed = String(error && error.message || error).indexOf('font_unavailable') !== -1 }
        if (!failed) throw new Error('missing font accepted')
        const text = figma.createText()
        text.characters = 'Hi'
        text.fontName = { family: 'Noto Sans SC', style: 'Bold' }
      })()
    `))
    const text = nodes(current).find(node => node.kind === 'text')
    expect(text?.text).toBe('Hi')
    expect(text?.textStyle?.weight).toBe(700)
    run.close()
  })

  it('rotates around the node center', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Rotate', `
      const rect = figma.createRectangle()
      rect.resize(100, 40)
      rect.x = 10
      rect.y = 20
      rect.rotation = 90
    `))
    const rect = nodes(current)[0]
    expect(rect.transform.map(value => Math.round(value * 1000) / 1000)).toEqual([0, -1, 1, 0, 40, 90])
    expect(Math.abs(Math.atan2(-rect.transform[1], rect.transform[0]) * 180 / Math.PI - 90)).toBeLessThan(0.01)
    run.close()
  })

  it('groups two rectangles and creates a component instance', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Structure', `
      const a = figma.createRectangle()
      const b = figma.createRectangle()
      b.x = 120
      const group = figma.group([a, b], figma.currentPage)
      group.name = 'Grouped'
      const component = figma.createComponent()
      component.name = 'Mark'
      const instance = component.createInstance()
      instance.name = 'Mark instance'
    `))
    expect(named(current, 'Grouped')?.kind).toBe('group')
    expect(named(current, 'Grouped')?.children).toHaveLength(2)
    expect(named(current, 'Mark')?.component).toBeTruthy()
    expect(named(current, 'Mark instance')?.instance?.componentId).toBe(named(current, 'Mark')?.id)
    run.close()
  })

  it('delivers a UI message into the still-running plugin', async () => {
    const current = editor()
    const run = await openPlugin(current, sampleUiPluginBundle())
    expect(run.ui?.width).toBe(280)
    expect(run.closed).toBe(false)
    run.deliver({ type: 'create-label', text: 'Hello' })
    expect(nodes(current).find(node => node.kind === 'text')?.text).toBe('Hello')
    expect(run.closed).toBe(true)
    run.close()
  })

  it('rejects network manifests and reads only the manifest files from a folder', async () => {
    expect(() => parsePluginManifest({ name: 'Net', id: 'net.plugin', api: '1.0.0', main: 'code.js', networkAccess: { allowedDomains: ['https://example.com'] } })).toThrow(PluginApiError)
    expect(() => parsePluginManifest({ name: 'Out', id: 'out.plugin', api: '1.0.0', main: '../code.js' })).toThrow(/folder/)
    const manifest = JSON.stringify({ name: 'Folder', id: 'folder.plugin', api: '1.0.0', main: 'code.js', ui: 'ui.html', editorType: ['figma'], networkAccess: { allowedDomains: ['none'] } })
    const file = (path: string, contents: string) => {
      const value = new File([contents], path.split('/').pop() || path)
      Object.defineProperty(value, 'webkitRelativePath', { value: path })
      return value
    }
    const loaded = await pluginBundleFromFiles([
      file('demo/manifest.json', manifest),
      file('demo/code.js', 'figma.createRectangle()'),
      file('demo/ui.html', '<p>Hi</p>'),
      file('demo/secret.txt', 'do not read'),
    ])
    expect(loaded.main).toContain('createRectangle')
    expect(loaded.ui).toBe('<p>Hi</p>')
    const current = editor()
    const run = await openPlugin(current, loaded)
    expect(nodes(current)).toHaveLength(1)
    run.close()
  })

  it('documents every coverage entry', () => {
    const coverage = pluginApiCoverage()
    expect(coverage.counts.supported).toBeGreaterThan(20)
    expect(coverage.counts.partial).toBeGreaterThan(10)
    expect(coverage.counts.unsupported).toBeGreaterThan(10)
    expect(coverage.counts.supported + coverage.counts.partial + coverage.counts.unsupported).toBe(coverage.entries.length)
    const doc = readFileSync(new URL('../../../../docs/FIGMA_PLUGIN_HOST_V1.md', import.meta.url), 'utf8')
    for (const entry of coverage.entries) expect(doc, entry.api).toContain(entry.api)
    const ids = coverage.entries.map(entry => entry.api)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
