// @ts-expect-error jsdom is a test-only dependency
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { crc32, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../../engine'
import { blank, node, paint } from '../../model'
import { samplePluginBundle, sampleUiPluginBundle } from './bundles'
import { pluginApiCoverage } from './coverage'
import { PluginApiError } from './errors'
import { clientStorageSet, memoryPluginStorage } from './client-storage'
import { imageContentId } from './images'
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
  it('ships a layout-kit PNG whose IDAT crc matches the bytes', () => {
    const source = readFileSync(new URL('../../../plugins/layout-kit/code.js', import.meta.url), 'utf8')
    const encoded = source.match(/base64Decode\('([^']+)'\)/)?.[1]
    expect(encoded).toBeTruthy()
    const bytes = Buffer.from(encoded!, 'base64')
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    let offset = 8
    let inflated = false
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.subarray(offset + 4, offset + 8)
      const data = bytes.subarray(offset + 8, offset + 8 + length)
      const stored = bytes.readUInt32BE(offset + 8 + length)
      expect(stored).toBe(crc32(Buffer.concat([type, data])) >>> 0)
      if (type.toString() === 'IDAT') { inflateSync(data); inflated = true }
      offset += 12 + length
    }
    expect(inflated).toBe(true)
  })

  it('runs the layout-kit fixture through storage, layout, a local instance, ungroup, and an image', async () => {
    const current = editor()
    const root = new URL('../../../plugins/layout-kit/', import.meta.url)
    const manifest = parsePluginManifest(JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')))
    const run = await openPlugin(current, {
      manifest,
      main: readFileSync(new URL('code.js', root), 'utf8'),
      ui: readFileSync(new URL('ui.html', root), 'utf8'),
    }, { storage: memoryPluginStorage() })
    const board = named(current, 'Board')
    expect(board?.layout?.mode).toBe('vertical')
    expect(board?.layout?.gap).toBe(8)
    expect(named(current, 'Chip')?.component).toBeTruthy()
    expect(named(current, 'Chip instance')?.instance?.componentId).toBe(named(current, 'Chip')?.id)
    expect(named(current, 'Pair')).toBeUndefined()
    expect(named(current, 'Swatch')?.fills[0]?.kind).toBe('image')
    expect(run.closeMessage).toBe('layout-kit')
    run.close()
  })

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
      if (typeof figma.variables === 'undefined' || typeof figma.createImage !== 'function') throw new Error('host api missing')
      if (!figma.viewport || typeof figma.viewport.zoom !== 'number') throw new Error('viewport missing')
      if (figma.currentUser !== null) throw new Error('user leaked')
      figma.createVector()
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
        await figma.clientStorage.setAsync('bytes', new Uint8Array([1, 2, 255]))
        await figma.clientStorage.setAsync('empty', new Uint8Array())
        await figma.clientStorage.setAsync('flag', undefined)
        const keys = await figma.clientStorage.keysAsync()
        if (keys.indexOf('count') < 0 || keys.indexOf('flag') < 0) throw new Error('missing key')
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
        const bytes = await figma.clientStorage.getAsync('bytes')
        if (!(bytes instanceof Uint8Array) || bytes.length !== 3 || bytes[2] !== 255) throw new Error('bytes')
        const empty = await figma.clientStorage.getAsync('empty')
        if (!(empty instanceof Uint8Array) || empty.length !== 0) throw new Error('empty')
        if ((await figma.clientStorage.keysAsync()).indexOf('flag') < 0) throw new Error('undefined key')
        if (await figma.clientStorage.getAsync('flag') !== undefined) throw new Error('undefined value')
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
    expect(pluginEditorEvents({ pageId: 'a', selection: '1', revision: 1 }, { pageId: 'a', selection: '1', revision: 1 }, true)).toEqual([])
    expect(pluginEditorEvents({ pageId: 'a', selection: '1', revision: 1 }, { pageId: 'b', selection: '2', revision: 2 }, false)).toEqual(['documentchange', 'currentpagechange', 'selectionchange'])
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
        try { await fetch('https://example.com/secret') } catch (error) { blocked = String(error).indexOf('network_denied') >= 0 }
        if (!blocked) throw new Error('fetch accepted')
      })()
    `))
    expect(named(current, 'Later')?.kind).toBe('rectangle')
    run.close()
  })

  it('imports SVG, finds by type, and writes the sizing and text fields community plugins use', async () => {
    const dom = new JSDOM('')
    vi.stubGlobal('DOMParser', dom.window.DOMParser)
    try {
      const current = editor()
      const run = await openPlugin(current, bundle('Community', `
        const icon = figma.createNodeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#3459d4"/></svg>')
        icon.name = 'Feather'
        const texts = figma.currentPage.findAllWithCriteria({ types: ['TEXT', 'RECTANGLE'] })
        const hug = figma.createFrame()
        hug.name = 'Hug'
        hug.layoutMode = 'HORIZONTAL'
        hug.primaryAxisSizingMode = 'AUTO'
        hug.counterAxisSizingMode = 'FIXED'
        const wrapped = figma.createFrame()
        wrapped.name = 'Wrap'
        wrapped.layoutMode = 'HORIZONTAL'
        wrapped.layoutWrap = 'WRAP'
        wrapped.primaryAxisSizingMode = 'AUTO'
        wrapped.counterAxisSizingMode = 'FIXED'
        wrapped.counterAxisSpacing = 8
        wrapped.itemSpacing = 4
        const text = figma.createText()
        text.characters = 'Hello'
        text.textAutoResize = 'HEIGHT'
        text.textCase = 'UPPER'
        text.textDecoration = 'UNDERLINE'
        text.paragraphSpacing = 4
        text.paragraphIndent = 2
        const encoded = figma.base64Encode(new Uint8Array([72, 105]))
        if (encoded !== 'SGk=' || figma.base64Decode(encoded)[0] !== 72) throw new Error('base64 ' + encoded)
        if (texts.length < 1) throw new Error('criteria')
        figma.on('documentchange', function (event) {
          if (!event || !event.documentChanges) throw new Error('event')
          figma.notify('doc-changed')
        })
        figma.showUI('<p>community</p>', { width: 120, height: 40 })
      `))
      expect(named(current, 'Feather')).toBeTruthy()
      const hug = named(current, 'Hug')
      expect(hug?.layout?.mode).toBe('horizontal')
      expect(hug?.sizing?.width).toBe('hug')
      expect(hug?.sizing?.height).toBe('fixed')
      const wrap = named(current, 'Wrap')
      expect(wrap?.layout?.wrap).toBe(true)
      expect(wrap?.layout?.lineGap).toBe(8)
      expect(wrap?.layout?.gap).toBe(4)
      expect(wrap?.sizing?.width).toBe('fixed')
      expect(wrap?.sizing?.height).toBe('fixed')
      const text = nodes(current).find(node => node.kind === 'text' && node.text === 'Hello')
      expect(text?.textStyle?.textCase).toBe('upper')
      expect(text?.textStyle?.wrap).toBe(true)
      expect(text?.sizing?.height).toBe('hug')
      expect(text?.textStyle?.paragraphSpacing).toBe(4)
      expect(text?.textRuns?.[0]?.underline).toBe(true)
      run.emit('documentchange')
      expect(run.notifications).toContain('doc-changed')
      run.close()
    } finally { vi.unstubAllGlobals(); dom.window.close() }
  })

  it('creates a local paint style and applies it, the way Design Lint does', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Styles', `
      const style = figma.createPaintStyle()
      style.name = 'Brand'
      style.paints = [{ type: 'SOLID', color: { r: 0.2, g: 0.35, b: 0.83 } }]
      const rect = figma.createRectangle()
      rect.name = 'Styled'
      rect.fillStyleId = style.id
      const found = figma.getLocalPaintStyles().filter(function (item) { return item.name === 'Brand' })
      if (found.length !== 1 || found[0].paints[0].type !== 'SOLID') throw new Error('style list')
      if (figma.getStyleById(style.id).name !== 'Brand') throw new Error('style id')
      const textStyle = figma.createTextStyle()
      textStyle.name = 'Body'
      textStyle.fontName = { family: 'Noto Sans SC', style: 'Regular' }
      textStyle.paragraphSpacing = 6
      const text = figma.createText()
      text.characters = 'Styled'
      text.textStyleId = textStyle.id
    `))
    const rect = named(current, 'Styled')
    const paintId = rect?.styleRefs?.fills
    expect(paintId).toBeTruthy()
    expect(current.state.doc.designSystem?.styles[paintId!]).toMatchObject({ name: 'Brand', kind: 'paint' })
    const text = nodes(current).find(node => node.text === 'Styled')
    expect(text?.styleRefs?.textStyle).toBeTruthy()
    expect(current.state.doc.designSystem?.styles[text!.styleRefs!.textStyle!].name).toBe('Body')
    run.close()
  })

  it('stores image bytes, paints with the hash, and exports SVG', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Image', `
      ;(async function () {
        const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,3,8,2,0,0,0,0,0,0,0])
        const image = figma.createImage(png)
        const again = figma.getImageByHash(image.hash)
        if (!again || again.hash !== image.hash) throw new Error('hash')
        const size = await image.getSizeAsync()
        if (size.width !== 2 || size.height !== 3) throw new Error('size ' + size.width + 'x' + size.height)
        const bytes = await image.getBytesAsync()
        if (bytes[0] !== 137) throw new Error('bytes')
        const rect = figma.createRectangle()
        rect.name = 'Photo'
        rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FIT' }]
        const svg = await rect.exportAsync({ format: 'SVG' })
        const text = new TextDecoder().decode(svg)
        if (text.indexOf('<svg') < 0) throw new Error(text.slice(0, 80))
        var pngBlocked = false
        try { await rect.exportAsync({ format: 'PNG' }) } catch (error) { pngBlocked = String(error).indexOf('SVG') >= 0 }
        if (!pngBlocked) throw new Error('png export accepted')
      })()
    `))
    const rect = named(current, 'Photo')
    expect(rect?.fills[0].kind).toBe('image')
    expect(rect?.fills[0].fit).toBe('contain')
    expect(rect?.fills[0].image).toMatch(/^data:image\/png;base64,/)
    run.close()
  })

  it('creates a local variable and binds width', async () => {
    const current = editor()
    const run = await openPlugin(current, bundle('Vars', `
      const collection = figma.variables.createVariableCollection('Spacing')
      const variable = figma.variables.createVariable('Gap', collection, 'FLOAT')
      variable.setValueForMode(collection.modes[0].modeId, 12)
      const rect = figma.createRectangle()
      rect.name = 'Bound'
      rect.setBoundVariable('width', variable)
      if (figma.variables.getLocalVariables('FLOAT').length !== 1) throw new Error('list')
      if (!figma.variables.getVariableById(variable.id)) throw new Error('id')
    `))
    const rect = named(current, 'Bound')
    expect(rect?.bindings?.width).toBeTruthy()
    const variable = current.state.doc.designSystem?.variables[rect!.bindings!.width]
    expect(variable).toMatchObject({ name: 'Gap', kind: 'number', values: { 'Mode 1': 12 } })
    run.close()
  })

  it('fetches only declared https origins and refuses private hosts', async () => {
    const current = editor()
    const manifest = parsePluginManifest({
      name: 'Net', id: 'net.fetch', api: '1.0.0', main: 'code.js', editorType: ['figma'],
      networkAccess: { allowedDomains: ['https://api.example.test', '*.cdn.test'], devAllowedDomains: ['http://localhost:3000'] },
    })
    const seen: string[] = []
    const run = await openPlugin(current, { manifest, main: `
      ;(async function () {
        const ok = await fetch('https://api.example.test/icons', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":1}' })
        const body = await ok.json()
        if (body.mark !== 'ok') throw new Error('body')
        const local = await fetch('http://localhost:3000/dev')
        if (local.status !== 204) throw new Error('local')
        var denied = 0
        for (const url of ['https://evil.test/x', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'https://api.example.test.evil/x']) {
          try { await fetch(url) } catch (error) { if (String(error).indexOf('network_denied') >= 0) denied += 1 }
        }
        if (denied !== 4) throw new Error('denied ' + denied)
      })()
    `, ui: null }, {
      fetch: async (url, init): Promise<{ status: number; url: string; headers: Record<string, string>; body: Uint8Array }> => {
        seen.push(`${init.method} ${url}`)
        if (url.startsWith('http://localhost')) return { status: 204, url, headers: {}, body: new Uint8Array() }
        return { status: 200, url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"mark":"ok"}') }
      },
    })
    expect(seen).toEqual(['POST https://api.example.test/icons', 'GET http://localhost:3000/dev'])
    run.close()
  })

  it('uses the FIG SHA-1 image id and the 5 MB clientStorage quota', () => {
    expect(imageContentId(new Uint8Array())).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(imageContentId(new TextEncoder().encode('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    const storage = memoryPluginStorage()
    clientStorageSet(storage, 'quota.plugin', 'ok', JSON.stringify('hi'))
    expect(() => clientStorageSet(storage, 'quota.plugin', 'big', JSON.stringify('x'.repeat(5 * 1024 * 1024)))).toThrow(PluginApiError)
  })

  it('resolves an image already stored on the document by its SHA-1', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0, 0, 0, 0, 0])
    const hash = imageContentId(png)
    let binary = ''
    for (const byte of png) binary += String.fromCharCode(byte)
    const current = editor()
    current.change('Store image', doc => {
      const layer = node('rectangle', 0, 0, 10, 10)
      layer.name = 'Imported'
      layer.fills = [{ ...paint('#000000', 'image'), image: `data:image/png;base64,${btoa(binary)}`, fit: 'cover' }]
      doc.nodes[layer.id] = layer
      doc.pages[0].children.push(layer.id)
    })
    const run = await openPlugin(current, bundle('Hash', `
      ;(async function () {
        const image = figma.getImageByHash('${hash}')
        if (!image || image.hash !== '${hash}') throw new Error('missing hash')
        const size = await image.getSizeAsync()
        if (size.width !== 2 || size.height !== 3) throw new Error('size')
      })()
    `))
    run.close()
  })

  it('documents every coverage entry', () => {
    const coverage = pluginApiCoverage()
    expect(coverage.counts.supported).toBeGreaterThan(20)
    expect(coverage.counts.partial).toBeGreaterThan(10)
    expect(coverage.counts.unsupported).toBeGreaterThan(10)
    expect(coverage.counts.supported + coverage.counts.partial + coverage.counts.unsupported).toBe(coverage.entries.length)
    const doc = readFileSync(new URL('../../../../../docs/FIGMA_PLUGIN_HOST_V1.md', import.meta.url), 'utf8')
    for (const entry of coverage.entries) expect(doc, entry.api).toContain(entry.api)
    const ids = coverage.entries.map(entry => entry.api)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
