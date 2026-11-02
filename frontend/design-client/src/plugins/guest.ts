import { PluginApiError } from './errors'

export type PluginHostHandler = (op: string, payload: Record<string, unknown>) => unknown

const writable = ['name', 'x', 'y', 'width', 'height', 'opacity', 'visible', 'locked', 'rotation', 'relativeTransform', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius', 'characters', 'fontSize', 'fontName', 'layoutMode', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutSizingHorizontal', 'layoutSizingVertical', 'constraints', 'blendMode', 'effects', 'pointCount', 'innerRadius', 'clipsContent', 'textAlignHorizontal', 'textAlignVertical']
const readable = [...writable, 'type', 'removed', 'parent', 'children', 'absoluteTransform', 'absoluteBoundingBox']
const unsupported = ['vectorNetwork', 'exportSettings', 'reactions', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'backgroundStyleId', 'gridStyleId', 'layoutGrids', 'guides', 'componentProperties', 'mainComponent']

export const guestPrelude = `
var writable = ${JSON.stringify(writable)}
var readable = ${JSON.stringify(readable)}
var unsupported = ${JSON.stringify(unsupported)}
function host(op, payload) {
  var text = __host(op, JSON.stringify(payload || {}))
  return text ? JSON.parse(text) : null
}
var meta = host('meta', {})
var cache = new Map()
var uiListeners = []
var listeners = { selectionchange: [], currentpagechange: [], close: [] }
var mixed = Object.freeze({ toString: function () { return 'Symbol(figma.mixed)' } })
function revive(prop, value) {
  if (value && value.mixed) return mixed
  if (prop === 'parent') return value && value.id ? wrap(value.id) : null
  if (prop === 'children') return (value || []).map(function (item) { return wrap(item.id) })
  return value
}
function wrap(id) {
  if (!id) return null
  if (cache.has(id)) return cache.get(id)
  var type = host('get', { id: id, prop: 'type' })
  var node = { id: id }
  readable.forEach(function (prop) {
    if (prop === 'selection') return
    var canWrite = writable.indexOf(prop) >= 0 && prop !== 'parent' && prop !== 'children'
    Object.defineProperty(node, prop, {
      enumerable: true,
      get: function () { return revive(prop, host('get', { id: id, prop: prop })) },
      set: canWrite ? function (value) {
        if (value === mixed) throw new Error('Cannot assign figma.mixed')
        host('set', { id: id, prop: prop, value: value })
      } : undefined,
    })
  })
  if (type === 'PAGE') {
    Object.defineProperty(node, 'selection', {
      enumerable: true,
      get: function () { return (host('get', { id: id, prop: 'selection' }) || []).map(wrap) },
      set: function (value) { host('set', { id: id, prop: 'selection', value: (value || []).map(function (item) { return item.id }) }) },
    })
  }
  node.resize = function (width, height) { host('resize', { id: id, width: width, height: height }) }
  node.appendChild = function (child) { host('reparent', { id: child.id, parentId: id }); return child }
  node.insertChild = function (index, child) { host('reparent', { id: child.id, parentId: id, index: index }); return child }
  node.remove = function () { host('remove', { id: id }) }
  node.clone = function () { return wrap(host('clone', { id: id }).id) }
  node.getPluginData = function (key) { return host('pluginDataGet', { id: id, key: key }) || '' }
  node.setPluginData = function (key, value) { host('pluginDataSet', { id: id, key: key, value: String(value) }) }
  node.findAll = function (pred) { return findAll(id, pred) }
  node.findOne = function (pred) { return findOne(id, pred) }
  node.exportAsync = function () { throw new Error('unsupported: node.exportAsync') }
  unsupported.forEach(function (prop) {
    Object.defineProperty(node, prop, { get: function () { throw new Error('unsupported: ' + prop) }, set: function () { throw new Error('unsupported: ' + prop) } })
  })
  cache.set(id, node)
  return node
}
function findAll(id, pred) {
  var rows = host('list', { id: id, deep: true }) || []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var node = wrap(rows[i].id)
    if (!pred || pred(node)) out.push(node)
  }
  return out
}
function findOne(id, pred) {
  var rows = host('list', { id: id, deep: true }) || []
  for (var i = 0; i < rows.length; i++) {
    var node = wrap(rows[i].id)
    if (!pred || pred(node)) return node
  }
  return null
}
function create(type) { return wrap(host('create', { type: type }).id) }
function colorChannels(value) {
  if (typeof value === 'string') {
    var hex = value.replace('#', '')
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    return { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255 }
  }
  if (Array.isArray(value)) return { r: value[0], g: value[1], b: value[2] }
  return { r: value.r, g: value.g, b: value.b }
}
var figma = {
  mixed: mixed,
  editorType: 'figma',
  mode: 'default',
  fileKey: null,
  pluginId: meta.pluginId,
  command: meta.command,
  apiVersion: '1.0.0',
  createRectangle: function () { return create('RECTANGLE') },
  createEllipse: function () { return create('ELLIPSE') },
  createFrame: function () { return create('FRAME') },
  createText: function () { return create('TEXT') },
  createLine: function () { return create('LINE') },
  createPolygon: function () { return create('POLYGON') },
  createStar: function () { return create('STAR') },
  createSection: function () { return create('SECTION') },
  createPage: function () { return create('PAGE') },
  createComponent: function () { throw new Error('unsupported: figma.createComponent') },
  createComponentFromNode: function () { throw new Error('unsupported: figma.createComponentFromNode') },
  createInstance: function () { throw new Error('unsupported: figma.createInstance') },
  createImage: function () { throw new Error('unsupported: figma.createImage') },
  createNodeFromSvg: function () { throw new Error('unsupported: figma.createNodeFromSvg') },
  importComponentByKeyAsync: function () { return Promise.reject(new Error('unsupported: figma.importComponentByKeyAsync')) },
  getImageByHash: function () { throw new Error('unsupported: figma.getImageByHash') },
  group: function (nodes, parent) {
    if (!nodes || !nodes.length) throw new Error('group requires nodes')
    for (var i = 0; i < nodes.length; i++) if (!nodes[i].parent || nodes[i].parent.id !== parent.id) throw new Error('group requires nodes that share the given parent')
    return wrap(host('group', { ids: nodes.map(function (node) { return node.id }) }).id)
  },
  ungroup: function (node) { return (host('ungroup', { id: node.id }) || []).map(wrap) },
  getNodeById: function (id) {
    try { host('get', { id: id, prop: 'type' }); return wrap(id) } catch (error) {
      if (String(error && error.message || error).indexOf('Unknown') >= 0) return null
      throw error
    }
  },
  getNodeByIdAsync: function (id) { return Promise.resolve(figma.getNodeById(id)) },
  loadAllPagesAsync: function () { return Promise.resolve() },
  setCurrentPageAsync: function (page) { figma.currentPage = page; return Promise.resolve() },
  notify: function (message) { host('notify', { message: String(message) }); return { cancel: function () {} } },
  closePlugin: function (message) { host('close', { message: message == null ? '' : String(message) }); throw new Error('__plugin_closed__') },
  commitUndo: function () { host('flush', {}) },
  loadFontAsync: function (font) { host('loadFont', { family: font.family, style: font.style || 'Regular' }); return Promise.resolve() },
  showUI: function (html, options) { host('showUI', { html: typeof html === 'string' ? html : __html__, options: options || {} }) },
  on: function (event, callback) {
    if (!listeners[event]) throw new Error('unsupported: figma.on(' + event + ')')
    listeners[event].push(callback)
  },
  off: function (event, callback) {
    if (!listeners[event]) return
    listeners[event] = listeners[event].filter(function (item) { return item !== callback })
  },
  util: {
    rgb: function (value) { var color = colorChannels(value); return { r: color.r, g: color.g, b: color.b } },
    rgba: function (value) { var color = colorChannels(arguments.length > 1 ? value : value); var alpha = arguments.length > 1 ? arguments[1] : (value && value.a) || 1; return { r: color.r, g: color.g, b: color.b, a: alpha } },
    solidPaint: function (color) { return { type: 'SOLID', color: colorChannels(color) } },
  },
  clientStorage: {
    getAsync: function (key) { return Promise.resolve(host('storageGet', { key: key })) },
    setAsync: function (key, value) { host('storageSet', { key: key, value: value }); return Promise.resolve() },
    deleteAsync: function (key) { host('storageDelete', { key: key }); return Promise.resolve() },
    keysAsync: function () { return Promise.resolve(host('storageKeys', {}) || []) },
  },
  ui: {
    postMessage: function (message) { host('uiPost', { message: message }) },
    resize: function (width, height) { host('uiResize', { width: width, height: height }) },
    onmessage: null,
    on: function (type, callback) { if (type !== 'message') throw new Error('unsupported: figma.ui.on(' + type + ')'); uiListeners.push(callback) },
    off: function (type, callback) { if (type === 'message') uiListeners = uiListeners.filter(function (item) { return item !== callback }) },
  },
}
Object.defineProperty(figma, 'root', { get: function () { return wrap(host('getPage', {}).id && host('get', { id: host('getPage', {}).id, prop: 'parent' }).id) } })
Object.defineProperty(figma, 'currentPage', {
  get: function () { return wrap(host('getPage', {}).id) },
  set: function (page) { host('setPage', { id: page.id }); cache.delete(page.id) },
})
Object.defineProperty(figma, 'viewport', {
  get: function () {
    return {
      get center() {
        var view = host('viewport', {})
        if (view.width && view.height && view.zoom) return { x: -view.x + view.width / 2 / view.zoom, y: -view.y + view.height / 2 / view.zoom }
        return { x: -view.x, y: -view.y }
      },
      get zoom() { return host('viewport', {}).zoom },
      set zoom(value) { host('setViewport', { zoom: value }) },
      scrollAndZoomIntoView: function (nodes) { host('reveal', { ids: (nodes || []).map(function (node) { return node.id }) }) },
      get bounds() { var view = host('viewport', {}); return { x: -view.x, y: -view.y, width: view.width || 0, height: view.height || 0 } },
    }
  },
})
Object.defineProperty(figma, 'variables', { get: function () { throw new Error('unsupported: figma.variables') } })
Object.defineProperty(figma, 'teamLibrary', { get: function () { throw new Error('unsupported: figma.teamLibrary') } })
function __deliverUiMessage(json) {
  var message = JSON.parse(json)
  if (typeof figma.ui.onmessage === 'function') figma.ui.onmessage(message)
  for (var i = 0; i < uiListeners.length; i++) uiListeners[i](message)
}
function __emit(event) {
  var list = listeners[event] || []
  for (var i = 0; i < list.length; i++) list[i]()
}
`

export type GuestApi = {
  figma: Record<string, unknown>
  __deliverUiMessage: (json: string) => void
  __emit: (event: string) => void
}

export function createGuestApi(host: PluginHostHandler, html = ''): GuestApi {
  const bridge = (op: string, payload: string) => {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = payload ? JSON.parse(payload) as Record<string, unknown> : {}
    } catch {
      throw new PluginApiError('plugin_failed', 'Plugin payload is not JSON')
    }
    const result = host(op, parsed)
    return JSON.stringify(result ?? null)
  }
  const factory = new Function('__host', '__html__', `${guestPrelude}\nreturn { figma: figma, __deliverUiMessage: __deliverUiMessage, __emit: __emit }`)
  return factory(bridge, html) as GuestApi
}

export async function runGuestScript(code: string, host: PluginHostHandler, html = ''): Promise<GuestApi> {
  const api = createGuestApi(host, html)
  const AsyncFunction = Object.getPrototypeOf(async function () { return undefined }).constructor as new (...args: string[]) => (figma: unknown, html: string) => Promise<unknown>
  try {
    await new AsyncFunction('figma', '__html__', code)(api.figma, html)
  } catch (error) {
    if (!pluginErrorMessageIncludesClosed(error)) throw error
  }
  return api
}

export function pluginErrorMessageIncludesClosed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('__plugin_closed__') || (error instanceof PluginApiError && error.code === 'plugin_closed')
}
