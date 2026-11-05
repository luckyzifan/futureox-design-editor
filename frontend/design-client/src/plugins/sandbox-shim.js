// Figma 插件容器沙箱垫片（纯 JS，由宿主以 ?raw 内联到 sandbox iframe）。
//
// 运行环境：`<iframe sandbox="allow-scripts">` + CSP default-src 'none'，
// 不透明源、无 DOM 存储、无网络。插件 main 代码由本垫片在收到
// plugin-init 镜像后以动态 <script> 注入执行（与 Figma 的 QuickJS 沙箱
// 对应：插件代码只看得到本文件定义的 `figma` 全局与 `__html__`）。
//
// P0 语义取舍（相对 Figma 官方 API，均会在偏离处打日志）：
//  - 节点读为镜像快照（同步），写为乐观更新 + 异步 automation 操作；
//  - loadFontAsync 对未知字体族回退到内置默认字体（Figma 会抛错）；
//  - viewport.scrollAndZoomIntoView 为记录警告的 no-op；
//  - documentchange 事件由本插件自身操作近似合成，外部编辑不推送。
(function () {
  'use strict'
  if (window.__figmaSandboxBooted) return
  window.__figmaSandboxBooted = true

  var KIND_TO_TYPE = {
    frame: 'FRAME', group: 'GROUP', section: 'SECTION', rectangle: 'RECTANGLE',
    ellipse: 'ELLIPSE', line: 'LINE', polygon: 'POLYGON', star: 'STAR',
    vector: 'VECTOR', text: 'TEXT', slice: 'SLICE',
  }
  var TYPE_TO_KIND = {}
  Object.keys(KIND_TO_TYPE).forEach(function (kind) { TYPE_TO_KIND[KIND_TO_TYPE[kind]] = kind })

  var state = {
    inited: false, closed: false,
    documentId: '', documentName: '', revision: 0,
    pages: [], pageId: null, selection: [],
    nodes: {}, fonts: [],
    detachedCounter: 0,
    opSeq: 0, opWaiters: {},
    handlers: {}, uiHandlers: {},
    warned: {},
  }

  function post(message) {
    // 会话令牌由宿主注入本文档；宿主只信带正确令牌的信封（真实浏览器中
    // 与 event.source 校验叠加，jsdom 中作为唯一可靠身份）。
    if (typeof window.__PLUGIN_SESSION__ === 'string') message.session = window.__PLUGIN_SESSION__
    parent.postMessage(message, '*')
  }
  function log(level, message) { post({ type: 'plugin-log', level: level, message: String(message) }) }
  function warnOnce(key, message) { if (state.warned[key]) return; state.warned[key] = true; log('warn', message) }

  var nativeConsole = window.console
  function formatArg(value) {
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch (e) { return String(value) }
  }
  // 转发到宿主日志面板，同时保留原生 console（开发时浏览器可调试）。
  window.console = {
    log: function () { forward('info', arguments); nativeConsole.log.apply(nativeConsole, arguments) },
    warn: function () { forward('warn', arguments); nativeConsole.warn.apply(nativeConsole, arguments) },
    error: function () { forward('error', arguments); nativeConsole.error.apply(nativeConsole, arguments) },
    info: function () { forward('info', arguments); nativeConsole.info.apply(nativeConsole, arguments) },
    debug: function () { nativeConsole.debug.apply(nativeConsole, arguments) },
  }
  function forward(level, args) {
    try { log(level, Array.prototype.map.call(args, formatArg).join(' ')) } catch (e) { /* 静默：日志不能中断插件 */ }
  }
  window.addEventListener('error', function (event) {
    log('error', '插件未捕获错误：' + (event.message || 'unknown') + (event.filename ? '' : ''))
  })

  // ---------- 操作发送与镜像维护 ----------

  function sendOp(method, params) {
    return new Promise(function (resolve, reject) {
      if (state.closed) { reject(new Error('插件已关闭')); return }
      var opId = ++state.opSeq
      state.opWaiters[opId] = { resolve: resolve, reject: reject, method: method, params: params }
      post({ type: 'plugin-op', opId: opId, method: method, params: params })
    })
  }
  function fireAndForget(method, params) {
    return sendOp(method, params).then(function (result) {
      fireDocumentChange(method, params, result)
      return result
    }).catch(function (error) {
      log('error', '操作 ' + method + ' 失败：' + (error && error.message ? error.message : String(error)))
      throw error
    })
  }

  function snapshot(id) { return state.nodes[id] }
  function isDetached(s) { return !!s.detached }

  function mergeIntoSnapshot(s, patch) {
    Object.keys(patch).forEach(function (key) { s[key] = patch[key] })
  }

  /** detached（已创建未挂载）节点：写操作累积进创建补丁。 */
  function detachedPatch(id, patch) {
    var s = snapshot(id)
    if (!s) return
    mergeIntoSnapshot(s, patch)
    s.pendingPatch = Object.assign({}, s.pendingPatch, patch)
  }

  function attachedPatch(id, patch) {
    var s = snapshot(id)
    if (!s) return
    mergeIntoSnapshot(s, patch)
    fireAndForget('node.update', { ids: [id], patch: patch })
  }

  function genericPatch(id, patch) {
    var s = snapshot(id)
    if (!s) throw new Error('节点 ' + id + ' 不存在或已删除')
    if (isDetached(s)) detachedPatch(id, patch)
    else attachedPatch(id, patch)
  }

  /** 文本类属性走 text.set（合并 textStyle、重置失效 runs）。 */
  function textPatch(id, params) {
    var s = snapshot(id)
    if (!s) throw new Error('节点 ' + id + ' 不存在或已删除')
    if (params.textStyle) s.textStyle = Object.assign({}, s.textStyle || {}, params.textStyle)
    if (params.text !== undefined) s.text = params.text
    if (params.fontSize !== undefined) s.fontSize = params.fontSize
    if (isDetached(s)) {
      var patch = {}
      if (params.text !== undefined) patch.text = params.text
      if (params.fontSize !== undefined) patch.fontSize = params.fontSize
      if (params.textRuns !== undefined) patch.textRuns = params.textRuns
      if (params.textStyle) patch.textStyle = fullTextStyle(s.textStyle)
      detachedPatch(id, patch)
    } else {
      fireAndForget('text.set', Object.assign({ ids: [id] }, params)).then(function () {
        // text.set 的 textStyle 是合并语义；用宿主刷新覆盖本地近似。
      }).catch(function () {})
    }
  }

  // ---------- 颜色与 Paint 转换 ----------

  function hexToRgb(hex) {
    var value = String(hex || '#000000').replace('#', '')
    if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2]
    var int = parseInt(value, 16)
    if (!Number.isFinite(int)) return { r: 0, g: 0, b: 0 }
    return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 }
  }
  function componentHex(component) {
    var value = Math.max(0, Math.min(255, Math.round(component * 255)))
    return value.toString(16).padStart(2, '0')
  }
  function rgbToHex(color) {
    if (!color || typeof color.r !== 'number') return '#000000'
    return '#' + componentHex(color.r) + componentHex(color.g) + componentHex(color.b)
  }

  var GRADIENT_KINDS = { LINEAR_GRADIENT: 'linear', RADIAL_GRADIENT: 'radial', ANGULAR_GRADIENT: 'angular', DIAMOND_GRADIENT: 'diamond' }
  var NATIVE_TO_FIGMA_GRADIENT = { linear: 'LINEAR_GRADIENT', radial: 'RADIAL_GRADIENT', angular: 'ANGULAR_GRADIENT', diamond: 'DIAMOND_GRADIENT' }

  function nativeToFigmaPaint(paint) {
    if (!paint || typeof paint !== 'object') return null
    var visible = paint.visible === undefined ? true : !!paint.visible
    var opacity = typeof paint.opacity === 'number' ? paint.opacity : 1
    if (paint.kind === 'solid') {
      return { type: 'SOLID', color: hexToRgb(paint.color), opacity: opacity, visible: visible }
    }
    if (NATIVE_TO_FIGMA_GRADIENT[paint.kind]) {
      var stops = (paint.stops || []).map(function (stop) {
        return { position: stop.offset, color: hexToRgb(stop.color) }
      })
      var gradient = {
        gradientStops: stops,
        gradientTransform: paint.transform && paint.transform.length === 6
          ? [[paint.transform[0], paint.transform[1], paint.transform[4]], [paint.transform[2], paint.transform[3], paint.transform[5]]]
          : [[1, 0, 0], [0, 1, 0]],
      }
      return { type: NATIVE_TO_FIGMA_GRADIENT[paint.kind], gradientTransform: gradient.gradientTransform, gradientStops: stops, visible: visible, opacity: opacity }
    }
    if (paint.kind === 'image') {
      return { type: 'IMAGE', scaleMode: paint.fit === 'contain' ? 'FIT' : paint.fit === 'stretch' ? 'STRETCH' : 'FILL', visible: visible, opacity: opacity }
    }
    return null
  }

  function figmaToNativePaint(paint, uid) {
    if (!paint || typeof paint !== 'object') return null
    var visible = paint.visible === undefined ? true : !!paint.visible
    var opacity = typeof paint.opacity === 'number' ? Math.max(0, Math.min(1, paint.opacity)) : 1
    if (paint.type === 'SOLID') {
      var color = paint.color || { r: 0, g: 0, b: 0 }
      return { id: uid(), kind: 'solid', color: rgbToHex(color), opacity: opacity, visible: visible, angle: 90, stops: [] }
    }
    if (paint.type && GRADIENT_KINDS[paint.type]) {
      var stops = (paint.gradientStops || []).map(function (stop) {
        return { offset: typeof stop.position === 'number' ? stop.position : 0, color: rgbToHex(stop.color) }
      })
      var matrix = paint.gradientTransform
      var transform = matrix && matrix.length === 2
        ? [matrix[0][0] || 1, matrix[0][1] || 0, matrix[1][0] || 0, matrix[1][1] || 1, matrix[0][2] || 0, matrix[1][2] || 0]
        : [1, 0, 0, 1, 0, 0]
      return { id: uid(), kind: GRADIENT_KINDS[paint.type], color: '#000000', opacity: opacity, visible: visible, angle: 90, stops: stops.length ? stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], transform: transform }
    }
    if (paint.type === 'IMAGE') {
      warnOnce('image-paint', 'P0 容器忽略 IMAGE 填充的图像字节；仅保留可见性')
      return { id: uid(), kind: 'image', color: '#000000', opacity: opacity, visible: visible, angle: 90, stops: [], image: null, fit: 'cover' }
    }
    return null
  }

  // ---------- 字体名（FontName）与文档字体映射 ----------

  var STYLE_TO_WEIGHT = [
    ['thin', 100], ['hairline', 100], ['extralight', 200], ['ultralight', 200], ['light', 300],
    ['regular', 400], ['normal', 400], ['roman', 400], ['book', 400],
    ['medium', 500], ['semibold', 600], ['demibold', 600], ['bold', 700],
    ['extrabold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900],
  ]
  var WEIGHT_TO_STYLE = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }
  function normalizeFamily(name) { return String(name || '').normalize('NFKC').replace(/[\s_-]/g, '').toLowerCase() }
  function styleToWeight(style) {
    var key = normalizeFamily(style)
    if (/^\d{3}$/.test(key)) return Number(key)
    for (var i = 0; i < STYLE_TO_WEIGHT.length; i++) if (STYLE_TO_WEIGHT[i][0] === key) return STYLE_TO_WEIGHT[i][1]
    return 400
  }
  function weightToStyle(weight) {
    var keys = Object.keys(WEIGHT_TO_STYLE).map(Number).sort(function (a, b) { return a - b })
    var best = keys[0]
    for (var i = 0; i < keys.length; i++) if (Math.abs(keys[i] - weight) < Math.abs(best - weight)) best = keys[i]
    return WEIGHT_TO_STYLE[best]
  }
  /** FontName → {fontId, weight}。兼容性回退：未知族回退内置默认并告警。 */
  function resolveFont(fontName) {
    var family = fontName && typeof fontName.family === 'string' ? fontName.family : 'Inter'
    var weight = styleToWeight(fontName && fontName.style)
    var key = normalizeFamily(family)
    var exact = null
    for (var i = 0; i < state.fonts.length; i++) {
      if (normalizeFamily(state.fonts[i].family) === key) { exact = state.fonts[i]; break }
    }
    if (exact) {
      var weights = exact.weights && exact.weights.length ? exact.weights : [weight]
      var nearest = weights[0]
      for (var j = 0; j < weights.length; j++) if (Math.abs(weights[j] - weight) < Math.abs(nearest - weight)) nearest = weights[j]
      if (nearest !== weight) warnOnce('font-weight:' + exact.family + ':' + weight, '字体 ' + exact.family + ' 无 ' + weight + ' 字重，已用 ' + nearest + ' 近似')
      return { fontId: exact.id, weight: nearest }
    }
    if (key === 'inter' || key === 'default' || key === 'builtindefault') return { fontId: 'default', weight: weight }
    warnOnce('font-family:' + key, '字体族 ' + family + ' 在本地文档不可用，已回退内置默认字体')
    return { fontId: 'default', weight: weight }
  }
  function fontIdToName(fontId, weight) {
    for (var i = 0; i < state.fonts.length; i++) if (state.fonts[i].id === fontId)
      return { family: state.fonts[i].family, style: weightToStyle(weight || 400) }
    return { family: 'Inter', style: weightToStyle(weight || 400) }
  }

  // ---------- 节点代理 ----------

  function proxyFor(id) {
    var s = snapshot(id)
    if (!s) return null
    if (s.kind === 'page') return new PageNode(id)
    return new SceneNode(id)
  }
  function requireLive(id) {
    var s = snapshot(id)
    if (!s || s.removed) throw new Error('节点已删除：' + id)
    return s
  }
  function childIds(id) {
    var s = snapshot(id)
    return s ? s.children : []
  }
  function traverse(rootId, visit) {
    var stack = childIds(rootId).slice()
    var guard = 0
    while (stack.length && guard++ < 100000) {
      var id = stack.shift()
      var s = snapshot(id)
      if (!s) continue
      if (visit(proxyFor(id), s) === false) return
      stack = childIds(id).concat(stack)
    }
  }

  var BLEND_NATIVE_TO_FIGMA = {
    'normal': 'NORMAL', 'multiply': 'MULTIPLY', 'screen': 'SCREEN', 'overlay': 'OVERLAY',
    'darken': 'DARKEN', 'lighten': 'LIGHTEN', 'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN',
    'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT', 'difference': 'DIFFERENCE', 'exclusion': 'EXCLUSION',
    'hue': 'HUE', 'saturation': 'SATURATION', 'color': 'COLOR', 'luminosity': 'LUMINOSITY',
  }
  var BLEND_FIGMA_TO_NATIVE = {}
  Object.keys(BLEND_NATIVE_TO_FIGMA).forEach(function (k) { BLEND_FIGMA_TO_NATIVE[BLEND_NATIVE_TO_FIGMA[k]] = k })
  var ALIGN_FIGMA_TO_NATIVE = { LEFT: 'start', CENTER: 'center', RIGHT: 'end', JUSTIFIED: 'justify' }
  var ALIGN_NATIVE_TO_FIGMA = { start: 'LEFT', center: 'CENTER', end: 'RIGHT', justify: 'JUSTIFIED' }

  function transformOf(id) {
    var s = requireLive(id)
    return Array.isArray(s.transform) && s.transform.length === 6 ? s.transform.slice() : [1, 0, 0, 1, s.x || 0, s.y || 0]
  }
  function rotationOf(transform) { return Math.atan2(transform[1], transform[0]) * 180 / Math.PI }

  function SceneNode(id) { this.id = id }
  SceneNode.prototype = {
    constructor: SceneNode,
    get type() { return KIND_TO_TYPE[requireLive(this.id).kind] || 'FRAME' },
    get name() { return requireLive(this.id).name },
    set name(value) { genericPatch(this.id, { name: String(value) }) },
    get visible() { return requireLive(this.id).visible !== false },
    set visible(value) { genericPatch(this.id, { visible: !!value }) },
    get locked() { return !!requireLive(this.id).locked },
    set locked(value) { genericPatch(this.id, { locked: !!value }) },
    get removed() { var s = snapshot(this.id); return !s || !!s.removed },
    get width() { return requireLive(this.id).width },
    get height() { return requireLive(this.id).height },
    get x() { return transformOf(this.id)[4] },
    set x(value) { var t = transformOf(this.id); t[4] = Number(value); genericPatch(this.id, { transform: t }) },
    get y() { return transformOf(this.id)[5] },
    set y(value) { var t = transformOf(this.id); t[5] = Number(value); genericPatch(this.id, { transform: t }) },
    get rotation() { return rotationOf(transformOf(this.id)) },
    set rotation(degrees) {
      var t = transformOf(this.id)
      var scale = Math.hypot(t[0], t[1]) || 1
      var angle = Number(degrees) * Math.PI / 180
      t[0] = Math.cos(angle) * scale; t[1] = Math.sin(angle) * scale
      t[2] = -Math.sin(angle) * scale; t[3] = Math.cos(angle) * scale
      genericPatch(this.id, { transform: t })
    },
    get opacity() { var s = requireLive(this.id); return typeof s.opacity === 'number' ? s.opacity : 1 },
    set opacity(value) { genericPatch(this.id, { opacity: Math.max(0, Math.min(1, Number(value))) }) },
    get blendMode() { var s = requireLive(this.id); return BLEND_NATIVE_TO_FIGMA[s.blend] || 'NORMAL' },
    set blendMode(value) {
      var native = BLEND_FIGMA_TO_NATIVE[value]
      if (!native) { warnOnce('blend:' + value, '混合模式 ' + value + ' 暂不支持，已忽略'); return }
      genericPatch(this.id, { blend: native })
    },
    get parent() { return proxyFor(requireLive(this.id).parentId) },
    get children() { return childIds(this.id).map(proxyFor).filter(Boolean) },
    get fills() {
      var s = requireLive(this.id)
      if (s.kind === 'text') return [{ type: 'SOLID', color: textRunColor(s), opacity: 1, visible: true }]
      return (s.fills || []).map(nativeToFigmaPaint).filter(Boolean)
    },
    set fills(value) {
      var s = requireLive(this.id)
      var paints = Array.isArray(value) ? value : [value]
      if (s.kind === 'text') {
        var color = paints.length && paints[0] && paints[0].color ? rgbToHex(paints[0].color) : '#000000'
        var length = (s.text || '').length
        if (length > 0) textPatch(this.id, { textRuns: [{ start: 0, end: length, color: color }] })
        return
      }
      genericPatch(this.id, { fills: paints.map(function (p) { return figmaToNativePaint(p, uid) }).filter(Boolean) })
    },
    get strokes() {
      var s = requireLive(this.id)
      return (s.strokes || []).map(function (stroke) {
        var paint = nativeToFigmaPaint(stroke.paint)
        return paint ? Object.assign({ strokeWeight: stroke.width || 1, strokeAlign: (stroke.align || 'inside').toUpperCase() }, paint) : null
      }).filter(Boolean)
    },
    set strokes(value) {
      warnOnce('strokes-set', 'P0 容器的描边写入为近似转换')
      var strokes = (Array.isArray(value) ? value : [value]).map(function (item) {
        var paint = figmaToNativePaint(item, uid)
        return paint ? { paint: paint, width: item.strokeWeight || 1, align: (item.strokeAlign || 'INSIDE').toLowerCase(), cap: 'butt', join: 'miter', dash: '' } : null
      }).filter(Boolean)
      genericPatch(this.id, { strokes: strokes })
    },
    get effects() { return [] },
    set effects(value) { warnOnce('effects-set', 'P0 容器暂不支持 effects 写入') },
    get cornerRadius() { var r = requireLive(this.id).radii; return (r && r[0]) || 0 },
    set cornerRadius(value) { var v = Math.max(0, Number(value) || 0); genericPatch(this.id, { radii: [v, v, v, v] }) },
    get clipsContent() { return !!requireLive(this.id).clip },
    get characters() { return requireLive(this.id).text || '' },
    set characters(value) { textPatch(this.id, { text: String(value) }) },
    get fontSize() { var s = requireLive(this.id); return typeof s.fontSize === 'number' ? s.fontSize : 16 },
    set fontSize(value) { textPatch(this.id, { fontSize: Math.max(1, Math.min(4096, Number(value) || 16)) }) },
    get fontName() { var s = requireLive(this.id); var style = s.textStyle || {}; return fontIdToName(style.fontId || 'default', style.weight || 400) },
    set fontName(value) { var resolved = resolveFont(value); textPatch(this.id, { textStyle: { fontId: resolved.fontId, weight: resolved.weight } }) },
    get textAlignHorizontal() { var style = requireLive(this.id).textStyle || {}; return ALIGN_NATIVE_TO_FIGMA[style.align] || 'LEFT' },
    set textAlignHorizontal(value) { var native = ALIGN_FIGMA_TO_NATIVE[value]; if (native) textPatch(this.id, { textStyle: { align: native } }) },
    get lineHeight() { warnOnce('line-height', 'P0 容器 lineHeight 为近似值'); var style = requireLive(this.id).textStyle || {}; return { unit: 'AUTO', value: null } },
    get pointCount() { return requireLive(this.id).points || 0 },
    get innerRadius() { return requireLive(this.id).innerRadius || 0 },
    set innerRadius(value) { genericPatch(this.id, { innerRadius: Math.max(0, Math.min(1, Number(value) || 0)) }) },
    resize: function (width, height) {
      var w = Math.max(0.01, Number(width)), h = Math.max(0.01, Number(height))
      if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('resize 参数无效')
      genericPatch(this.id, { width: w, height: h })
    },
    resizeWithoutConstraints: function (width, height) { this.resize(width, height) },
    scale: function () { warnOnce('scale', 'P0 容器暂不支持 node.scale()') },
    appendChild: function (child) { insertChildInto(this.id, child, null) },
    insertChild: function (index, child) { insertChildInto(this.id, child, index) },
    remove: function () { removeNode(this.id) },
    findOne: function (criteria) { var found = null; traverse(this.id, function (node) { if (!found && criteria(node)) found = node; return found === null }); return found },
    findAll: function (criteria) { var found = []; traverse(this.id, function (node) { if (criteria(node)) found.push(node) }); return found },
    getPluginData: function () { warnOnce('plugin-data', 'P0 容器的 plugin data 为内存态，插件关闭后不保留'); return '' },
    setPluginData: function () { warnOnce('plugin-data', 'P0 容器的 plugin data 为内存态，插件关闭后不保留') },
    toString: function () { return '<SceneNode ' + this.type + ' ' + this.id + '>' },
  }

  function textRunColor(s) {
    var runs = s.textRuns || []
    if (runs.length && runs[0].color) return hexToRgb(runs[0].color)
    return { r: 0.145, g: 0.145, b: 0.145 }
  }

  function insertChildInto(parentId, child, index) {
    if (!child || !child.id) throw new Error('appendChild 需要节点参数')
    var childState = snapshot(child.id)
    if (!childState) throw new Error('子节点不存在')
    var parentState = snapshot(parentId)
    if (!parentState) throw new Error('父节点不存在')
    if (childState.kind === 'page') throw new Error('页面不能作为子节点')
    if (childState.detached) {
      if (parentState.detached) {
        // 父级尚未落地：只挂镜像；等父级创建时级联落地（保持 FIFO 顺序）。
        childState.parentId = parentId
        parentState.children.push(childState.id)
        return
      }
      createNodeNow(childState, parentState, index)
    } else if (childState.parentId !== parentId) {
      var moveParams = { ids: [childState.id], parentId: parentId }
      if (index !== null && index !== undefined) moveParams.index = index
      var previous = childState.parentId && snapshot(childState.parentId)
      if (previous) previous.children = previous.children.filter(function (id) { return id !== childState.id })
      childState.parentId = parentId
      parentState.children.push(childState.id)
      fireAndForget('node.move', moveParams)
    }
  }

  /** 把一个 detached 节点真正提交为 node.create，并级联落地其子树。 */
  function createNodeNow(childState, parentState, index) {
    var patch = Object.assign({}, childState.pendingPatch)
    delete patch.detached
    delete patch.pendingPatch
    childState.detached = false
    childState.parentId = parentState.id
    var params = {
      id: childState.id, kind: childState.kind,
      x: childState.x || 0, y: childState.y || 0,
      width: childState.width || 100, height: childState.height || 100,
      parentId: parentState.id,
    }
    if (Object.keys(patch).length) params.patch = patch
    if (index !== null && index !== undefined) params.index = index
    parentState.children.push(childState.id)
    fireAndForget('node.create', params)
    // 级联：先父后子，保证宿主按序看到 node.create。
    childState.children.slice().forEach(function (grandchildId) {
      var grandchild = snapshot(grandchildId)
      if (grandchild && grandchild.detached) createNodeNow(grandchild, childState, null)
    })
  }

  function removeNode(id) {
    var s = snapshot(id)
    if (!s || s.removed) return
    if (s.detached) { s.removed = true; delete state.nodes[id]; return }
    if (s.parentId) {
      var parent = snapshot(s.parentId)
      if (parent) parent.children = parent.children.filter(function (childId) { return childId !== id })
    }
    s.removed = true
    fireAndForget('node.delete', { ids: [id] })
  }

  function PageNode(id) { this.id = id }
  PageNode.prototype = {
    constructor: PageNode,
    get type() { return 'PAGE' },
    get name() { return requireLive(this.id).name },
    set name(value) {
      warnOnce('page-rename', 'P0 容器暂不支持插件重命名页面，已忽略')
    },
    get removed() { return !snapshot(this.id) },
    get children() { return childIds(this.id).map(proxyFor).filter(Boolean) },
    get parent() { return documentProxy },
    get selection() {
      return state.selection.map(proxyFor).filter(Boolean)
    },
    set selection(nodes) {
      var ids = (Array.isArray(nodes) ? nodes : [nodes]).map(function (node) {
        if (!node || typeof node.id !== 'string') throw new Error('selection 需要节点数组')
        return node.id
      })
      state.selection = ids
      fireAndForget('selection.set', { ids: ids, pageId: this.id })
    },
    appendChild: function (child) { insertChildInto(this.id, child, null) },
    insertChild: function (index, child) { insertChildInto(this.id, child, index) },
    findById: function (id) {
      // Figma 语义：页面内任意深度（含根）按 id 精确查找。
      var s = snapshot(String(id))
      if (!s || s.removed || s.kind === 'page') return null
      var parent = s.parentId
      var guard = 0
      while (parent && guard++ < 10000) {
        if (parent === this.id) return proxyFor(s.id)
        var ps = snapshot(parent)
        parent = ps && ps.parentId
      }
      return null
    },
    findOne: function (criteria) { var found = null; traverse(this.id, function (node) { if (!found && criteria(node)) found = node; return found === null }); return found },
    findAll: function (criteria) { var found = []; traverse(this.id, function (node) { if (criteria(node)) found.push(node) }); return found },
    toString: function () { return '<PageNode ' + this.id + '>' },
  }

  var documentProxy = {
    get type() { return 'DOCUMENT' },
    get name() { return state.documentName },
    get removed() { return false },
    get children() { return state.pages.map(function (page) { return proxyFor(page.id) }) },
    findOne: function (criteria) {
      for (var i = 0; i < state.pages.length; i++) {
        var found = proxyFor(state.pages[i].id).findOne(criteria)
        if (found) return found
      }
      return null
    },
    findAll: function (criteria) {
      var found = []
      for (var i = 0; i < state.pages.length; i++)
        found = found.concat(proxyFor(state.pages[i].id).findAll(criteria))
      return found
    },
  }

  // ---------- 事件 ----------

  function handlersOf(map, type) {
    if (!map[type]) map[type] = []
    return map[type]
  }
  function fireHandlers(map, type, payload) {
    var list = map[type] || []
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload) } catch (error) { log('error', '事件处理抛错：' + (error && error.message ? error.message : String(error))) }
    }
  }
  function fireDocumentChange(method, params, result) {
    var handlers = state.handlers.documentchange
    if (!handlers || !handlers.length) return
    var changes = []
    var touched = opTouchedIds(method, params, result)
    touched.forEach(function (id) {
      var node = proxyFor(id)
      if (!node) return
      if (method === 'node.create') changes.push({ type: 'CREATE', node: node, parent: node.parent })
      else if (method === 'node.delete') changes.push({ type: 'DELETE', node: node, parent: null })
      else changes.push({ type: 'PROPERTY_CHANGE', node: node, properties: [] })
    })
    fireHandlers(state.handlers, 'documentchange', { documentChanges: changes, origin: 'plugin' })
  }
  function opTouchedIds(method, params, result) {
    if (method === 'node.create') return params.id ? [params.id] : []
    if (params && Array.isArray(params.ids)) return params.ids.slice(0, 64)
    return []
  }

  // ---------- figma 全局 ----------

  var DEFAULT_SIZES = {
    frame: [100, 100], rectangle: [100, 100], ellipse: [100, 100], line: [100, 0.01],
    polygon: [100, 100], star: [100, 100], vector: [100, 100], text: [100, 20],
  }

  /** 内核 node.create 要求 UUID；沙箱内自行生成 v4（无 crypto 依赖，jsdom 可用）。 */
  function uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var random = Math.random() * 16 | 0
      var value = char === 'x' ? random : (random & 0x3) | 0x8
      return value.toString(16)
    })
  }

  /** 画笔/描边转换需要的本地 paint id（仅沙箱镜像内唯一）。 */
  var paintCounter = 0
  function uid() {
    return 'pp-' + (++paintCounter) + '-' + Math.random().toString(16).slice(2, 10)
  }

  /** 完整默认 textStyle（内核校验需要完整字段，分片补丁在本地合并）。 */
  function fullTextStyle(existing) {
    return Object.assign(
      { fontId: 'default', fallbacks: [], weight: 400, lineHeight: 1.35, letterSpacing: 0, wrap: false, align: 'start', direction: 'auto' },
      existing || {})
  }

  function createDetached(kind) {
    var id = uuid4()
    var entry = {
      id: id, kind: kind, name: defaultName(kind), x: 0, y: 0,
      width: DEFAULT_SIZES[kind][0], height: DEFAULT_SIZES[kind][1],
      transform: [1, 0, 0, 1, 0, 0], visible: true, locked: false, opacity: 1,
      blend: 'normal', children: [], parentId: null, fills: [], strokes: [], effects: [],
      radii: [0, 0, 0, 0], clip: false, detached: true, pendingPatch: {},
      points: kind === 'polygon' ? 5 : 0, innerRadius: kind === 'star' ? 0.5 : 0,
      text: '', fontSize: 16, textStyle: null,
    }
    if (kind === 'frame' || kind === 'section') entry.pendingPatch.fills = []
    state.nodes[id] = entry
    return new SceneNode(id)
  }
  function defaultName(kind) {
    var names = { frame: 'Frame', rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon', star: 'Star', vector: 'Vector', text: 'Text' }
    return names[kind] || 'Node'
  }

  var MIXED = Symbol('figma.mixed')

  var figma = {
    get root() { return documentProxy },
    get currentPage() { return proxyFor(state.pageId) },
    get command() { return undefined },
    mixed: MIXED,
    createFrame: function () { return createDetached('frame') },
    createRectangle: function () { return createDetached('rectangle') },
    createEllipse: function () { return createDetached('ellipse') },
    createLine: function () { return createDetached('line') },
    createPolygon: function () { return createDetached('polygon') },
    createStar: function () { return createDetached('star') },
    createVector: function () { return createDetached('vector') },
    createText: function () { return createDetached('text') },
    createNodeFromSvg: function () { warnOnce('svg', 'P0 容器暂不支持 createNodeFromSvg'); throw new Error('P0 容器暂不支持 createNodeFromSvg') },
    createImage: function () { warnOnce('image', 'P0 容器暂不支持 createImage'); throw new Error('P0 容器暂不支持 createImage') },
    loadFontAsync: function (fontName) {
      return new Promise(function (resolve) {
        // 字体表已在 init 下发；未知族按兼容性回退解析（见 resolveFont）。
        resolveFont(fontName)
        resolve()
      })
    },
    getNodeById: function (id) { return proxyFor(String(id)) },
    notify: function (message, options) {
      post({
        type: 'plugin-notify', message: String(message),
        error: !!(options && options.error),
        timeout: options && typeof options.timeout === 'number' ? Math.max(0, Math.min(10000, options.timeout)) : undefined,
      })
    },
    closePlugin: function (message) {
      if (state.closed) return
      state.closed = true
      post({ type: 'plugin-close', message: typeof message === 'string' ? message : undefined })
    },
    showUI: function (html, options) {
      if (typeof html !== 'string') throw new Error('showUI 需要 HTML 字符串')
      post({
        type: 'plugin-show-ui', html: html,
        width: options && typeof options.width === 'number' ? Math.max(100, Math.min(2000, options.width)) : undefined,
        height: options && typeof options.height === 'number' ? Math.max(50, Math.min(2000, options.height)) : undefined,
        visible: options ? options.visible !== false : true,
        themeColors: !!(options && options.themeColors),
      })
    },
    ui: {
      postMessage: function (message) {
        post({ type: 'plugin-ui-out', message: message === undefined ? null : message })
      },
      onmessage: null,
      on: function (type, handler) {
        if (type === 'message') { if (typeof handler === 'function') handlersOf(state.uiHandlers, 'message').push(handler) }
        else if (type === 'close') { /* 关闭通知在 P0 中随插件销毁隐式发生 */ }
      },
      hide: function () { post({ type: 'plugin-ui-control', action: 'hide' }) },
      show: function () { post({ type: 'plugin-ui-control', action: 'show' }) },
      resize: function (width, height) {
        post({ type: 'plugin-ui-control', action: 'resize', width: Math.max(100, Math.min(2000, Number(width) || 300)), height: Math.max(50, Math.min(2000, Number(height) || 200)) })
      },
    },
    on: function (type, handler) {
      if (typeof handler !== 'function') return
      if (type === 'documentchange') warnOnce('documentchange', 'documentchange 事件仅覆盖插件自身操作的近似变更')
      if (type === 'pagechange') warnOnce('pagechange', 'P0 容器暂不派发 pagechange')
      handlersOf(state.handlers, type).push(handler)
    },
    off: function (type, handler) {
      var list = state.handlers[type]
      if (!list) return
      var index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    viewport: {
      scrollAndZoomIntoView: function () { warnOnce('viewport', 'P0 容器暂未实现 viewport.scrollAndZoomIntoView') },
      get zoom() { return 1 },
      get scroll() { warnOnce('viewport', 'P0 容器暂不支持 viewport 读取'); return { x: 0, y: 0 } },
      set zoom(value) { warnOnce('viewport', 'P0 容器暂不支持 viewport 写入') },
      set scroll(value) { warnOnce('viewport', 'P0 容器暂不支持 viewport 写入') },
    },
    constants: {},
    allowCustomUI: false,
    getPluginData: function () { return '' },
    setPluginData: function () { warnOnce('plugin-data', 'P0 容器的 plugin data 为内存态') },
    getPluginDataByKeyAsync: function () { return Promise.resolve(null) },
    setPluginDataByKeyAsync: function () { warnOnce('plugin-data', 'P0 容器的 plugin data 为内存态'); return Promise.resolve() },
    clientStorage: {
      getAsync: function () { warnOnce('client-storage', 'P0 容器的 clientStorage 为内存态'); return Promise.resolve(null) },
      setAsync: function () { warnOnce('client-storage', 'P0 容器的 clientStorage 为内存态'); return Promise.resolve() },
      deleteAsync: function () { return Promise.resolve() },
      keysAsync: function () { return Promise.resolve([]) },
    },
  }

  // ui.onmessage 赋值时注册进 handlers。
  Object.defineProperty(figma.ui, 'onmessage', {
    get: function () { return state.uiHandlers.message && state.uiHandlers.message[0] },
    set: function (handler) {
      state.uiHandlers.message = []
      if (typeof handler === 'function') state.uiHandlers.message.push(handler)
    },
  })

  // ---------- 宿主消息处理 ----------

  function applySnapshot(id, snap) {
    if (!snap) { delete state.nodes[id]; return }
    var previous = state.nodes[id]
    state.nodes[id] = Object.assign({
      id: id, kind: snap.kind, name: snap.name, x: snap.x, y: snap.y,
      width: snap.width, height: snap.height, transform: snap.transform || [1, 0, 0, 1, snap.x, snap.y],
      visible: snap.visible !== false, locked: !!snap.locked, opacity: typeof snap.opacity === 'number' ? snap.opacity : 1,
      blend: snap.blend || 'normal', children: snap.children || [], parentId: snap.parentId,
      fills: snap.fills || [], strokes: snap.strokes || [], effects: snap.effects || [],
      radii: snap.radii || [0, 0, 0, 0], clip: !!snap.clip,
      text: snap.text, fontSize: snap.fontSize, textStyle: snap.textStyle,
      points: snap.points, innerRadius: snap.innerRadius,
      removed: false,
    }, previous && previous.detached ? { detached: false } : {})
  }

  function handleInit(message) {
    if (state.inited) {
      // 宿主 init 重发兜底：已初始化则忽略，避免插件代码二次执行。
      return
    }
    state.documentId = message.documentId
    state.documentName = message.documentName
    state.revision = message.revision
    state.pageId = message.pageId
    state.pages = message.pages || []
    state.selection = message.selection || []
    state.fonts = message.fonts || []
    state.nodes = {}
    var pageById = {}
    state.pages.forEach(function (page) {
      pageById[page.id] = page
      state.nodes[page.id] = {
        id: page.id, kind: 'page', name: page.name, children: page.children || [],
        parentId: null, removed: false,
      }
    })
    Object.keys(message.nodes || {}).forEach(function (id) { applySnapshot(id, message.nodes[id]) })
    state.inited = true
    if (message.uiHtml !== null && message.uiHtml !== undefined) window.__html__ = message.uiHtml
    // 注入插件 main 代码（动态 script 元素；CSP 仅 unsafe-inline，不用 eval）。
    // 注意：__PLUGIN_SOURCE__ 由随后的第二个 script 标签赋值，必须在 init
    // 时读取而非垫片启动时缓存（消息任务晚于全部同步脚本执行）。
    var pluginSource = typeof window.__PLUGIN_SOURCE__ === 'string' ? window.__PLUGIN_SOURCE__ : null
    if (pluginSource) {
      var script = document.createElement('script')
      script.textContent = pluginSource
      ;(document.body || document.documentElement).appendChild(script)
    }
    fireHandlers(state.handlers, 'run', { command: undefined })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'plugin-init') { handleInit(data); return }
    if (!state.inited) return
    if (data.type === 'plugin-op-result') {
      var waiter = state.opWaiters[data.opId]
      if (!waiter) return
      delete state.opWaiters[data.opId]
      if (data.ok) {
        if (typeof data.revision === 'number') state.revision = data.revision
        var refresh = data.refresh || {}
        Object.keys(refresh).forEach(function (id) { applySnapshot(id, refresh[id]) })
        ;(data.removed || []).forEach(function (id) { delete state.nodes[id] })
        if (data.pageId) state.pageId = data.pageId
        if (data.selection) state.selection = data.selection
        waiter.resolve(data.result)
      } else {
        var error = new Error(data.message || '操作失败')
        waiter.reject(error)
      }
      return
    }
    if (data.type === 'plugin-ui-message') {
      // 来自插件 UI iframe 的消息（宿主已按 Figma 协议解包 pluginMessage）。
      fireHandlers(state.uiHandlers, 'message', data.message)
      return
    }
    if (data.type === 'plugin-selection-changed') {
      if (data.pageId) state.pageId = data.pageId
      state.selection = data.selection || []
      fireHandlers(state.handlers, 'selectionchange', undefined)
      return
    }
    if (data.type === 'plugin-closed') {
      state.closed = true
      fireHandlers(state.handlers, 'close', undefined)
    }
  })

  window.figma = figma
})()
