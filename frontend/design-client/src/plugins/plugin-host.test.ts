import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { samplePluginBundle, sampleUiPluginBundle } from './bundles'
import { pluginApiCoverage } from './coverage'
import { PluginApiError } from './errors'
import { memoryPluginStorage } from './client-storage'
import { pluginBundleFromFiles } from './load-folder'
import { pluginBundleFromZip } from './load-zip'
import { parsePluginManifest, type PluginBundle } from './manifest'
import { PLUGIN_DATA_NAMESPACE } from './plugin-data'
import { openPlugin } from './runtime'
import { pluginEditorEvents, pluginUiSrcdoc } from './ui-document'
import { strToU8, zipSync } from 'fflate'

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
      if (typeof figma.variables !== 'undefined') throw new Error('variables leaked')
      if (!figma.viewport || typeof figma.viewport.zoom !== 'number') throw new Error('viewport missing')
      if (figma.currentUser !== null) throw new Error('user leaked')
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

  it('keeps a plugin that asks for network, and reads only the manifest files from a folder', async () => {
    const net = parsePluginManifest({ name: 'Net', id: 'net.plugin', api: '1.0.0', main: 'code.js', networkAccess: { allowedDomains: ['https://example.com'] }, permissions: ['currentuser'] })
    expect(net.networkIgnored).toBe(true)
    expect(net.permissionsIgnored).toEqual(['currentuser'])
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

  it('runs a zipped plugin: selection, paints, command, and one close', async () => {
    const bytes = zipSync({
      'Demo/manifest.json': strToU8(JSON.stringify({
        name: 'Zip', id: 'zip.plugin', api: '1.0.0', main: 'code.js', ui: 'ui.html', editorType: ['figma'],
        networkAccess: { allowedDomains: ['https://example.com'] }, permissions: ['currentuser'],
        menu: [{ name: 'Create', command: 'create' }, { separator: true }, { name: 'More', menu: [{ name: 'Nested', command: 'nested' }] }],
      })),
      'Demo/code.js': strToU8(`
        if (figma.command !== 'create') throw new Error('command ' + figma.command)
        const rect = figma.createRectangle()
        rect.name = 'Zipped'
        rect.resize(80, 40)
        rect.fills = [figma.util.solidPaint('#3459D4')]
        figma.currentPage.selection = [rect]
        figma.closePlugin('zipped')
      `),
      'Demo/ui.html': strToU8('<p>Zip UI</p>'),
      'Demo/readme.txt': strToU8('ignored'),
    })
    expect(() => pluginBundleFromZip(zipSync({ '../manifest.json': strToU8('{}') }))).toThrow(PluginApiError)
    const loaded = pluginBundleFromZip(bytes)
    expect(loaded.manifest.networkIgnored).toBe(true)
    expect(loaded.manifest.commands.map(item => item.command)).toEqual(['create', 'nested'])
    expect(loaded.ui).toContain('Zip UI')
    const current = editor()
    const run = await openPlugin(current, loaded, { command: 'create' })
    const rect = named(current, 'Zipped')
    expect(rect?.width).toBe(80)
    expect(rect?.fills[0].color.toLowerCase()).toBe('#3459d4')
    expect(current.state.selection).toEqual([rect?.id])
    expect(run.closeMessage).toBe('zipped')
    run.close()
  })

  it('stores clientStorage outside the document and plugin data inside one undo', async () => {
    const storage = memoryPluginStorage()
    const current = editor()
    const saved = await openPlugin(current, bundle('Store', `
      ;(async function () {
        await figma.clientStorage.setAsync('count', { n: 2 })
        const keys = await figma.clientStorage.keysAsync()
        if (keys.indexOf('count') < 0) throw new Error('missing key')
        const rect = figma.createRectangle()
        rect.name = 'Tagged'
        rect.setPluginData('role', 'button')
        if (rect.getPluginData('role') !== 'button') throw new Error('missing plugin data')
        if (rect.getPluginData('nope') !== '') throw new Error('default plugin data')
        rect.setSharedPluginData('com.example', 'k', 'v')
        if (rect.getSharedPluginData('com.example', 'k') !== 'v') throw new Error('shared')
      })()
    `), { storage })
    expect(saved.flushes).toBe(1)
    const rect = named(current, 'Tagged')
    expect(current.state.doc.fdCompatibility?.extensions?.[PLUGIN_DATA_NAMESPACE]).toBeTruthy()
    current.undo()
    expect(current.state.doc.nodes[rect!.id]).toBeUndefined()
    expect(current.state.doc.fdCompatibility ?? null).toBeNull()
    expect(current.canUndo).toBe(false)
    const again = await openPlugin(current, bundle('Store', `
      ;(async function () {
        const value = await figma.clientStorage.getAsync('count')
        if (!value || value.n !== 2) throw new Error('lost ' + JSON.stringify(value))
        await figma.clientStorage.deleteAsync('count')
        if (await figma.clientStorage.getAsync('count') !== undefined) throw new Error('still stored')
      })()
    `), { storage })
    again.close()
    saved.close()
  })

  it('reports page bounds, text alignment, and reveals without changing zoom', async () => {
    const current = editor()
    const before = current.effectiveView().zoom
    const run = await openPlugin(current, bundle('Place', `
      const frame = figma.createFrame()
      frame.x = 50
      frame.y = 40
      const rect = figma.createRectangle()
      rect.resize(20, 10)
      frame.appendChild(rect)
      rect.x = 5
      rect.y = 6
      const box = rect.absoluteBoundingBox
      if (box.x !== 55 || box.y !== 46 || box.width !== 20 || box.height !== 10) throw new Error(JSON.stringify(box))
      rect.relativeTransform = [[1, 0, 8], [0, 1, 9]]
      const text = figma.createText()
      text.characters = 'Hi'
      text.textAlignHorizontal = 'CENTER'
      text.lineHeight = { unit: 'PERCENT', value: 150 }
      text.letterSpacing = { unit: 'PIXELS', value: 1.5 }
      figma.viewport.scrollAndZoomIntoView([frame])
      figma.viewport.zoom = 2
      if (typeof figma.viewport.center.x !== 'number') throw new Error('center')
    `))
    const rect = nodes(current).find(node => node.kind === 'rectangle')
    expect(rect?.transform.slice(4)).toEqual([8, 9])
    const text = nodes(current).find(node => node.kind === 'text')
    expect(text?.textStyle?.align).toBe('center')
    expect(text?.textStyle?.lineHeight).toBeCloseTo(1.5)
    expect(text?.textStyle?.letterSpacing).toBeCloseTo(1.5)
    expect(current.revealSnapshot()?.ids).toEqual([named(current, '画板')?.id || nodes(current).find(node => node.kind === 'frame')?.id])
    expect(current.effectiveView().zoom).toBe(2)
    expect(before).toBe(1)
    run.close()
  })

  it('delivers selectionchange only when the host emits it', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Watch', `
      figma.on('selectionchange', function () {
        figma.notify('selected ' + figma.currentPage.selection.length)
      })
      figma.showUI('<p>panel</p>', { width: 120, height: 80, title: 'Watch' })
      const rect = figma.createRectangle()
      figma.currentPage.selection = [rect]
    `, '<p>ignored</p>'))
    expect(run.notifications.some(message => message.startsWith('selected'))).toBe(false)
    expect(run.ui?.title).toBe('Watch')
    expect(run.ui?.visible).toBe(true)
    run.emit('selectionchange')
    expect(run.notifications.some(message => message.startsWith('selected'))).toBe(true)
    expect(pluginEditorEvents({ pageId: 'a', selection: '1' }, { pageId: 'a', selection: '1' }, true)).toEqual([])
    expect(pluginEditorEvents({ pageId: 'a', selection: '1' }, { pageId: 'b', selection: '2' }, false)).toEqual(['currentpagechange', 'selectionchange'])
    expect(pluginUiSrcdoc('<button>Go</button>')).toContain("connect-src 'none'")
    expect(pluginUiSrcdoc('<button>Go</button>')).toContain('<button>Go</button>')
    run.close()
  })

  it('runs a zero-delay timer and rejects fetch', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Later', `
      ;(async function () {
        await new Promise(function (resolve) { setTimeout(resolve, 0) })
        figma.createRectangle().name = 'Later'
        var blocked = false
        try { setTimeout(function () {}, 10) } catch (error) { blocked = String(error).indexOf('unsupported_api') >= 0 }
        if (!blocked) throw new Error('delay accepted')
        try { fetch('https://example.com') } catch (error) { blocked = String(error).indexOf('fetch') >= 0 }
        if (!blocked) throw new Error('fetch accepted')
      })()
    `))
    expect(named(current, 'Later')?.kind).toBe('rectangle')
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
