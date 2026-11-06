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
    findAllWithCriteria: function (criteria) { return findAll(id, function (node) { return criteriaMatch(criteria, node) }) },
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
      if (prop === 'findAllWithCriteria') return function (criteria) { return findAll(nodeId, function (node) { return criteriaMatch(criteria, node) }) }
      if (prop === 'findOne') return function (callback) { return findOne(nodeId, callback) }
      if (prop === 'findChildren') return function (callback) { return findChildren(nodeId, callback) }
      if (prop === 'createInstance') return function () { return wrap(host('instance', { componentId: nodeId }).id) }
      if (prop === 'detachInstance') return function () { host('detach', { id: nodeId }); return wrap(nodeId) }
      if (prop === 'getPluginData' || prop === 'setPluginData' || prop === 'getPluginDataKeys' || prop === 'getSharedPluginData' || prop === 'setSharedPluginData' || prop === 'getSharedPluginDataKeys')
        return pluginDataMethods('node', nodeId)[prop]
      if (prop === 'exportAsync') return function (settings) {
        const format = settings && settings.format || 'PNG'
        const constraint = settings && settings.constraint
        const scale = constraint && constraint.type === 'SCALE' ? constraint.value : undefined
        const normalized = String(format).toUpperCase()
        if (normalized === 'SVG') return Promise.resolve().then(function () {
          const result = host('export', { id: nodeId, format: 'SVG', scale: scale })
          if (typeof TextEncoder === 'function') return new TextEncoder().encode(result.text)
          const encoded = unescape(encodeURIComponent(result.text))
          const bytes = new Uint8Array(encoded.length)
          for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i)
          return bytes
        })
        if (normalized === 'PNG' || normalized === 'JPG') {
          return new Promise(function (resolve, reject) {
            let result
            try { result = host('exportBegin', { id: nodeId, format: normalized, scale: scale }) }
            catch (error) { reject(error); return }
            if (result && result.pending) exportWaiters[result.pending] = { resolve: resolve, reject: reject }
            else resolve(null)
          }).then(function (payload) {
            if (!payload) return null
            return new Uint8Array(figma.base64Decode(payload.base64 || ''))
          })
        }
        throw new Error('unsupported_api: exportAsync supports SVG, PNG and JPG in this host')
      }
      if (prop === 'setBoundVariable') return function (field, variable) {
        host('variableBind', { id: nodeId, field: field, variableId: variable ? variable.id : null })
      }
      if (prop === 'boundVariables') {
        const snap = read(nodeId).boundVariables || {}
        const bound = {}
        for (const key in snap) if (snap[key]) bound[key] = variableProxy(snap[key])
        return bound
      }
      if (prop === 'setRelaunchData' || prop === 'getStyledTextSegments')
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
function criteriaMatch(criteria, node) {
  if (!criteria || typeof criteria !== 'object' || !Array.isArray(criteria.types) || !criteria.types.length)
    throw new Error('invalid_value: findAllWithCriteria requires types')
  if (criteria.pluginData || criteria.sharedPluginData) unsupported('findAllWithCriteria plugin data filter')
  for (let i = 0; i < criteria.types.length; i++) if (criteria.types[i] === node.type) return true
  return false
}
function styleProxy(id) {
  function read() {
    const snap = host('styleRead', { id: id })
    if (!snap) throw new Error('Style does not exist')
    return snap
  }
  return {
    get id() { return id },
    get type() { return read().type },
    get name() { return read().name },
    set name(value) { host('stylePatch', { id: id, name: value }) },
    get key() { return id },
    get description() { return '' },
    set description(_value) {},
    get paints() { return read().paints },
    set paints(value) { host('stylePatch', { id: id, paints: value }) },
    get effects() { return read().effects },
    set effects(value) { host('stylePatch', { id: id, effects: value }) },
    get fontName() { return read().fontName },
    set fontName(value) { host('stylePatch', { id: id, fontName: value }) },
    get fontSize() { return read().fontSize },
    set fontSize(value) { host('stylePatch', { id: id, fontSize: value }) },
    get letterSpacing() { return read().letterSpacing },
    set letterSpacing(value) { host('stylePatch', { id: id, letterSpacing: value }) },
    get lineHeight() { return read().lineHeight },
    set lineHeight(value) { host('stylePatch', { id: id, lineHeight: value }) },
    get textCase() { return read().textCase },
    set textCase(value) { host('stylePatch', { id: id, textCase: value }) },
    get textDecoration() { return read().textDecoration },
    set textDecoration(value) { host('stylePatch', { id: id, textDecoration: value }) },
    get textAlignHorizontal() { return read().textAlignHorizontal },
    get textAlignVertical() { return read().textAlignVertical },
    get textAutoResize() { return read().textAutoResize },
    get paragraphSpacing() { return read().paragraphSpacing },
    set paragraphSpacing(value) { host('stylePatch', { id: id, paragraphSpacing: value }) },
    get paragraphIndent() { return read().paragraphIndent },
    set paragraphIndent(value) { host('stylePatch', { id: id, paragraphIndent: value }) },
    remove: function () { host('styleDelete', { id: id }) },
  }
}
function imageObject(hash) {
  return {
    hash: hash,
    getBytesAsync: function () {
      return Promise.resolve().then(function () { return figma.base64Decode(host('imageBytes', { hash: hash })) })
    },
    getSizeAsync: function () {
      return Promise.resolve().then(function () { return host('imageSize', { hash: hash }) })
    },
  }
}
function variableProxy(id) {
  return {
    get id() { return id },
    get name() { return host('variableRead', { id: id }).name },
    set name(value) { host('variableRename', { id: id, name: String(value) }) },
    get resolvedType() { return host('variableRead', { id: id }).resolvedType },
    get variableCollectionId() { return host('variableRead', { id: id }).collectionId },
    setValueForMode: function (modeId, value) { host('variableSet', { id: id, mode: String(modeId), value: value }) },
    remove: function () { host('variableDelete', { id: id }) },
  }
}
function collectionProxy(id) {
  function read() {
    const snap = host('collectionRead', { id: id })
    if (!snap) throw new Error('Variable collection does not exist')
    return snap
  }
  return {
    get id() { return id },
    get name() { return read().name },
    set name(value) { host('collectionRename', { id: id, name: String(value) }) },
    get modes() { return read().modes },
    get defaultModeId() { return read().defaultModeId },
    get variableIds() { return read().variableIds },
    addMode: function (name) { return host('collectionAddMode', { id: id, name: String(name) }).modeId },
    renameMode: function (modeId, name) { host('collectionRenameMode', { id: id, mode: String(modeId), name: String(name) }) },
    remove: function () { host('collectionDelete', { id: id }) },
  }
}
function create(kind) { return wrap(host('create', { kind: kind }).id) }
function booleanOp(operation, nodes) {
  return wrap(host('boolean', { operation: operation, ids: nodes.map(function (node) { return node.id }) }).id)
}
const __pluginMeta = host('meta', null)
const listeners = { selectionchange: [], currentpagechange: [], documentchange: [], close: [] }
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
  createSlice: function () { return create('slice') },
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
        if (!result.found || result.kind === 'undefined') return undefined
        if (result.kind === 'bytes') {
          const parts = result.parts || []
          const chunks = []
          let total = 0
          for (let index = 0; index < parts.length; index++) {
            const chunk = figma.base64Decode(parts[index])
            chunks.push(chunk)
            total += chunk.length
          }
          const bytes = new Uint8Array(total)
          let offset = 0
          for (let index = 0; index < chunks.length; index++) {
            bytes.set(chunks[index], offset)
            offset += chunks[index].length
          }
          return bytes
        }
        return result.value
      })
    },
    setAsync: function (key, value) {
      return Promise.resolve().then(function () {
        if (value === undefined) { host('clientStorageSet', { key: key, kind: 'undefined' }); return }
        if (typeof Uint8Array === 'function' && value instanceof Uint8Array) {
          const chunk = 120000
          const parts = Math.max(1, Math.ceil(value.length / chunk))
          for (let index = 0; index < parts; index++) {
            const slice = value.subarray(index * chunk, Math.min(value.length, (index + 1) * chunk))
            host('clientStorageSet', { key: key, kind: 'bytes', part: index, parts: parts, rawBytes: value.length, base64: figma.base64Encode(slice) })
          }
          return
        }
        let json
        try { json = JSON.stringify(value) } catch (error) { throw new Error('invalid_value: clientStorage value must be JSON') }
        if (typeof json !== 'string') throw new Error('invalid_value: clientStorage value must be JSON')
        host('clientStorageSet', { key: key, json: json })
      })
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
    return new Promise(function (resolve, reject) {
      let result
      try { result = host('loadFont', { family: fontName.family, style: fontName.style }) }
      catch (error) { reject(error); return }
      if (result && result.pending) fontWaiters[result.pending] = { resolve: resolve, reject: reject }
      else resolve(undefined)
    })
  },
  listAvailableFontsAsync: function () { return Promise.resolve().then(function () { return host('fonts', null) }) },
  createImage: function (data) {
    if (!data || typeof data.length !== 'number') throw new Error('invalid_value: createImage expects bytes')
    return imageObject(host('imageCreate', { base64: figma.base64Encode(data) }).hash)
  },
  createImageAsync: function () { unsupported('figma.createImageAsync') },
  getImageByHash: function (hash) {
    const found = host('imageFind', { hash: String(hash) })
    return found ? imageObject(found.hash) : null
  },
  variables: {
    getLocalVariableCollections: function () { return host('collectionList', null).map(function (item) { return collectionProxy(item.id) }) },
    getLocalVariables: function (type) { return host('variableList', { type: type || null }).map(function (item) { return variableProxy(item.id) }) },
    getVariableById: function (id) {
      if (id == null) return null
      const snap = host('variableRead', { id: String(id) })
      return snap ? variableProxy(snap.id) : null
    },
    createVariableCollection: function (name) { return collectionProxy(host('collectionCreate', { name: String(name) }).id) },
    createVariable: function (name, collection, resolvedType) {
      return variableProxy(host('variableCreate', { name: String(name), collectionId: collection && collection.id, resolvedType: String(resolvedType) }).id)
    },
  },
  createNodeFromSvg: function (svg) { return wrap(host('svg', { svg: String(svg) }).id) },
  getLocalPaintStyles: function () { return host('styleList', { kind: 'paint' }).map(function (item) { return styleProxy(item.id) }) },
  getLocalTextStyles: function () { return host('styleList', { kind: 'text' }).map(function (item) { return styleProxy(item.id) }) },
  getLocalEffectStyles: function () { return host('styleList', { kind: 'effect' }).map(function (item) { return styleProxy(item.id) }) },
  getStyleById: function (id) {
    if (id == null) return null
    const snap = host('styleRead', { id: String(id) })
    return snap ? styleProxy(snap.id) : null
  },
  createPaintStyle: function () { return styleProxy(host('styleCreate', { kind: 'paint' }).id) },
  createTextStyle: function () { return styleProxy(host('styleCreate', { kind: 'text' }).id) },
  createEffectStyle: function () { return styleProxy(host('styleCreate', { kind: 'effect' }).id) },
  base64Encode: function (data) {
    const bytes = []
    const view = data && typeof data.length === 'number' ? data : []
    if (view.length > 262144) throw new Error('plugin_limit: base64Encode input is too large')
    for (let i = 0; i < view.length; i++) bytes.push(view[i] & 255)
    return host('base64Encode', { bytes: bytes })
  },
  base64Decode: function (data) {
    const bytes = host('base64Decode', { data: String(data) })
    return Uint8Array.from(bytes)
  },
  createVector: function () { unsupported('figma.createVector') },
  loadAllPagesAsync: function () { return Promise.resolve(host('loadAllPages', null)) },
  getNodeByIdAsync: function (id) { return Promise.resolve(figma.getNodeById(id)) },
  setCurrentPageAsync: function (page) { return Promise.resolve(host('setPage', { id: page && page.id })) },
  getStyleByIdAsync: function (id) { return Promise.resolve(figma.getStyleById(id)) },
  getLocalPaintStylesAsync: function () { return Promise.resolve(figma.getLocalPaintStyles()) },
  getLocalTextStylesAsync: function () { return Promise.resolve(figma.getLocalTextStyles()) },
  getLocalEffectStylesAsync: function () { return Promise.resolve(figma.getLocalEffectStyles()) },
  importComponentByKeyAsync: function () { unsupported('figma.importComponentByKeyAsync') },
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
  const event = type === 'documentchange' ? { documentChanges: [] } : undefined
  const list = (listeners[type] || []).slice()
  for (let i = 0; i < list.length; i++) list[i](event)
}
globalThis.figma = figma
globalThis.console = {
  log: function () { host('log', { level: 'log', message: Array.prototype.join.call(arguments, ' ') }) },
  warn: function () { host('log', { level: 'warn', message: Array.prototype.join.call(arguments, ' ') }) },
  error: function () { host('log', { level: 'error', message: Array.prototype.join.call(arguments, ' ') }) },
}
const fetchWaiters = {}
const exportWaiters = {}
globalThis.__finishExport = function (id, payload) {
  const waiter = exportWaiters[id]
  delete exportWaiters[id]
  if (!waiter) return
  if (!payload || payload.ok === false) waiter.reject(new Error((payload && payload.code || 'export_failed') + ': ' + (payload && payload.message || 'Raster export failed')))
  else waiter.resolve({ base64: payload.base64 || '' })
}
let fetchSerial = 1
const fontWaiters = {}
globalThis.__finishFont = function (id, payload) {
  const waiter = fontWaiters[id]
  delete fontWaiters[id]
  if (!waiter) return
  if (!payload || payload.ok === false) waiter.reject(new Error((payload && payload.code || 'font_unavailable') + ': ' + (payload && payload.message || 'Font did not load')))
  else waiter.resolve(undefined)
}
globalThis.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input && input.url
  const method = init && init.method || 'GET'
  const headers = {}
  const source = init && init.headers
  if (source && typeof source.forEach === 'function') source.forEach(function (value, key) { headers[key] = String(value) })
  else if (source && typeof source === 'object') {
    for (const key in source) headers[key] = String(source[key])
  }
  const body = init && init.body
  if (body != null && typeof body !== 'string') throw new Error('invalid_value: fetch body must be a string')
  return new Promise(function (resolve, reject) {
    const id = fetchSerial++
    fetchWaiters[id] = { resolve: resolve, reject: reject }
    try { host('fetchBegin', { id: id, url: String(url), method: method, headers: headers, body: body == null ? null : body }) }
    catch (error) { delete fetchWaiters[id]; reject(error) }
  })
}
globalThis.__finishFetch = function (id, payload) {
  const waiter = fetchWaiters[id]
  delete fetchWaiters[id]
  if (!waiter) return
  if (!payload || payload.ok === false && payload.code) {
    waiter.reject(new Error((payload && payload.code || 'network_denied') + ': ' + (payload && payload.message || 'Plugin fetch failed')))
    return
  }
  const bytes = figma.base64Decode(payload.bodyBase64 || '')
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
  try { text = decodeURIComponent(escape(text)) } catch (error) {}
  const response = {
    ok: payload.status >= 200 && payload.status < 300,
    status: payload.status,
    url: payload.url,
    headers: { get: function (name) { const value = payload.headers && payload.headers[String(name).toLowerCase()]; return value == null ? null : value } },
    text: function () { return Promise.resolve(text) },
    json: function () { return Promise.resolve(JSON.parse(text)) },
    arrayBuffer: function () { return Promise.resolve(bytes.buffer) },
  }
  waiter.resolve(response)
}
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
