import { defaultLayout, effect, node, paint, stroke, type DesignNode, type Kind, type Matrix, type Page } from '../model'
import { PluginApiError, PluginClosed } from './errors'
import type { PluginCommit, PluginSnapshot, PluginTurn, PluginUiState } from './protocol'

export type PluginHandle = {
  id: string
  type: string
  name: string
  x: number
  y: number
  width: number
  height: number
  resize(width: number, height: number): void
  rotation: number
  relativeTransform: number[][]
  cornerRadius: number | { readonly type: 'MIXED' }
  topLeftRadius: number
  topRightRadius: number
  bottomRightRadius: number
  bottomLeftRadius: number
  cornerSmoothing: number
  strokeWeight: number | { readonly type: 'MIXED' }
  characters: string
  parent: PluginHandle | null
  children: PluginHandle[]
  appendChild(child: PluginHandle): void
  insertChild(index: number, child: PluginHandle): void
  remove(): void
  clone(): PluginHandle
  findAll(callback?: (node: PluginHandle) => boolean): PluginHandle[]
  findOne(callback?: (node: PluginHandle) => boolean): PluginHandle | null
  getPluginData(key: string): string
  setPluginData(key: string, value: string): void
  selection?: PluginHandle[]
}

export type PluginFigma = {
  mixed: { readonly type: 'MIXED' }
  fileKey: null
  pluginId: string
  command: string
  editorType: 'figma'
  mode: 'default'
  root: PluginHandle
  currentPage: PluginHandle
  viewport: {
    center: { x: number; y: number }
    zoom: number
    scrollAndZoomIntoView(nodes: PluginHandle[]): void
  }
  util: { rgb(r: number, g: number, b: number): { r: number; g: number; b: number } }
  ui: {
    onmessage: ((message: unknown) => void) | null
    postMessage(message: unknown): void
    on(event: string, handler: (message: unknown) => void): void
    show(): void
    hide(): void
  }
  createRectangle(): PluginHandle
  createEllipse(): PluginHandle
  createFrame(): PluginHandle
  createText(): PluginHandle
  createLine(): PluginHandle
  createPolygon(): PluginHandle
  createStar(): PluginHandle
  createSection(): PluginHandle
  createPage(): PluginHandle
  group(nodes: PluginHandle[], parent: PluginHandle): PluginHandle
  getNodeById(id: string): PluginHandle | null
  notify(message: string): void
  closePlugin(message?: string): void
  showUI(html: string, options?: { width?: number; height?: number; title?: string; visible?: boolean }): void
  loadFontAsync(font: { family: string; style?: string }): Promise<void>
  on(event: string, handler: () => void): void
  off(event: string, handler: () => void): void
}

const typeNames: Record<Kind, string> = {
  rectangle: 'RECTANGLE', ellipse: 'ELLIPSE', frame: 'FRAME', section: 'SECTION', group: 'GROUP',
  polygon: 'POLYGON', star: 'STAR', line: 'LINE', vector: 'VECTOR', text: 'TEXT', slice: 'SLICE',
}
const containers = new Set<Kind>(['frame', 'section', 'group'])
export const pluginMixed = Object.freeze({ type: 'MIXED' as const })

function fail(api: string, code: 'unsupported' | 'invalid'): never {
  throw new PluginApiError(api, code)
}

function unsupportedNamespace(api: string): unknown {
  return new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'then') return undefined
      return unsupportedNamespace(`${api}.${String(key)}`)
    },
    apply() { fail(api, 'unsupported') },
    set() { fail(api, 'unsupported') },
  })
}

function guard<T extends object>(target: T, label: string, readOnly: ReadonlySet<string>): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === 'symbol') return Reflect.get(obj, key, receiver)
      if (key === 'then') return undefined
      if (Reflect.has(obj, key)) return Reflect.get(obj, key, receiver)
      return unsupportedNamespace(`${label}.${key}`)
    },
    set(obj, key, value, receiver) {
      if (typeof key !== 'string' || readOnly.has(key)) fail(`${label}.${String(key)}`, 'invalid')
      if (!Reflect.has(obj, key)) fail(`${label}.${key}`, 'unsupported')
      return Reflect.set(obj, key, value, receiver)
    },
  })
}

function finite(value: unknown, min: number, max: number, api: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(api, 'invalid')
  return value
}

function plainText(value: unknown, max: number, api: string, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max) fail(api, 'invalid')
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(api, 'invalid')
  if (!allowEmpty && !value.trim()) fail(api, 'invalid')
  return value
}

function documentText(value: unknown, max: number, api: string) {
  if (typeof value !== 'string' || value.length > max) fail(api, 'invalid')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(api, 'invalid')
  return value
}

function rgbToHex(color: { r?: number; g?: number; b?: number }, api: string) {
  const channel = (value: number | undefined) => Math.round(finite(value, 0, 1, api) * 255).toString(16).padStart(2, '0')
  return `#${channel(color?.r)}${channel(color?.g)}${channel(color?.b)}`
}

function hexToRgb(value: string, api: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) fail(api, 'unsupported')
  const parsed = Number.parseInt(value.slice(1), 16)
  return { r: ((parsed >> 16) & 255) / 255, g: ((parsed >> 8) & 255) / 255, b: (parsed & 255) / 255 }
}

export function createPluginSession(snapshot: PluginSnapshot, plugin: { id: string; name: string; command: string }) {
  const doc = { pages: structuredClone(snapshot.pages), nodes: structuredClone(snapshot.nodes) }
  const parents = new Map<string, string>()
  const reindex = () => {
    parents.clear()
    for (const page of doc.pages) for (const id of page.children) parents.set(id, page.id)
    for (const sceneNode of Object.values(doc.nodes)) for (const id of sceneNode.children) parents.set(id, sceneNode.id)
  }
  reindex()
  let currentPageId = snapshot.pageId
  if (!doc.pages.some(page => page.id === currentPageId)) fail('current page', 'invalid')
  let selection = snapshot.selection.filter(id => doc.nodes[id])
  const camera = { ...snapshot.viewport, zoom: snapshot.viewport.zoom > 0 ? snapshot.viewport.zoom : 1 }
  const loadedFonts = new Set<string>()
  const fontNames = new Map<string, { family: string; style: string }>()
  const nodeProxies = new Map<string, PluginHandle>()
  const pageProxies = new Map<string, PluginHandle>()
  const removed = new Set<string>()
  const dirty = new Set<string>()
  const pendingDeleted = new Set<string>()
  let pagesDirty = false
  let mutated = false
  let created = 0
  let reveal: string[] = []
  let notifications: string[] = []
  let outbound: unknown[] = []
  let uiState: PluginUiState | null = null
  let closed = false
  let closeMessage: string | undefined
  const events = new Map<string, Set<() => void>>()
  const ui = {
    onmessage: null as ((message: unknown) => void) | null,
    postMessage(pluginMessage: unknown) {
      let encoded: string
      try { encoded = JSON.stringify(pluginMessage) } catch { fail('figma.ui.postMessage', 'invalid') }
      if (typeof encoded !== 'string' || encoded.length > 65536) fail('figma.ui.postMessage', 'invalid')
      if (outbound.length >= 20) fail('figma.ui.postMessage', 'invalid')
      outbound.push(JSON.parse(encoded))
    },
    on(event: string, handler: (message: unknown) => void) {
      if (event !== 'message') fail(`figma.ui.on('${event}')`, 'unsupported')
      if (typeof handler !== 'function') fail('figma.ui.on', 'invalid')
      ui.onmessage = handler
    },
    show() { if (!uiState) fail('figma.ui.show', 'invalid'); uiState = { ...uiState, visible: true } },
    hide() { if (!uiState) fail('figma.ui.hide', 'invalid'); uiState = { ...uiState, visible: false } },
  }

  function touchNode(id: string) { dirty.add(id); mutated = true }
  function touchPages() { pagesDirty = true; mutated = true }
  function live(id: string) {
    const sceneNode = doc.nodes[id]
    if (!sceneNode || removed.has(id)) fail('removed node', 'invalid')
    return sceneNode
  }
  function inside(container: string, id: string) {
    let current: string | undefined = id
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      if (current === container) return true
      seen.add(current)
      current = parents.get(current)
    }
    return false
  }
  function onPage(id: string, pageId: string) {
    return inside(pageId, id)
  }
  function childList(parentId: string) {
    const page = doc.pages.find(item => item.id === parentId)
    if (page) return page.children
    const sceneNode = doc.nodes[parentId]
    if (!sceneNode || !containers.has(sceneNode.kind)) fail('parent', 'invalid')
    return sceneNode.children
  }
  function detach(id: string) {
    const parentId = parents.get(id)
    if (!parentId) return
    const list = childList(parentId)
    const index = list.indexOf(id)
    if (index >= 0) list.splice(index, 1)
    parents.delete(id)
    if (doc.nodes[parentId]) touchNode(parentId)
    else touchPages()
  }
  function attach(id: string, parentId: string, index: number) {
    const list = childList(parentId)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, id)
    parents.set(id, parentId)
    if (doc.nodes[parentId]) touchNode(parentId)
    else touchPages()
  }
  function reparent(childId: string, parentId: string, index?: number) {
    live(childId)
    if (childId === parentId || inside(childId, parentId)) fail('appendChild', 'invalid')
    childList(parentId)
    detach(childId)
    attach(childId, parentId, index === undefined ? childList(parentId).length : index)
  }
  function createRaw(kind: Kind, parentId: string, index?: number) {
    if (created >= 2000) fail('create', 'invalid')
    const createdNode = node(kind, 0, 0, 100, kind === 'line' ? 0.01 : 100)
    if (kind === 'text') { createdNode.text = ''; createdNode.fontSize = 12 }
    created += 1
    doc.nodes[createdNode.id] = createdNode
    touchNode(createdNode.id)
    attach(createdNode.id, parentId, index ?? childList(parentId).length)
    return createdNode.id
  }
  function storageKey(key: string) {
    if (typeof key !== 'string' || key.length < 1 || key.length > 100 || key.includes('\0')) fail('plugin data key', 'invalid')
    return `figmaPlugin:${encodeURIComponent(plugin.id)}:${encodeURIComponent(key)}`
  }
  function requireFont(id: string) {
    const name = fontNames.get(id) ?? { family: 'Inter', style: 'Regular' }
    if (!loadedFonts.has(`${name.family}\0${name.style}`)) fail('text write before figma.loadFontAsync', 'invalid')
  }
  function readSolids(paints: { kind: string; color: string; opacity: number; visible: boolean }[], api: string) {
    return paints.map(item => {
      if (item.kind !== 'solid') fail(`${api} non-solid paint`, 'unsupported')
      return { type: 'SOLID' as const, color: hexToRgb(item.color, api), opacity: item.opacity, visible: item.visible }
    })
  }
  function writeSolids(value: unknown, api: string) {
    if (!Array.isArray(value) || value.length > 16) fail(api, 'invalid')
    return value.map(entry => {
      if (!entry || typeof entry !== 'object' || (entry as { type?: string }).type !== 'SOLID') fail(`${api} only supports SOLID`, 'unsupported')
      const solid = entry as { color?: { r?: number; g?: number; b?: number }; opacity?: number; visible?: boolean }
      const color = rgbToHex(solid.color ?? {}, api)
      const createdPaint = paint(color)
      createdPaint.opacity = solid.opacity === undefined ? 1 : finite(solid.opacity, 0, 1, `${api}.opacity`)
      createdPaint.visible = solid.visible !== false
      createdPaint.stops = [{ offset: 0, color }, { offset: 1, color }]
      return createdPaint
    })
  }
  function ensureLayout(sceneNode: DesignNode, api: string) {
    if (!containers.has(sceneNode.kind) || !sceneNode.layout || sceneNode.layout.mode === 'none') fail(api, 'invalid')
    if (sceneNode.layout.mode === 'grid') fail(api, 'unsupported')
    return sceneNode.layout
  }

  function authoredCorners(id: string, api: string) {
    const sceneNode = live(id)
    if (!['rectangle', 'frame', 'section'].includes(sceneNode.kind) || sceneNode.network) fail(api, 'invalid')
    return sceneNode
  }
  function writeCorner(id: string, index: 0 | 1 | 2 | 3, api: string, value: number) {
    const sceneNode = authoredCorners(id, api)
    const radii: [number, number, number, number] = [sceneNode.radii[0], sceneNode.radii[1], sceneNode.radii[2], sceneNode.radii[3]]
    radii[index] = finite(value, 0, 1e7, api)
    sceneNode.radii = radii
    touchNode(id)
  }

  function nodeApi(id: string): PluginHandle {
    const cached = nodeProxies.get(id)
    if (cached) return cached
    const readOnly = new Set(['id', 'type', 'parent', 'children', 'removed', 'resize', 'remove', 'clone', 'appendChild', 'insertChild', 'findAll', 'findOne', 'getPluginData', 'setPluginData'])
    const target = {
      get id() { return id },
      get type() { return typeNames[live(id).kind] },
      get removed() { return removed.has(id) },
      get name() { return live(id).name },
      set name(value: string) { const sceneNode = live(id); sceneNode.name = plainText(value, 200, 'name', true); touchNode(id) },
      get x() { return live(id).transform[4] },
      set x(value: number) { const sceneNode = live(id); const next = sceneNode.transform.slice() as Matrix; next[4] = finite(value, -1e7, 1e7, 'x'); sceneNode.transform = next; touchNode(id) },
      get y() { return live(id).transform[5] },
      set y(value: number) { const sceneNode = live(id); const next = sceneNode.transform.slice() as Matrix; next[5] = finite(value, -1e7, 1e7, 'y'); sceneNode.transform = next; touchNode(id) },
      get width() { return live(id).width },
      set width(value: number) { live(id).width = finite(value, 0.01, 1e7, 'width'); touchNode(id) },
      get height() { return live(id).height },
      set height(value: number) { live(id).height = finite(value, 0.01, 1e7, 'height'); touchNode(id) },
      resize(width: number, height: number) { const sceneNode = live(id); sceneNode.width = finite(width, 0.01, 1e7, 'resize'); sceneNode.height = finite(height, 0.01, 1e7, 'resize'); touchNode(id) },
      get rotation() {
        const [a, b] = live(id).transform
        let degrees = Math.atan2(b, a) * 180 / Math.PI
        if (degrees > 180) degrees -= 360
        if (degrees <= -180) degrees += 360
        return Math.round(degrees * 1000) / 1000
      },
      set rotation(value: number) {
        const degrees = finite(value, -180, 180, 'rotation')
        const radians = degrees * Math.PI / 180
        const sceneNode = live(id)
        sceneNode.transform = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), sceneNode.transform[4], sceneNode.transform[5]]
        touchNode(id)
      },
      get relativeTransform() {
        const [a, b, c, d, tx, ty] = live(id).transform
        return [[a, c, tx], [b, d, ty]]
      },
      set relativeTransform(value: unknown) {
        if (!Array.isArray(value) || value.length !== 2 || !value.every(row => Array.isArray(row) && row.length === 3)) fail('relativeTransform', 'invalid')
        const rows = value as number[][]
        const [a, c, tx] = rows[0]
        const [b, d, ty] = rows[1]
        for (const part of [a, b, c, d, tx, ty]) finite(part, -1e7, 1e7, 'relativeTransform')
        if (Math.abs(a * d - b * c) < 1e-8) fail('relativeTransform', 'invalid')
        live(id).transform = [a, b, c, d, tx, ty]
        touchNode(id)
      },
      get opacity() { return live(id).opacity },
      set opacity(value: number) { live(id).opacity = finite(value, 0, 1, 'opacity'); touchNode(id) },
      get visible() { return live(id).visible },
      set visible(value: boolean) { if (typeof value !== 'boolean') fail('visible', 'invalid'); live(id).visible = value; touchNode(id) },
      get locked() { return live(id).locked },
      set locked(value: boolean) { if (typeof value !== 'boolean') fail('locked', 'invalid'); live(id).locked = value; touchNode(id) },
      get parent() {
        const parentId = parents.get(id)
        if (!parentId) return null
        return doc.nodes[parentId] ? nodeApi(parentId) : pageApi(parentId)
      },
      get children() { return live(id).children.filter(child => doc.nodes[child]).map(child => nodeApi(child)) },
      get fills() { const sceneNode = live(id); if (sceneNode.kind === 'slice') fail('slice fills', 'unsupported'); return readSolids(sceneNode.fills, 'fills') },
      set fills(value: unknown) { const sceneNode = live(id); if (sceneNode.kind === 'slice') fail('slice fills', 'unsupported'); sceneNode.fills = writeSolids(value, 'fills'); touchNode(id) },
      get strokes() { return live(id).strokes.map(item => ({ ...readSolids([item.paint], 'strokes')[0], strokeWeight: item.width })) },
      set strokes(value: unknown) {
        const sceneNode = live(id)
        sceneNode.strokes = writeSolids(value, 'strokes').map(item => { const created = stroke(item.color, 1); created.paint = item; return created })
        touchNode(id)
      },
      get strokeWeight(): number | typeof pluginMixed {
        const strokes = live(id).strokes
        if (!strokes.length) return 0
        return strokes.every(item => item.width === strokes[0].width) ? strokes[0].width : pluginMixed
      },
      set strokeWeight(value: number | typeof pluginMixed) {
        if (typeof value !== 'number') fail('strokeWeight', 'invalid')
        const width = finite(value, 0, 10000, 'strokeWeight')
        const sceneNode = live(id)
        if (!sceneNode.strokes.length) { if (width > 0) sceneNode.strokes = [stroke('#303344', width)] }
        else sceneNode.strokes = sceneNode.strokes.map(item => ({ ...item, paint: { ...item.paint }, width }))
        touchNode(id)
      },
      get cornerRadius(): number | typeof pluginMixed {
        const sceneNode = live(id)
        if (sceneNode.kind === 'polygon' || sceneNode.kind === 'star') return sceneNode.cornerRadius ?? 0
        const [a, b, c, d] = sceneNode.radii
        return a === b && b === c && c === d ? a : pluginMixed
      },
      set cornerRadius(value: number | typeof pluginMixed) {
        if (typeof value !== 'number') fail('cornerRadius', 'invalid')
        const radius = finite(value, 0, 1e7, 'cornerRadius')
        const sceneNode = live(id)
        if (sceneNode.kind === 'polygon' || sceneNode.kind === 'star') sceneNode.cornerRadius = radius
        else sceneNode.radii = [radius, radius, radius, radius]
        touchNode(id)
      },
      get topLeftRadius() { return authoredCorners(id, 'topLeftRadius').radii[0] },
      set topLeftRadius(value: number) { writeCorner(id, 0, 'topLeftRadius', value) },
      get topRightRadius() { return authoredCorners(id, 'topRightRadius').radii[1] },
      set topRightRadius(value: number) { writeCorner(id, 1, 'topRightRadius', value) },
      get bottomRightRadius() { return authoredCorners(id, 'bottomRightRadius').radii[2] },
      set bottomRightRadius(value: number) { writeCorner(id, 2, 'bottomRightRadius', value) },
      get bottomLeftRadius() { return authoredCorners(id, 'bottomLeftRadius').radii[3] },
      set bottomLeftRadius(value: number) { writeCorner(id, 3, 'bottomLeftRadius', value) },
      get cornerSmoothing() { return authoredCorners(id, 'cornerSmoothing').smoothing },
      set cornerSmoothing(value: number) { const sceneNode = authoredCorners(id, 'cornerSmoothing'); sceneNode.smoothing = finite(value, 0, 1, 'cornerSmoothing'); touchNode(id) },
      get characters() { const sceneNode = live(id); if (sceneNode.kind !== 'text') fail('characters', 'invalid'); return sceneNode.text },
      set characters(value: string) {
        const sceneNode = live(id)
        if (sceneNode.kind !== 'text') fail('characters', 'invalid')
        requireFont(id)
        const text = documentText(value, 100_000, 'characters')
        if (text !== sceneNode.text) sceneNode.textRuns = []
        sceneNode.text = text
        touchNode(id)
      },
      get fontSize() { const sceneNode = live(id); if (sceneNode.kind !== 'text') fail('fontSize', 'invalid'); return sceneNode.fontSize },
      set fontSize(value: number) {
        const sceneNode = live(id)
        if (sceneNode.kind !== 'text') fail('fontSize', 'invalid')
        requireFont(id)
        sceneNode.fontSize = finite(value, 1, 4096, 'fontSize')
        for (const run of sceneNode.textRuns ?? []) delete run.fontSize
        touchNode(id)
      },
      get fontName() { return fontNames.get(id) ?? { family: 'Inter', style: 'Regular' } },
      set fontName(value: { family?: string; style?: string }) {
        live(id)
        if (!value || typeof value.family !== 'string') fail('fontName', 'invalid')
        const style = value.style ?? 'Regular'
        if (!loadedFonts.has(`${value.family}\0${style}`)) fail('fontName before figma.loadFontAsync', 'invalid')
        fontNames.set(id, { family: plainText(value.family, 200, 'fontName'), style: plainText(style, 80, 'fontName') })
        touchNode(id)
      },
      get layoutMode() {
        const sceneNode = live(id)
        if (!sceneNode.layout || sceneNode.layout.mode === 'none') return 'NONE'
        if (sceneNode.layout.mode === 'horizontal') return 'HORIZONTAL'
        if (sceneNode.layout.mode === 'vertical') return 'VERTICAL'
        fail('layoutMode GRID', 'unsupported')
      },
      set layoutMode(value: string) {
        const sceneNode = live(id)
        if (value === 'NONE') { delete sceneNode.layout; touchNode(id); return }
        if (value !== 'HORIZONTAL' && value !== 'VERTICAL') fail(`layoutMode ${value}`, 'unsupported')
        if (!containers.has(sceneNode.kind)) fail('layoutMode', 'invalid')
        sceneNode.layout = { ...(sceneNode.layout ?? defaultLayout()), mode: value === 'HORIZONTAL' ? 'horizontal' : 'vertical' }
        touchNode(id)
      },
      get itemSpacing() { const layout = live(id).layout; if (layout?.mode === 'grid') fail('itemSpacing', 'unsupported'); return layout && layout.mode !== 'none' ? layout.gap : 0 },
      set itemSpacing(value: number) { ensureLayout(live(id), 'itemSpacing').gap = finite(value, 0, 1e5, 'itemSpacing'); touchNode(id) },
      get paddingTop() { return live(id).layout?.padding[0] ?? 0 },
      set paddingTop(value: number) { const layout = ensureLayout(live(id), 'paddingTop'); layout.padding = [finite(value, 0, 1e5, 'paddingTop'), layout.padding[1], layout.padding[2], layout.padding[3]]; touchNode(id) },
      get paddingRight() { return live(id).layout?.padding[1] ?? 0 },
      set paddingRight(value: number) { const layout = ensureLayout(live(id), 'paddingRight'); layout.padding = [layout.padding[0], finite(value, 0, 1e5, 'paddingRight'), layout.padding[2], layout.padding[3]]; touchNode(id) },
      get paddingBottom() { return live(id).layout?.padding[2] ?? 0 },
      set paddingBottom(value: number) { const layout = ensureLayout(live(id), 'paddingBottom'); layout.padding = [layout.padding[0], layout.padding[1], finite(value, 0, 1e5, 'paddingBottom'), layout.padding[3]]; touchNode(id) },
      get paddingLeft() { return live(id).layout?.padding[3] ?? 0 },
      set paddingLeft(value: number) { const layout = ensureLayout(live(id), 'paddingLeft'); layout.padding = [layout.padding[0], layout.padding[1], layout.padding[2], finite(value, 0, 1e5, 'paddingLeft')]; touchNode(id) },
      get effects() {
        return live(id).effects.map(item => {
          if (item.kind === 'shadow') return { type: 'DROP_SHADOW', color: { ...hexToRgb(item.color, 'effects'), a: item.opacity }, offset: { x: item.x, y: item.y }, radius: item.radius, spread: item.spread, visible: item.visible }
          if (item.kind === 'blur') return { type: 'LAYER_BLUR', radius: item.radius, visible: item.visible }
          fail(`effects ${item.kind}`, 'unsupported')
        })
      },
      set effects(value: unknown) {
        if (!Array.isArray(value) || value.length > 16) fail('effects', 'invalid')
        live(id).effects = value.map(entry => {
          if (!entry || typeof entry !== 'object') fail('effects', 'invalid')
          const record = entry as { type?: string; color?: { r?: number; g?: number; b?: number; a?: number }; offset?: { x?: number; y?: number }; radius?: number; spread?: number; visible?: boolean; opacity?: number }
          if (record.type === 'DROP_SHADOW') {
            const created = effect('shadow')
            created.x = finite(record.offset?.x ?? 0, -1e7, 1e7, 'effects.offset')
            created.y = finite(record.offset?.y ?? 0, -1e7, 1e7, 'effects.offset')
            created.radius = finite(record.radius ?? 0, 0, 1000, 'effects.radius')
            created.spread = finite(record.spread ?? 0, -1e7, 1e7, 'effects.spread')
            created.color = rgbToHex(record.color ?? {}, 'effects.color')
            created.opacity = record.color?.a === undefined ? finite(record.opacity ?? 1, 0, 1, 'effects.opacity') : finite(record.color.a, 0, 1, 'effects.color')
            created.visible = record.visible !== false
            return created
          }
          if (record.type === 'LAYER_BLUR' || record.type === 'FOREGROUND_BLUR') {
            const created = effect('blur')
            created.radius = finite(record.radius ?? 0, 0, 1000, 'effects.radius')
            created.visible = record.visible !== false
            return created
          }
          fail(`effects ${record.type ?? 'unknown'}`, 'unsupported')
        })
        touchNode(id)
      },
      get pointCount() { const sceneNode = live(id); if (sceneNode.kind !== 'polygon' && sceneNode.kind !== 'star') fail('pointCount', 'invalid'); return sceneNode.points },
      set pointCount(value: number) {
        const sceneNode = live(id)
        if (sceneNode.kind !== 'polygon' && sceneNode.kind !== 'star') fail('pointCount', 'invalid')
        const count = finite(value, 3, 128, 'pointCount')
        if (!Number.isInteger(count)) fail('pointCount', 'invalid')
        sceneNode.points = count
        touchNode(id)
      },
      get innerRadius() { const sceneNode = live(id); if (sceneNode.kind !== 'star') fail('innerRadius', 'invalid'); return sceneNode.innerRadius },
      set innerRadius(value: number) { const sceneNode = live(id); if (sceneNode.kind !== 'star') fail('innerRadius', 'invalid'); sceneNode.innerRadius = finite(value, 0.01, 1, 'innerRadius'); touchNode(id) },
      appendChild(child: PluginHandle) { reparent(child?.id, id) },
      insertChild(index: number, child: PluginHandle) { reparent(child?.id, id, finite(index, 0, 1e6, 'insertChild')) },
      findAll(callback?: (node: PluginHandle) => boolean) { return walk(live(id).children, callback) },
      findOne(callback?: (node: PluginHandle) => boolean) { return walk(live(id).children, callback)[0] ?? null },
      getPluginData(key: string) { return live(id).bindings?.[storageKey(key)] ?? '' },
      setPluginData(key: string, value: string) {
        const sceneNode = live(id)
        const stored = storageKey(key)
        if (typeof value !== 'string' || value.length > 10000) fail('setPluginData', 'invalid')
        const bindings = { ...(sceneNode.bindings ?? {}) }
        const prefix = `figmaPlugin:${encodeURIComponent(plugin.id)}:`
        if (!Object.hasOwn(bindings, stored) && Object.keys(bindings).filter(item => item.startsWith(prefix)).length >= 50) fail('setPluginData', 'invalid')
        bindings[stored] = value
        sceneNode.bindings = bindings
        touchNode(id)
      },
      remove() { removeNode(id) },
      clone() { return nodeApi(cloneNode(id, true)) },
    }
    const handle = guard(target, `node ${id}`, readOnly) as unknown as PluginHandle
    nodeProxies.set(id, handle)
    return handle
  }

  function walk(ids: string[], callback?: (node: PluginHandle) => boolean) {
    const matches: PluginHandle[] = []
    for (const child of ids) {
      if (!doc.nodes[child] || removed.has(child)) continue
      const handle = nodeApi(child)
      if (!callback || callback(handle)) matches.push(handle)
      matches.push(...walk(doc.nodes[child].children, callback))
    }
    return matches
  }

  function removeNode(id: string) {
    live(id)
    detach(id)
    const drop = (current: string) => {
      const sceneNode = doc.nodes[current]
      if (!sceneNode) return
      for (const child of [...sceneNode.children]) drop(child)
      delete doc.nodes[current]
      removed.add(current)
      pendingDeleted.add(current)
      dirty.delete(current)
      parents.delete(current)
    }
    drop(id)
    selection = selection.filter(item => item !== id && !removed.has(item))
    mutated = true
  }

  function cloneNode(id: string, insert: boolean): string {
    const source = live(id)
    if (source.component || source.instance || source.componentSet || source.booleanOperation) fail('clone of components or boolean nodes', 'unsupported')
    if (created >= 2000) fail('clone', 'invalid')
    const copy = structuredClone(source)
    copy.id = crypto.randomUUID()
    copy.children = source.children.map(child => cloneNode(child, false))
    doc.nodes[copy.id] = copy
    created += 1
    touchNode(copy.id)
    for (const child of copy.children) parents.set(child, copy.id)
    if (insert) {
      const parentId = parents.get(id)
      if (!parentId) fail('clone', 'invalid')
      attach(copy.id, parentId, childList(parentId).indexOf(id) + 1)
    }
    return copy.id
  }

  function pageApi(pageId: string): PluginHandle {
    const cached = pageProxies.get(pageId)
    if (cached) return cached
    const page = () => {
      const found = doc.pages.find(item => item.id === pageId)
      if (!found) fail('page', 'invalid')
      return found
    }
    const readOnly = new Set(['id', 'type', 'parent', 'children', 'appendChild', 'insertChild', 'findAll', 'findOne', 'remove', 'clone'])
    const target = {
      get id() { return pageId },
      get type() { return 'PAGE' },
      get name() { return page().name },
      set name(value: string) { page().name = plainText(value, 200, 'page.name'); touchPages() },
      get parent() { return root },
      get children() { return page().children.filter(id => doc.nodes[id]).map(id => nodeApi(id)) },
      get selection() { return pageId === currentPageId ? selection.filter(id => doc.nodes[id]).map(id => nodeApi(id)) : [] },
      set selection(value: PluginHandle[]) {
        if (pageId !== currentPageId) fail('page.selection', 'invalid')
        if (!Array.isArray(value) || value.length > 1000) fail('selection', 'invalid')
        const ids = value.map(item => {
          if (!item || typeof item.id !== 'string' || !onPage(item.id, pageId)) fail('selection', 'invalid')
          return item.id
        })
        selection = [...new Set(ids)]
      },
      appendChild(child: PluginHandle) { reparent(child?.id, pageId) },
      insertChild(index: number, child: PluginHandle) { reparent(child?.id, pageId, finite(index, 0, 1e6, 'insertChild')) },
      findAll(callback?: (node: PluginHandle) => boolean) { return walk(page().children, callback) },
      findOne(callback?: (node: PluginHandle) => boolean) { return walk(page().children, callback)[0] ?? null },
      remove() { fail('page.remove', 'unsupported') },
      clone() { fail('page.clone', 'unsupported') },
      resize() { fail('page.resize', 'unsupported') },
      getPluginData() { return '' },
      setPluginData() { fail('page.setPluginData', 'unsupported') },
      x: 0, y: 0, width: 0, height: 0,
    }
    const handle = guard(target, `page ${pageId}`, readOnly) as unknown as PluginHandle
    pageProxies.set(pageId, handle)
    return handle
  }

  const root = guard({
    get id() { return snapshot.documentId },
    get type() { return 'DOCUMENT' },
    get name() { return snapshot.documentName },
    get parent() { return null },
    get children() { return doc.pages.map(item => pageApi(item.id)) },
    appendChild() { fail('figma.root.appendChild', 'unsupported') },
    remove() { fail('figma.root.remove', 'unsupported') },
    clone() { fail('figma.root.clone', 'unsupported') },
    resize() { fail('figma.root.resize', 'unsupported') },
    findAll(callback?: (node: PluginHandle) => boolean) { return doc.pages.flatMap(item => walk(item.children, callback)) },
    findOne(callback?: (node: PluginHandle) => boolean) { return this.findAll(callback)[0] ?? null },
    getPluginData() { return '' },
    setPluginData() { fail('document.setPluginData', 'unsupported') },
    x: 0, y: 0, width: 0, height: 0,
  }, 'figma.root', new Set(['id', 'type', 'name', 'parent', 'children', 'appendChild', 'remove', 'clone', 'resize', 'findAll', 'findOne', 'getPluginData', 'setPluginData']))

  function create(kind: Kind) { return nodeApi(createRaw(kind, currentPageId)) }
  const figmaTarget = {
    mixed: pluginMixed,
    fileKey: null,
    pluginId: plugin.id,
    command: plugin.command,
    editorType: 'figma' as const,
    mode: 'default' as const,
    root,
    get currentPage() { return pageApi(currentPageId) },
    set currentPage(page: PluginHandle) {
      if (!page || page.type !== 'PAGE' || !doc.pages.some(item => item.id === page.id)) fail('figma.currentPage', 'invalid')
      currentPageId = page.id
      selection = []
    },
    viewport: guard({
      get center() { return { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom } },
      get zoom() { return camera.zoom },
      scrollAndZoomIntoView(nodes: PluginHandle[]) {
        if (!Array.isArray(nodes) || !nodes.length || nodes.length > 1000) fail('scrollAndZoomIntoView', 'invalid')
        reveal = nodes.map(item => { if (!item || !doc.nodes[item.id]) fail('scrollAndZoomIntoView', 'invalid'); return item.id })
      },
    }, 'figma.viewport', new Set(['center', 'zoom'])),
    util: guard({
      rgb(r: number, g: number, b: number) { return { r: finite(r, -1e7, 1e7, 'rgb'), g: finite(g, -1e7, 1e7, 'rgb'), b: finite(b, -1e7, 1e7, 'rgb') } },
    }, 'figma.util', new Set(['rgb'])),
    ui: guard(ui, 'figma.ui', new Set(['postMessage', 'on', 'show', 'hide'])),
    createRectangle: () => create('rectangle'),
    createEllipse: () => create('ellipse'),
    createFrame: () => create('frame'),
    createText: () => create('text'),
    createLine: () => create('line'),
    createPolygon: () => create('polygon'),
    createStar: () => create('star'),
    createSection: () => create('section'),
    createPage() {
      if (doc.pages.length >= 50) fail('figma.createPage', 'invalid')
      const createdPage: Page = { id: crypto.randomUUID(), name: `Page ${doc.pages.length + 1}`, children: [], background: '#f5f5f5' }
      doc.pages.push(createdPage)
      touchPages()
      return pageApi(createdPage.id)
    },
    group(nodes: PluginHandle[], parent: PluginHandle) {
      if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 1000 || !parent?.id) fail('figma.group', 'invalid')
      const parentId = parent.id
      for (const child of nodes) if (parents.get(child?.id) !== parentId) fail('figma.group', 'invalid')
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const child of nodes) {
        const sceneNode = live(child.id)
        minX = Math.min(minX, sceneNode.transform[4]); minY = Math.min(minY, sceneNode.transform[5])
        maxX = Math.max(maxX, sceneNode.transform[4] + sceneNode.width); maxY = Math.max(maxY, sceneNode.transform[5] + sceneNode.height)
      }
      const index = Math.min(...nodes.map(child => childList(parentId).indexOf(child.id)))
      for (const child of nodes) detach(child.id)
      const grouped = createRaw('group', parentId, index)
      const sceneGroup = live(grouped)
      sceneGroup.transform = [1, 0, 0, 1, minX, minY]
      sceneGroup.width = Math.max(0.01, maxX - minX)
      sceneGroup.height = Math.max(0.01, maxY - minY)
      for (const child of nodes) {
        const sceneNode = live(child.id)
        sceneNode.transform = [sceneNode.transform[0], sceneNode.transform[1], sceneNode.transform[2], sceneNode.transform[3], sceneNode.transform[4] - minX, sceneNode.transform[5] - minY]
        touchNode(child.id)
        reparent(child.id, grouped)
      }
      return nodeApi(grouped)
    },
    getNodeById(id: string) {
      if (typeof id !== 'string') fail('getNodeById', 'invalid')
      if (id === snapshot.documentId) return root
      if (doc.pages.some(item => item.id === id)) return pageApi(id)
      if (!doc.nodes[id] || removed.has(id)) return null
      return nodeApi(id)
    },
    notify(message: string) {
      const text = plainText(message, 200, 'figma.notify', true).trim().slice(0, 200)
      if (!text) return
      if (notifications.length >= 20) fail('figma.notify', 'invalid')
      notifications.push(text)
    },
    closePlugin(message?: string) {
      closed = true
      closeMessage = message === undefined ? undefined : plainText(message, 200, 'figma.closePlugin', true).trim().slice(0, 200)
      for (const handler of events.get('close') ?? []) { try { handler() } catch { /* a close listener cannot cancel closePlugin */ } }
      throw new PluginClosed(closeMessage)
    },
    showUI(html: string, options?: { width?: number; height?: number; title?: string; visible?: boolean }) {
      if (typeof html !== 'string' || html.length > 200_000) fail('figma.showUI', 'invalid')
      uiState = {
        html,
        width: Math.round(options?.width === undefined ? 300 : finite(options.width, 200, 800, 'showUI width')),
        height: Math.round(options?.height === undefined ? 240 : finite(options.height, 140, 800, 'showUI height')),
        title: options?.title === undefined ? plugin.name : plainText(options.title, 80, 'showUI title'),
        visible: options?.visible !== false,
      }
    },
    async loadFontAsync(font: { family?: string; style?: string }) {
      if (!font || typeof font.family !== 'string') fail('figma.loadFontAsync', 'invalid')
      const family = plainText(font.family, 200, 'loadFontAsync')
      const style = font.style === undefined ? 'Regular' : plainText(font.style, 80, 'loadFontAsync')
      loadedFonts.add(`${family}\0${style}`)
    },
    on(event: string, handler: () => void) {
      if (!['selectionchange', 'currentpagechange', 'close'].includes(event)) fail(`figma.on('${event}')`, 'unsupported')
      if (typeof handler !== 'function') fail('figma.on', 'invalid')
      const set = events.get(event) ?? new Set()
      set.add(handler)
      events.set(event, set)
    },
    off(event: string, handler: () => void) { events.get(event)?.delete(handler) },
  }
  const figma = guard(figmaTarget, 'figma', new Set(['mixed', 'fileKey', 'pluginId', 'command', 'editorType', 'mode', 'root', 'viewport', 'util', 'ui', 'createRectangle', 'createEllipse', 'createFrame', 'createText', 'createLine', 'createPolygon', 'createStar', 'createSection', 'createPage', 'group', 'getNodeById', 'notify', 'closePlugin', 'showUI', 'loadFontAsync', 'on', 'off'])) as unknown as PluginFigma

  function exportTurn(): PluginTurn {
    const upserts: Record<string, DesignNode> = {}
    for (const id of dirty) if (doc.nodes[id] && !removed.has(id)) upserts[id] = structuredClone(doc.nodes[id])
    const commit: PluginCommit = {
      mutated, pageId: currentPageId,
      selection: selection.filter(id => doc.nodes[id] && !removed.has(id) && onPage(id, currentPageId)),
      pages: pagesDirty ? structuredClone(doc.pages) : null,
      upserts, deleted: [...pendingDeleted],
      reveal: reveal.filter(id => doc.nodes[id] && !removed.has(id)),
    }
    const turn: PluginTurn = { commit, notifications: [...notifications], ui: uiState ? { ...uiState } : null, outbound: [...outbound], closed, closeMessage }
    dirty.clear(); pendingDeleted.clear(); pagesDirty = false; mutated = false; reveal = []; notifications = []; outbound = []
    return turn
  }

  async function deliver(message: unknown) {
    if (closed) fail('plugin message', 'invalid')
    const handler = ui.onmessage
    if (typeof handler !== 'function') return
    try {
      const result = handler(message) as unknown
      if (result && typeof (result as Promise<unknown>).then === 'function') await result
    } catch (error) {
      if (error instanceof PluginClosed) return
      throw error
    }
  }

  return { figma, exportTurn, deliver }
}

export type PluginSession = ReturnType<typeof createPluginSession>
