/** Guest-side Figma-shaped API. It can only reach the host through __host. */
export const PLUGIN_PRELUDE = String.raw`
const __bridge = globalThis.__host
try { delete globalThis.__host } catch (error) {}
const FIND_LIMIT = 2000
const cache = new Map()
let documentCache = null
const dead = new Set()
const proxies = new Map()
function unsupported(api) {
  throw new Error('unsupported_api: ' + api + ' is not available in Futureox Design')
}
function host(op, payload) {
  const reading = {
    readNode: 1, readDocument: 1, children: 1, fonts: 1, log: 1, notify: 1, postMessage: 1,
    showUI: 1, uiResize: 1, uiShow: 1, uiHide: 1, uiClose: 1, loadFont: 1, meta: 1, listen: 1,
    viewportRead: 1, clientStorageGet: 1, clientStorageKeys: 1,
    pluginDataGet: 1, pluginDataKeys: 1, sharedPluginDataGet: 1, sharedPluginDataKeys: 1,
  }
  if (!reading[op]) { cache.clear(); documentCache = null }
  const raw = __bridge(op, JSON.stringify(payload === undefined ? null : payload))
  const parsed = JSON.parse(raw)
  if (!parsed.ok) {
    if (parsed.code === 'plugin_closed') throw new Error('__futureox_plugin_closed__:' + (parsed.message || ''))
    throw new Error((parsed.code || 'plugin_failed') + ': ' + (parsed.message || 'Plugin failed'))
  }
  return parsed.result
}
function readDocument() {
  if (!documentCache) documentCache = host('readDocument', null)
  return documentCache
}
function read(id) {
  if (dead.has(id)) throw new Error('Node has been removed')
  let snap = cache.get(id)
  if (!snap) {
    snap = host('readNode', { id: id })
    if (!snap || snap.type === 'PAGE') throw new Error('Node does not exist')
    cache.set(id, snap)
  }
  return snap
}
function pageRecord(id) {
  const doc = readDocument()
  for (let i = 0; i < doc.pages.length; i++) if (doc.pages[i].id === id) return doc.pages[i]
  throw new Error('Page does not exist')
}
function pluginDataMethods(scope, id) {
  return {
    getPluginData: function (key) { return host('pluginDataGet', { scope: scope, id: id, key: String(key) }) },
    setPluginData: function (key, value) {
      if (typeof value !== 'string') throw new Error('invalid_value: Plugin data values must be strings')
      host('pluginDataSet', { scope: scope, id: id, key: String(key), value: value })
    },
    getPluginDataKeys: function () { return host('pluginDataKeys', { scope: scope, id: id }) },
    getSharedPluginData: function (namespace, key) { return host('sharedPluginDataGet', { scope: scope, id: id, namespace: String(namespace), key: String(key) }) },
    setSharedPluginData: function (namespace, key, value) {
      if (typeof value !== 'string') throw new Error('invalid_value: Plugin data values must be strings')
      host('sharedPluginDataSet', { scope: scope, id: id, namespace: String(namespace), key: String(key), value: value })
    },
    getSharedPluginDataKeys: function (namespace) { return host('sharedPluginDataKeys', { scope: scope, id: id, namespace: String(namespace) }) },
  }
}
function pageProxy(id) {
  const data = pluginDataMethods('page', id)
  return {
    get id() { return id },
    get type() { return 'PAGE' },
    get name() { return pageRecord(id).name },
    set name(value) { host('renamePage', { id: id, name: value }) },
    get children() { return pageRecord(id).childIds.map(wrap) },
    get selection() {
      const doc = readDocument()
      return doc.currentPageId === id ? doc.selection.map(wrap) : []
    },
    set selection(nodes) {
      host('setPage', { id: id })
      host('selection', { ids: nodes.map(function (node) { return node.id }) })
    },
    appendChild: function (child) { host('move', { id: child.id, parentId: id }); return child },
    insertChild: function (index, child) { host('move', { id: child.id, parentId: id, index: index }); return child },
    findAll: function (callback) { return findAll(id, callback) },
    findOne: function (callback) { return findOne(id, callback) },
    findChildren: function (callback) { return findChildren(id, callback) },
    getPluginData: data.getPluginData,
    setPluginData: data.setPluginData,
    getPluginDataKeys: data.getPluginDataKeys,
    getSharedPluginData: data.getSharedPluginData,
    setSharedPluginData: data.setSharedPluginData,
    getSharedPluginDataKeys: data.getSharedPluginDataKeys,
  }
}
function visit(id, callback, into, state) {
  const children = host('children', { id: id }).ids
  for (let i = 0; i < children.length; i++) {
    state.count += 1
    if (state.count > FIND_LIMIT) throw new Error('findAll visited more than ' + FIND_LIMIT + ' nodes')
    const node = wrap(children[i])
    if (!callback || callback(node)) into.push(node)
    visit(children[i], callback, into, state)
  }
}
function findAll(id, callback) {
  const found = []
  visit(id, callback, found, { count: 0 })
  return found
}
function findOne(id, callback) {
  const found = []
  try { visit(id, function (node) { if (callback(node)) { found.push(node); throw found } return false }, [], { count: 0 }) }
  catch (error) { if (error === found) return found[0] ; throw error }
  return null
}
function findChildren(id, callback) {
  return host('children', { id: id }).ids.map(wrap).filter(function (node) { return !callback || callback(node) })
}
function wrap(id) {
  if (proxies.has(id)) return proxies.get(id)
  const proxy = new Proxy({ id: id }, {
    get: function (target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined
      const nodeId = target.id
      if (prop === 'id') return nodeId
      if (prop === 'removed') return dead.has(nodeId)
      if (prop === 'parent') {
        const snap = read(nodeId)
        if (!snap.parentId) return null
        return snap.parentIsPage ? pageProxy(snap.parentId) : wrap(snap.parentId)
      }
      if (prop === 'children') return read(nodeId).childIds.map(wrap)
      if (prop === 'mainComponent') { const main = read(nodeId).mainComponentId; return main ? wrap(main) : null }
      if (prop === 'cornerRadius') { const radius = read(nodeId).cornerRadius; return radius === null ? figma.mixed : radius }
      if (prop === 'resize' || prop === 'resizeWithoutConstraints') return function (width, height) { host('resize', { id: nodeId, width: width, height: height }) }
      if (prop === 'remove') return function () { dead.add(nodeId); host('remove', { id: nodeId }) }
      if (prop === 'clone') return function () { return wrap(host('clone', { id: nodeId }).id) }
      if (prop === 'appendChild') return function (child) { host('move', { id: child.id, parentId: nodeId }); return child }
      if (prop === 'insertChild') return function (index, child) { host('move', { id: child.id, parentId: nodeId, index: index }); return child }
      if (prop === 'findAll') return function (callback) { return findAll(nodeId, callback) }
      if (prop === 'findOne') return function (callback) { return findOne(nodeId, callback) }
      if (prop === 'findChildren') return function (callback) { return findChildren(nodeId, callback) }
      if (prop === 'createInstance') return function () { return wrap(host('instance', { componentId: nodeId }).id) }
      if (prop === 'detachInstance') return function () { host('detach', { id: nodeId }); return wrap(nodeId) }
      if (prop === 'getPluginData' || prop === 'setPluginData' || prop === 'getPluginDataKeys' || prop === 'getSharedPluginData' || prop === 'setSharedPluginData' || prop === 'getSharedPluginDataKeys')
        return pluginDataMethods('node', nodeId)[prop]
      if (prop === 'exportAsync' || prop === 'setRelaunchData' || prop === 'getStyledTextSegments')
        return function () { unsupported('SceneNode.' + prop) }
      const snap = read(nodeId)
      if (Object.prototype.hasOwnProperty.call(snap, prop)) return snap[prop]
      return undefined
    },
    set: function (target, prop, value) {
      if (value === figma.mixed) unsupported('figma.mixed')
      host('patch', { id: target.id, props: { [prop]: value } })
      return true
    },
  })
  proxies.set(id, proxy)
  return proxy
}
function create(kind) { return wrap(host('create', { kind: kind }).id) }
function booleanOp(operation, nodes) {
  return wrap(host('boolean', { operation: operation, ids: nodes.map(function (node) { return node.id }) }).id)
}
const __pluginMeta = host('meta', null)
const listeners = { selectionchange: [], currentpagechange: [], close: [] }
let closing = false
let skipInvisibleInstanceChildren = true
function channel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('invalid_value: color channel must be from 0 to 1')
  return value
}
function hexChannels(input) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(input).trim())
  if (!match) throw new Error('invalid_value: color must be #RGB, #RRGGBB, or #RRGGBBAA')
  let hex = match[1]
  if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2)
  const value = parseInt(hex.slice(0, 6), 16)
  return {
    rgb: { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 },
    alpha: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  }
}
const figma = {
  mixed: Object.freeze({ kind: 'mixed' }),
  createRectangle: function () { return create('rectangle') },
  createEllipse: function () { return create('ellipse') },
  createFrame: function () { return create('frame') },
  createSection: function () { return create('section') },
  createPolygon: function () { return create('polygon') },
  createStar: function () { return create('star') },
  createLine: function () { return create('line') },
  createText: function () { return create('text') },
  createComponent: function () { return wrap(host('component', null).id) },
  createComponentFromNode: function (node) { return wrap(host('componentFromNode', { id: node.id }).id) },
  createPage: function (options) { return pageProxy(host('createPage', { name: options && options.name, makeCurrent: !!(options && options.makeCurrent) }).id) },
  group: function (nodes, parent) { return wrap(host('group', { ids: nodes.map(function (node) { return node.id }), parentId: parent.id }).id) },
  ungroup: function (node) { return host('ungroup', { id: node.id }).ids.map(wrap) },
  union: function (nodes) { return booleanOp('union', nodes) },
  subtract: function (nodes) { return booleanOp('subtract', nodes) },
  intersect: function (nodes) { return booleanOp('intersect', nodes) },
  exclude: function (nodes) { return booleanOp('exclude', nodes) },
  getNodeById: function (id) {
    if (id == null) return null
    const snap = host('readNode', { id: String(id) })
    if (!snap) return null
    if (snap.type === 'PAGE') return pageProxy(snap.id)
    cache.set(snap.id, snap)
    return wrap(snap.id)
  },
  get currentPage() { return pageProxy(readDocument().currentPageId) },
  set currentPage(page) { host('setPage', { id: page.id }) },
  get root() {
    const id = readDocument().id
    const data = pluginDataMethods('root', id)
    return {
      get type() { return 'DOCUMENT' },
      get id() { return id },
      get name() { return readDocument().name },
      get children() { return readDocument().pages.map(function (page) { return pageProxy(page.id) }) },
      getPluginData: data.getPluginData,
      setPluginData: data.setPluginData,
      getPluginDataKeys: data.getPluginDataKeys,
      getSharedPluginData: data.getSharedPluginData,
      setSharedPluginData: data.setSharedPluginData,
      getSharedPluginDataKeys: data.getSharedPluginDataKeys,
    }
  },
  get editorType() { return 'figma' },
  get mode() { return 'default' },
  get pluginId() { return __pluginMeta.pluginId },
  get fileKey() { return null },
  get command() { return __pluginMeta.command == null ? undefined : __pluginMeta.command },
  get currentUser() { return null },
  get skipInvisibleInstanceChildren() { return skipInvisibleInstanceChildren },
  set skipInvisibleInstanceChildren(value) { skipInvisibleInstanceChildren = !!value },
  notify: function (message) { host('notify', { message: String(message) }) },
  commitUndo: function () { host('commitUndo', null) },
  closePlugin: function (message) {
    if (!closing) {
      closing = true
      const list = listeners.close.splice(0)
      for (let i = 0; i < list.length; i++) list[i]()
    }
    host('close', { message: message == null ? '' : String(message) })
  },
  showUI: function (html, options) {
    host('showUI', {
      html: html == null ? __html__ : String(html),
      width: options && options.width,
      height: options && options.height,
      visible: options && options.visible,
      title: options && options.title,
    })
  },
  on: function (type, callback) {
    if (!listeners[type] || typeof callback !== 'function') unsupported('figma.on(' + type + ')')
    listeners[type].push(callback)
    if (type !== 'close') host('listen', { type: type })
  },
  off: function (type, callback) {
    const list = listeners[type]
    if (!list) unsupported('figma.off(' + type + ')')
    const index = list.indexOf(callback)
    if (index >= 0) list.splice(index, 1)
  },
  viewport: {
    get zoom() { return host('viewportRead', null).zoom },
    set zoom(value) { host('viewportZoom', { zoom: value }) },
    get center() { return host('viewportRead', null).center },
    set center(value) { host('viewportCenter', { x: value && value.x, y: value && value.y }) },
    scrollAndZoomIntoView: function (nodes) {
      host('viewportReveal', { ids: (nodes || []).map(function (node) { return node.id }) })
    },
  },
  clientStorage: {
    getAsync: function (key) {
      return Promise.resolve().then(function () {
        const result = host('clientStorageGet', { key: key })
        return result.found ? result.value : undefined
      })
    },
    setAsync: function (key, value) {
      let json
      try { json = JSON.stringify(value) } catch (error) { throw new Error('invalid_value: clientStorage value must be JSON') }
      if (typeof json !== 'string') throw new Error('invalid_value: clientStorage value must be JSON')
      return Promise.resolve().then(function () { host('clientStorageSet', { key: key, json: json }) })
    },
    deleteAsync: function (key) {
      return Promise.resolve().then(function () { host('clientStorageDelete', { key: key }) })
    },
    keysAsync: function () {
      return Promise.resolve().then(function () { return host('clientStorageKeys', null) })
    },
  },
  util: {
    rgb: function (r, g, b) { return { r: channel(r), g: channel(g), b: channel(b) } },
    rgba: function (r, g, b, a) { return { r: channel(r), g: channel(g), b: channel(b), a: channel(a) } },
    solidPaint: function (color) {
      if (typeof color === 'string') {
        const parsed = hexChannels(color)
        const paint = { type: 'SOLID', color: parsed.rgb }
        if (parsed.alpha !== 1) paint.opacity = parsed.alpha
        return paint
      }
      if (color && typeof color === 'object') return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b } }
      throw new Error('invalid_value: solidPaint expects a color')
    },
  },
  loadFontAsync: function (fontName) {
    return Promise.resolve().then(function () { return host('loadFont', { family: fontName.family, style: fontName.style }) })
  },
  listAvailableFontsAsync: function () { return Promise.resolve().then(function () { return host('fonts', null) }) },
  createImage: function () { unsupported('figma.createImage') },
  createImageAsync: function () { unsupported('figma.createImageAsync') },
  createNodeFromSvg: function () { unsupported('figma.createNodeFromSvg') },
  createVector: function () { unsupported('figma.createVector') },
  loadAllPagesAsync: function () { unsupported('figma.loadAllPagesAsync') },
  importComponentByKeyAsync: function () { unsupported('figma.importComponentByKeyAsync') },
  createPaintStyle: function () { unsupported('figma.createPaintStyle') },
  createTextStyle: function () { unsupported('figma.createTextStyle') },
  createEffectStyle: function () { unsupported('figma.createEffectStyle') },
  createGridStyle: function () { unsupported('figma.createGridStyle') },
  ui: {
    onmessage: null,
    postMessage: function (message) { host('postMessage', { message: message }) },
    resize: function (width, height) { host('uiResize', { width: width, height: height }) },
    show: function () { host('uiShow', null) },
    hide: function () { host('uiHide', null) },
    close: function () { host('uiClose', null) },
    on: function (type, callback) {
      if (type !== 'message') unsupported('figma.ui.on')
      figma.ui.onmessage = callback
    },
  },
}
globalThis.__deliverPluginMessage = function (message) {
  if (typeof figma.ui.onmessage === 'function') figma.ui.onmessage(message)
}
globalThis.__deliverPluginEvent = function (type) {
  const list = (listeners[type] || []).slice()
  for (let i = 0; i < list.length; i++) list[i]()
}
globalThis.figma = figma
globalThis.console = {
  log: function () { host('log', { level: 'log', message: Array.prototype.join.call(arguments, ' ') }) },
  warn: function () { host('log', { level: 'warn', message: Array.prototype.join.call(arguments, ' ') }) },
  error: function () { host('log', { level: 'error', message: Array.prototype.join.call(arguments, ' ') }) },
}
globalThis.fetch = function () { unsupported('fetch') }
globalThis.setTimeout = function (fn, ms) {
  if (typeof fn !== 'function') throw new Error('invalid_value: setTimeout expects a function')
  if (ms !== undefined && ms !== 0) unsupported('setTimeout delay')
  Promise.resolve().then(function () { fn() })
  return 0
}
globalThis.clearTimeout = function () {}
globalThis.setInterval = function () { unsupported('setInterval') }
globalThis.clearInterval = function () {}
`
