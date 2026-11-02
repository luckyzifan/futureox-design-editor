import { createEditorDesignAutomation } from '../../automation'
import { apply, bounds, worldMatrix } from '../../geometry'
import type { Editor } from '../../engine'
import {
  defaultLayout, defaultSizing, defaultTextStyle, effect, paint, stroke,
  type AutoLayout, type Constraints, type DesignNode, type Effect, type Kind, type Matrix, type Paint, type Sizing, type Stroke, type TextStyle,
} from '../../model'
import { clientStorageDelete, clientStorageGet, clientStorageKeys, clientStorageSet, defaultPluginStorage, type PluginStorage } from './client-storage'
import { bytesFromDataUrl, dataUrlForImage, imageContentId, imageMime, imageSize } from './images'
import { PLUGIN_FETCH_METHODS, matchNetworkAccess, pluginFetchHeaders, type PluginFetch } from './network'
import { figmaColorToHex, hexToFigmaColor } from './colors'
import { PluginApiError, PluginClosed } from './errors'
import { PLUGIN_LIMITS } from './limits'
import {
  pluginDataEmpty, pluginDataGet, pluginDataKeys, pluginDataSet, readPluginData, sharedPluginDataGet, sharedPluginDataKeys, sharedPluginDataSet,
  pluginDataExtension, type PluginDataScope, type PluginDataStore,
} from './plugin-data'

type Assignment = { key: string; value: unknown }
type Command =
  | { type: 'create'; id: string; kind: Kind; assignments: Assignment[] }
  | { type: 'update'; id: string; assignments: Assignment[] }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; parentId: string; index?: number }
  | { type: 'selection'; ids: string[] }
  | { type: 'setPage'; id: string }
  | { type: 'createPage'; id: string; name?: string; makeCurrent: boolean }
  | { type: 'renamePage'; id: string; name: string }
  | { type: 'styleCreate'; id: string; kind: 'paint' | 'text' | 'effect'; name: string; value: unknown }
  | { type: 'styleUpdate'; id: string; name?: string; value?: unknown }
  | { type: 'styleApply'; nodeId: string; field: 'fills' | 'textStyle' | 'effects'; styleId: string | null }
  | { type: 'styleDelete'; id: string }
  | { type: 'collectionCreate'; id: string; name: string; modes: string[] }
  | { type: 'variableCreate'; id: string; name: string; collectionId: string; kind: 'color' | 'number' | 'boolean' | 'string'; values: Record<string, unknown> }
  | { type: 'variableSet'; id: string; mode: string; value: unknown }
  | { type: 'variableBind'; nodeId: string; path: string; variableId: string | null }

type Working = {
  kind: Kind
  transform: Matrix
  width: number
  height: number
  radii: [number, number, number, number]
  strokes: Stroke[]
  layout: AutoLayout | null
  sizing: Sizing | null
  constraints: Constraints | null
  textStyle: TextStyle | null
  fontSize: number
  text: string
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
}

type AutomationOp = { method: string; params?: Record<string, unknown> }
type Hooks = {
  onNotify?: (message: string) => void
  onUi?: (ui: PluginUiState) => void
  onPostMessage?: (message: unknown) => void
}
export type PluginUiState = { html: string; width: number; height: number; title: string; visible: boolean }

export type PluginSessionOptions = {
  name: string
  pluginId: string
  command?: string
  uiHtml: string | null
  storage?: PluginStorage
  networkDomains?: readonly string[]
  fetch?: PluginFetch
  hooks?: Hooks
}

const KINDS = new Set<Kind>(['slice', 'frame', 'section', 'group', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector', 'text'])
const TRANSFORM_KEYS = new Set(['x', 'y', 'rotation'])
const CREATE_SIZE: Partial<Record<Kind, [number, number]>> = {
  text: [100, 40], line: [100, 0.01],
}
const BLEND_TO_FIGMA: Record<string, string> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
  'linear-burn': 'LINEAR_BURN', 'linear-dodge': 'LINEAR_DODGE', 'pass-through': 'PASS_THROUGH',
}
const FIGMA_TO_BLEND = Object.fromEntries(Object.entries(BLEND_TO_FIGMA).map(([key, value]) => [value, key]))
const ALIGN_TO_FIGMA: Record<string, string> = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH', scale: 'SCALE' }
const FIGMA_TO_ALIGN: Record<string, Constraints['horizontal']> = { MIN: 'start', CENTER: 'center', MAX: 'end', STRETCH: 'stretch', SCALE: 'scale' }
const WEIGHTS: Record<string, number> = {
  thin: 100, 'extra light': 200, extralight: 200, light: 300, regular: 400, normal: 400, medium: 500,
  'semi bold': 600, semibold: 600, bold: 700, 'extra bold': 800, extrabold: 800, black: 900,
}
const WEIGHT_NAMES: [number, string][] = [[100, 'Thin'], [200, 'Extra Light'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semi Bold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']]

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new PluginApiError('invalid_value', `${label} must be a finite number from ${min} to ${max}`)
  return value
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new PluginApiError('invalid_value', `${label} must be a boolean`)
  return value
}
function shortText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new PluginApiError('invalid_value', `${label} must be a string`)
  if (value.length > max) throw new PluginApiError('invalid_value', `${label} must be at most ${max} characters`)
  return value
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginApiError('invalid_value', `${label} must be an object`)
  return value as Record<string, unknown>
}
function clampSize(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
function withRotation(matrix: Matrix, width: number, height: number, degrees: number): Matrix {
  const [a, b, c, d, tx, ty] = matrix
  const cx = tx + (a * width + c * height) / 2
  const cy = ty + (b * width + d * height) / 2
  const sx = Math.hypot(a, b) || 1
  const sy = Math.hypot(c, d) || 1
  const sign = a * d - b * c < 0 ? -1 : 1
  const rad = degrees * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const na = sx * cos
  const nb = -sx * sin
  const nc = sy * sin * sign
  const nd = sy * cos * sign
  return [na, nb, nc, nd, cx - (na * width + nc * height) / 2, cy - (nb * width + nd * height) / 2]
}
function rotationOf(matrix: Matrix): number {
  const degrees = Math.atan2(-matrix[1], matrix[0]) * 180 / Math.PI
  if (!Number.isFinite(degrees)) return 0
  const rounded = Math.round(degrees * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}
function styleName(weight: number): string {
  let best = WEIGHT_NAMES[3]
  for (const entry of WEIGHT_NAMES) if (Math.abs(entry[0] - weight) < Math.abs(best[0] - weight)) best = entry
  return best[1]
}
type PluginImage = { mime: string; bytes: Uint8Array; base64: string }
function mapFill(value: unknown, images?: Map<string, PluginImage>): Paint {
  const fill = record(value, 'fill')
  const type = fill.type
  const visible = fill.visible === undefined ? true : boolean(fill.visible, 'fill.visible')
  const opacity = fill.opacity === undefined ? 1 : finite(fill.opacity, 'fill.opacity', 0, 1)
  if (type === 'SOLID') {
    const color = figmaColorToHex(fill.color)
    const made = paint(color.hex)
    made.opacity = Math.min(1, opacity * color.alpha)
    made.visible = visible
    made.stops = [{ offset: 0, color: color.hex }, { offset: 1, color: color.hex }]
    return made
  }
  const gradientKind = type === 'GRADIENT_LINEAR' ? 'linear'
    : type === 'GRADIENT_RADIAL' ? 'radial'
      : type === 'GRADIENT_ANGULAR' ? 'angular'
        : type === 'GRADIENT_DIAMOND' ? 'diamond'
          : null
  if (gradientKind) {
    const stops = fill.gradientStops
    if (!Array.isArray(stops) || stops.length < 2) throw new PluginApiError('invalid_value', `${String(type)} needs at least two gradientStops`)
    const mapped = stops.map(stop => {
      const item = record(stop, 'gradientStop')
      const color = figmaColorToHex(item.color)
      return { offset: finite(item.position, 'gradientStop.position', 0, 1), color: color.hex }
    })
    const made = paint(mapped[0].color, gradientKind)
    made.opacity = opacity
    made.visible = visible
    made.stops = mapped
    made.angle = Array.isArray(fill.gradientTransform) ? angleOf(fill.gradientTransform) : 180
    return made
  }
  if (type === 'IMAGE') {
    const hash = shortText(fill.imageHash, 'imageHash', 80)
    const stored = images?.get(hash)
    if (!stored) throw new PluginApiError('invalid_value', 'Unknown image hash. Create the image with figma.createImage first.')
    const made = paint('#ffffff', 'image')
    const scale = String(fill.scaleMode || 'FILL')
    made.fit = scale === 'FIT' ? 'contain' : scale === 'CROP' ? 'stretch' : 'cover'
    made.image = dataUrlForImage(stored.mime, stored.base64)
    made.opacity = opacity
    made.visible = visible
    return made
  }
  throw new PluginApiError('unsupported_api', `Fill ${String(type)} is not available. SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, GRADIENT_DIAMOND, and IMAGE are supported. The previous paints were left unchanged.`)
}
function angleOf(transform: unknown): number {
  if (!Array.isArray(transform) || !Array.isArray(transform[0]) || !Array.isArray(transform[1])) return 180
  const a = Number(transform[0][0])
  const b = Number(transform[1][0])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 180
  const degrees = Math.atan2(b, a) * 180 / Math.PI
  return Number.isFinite(degrees) ? degrees : 180
}
function mapFills(value: unknown, images?: Map<string, PluginImage>): Paint[] {
  if (!Array.isArray(value) || value.length > 16) throw new PluginApiError('invalid_value', 'fills must be an array of at most 16 paints')
  return value.map(item => mapFill(item, images))
}
function mapStrokePaint(value: unknown): Paint {
  const body = record(value, 'stroke')
  return mapFill({ ...body, type: body.type ?? 'SOLID' })
}
function blankStroke(width: number): Stroke {
  const made = stroke('#000000', width)
  made.align = 'center'
  made.cap = 'butt'
  return made
}
function mapEffects(value: unknown): Effect[] {
  if (!Array.isArray(value) || value.length > 16) throw new PluginApiError('invalid_value', 'effects must be an array of at most 16 effects')
  return value.map(item => {
    const effectValue = record(item, 'effect')
    const visible = effectValue.visible === undefined ? true : boolean(effectValue.visible, 'effect.visible')
    if (effectValue.type === 'DROP_SHADOW' || effectValue.type === 'INNER_SHADOW') {
      const made = effect(effectValue.type === 'DROP_SHADOW' ? 'shadow' : 'inner-shadow')
      const color = effectValue.color ? figmaColorToHex(effectValue.color) : { hex: '#000000', alpha: 1 }
      const offset = effectValue.offset ? record(effectValue.offset, 'effect.offset') : {}
      made.visible = visible
      made.color = color.hex
      made.opacity = color.alpha
      made.x = finite(offset.x ?? 0, 'effect.offset.x', -1e7, 1e7)
      made.y = finite(offset.y ?? 0, 'effect.offset.y', -1e7, 1e7)
      made.radius = finite(effectValue.radius ?? 0, 'effect.radius', 0, 1000)
      made.spread = finite(effectValue.spread ?? 0, 'effect.spread', -1e7, 1e7)
      return made
    }
    if (effectValue.type === 'LAYER_BLUR' || effectValue.type === 'BACKGROUND_BLUR') {
      const made = effect(effectValue.type === 'LAYER_BLUR' ? 'blur' : 'background-blur')
      made.visible = visible
      made.radius = finite(effectValue.radius ?? 0, 'effect.radius', 0, 1000)
      made.x = 0
      made.y = 0
      made.spread = 0
      made.opacity = 1
      return made
    }
    throw new PluginApiError('unsupported_api', `Effect ${String(effectValue.type)} is not available`)
  })
}
function figmaType(node: DesignNode): string {
  if (node.componentSet) return 'COMPONENT_SET'
  if (node.component) return 'COMPONENT'
  if (node.instance) return 'INSTANCE'
  if (node.booleanOperation) return 'BOOLEAN_OPERATION'
  const names: Record<Kind, string> = {
    rectangle: 'RECTANGLE', ellipse: 'ELLIPSE', frame: 'FRAME', section: 'SECTION', group: 'GROUP',
    polygon: 'POLYGON', star: 'STAR', line: 'LINE', vector: 'VECTOR', text: 'TEXT', slice: 'SLICE',
  }
  return names[node.kind]
}
function toFigmaFills(fills: Paint[], images?: Map<string, PluginImage>, urls?: Map<string, string>) {
  return fills.map(item => {
    if (item.kind === 'image' && item.image) {
      let hash = urls?.get(item.image) ?? null
      if (!hash) {
        const decoded = bytesFromDataUrl(item.image)
        if (decoded && images && urls) {
          hash = imageContentId(decoded.bytes)
          let binary = ''
          for (const byte of decoded.bytes) binary += String.fromCharCode(byte)
          images.set(hash, { mime: decoded.mime, bytes: decoded.bytes, base64: btoa(binary) })
          urls.set(item.image, hash)
        }
      }
      const scale = item.fit === 'contain' ? 'FIT' : item.fit === 'stretch' ? 'CROP' : 'FILL'
      return { type: 'IMAGE', imageHash: hash, scaleMode: scale, opacity: item.opacity, visible: item.visible }
    }
    if (item.kind === 'solid') return { type: 'SOLID', color: hexToFigmaColor(item.color), opacity: item.opacity, visible: item.visible }
    const gradient = item.kind === 'linear' ? 'GRADIENT_LINEAR'
      : item.kind === 'radial' ? 'GRADIENT_RADIAL'
        : item.kind === 'angular' ? 'GRADIENT_ANGULAR'
          : item.kind === 'diamond' ? 'GRADIENT_DIAMOND'
            : null
    if (gradient) return {
      type: gradient, opacity: item.opacity, visible: item.visible,
      gradientStops: item.stops.map(stop => ({ position: stop.offset, color: { ...hexToFigmaColor(stop.color), a: 1 } })),
    }
    return { type: 'UNSUPPORTED', kind: item.kind }
  })
}
function toFigmaEffects(effects: Effect[]) {
  return effects.map(item => {
    if (item.kind === 'shadow' || item.kind === 'inner-shadow') return {
      type: item.kind === 'shadow' ? 'DROP_SHADOW' : 'INNER_SHADOW', visible: item.visible,
      color: { ...hexToFigmaColor(item.color), a: item.opacity }, offset: { x: item.x, y: item.y }, radius: item.radius, spread: item.spread,
    }
    if (item.kind === 'blur' || item.kind === 'background-blur') return {
      type: item.kind === 'blur' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', visible: item.visible, radius: item.radius,
    }
    return { type: 'UNSUPPORTED', kind: item.kind }
  })
}

export type PluginSession = ReturnType<typeof createPluginSession>

export function createPluginSession(editor: Editor, options: PluginSessionOptions) {
  const api = createEditorDesignAutomation(editor, undefined, [pluginDataExtension])
  const pluginName = options.name
  const pluginId = options.pluginId
  const storage = options.storage ?? defaultPluginStorage()
  const networkDomains = options.networkDomains ?? []
  const images = new Map<string, PluginImage>()
  const imageUrls = new Map<string, string>()
  const networkJobs: { id: number; url: string; method: string; headers: Record<string, string>; body: string | null }[] = []
  const documentId = editor.state.doc.id
  const sessionId = editor.sessionGeneration
  const commands: Command[] = []
  const notifications: string[] = []
  const logs: string[] = []
  let ui: PluginUiState | null = null
  let uiShown = false
  let listening = false
  let closed = false
  let closeMessage = ''
  let flushing = false
  let flushes = 0
  let calls = 0
  let applying = 0
  let pluginStore: PluginDataStore = {}
  let pluginStoreDirty = false
  let fontFamilies: Record<string, { family: string }> | null = null

  function failIfReplaced() {
    if (editor.state.doc.id !== documentId || editor.sessionGeneration !== sessionId)
      throw new PluginApiError('document_changed', 'The open document changed while the plugin was running')
  }
  function execute(method: string, params: Record<string, unknown>, mutate: boolean) {
    failIfReplaced()
    if (mutate) applying += 1
    try {
      const response = api.execute({
        method, params,
        ...(mutate ? { documentId, session: sessionId, expectedRevision: editor.state.version } : {}),
      })
      if (!response.ok) throw new PluginApiError(response.error.code, response.error.message)
      const result = response.result as { completion?: { superseded?: boolean } } | null
      if (result && typeof result === 'object' && result.completion?.superseded)
        throw new PluginApiError('document_changed', 'The document changed while the plugin was running')
      return response.result
    } finally { if (mutate) applying -= 1 }
  }
  function batch(operations: AutomationOp[]) {
    if (!operations.length) return null
    const label = `Plugin: ${pluginName}`.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)
    const result = execute('batch.apply', { operations, label }, true)
    flushes += 1
    return result
  }
  function operationResult(result: unknown): Record<string, unknown> {
    const operations = (result as { operations?: { result?: Record<string, unknown> }[] } | null)?.operations
    return operations?.[0]?.result ?? (result && typeof result === 'object' ? result as Record<string, unknown> : {})
  }
  function resultId(result: unknown): string {
    const id = operationResult(result).id
    if (typeof id !== 'string' || !id) throw new PluginApiError('plugin_failed', 'The editor did not return a new node id')
    return id
  }
  function ensureRoom() {
    if (commands.length >= PLUGIN_LIMITS.batchOps) flush()
  }
  function hasMove(id: string) {
    return commands.some(command => command.type === 'move' && command.id === id)
  }
  function bucket(id: string): { assignments: Assignment[] } {
    for (let index = commands.length - 1; index >= 0; index--) {
      const command = commands[index]
      if (command.type === 'move' || command.type === 'remove' || command.type === 'setPage' || command.type === 'createPage' || command.type === 'renamePage' || command.type === 'selection' || command.type === 'styleCreate' || command.type === 'styleUpdate' || command.type === 'styleApply' || command.type === 'styleDelete' || command.type === 'collectionCreate' || command.type === 'variableCreate' || command.type === 'variableSet' || command.type === 'variableBind') break
      if ((command.type === 'create' || command.type === 'update') && command.id === id) return command
    }
    const update: Command = { type: 'update', id, assignments: [] }
    commands.push(update)
    return update
  }
  function write(id: string, key: string, value: unknown) {
    if (key === 'fills') mapFills(value, images)
    if (key === 'strokes') {
      if (!Array.isArray(value)) throw new PluginApiError('invalid_value', 'strokes must be an array of at most 16 strokes')
      for (const item of value) mapStrokePaint(item)
    }
    if (key === 'effects') mapEffects(value)
    if (TRANSFORM_KEYS.has(key) && hasMove(id)) flush()
    ensureRoom()
    bucket(id).assignments.push({ key, value })
  }
  function families() {
    if (!fontFamilies) {
      const doc = execute('document.get', {}, false) as { fonts?: Record<string, { family: string }> }
      fontFamilies = doc.fonts || {}
    }
    return fontFamilies
  }
  function resolveFamily(family: string): string | null {
    const wanted = family.trim()
    if (wanted.toLowerCase() === 'noto sans sc') return 'default'
    for (const [id, font] of Object.entries(families()))
      if (font.family === wanted || font.family.toLowerCase() === wanted.toLowerCase()) return id
    return null
  }
  function requireFont(family: string, style: string) {
    if (/italic/i.test(style)) throw new PluginApiError('unsupported_api', `Italic styles are not available (${style})`)
    const weight = WEIGHTS[style.trim().toLowerCase()]
    if (!weight) throw new PluginApiError('font_unavailable', `Font style ${style} is not available`)
    const fontId = resolveFamily(family)
    if (!fontId) throw new PluginApiError('font_unavailable', `Font ${family} is not loaded in this document`)
    return { fontId, weight }
  }
  function ensureText(working: Working) {
    if (working.kind !== 'text') throw new PluginApiError('invalid_kind', 'This property is only available on text')
    working.textStyle = { ...(working.textStyle ?? defaultTextStyle()) }
    return working.textStyle
  }
  function decorationRuns(working: Working) {
    if (working.textDecoration === 'NONE' || !working.text.length) return []
    return [{
      start: 0, end: working.text.length,
      underline: working.textDecoration === 'UNDERLINE',
      strikethrough: working.textDecoration === 'STRIKETHROUGH',
    }]
  }
  function applyTextAutoResize(working: Working, value: string) {
    const style = ensureText(working)
    working.sizing = { ...(working.sizing ?? defaultSizing()) }
    if (value === 'WIDTH_AND_HEIGHT') { style.wrap = false; working.sizing.width = 'hug'; working.sizing.height = 'hug' }
    else if (value === 'HEIGHT') { style.wrap = true; working.sizing.width = 'fixed'; working.sizing.height = 'hug' }
    else if (value === 'NONE') { style.wrap = true; working.sizing.width = 'fixed'; working.sizing.height = 'fixed' }
    else if (value === 'TRUNCATE') { style.wrap = false; working.sizing.width = 'fixed'; working.sizing.height = 'fixed' }
    else throw new PluginApiError('unsupported_api', `textAutoResize ${value} is not available`)
  }
  function textAutoResizeOf(style: TextStyle | null | undefined, sizing: Sizing | null | undefined) {
    const wrap = style?.wrap !== false
    const width = sizing?.width || 'fixed'
    const height = sizing?.height || 'fixed'
    if (width === 'hug' && height === 'hug') return 'WIDTH_AND_HEIGHT'
    if (height === 'hug') return 'HEIGHT'
    if (!wrap) return 'TRUNCATE'
    return 'NONE'
  }
  function axisSizing(layout: AutoLayout | null | undefined, sizing: Sizing | null | undefined, axis: 'primary' | 'counter') {
    if (!layout || layout.mode === 'none' || layout.mode === 'grid') return 'FIXED'
    const horizontal = layout.mode === 'horizontal'
    const key = axis === 'primary' ? (horizontal ? 'width' : 'height') : (horizontal ? 'height' : 'width')
    return (sizing?.[key] || 'fixed') === 'hug' ? 'AUTO' : 'FIXED'
  }
  function lineHeightOf(value: unknown, fontSize: number): number {
    const spec = record(value, 'lineHeight')
    const unit = String(spec.unit)
    if (unit === 'AUTO') return 1.35
    const amount = finite(spec.value, 'lineHeight.value', 0.1, 10000)
    const multiplier = unit === 'PERCENT' ? amount / 100 : unit === 'PIXELS' ? amount / Math.max(fontSize, 1) : NaN
    if (!Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 10)
      throw new PluginApiError('invalid_value', 'lineHeight must be PERCENT, PIXELS, or AUTO within the document range')
    return multiplier
  }
  function letterSpacingOf(value: unknown, fontSize: number): number {
    const spec = record(value, 'letterSpacing')
    const amount = finite(spec.value, 'letterSpacing.value', -10000, 10000)
    const unit = String(spec.unit)
    const pixels = unit === 'PIXELS' ? amount : unit === 'PERCENT' ? amount / 100 * fontSize : NaN
    return finite(pixels, 'letterSpacing', -1000, 1000)
  }
  function relativeMatrix(value: unknown): Matrix {
    if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[0]) || !Array.isArray(value[1]) || value[0].length < 3 || value[1].length < 3)
      throw new PluginApiError('invalid_value', 'relativeTransform must be a 2×3 matrix')
    const matrix = [value[0][0], value[1][0], value[0][1], value[1][1], value[0][2], value[1][2]]
    if (matrix.some(item => typeof item !== 'number' || !Number.isFinite(item)))
      throw new PluginApiError('invalid_value', 'relativeTransform must be finite')
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2]
    if (Math.abs(determinant) < 1e-8) throw new PluginApiError('invalid_value', 'relativeTransform is singular')
    return matrix as Matrix
  }
  function loadPluginStore() {
    if (!pluginStoreDirty) pluginStore = readPluginData(editor.authoredDocument)
  }
  function dataScope(value: unknown): PluginDataScope {
    if (value === 'node' || value === 'page' || value === 'root') return value
    throw new PluginApiError('invalid_value', 'Plugin data scope is invalid')
  }
  function assertDataTarget(scope: PluginDataScope, id: string) {
    if (commands.some(command => command.type === 'remove' && command.id === id))
      throw new PluginApiError('not_found', 'Node has been removed')
    if (scope === 'root') {
      if (id !== documentId && id !== editor.state.doc.id) throw new PluginApiError('not_found', 'Document does not exist')
      return
    }
    if (scope === 'page') {
      if (commands.some(command => command.type === 'createPage' && command.id === id) || editor.state.doc.pages.some(page => page.id === id)) return
      throw new PluginApiError('not_found', 'Page does not exist')
    }
    if (commands.some(command => command.type === 'create' && command.id === id) || editor.state.doc.nodes[id]) return
    throw new PluginApiError('not_found', 'Node does not exist')
  }
  function defaults(kind: Kind): Working {
    const [width, height] = CREATE_SIZE[kind] ?? [100, 100]
    return {
      kind, transform: [1, 0, 0, 1, 0, 0], width, height, radii: [0, 0, 0, 0], strokes: [],
      layout: null, sizing: null, constraints: null, textStyle: kind === 'text' ? defaultTextStyle() : null,
      fontSize: 28, text: '', textDecoration: 'NONE',
    }
  }
  function fromDocument(id: string): Working {
    const result = execute('node.get', { id }, false) as { node: DesignNode }
    const node = result.node
    return {
      kind: node.kind,
      transform: [...node.transform] as Matrix,
      width: node.width,
      height: node.height,
      radii: [...node.radii] as Working['radii'],
      strokes: structuredClone(node.strokes),
      layout: node.layout ? structuredClone(node.layout) : null,
      sizing: node.sizing ? structuredClone(node.sizing) : null,
      constraints: node.constraints ? structuredClone(node.constraints) : null,
      textStyle: node.textStyle ? structuredClone(node.textStyle) : null,
      fontSize: node.fontSize,
      text: node.text,
      textDecoration: node.textRuns?.some(run => run.strikethrough) ? 'STRIKETHROUGH' : node.textRuns?.some(run => run.underline) ? 'UNDERLINE' : 'NONE',
    }
  }
  function ensureStroke(working: Working) {
    if (!working.strokes.length) working.strokes.push(blankStroke(1))
  }
  function applyAssignment(working: Working, assignment: Assignment, patch: Record<string, unknown>) {
    const { key, value } = assignment
    if (key === 'name') patch.name = shortText(value, 'name', 200)
    else if (key === 'x') working.transform[4] = finite(value, 'x', -1e7, 1e7)
    else if (key === 'y') working.transform[5] = finite(value, 'y', -1e7, 1e7)
    else if (key === 'rotation') working.transform = withRotation(working.transform, working.width, working.height, finite(value, 'rotation', -1e6, 1e6))
    else if (key === 'width') working.width = finite(value, 'width', 0.01, 1e7)
    else if (key === 'height') working.height = finite(value, 'height', 0.01, 1e7)
    else if (key === 'visible') patch.visible = boolean(value, 'visible')
    else if (key === 'locked') patch.locked = boolean(value, 'locked')
    else if (key === 'opacity') patch.opacity = finite(value, 'opacity', 0, 1)
    else if (key === 'clipsContent') patch.clip = boolean(value, 'clipsContent')
    else if (key === 'blendMode') {
      const blend = FIGMA_TO_BLEND[String(value)]
      if (!blend) throw new PluginApiError('unsupported_api', `Blend mode ${String(value)} is not available`)
      patch.blend = blend
    } else if (key === 'fills') patch.fills = mapFills(value, images)
    else if (key === 'strokes') {
      if (!Array.isArray(value) || value.length > 16) throw new PluginApiError('invalid_value', 'strokes must be an array of at most 16 strokes')
      working.strokes = value.map(item => {
        const made = blankStroke(finite(record(item, 'stroke').strokeWeight ?? record(item, 'stroke').weight ?? 1, 'strokeWeight', 0, 10000))
        made.paint = mapStrokePaint(item)
        return made
      })
      patch.strokes = working.strokes
    } else if (key === 'strokeWeight' || key === 'strokeAlign' || key === 'strokeCap' || key === 'strokeJoin' || key === 'dashPattern') {
      ensureStroke(working)
      const first = working.strokes[0]
      if (key === 'strokeWeight') for (const item of working.strokes) item.width = finite(value, 'strokeWeight', 0, 10000)
      if (key === 'strokeAlign') {
        const align = String(value)
        if (!['CENTER', 'INSIDE', 'OUTSIDE'].includes(align)) throw new PluginApiError('invalid_value', 'strokeAlign must be CENTER, INSIDE, or OUTSIDE')
        for (const item of working.strokes) item.align = align.toLowerCase() as Stroke['align']
      }
      if (key === 'strokeCap') {
        const caps: Record<string, Stroke['cap']> = { NONE: 'butt', BUTT: 'butt', ROUND: 'round', SQUARE: 'square' }
        const cap = caps[String(value)]
        if (!cap) throw new PluginApiError('unsupported_api', `Stroke cap ${String(value)} is not available`)
        first.cap = cap
      }
      if (key === 'strokeJoin') {
        const joins: Record<string, Stroke['join']> = { MITER: 'miter', BEVEL: 'bevel', ROUND: 'round' }
        const join = joins[String(value)]
        if (!join) throw new PluginApiError('unsupported_api', `Stroke join ${String(value)} is not available`)
        first.join = join
      }
      if (key === 'dashPattern') {
        if (!Array.isArray(value) || value.length > 32) throw new PluginApiError('invalid_value', 'dashPattern must be an array of lengths')
        first.dash = value.map(item => finite(item, 'dashPattern', 0, 1e7)).join(',')
      }
      patch.strokes = working.strokes
    } else if (key === 'cornerRadius') {
      const radius = finite(value, 'cornerRadius', 0, 1e7)
      working.radii = [radius, radius, radius, radius]
      patch.radii = [...working.radii]
    } else if (key === 'topLeftRadius' || key === 'topRightRadius' || key === 'bottomRightRadius' || key === 'bottomLeftRadius') {
      const index = { topLeftRadius: 0, topRightRadius: 1, bottomRightRadius: 2, bottomLeftRadius: 3 }[key]
      working.radii[index] = finite(value, key, 0, 1e7)
      patch.radii = [...working.radii]
    } else if (key === 'effects') patch.effects = mapEffects(value)
    else if (key === 'characters') {
      if (working.kind !== 'text') throw new PluginApiError('invalid_kind', 'characters is only available on text')
      working.text = shortText(value, 'characters', 100_000)
      patch.text = working.text
      patch.textRuns = decorationRuns(working)
    } else if (key === 'textCase' || key === 'textDecoration' || key === 'paragraphSpacing' || key === 'paragraphIndent' || key === 'textAutoResize') {
      const style = ensureText(working)
      if (key === 'textCase') {
        if (value !== 'ORIGINAL' && value !== 'UPPER' && value !== 'LOWER')
          throw new PluginApiError('unsupported_api', `textCase ${String(value)} is not available`)
        style.textCase = value === 'UPPER' ? 'upper' : value === 'LOWER' ? 'lower' : 'original'
      } else if (key === 'textDecoration') {
        if (value !== 'NONE' && value !== 'UNDERLINE' && value !== 'STRIKETHROUGH')
          throw new PluginApiError('unsupported_api', `textDecoration ${String(value)} is not available`)
        working.textDecoration = value as Working['textDecoration']
        patch.textRuns = decorationRuns(working)
      } else if (key === 'paragraphSpacing') style.paragraphSpacing = finite(value, 'paragraphSpacing', 0, 10000)
      else if (key === 'paragraphIndent') style.paragraphIndent = finite(value, 'paragraphIndent', -10000, 10000)
      else applyTextAutoResize(working, String(value))
      patch.textStyle = style
      if (working.sizing) patch.sizing = { ...working.sizing }
    } else if (key === 'fontSize') {
      if (working.kind !== 'text') throw new PluginApiError('invalid_kind', 'fontSize is only available on text')
      working.fontSize = finite(value, 'fontSize', 1, 4096)
      patch.fontSize = working.fontSize
    } else if (key === 'textAlignHorizontal' || key === 'textAlignVertical' || key === 'lineHeight' || key === 'letterSpacing') {
      const style = ensureText(working)
      if (key === 'textAlignHorizontal') {
        const modes: Record<string, TextStyle['align']> = { LEFT: 'start', CENTER: 'center', RIGHT: 'end', JUSTIFIED: 'justify' }
        const align = modes[String(value)]
        if (!align) throw new PluginApiError('unsupported_api', `textAlignHorizontal ${String(value)} is not available`)
        style.align = align
      } else if (key === 'textAlignVertical') {
        const modes: Record<string, NonNullable<TextStyle['verticalAlign']>> = { TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' }
        const align = modes[String(value)]
        if (!align) throw new PluginApiError('unsupported_api', `textAlignVertical ${String(value)} is not available`)
        style.verticalAlign = align
      } else if (key === 'lineHeight') style.lineHeight = lineHeightOf(value, working.fontSize || 28)
      else style.letterSpacing = letterSpacingOf(value, working.fontSize || 28)
      patch.textStyle = style
    } else if (key === 'fontName') {
      if (working.kind !== 'text') throw new PluginApiError('invalid_kind', 'fontName is only available on text')
      const font = record(value, 'fontName')
      const resolved = requireFont(shortText(font.family, 'fontName.family', 200), shortText(font.style ?? 'Regular', 'fontName.style', 80))
      working.textStyle = { ...(working.textStyle ?? defaultTextStyle()), fontId: resolved.fontId, weight: resolved.weight }
      patch.textStyle = working.textStyle
    } else if (key === 'pointCount') patch.points = finite(value, 'pointCount', 3, 128)
    else if (key === 'innerRadius') patch.innerRadius = finite(value, 'innerRadius', 0.01, 1)
    else if (key === 'layoutMode' || key === 'itemSpacing' || key === 'paddingTop' || key === 'paddingRight' || key === 'paddingBottom' || key === 'paddingLeft' || key === 'primaryAxisAlignItems' || key === 'counterAxisAlignItems') {
      if (!working.layout) {
        if (key !== 'layoutMode') throw new PluginApiError('invalid_value', 'Set layoutMode before other auto-layout properties')
        working.layout = defaultLayout()
      }
      if (key === 'layoutMode') {
        const modes: Record<string, AutoLayout['mode']> = { NONE: 'none', HORIZONTAL: 'horizontal', VERTICAL: 'vertical' }
        const mode = modes[String(value)]
        if (!mode) throw new PluginApiError('unsupported_api', `layoutMode ${String(value)} is not available`)
        working.layout.mode = mode
      } else if (key === 'itemSpacing') working.layout.gap = finite(value, 'itemSpacing', 0, 1e5)
      else if (key === 'paddingTop') working.layout.padding[0] = finite(value, key, 0, 1e5)
      else if (key === 'paddingRight') working.layout.padding[1] = finite(value, key, 0, 1e5)
      else if (key === 'paddingBottom') working.layout.padding[2] = finite(value, key, 0, 1e5)
      else if (key === 'paddingLeft') working.layout.padding[3] = finite(value, key, 0, 1e5)
      else if (key === 'primaryAxisAlignItems') {
        const modes: Record<string, AutoLayout['justify']> = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space-between' }
        const mode = modes[String(value)]
        if (!mode) throw new PluginApiError('unsupported_api', `primaryAxisAlignItems ${String(value)} is not available`)
        working.layout.justify = mode
      } else {
        const modes: Record<string, AutoLayout['align']> = { MIN: 'start', CENTER: 'center', MAX: 'end' }
        const mode = modes[String(value)]
        if (!mode) throw new PluginApiError('unsupported_api', `counterAxisAlignItems ${String(value)} is not available`)
        working.layout.align = mode
      }
      patch.layout = { ...working.layout, padding: [...working.layout.padding] as AutoLayout['padding'] }
    } else if (key === 'relativeTransform') working.transform = relativeMatrix(value)
    else if (key === 'primaryAxisSizingMode' || key === 'counterAxisSizingMode') {
      if (!working.layout || working.layout.mode === 'none') throw new PluginApiError('invalid_value', 'Set layoutMode before axis sizing')
      const mode = String(value) === 'AUTO' ? 'hug' : String(value) === 'FIXED' ? 'fixed' : ''
      if (!mode) throw new PluginApiError('unsupported_api', `${key} ${String(value)} is not available`)
      const horizontal = working.layout.mode === 'horizontal'
      const widthAxis = key === 'primaryAxisSizingMode' ? horizontal : !horizontal
      working.sizing = { ...(working.sizing ?? defaultSizing()) }
      if (widthAxis) working.sizing.width = mode
      else working.sizing.height = mode
      patch.sizing = { ...working.sizing }
    } else if (key === 'layoutWrap' || key === 'counterAxisSpacing') {
      if (!working.layout || working.layout.mode === 'none') throw new PluginApiError('invalid_value', 'Set layoutMode before wrap or counter-axis spacing')
      if (key === 'layoutWrap') {
        if (value !== 'NONE' && value !== 'WRAP') throw new PluginApiError('unsupported_api', `layoutWrap ${String(value)} is not available`)
        working.layout.wrap = value === 'WRAP'
      } else working.layout.lineGap = finite(value, 'counterAxisSpacing', 0, 1e5)
      patch.layout = { ...working.layout, padding: [...working.layout.padding] as AutoLayout['padding'] }
    } else if (key === 'layoutPositioning') {
      if (value !== 'AUTO' && value !== 'ABSOLUTE') throw new PluginApiError('unsupported_api', `layoutPositioning ${String(value)} is not available`)
      working.sizing = { ...(working.sizing ?? defaultSizing()), absolute: value === 'ABSOLUTE' }
      patch.sizing = { ...working.sizing }
    } else if (key === 'minWidth' || key === 'maxWidth' || key === 'minHeight' || key === 'maxHeight') {
      working.sizing = { ...(working.sizing ?? defaultSizing()) }
      const limit = value === null ? (key.startsWith('min') ? 0.01 : 1e7) : finite(value, key, key.startsWith('min') ? 0.01 : 0.01, 1e7)
      working.sizing[key] = limit
      patch.sizing = { ...working.sizing }
    } else if (key === 'strokeStyleId') throw new PluginApiError('unsupported_api', 'strokeStyleId is not available on this plugin host')
    else if (key === 'layoutAlign' || key === 'layoutGrow') {
      working.sizing = { ...(working.sizing ?? defaultSizing()) }
      if (key === 'layoutGrow') {
        const grow = finite(value, 'layoutGrow', 0, 1)
        working.sizing.width = grow > 0 ? 'fill' : 'fixed'
      } else {
        const modes: Record<string, Sizing['alignSelf']> = { MIN: 'start', CENTER: 'center', MAX: 'end', STRETCH: 'stretch', INHERIT: null }
        if (!Object.prototype.hasOwnProperty.call(modes, String(value)))
          throw new PluginApiError('unsupported_api', `layoutAlign ${String(value)} is not available`)
        working.sizing.alignSelf = modes[String(value)]
      }
      patch.sizing = { ...working.sizing }
    } else if (key === 'layoutSizingHorizontal' || key === 'layoutSizingVertical') {
      working.sizing = { ...(working.sizing ?? defaultSizing()) }
      const modes: Record<string, Sizing['width']> = { FIXED: 'fixed', HUG: 'hug', FILL: 'fill' }
      const mode = modes[String(value)]
      if (!mode) throw new PluginApiError('unsupported_api', `${key} ${String(value)} is not available`)
      if (key === 'layoutSizingHorizontal') working.sizing.width = mode
      else working.sizing.height = mode
      patch.sizing = { ...working.sizing }
    } else if (key === 'constraints') {
      const spec = record(value, 'constraints')
      const horizontal = FIGMA_TO_ALIGN[String(spec.horizontal)]
      const vertical = FIGMA_TO_ALIGN[String(spec.vertical)]
      if (!horizontal || !vertical) throw new PluginApiError('unsupported_api', 'constraints must use MIN, CENTER, MAX, STRETCH, or SCALE')
      working.constraints = { horizontal, vertical, referenceWidth: null, referenceHeight: null }
      patch.constraints = working.constraints
    } else throw new PluginApiError('unsupported_api', `${key} is not available on this plugin host`)
    if (key === 'x' || key === 'y' || key === 'rotation' || key === 'relativeTransform') patch.transform = [...working.transform]
    if (key === 'width') patch.width = working.width
    if (key === 'height') patch.height = working.height
  }
  function compileAssignments(working: Working, assignments: Assignment[]) {
    const patch: Record<string, unknown> = {}
    for (const assignment of assignments) applyAssignment(working, assignment, patch)
    return patch
  }
  function compile(list: Command[], pageId: string): AutomationOp[] {
    const ops: AutomationOp[] = []
    const synthetic = new Map<string, Working>()
    let page = pageId
    for (const command of list) {
      if (command.type === 'create') {
        const working = defaults(command.kind)
        if (command.kind === 'text') command.assignments.unshift({ key: 'characters', value: '' })
        const patch = compileAssignments(working, command.assignments)
        synthetic.set(command.id, working)
        ops.push({
          method: 'node.create',
          params: { id: command.id, kind: command.kind, parentId: page, x: working.transform[4], y: working.transform[5], width: working.width, height: working.height, ...(Object.keys(patch).length ? { patch } : {}) },
        })
      } else if (command.type === 'update') {
        const working = synthetic.get(command.id) ?? fromDocument(command.id)
        const patch = compileAssignments(working, command.assignments)
        synthetic.set(command.id, working)
        if (Object.keys(patch).length) ops.push({ method: 'node.update', params: { ids: [command.id], patch } })
      } else if (command.type === 'remove') ops.push({ method: 'node.delete', params: { ids: [command.id] } })
      else if (command.type === 'move') ops.push({ method: 'node.move', params: { ids: [command.id], parentId: command.parentId, ...(command.index === undefined ? {} : { index: command.index }), preserveWorld: true } })
      else if (command.type === 'selection') ops.push({ method: 'selection.set', params: { ids: command.ids } })
      else if (command.type === 'setPage') { ops.push({ method: 'page.setCurrent', params: { id: command.id } }); page = command.id }
      else if (command.type === 'createPage') {
        ops.push({ method: 'page.create', params: { id: command.id, ...(command.name ? { name: command.name } : {}), makeCurrent: command.makeCurrent } })
        if (command.makeCurrent) page = command.id
      }       else if (command.type === 'renamePage') ops.push({ method: 'page.update', params: { id: command.id, patch: { name: command.name } } })
      else if (command.type === 'styleCreate') ops.push({ method: 'style.create', params: { id: command.id, name: command.name, kind: command.kind, value: command.value } })
      else if (command.type === 'styleUpdate') {
        const params: Record<string, unknown> = { styleId: command.id }
        if (command.name !== undefined) params.name = command.name
        if (command.value !== undefined) params.value = command.value
        ops.push({ method: 'style.update', params })
      } else if (command.type === 'styleApply') {
        ops.push(command.styleId
          ? { method: 'style.apply', params: { nodeId: command.nodeId, field: command.field, styleId: command.styleId } }
          : { method: 'style.unapply', params: { nodeId: command.nodeId, field: command.field } })
      } else if (command.type === 'styleDelete') ops.push({ method: 'style.delete', params: { styleId: command.id } })
      else if (command.type === 'collectionCreate') ops.push({ method: 'collection.create', params: { id: command.id, name: command.name, modes: command.modes, defaultMode: command.modes[0] } })
      else if (command.type === 'variableCreate') ops.push({ method: 'variable.create', params: { id: command.id, name: command.name, collectionId: command.collectionId, kind: command.kind, values: command.values } })
      else if (command.type === 'variableSet') ops.push({ method: 'variable.setValue', params: { variableId: command.id, mode: command.mode, value: command.value } })
      else if (command.type === 'variableBind') ops.push(command.variableId
        ? { method: 'variable.bind', params: { nodeId: command.nodeId, path: command.path, variableId: command.variableId } }
        : { method: 'variable.unbind', params: { nodeId: command.nodeId, path: command.path } })
    }
    return ops
  }
  function flush() {
    if (flushing || (!commands.length && !pluginStoreDirty)) return
    flushing = true
    const list = commands.splice(0)
    const dirty = pluginStoreDirty
    try {
      const ops = compile(list, editor.state.page)
      if (dirty) ops.push({ method: 'plugin.data.replace', params: { json: JSON.stringify(pluginStore) } })
      if (ops.length) batch(ops)
      if (dirty && pluginDataEmpty(pluginStore)) pluginStore = {}
      pluginStoreDirty = false
    } catch (error) {
      commands.unshift(...list)
      throw error
    } finally { flushing = false }
  }
  function publishUi(next: PluginUiState) {
    ui = next
    uiShown = true
    options.hooks?.onUi?.(ui)
  }
  function camera() { return editor.effectiveView() }
  function worldOrigin() {
    const view = camera()
    const zoom = view.zoom || 1
    return { x: -view.x / zoom, y: -view.y / zoom }
  }
  function toTransform(matrix: Matrix) {
    return [[matrix[0], matrix[2], matrix[4]], [matrix[1], matrix[3], matrix[5]]]
  }
  function absoluteBox(id: string, node: DesignNode) {
    const matrix = worldMatrix(editor.authoredDocument, id)
    return bounds([
      apply(matrix, { x: 0, y: 0 }),
      apply(matrix, { x: node.width, y: 0 }),
      apply(matrix, { x: node.width, y: node.height }),
      apply(matrix, { x: 0, y: node.height }),
    ])
  }
  function nodeView(id: string) {
    let result: { node: DesignNode; parentId?: string; pageId: string }
    try { result = execute('node.get', { id }, false) as typeof result }
    catch (error) {
      if (error instanceof PluginApiError && error.code === 'not_found') return null
      throw error
    }
    const node = result.node
    const same = node.radii.every(radius => radius === node.radii[0])
    const layout = node.layout
    const sizing = node.sizing
    const fontId = node.textStyle?.fontId ?? 'default'
    const family = fontId === 'default' ? 'Noto Sans SC' : families()[fontId]?.family || 'Noto Sans SC'
    const align = (value: string | undefined, fallback: string) => ALIGN_TO_FIGMA[value || ''] || fallback
    return {
      id: node.id, type: figmaType(node), name: node.name, x: node.transform[4], y: node.transform[5],
      width: node.width, height: node.height, rotation: rotationOf(node.transform),
      relativeTransform: toTransform(node.transform),
      absoluteTransform: toTransform(worldMatrix(editor.authoredDocument, id)),
      absoluteBoundingBox: absoluteBox(id, node),
      visible: node.visible, locked: node.locked, opacity: node.opacity, blendMode: BLEND_TO_FIGMA[node.blend] || 'NORMAL',
      fills: toFigmaFills(node.fills, images, imageUrls),
      strokes: node.strokes.map(item => ({ ...toFigmaFills([item.paint], images, imageUrls)[0], strokeWeight: item.width })),
      strokeWeight: node.strokes[0]?.width ?? 0,
      strokeAlign: (node.strokes[0]?.align || 'center').toUpperCase(),
      strokeCap: { butt: 'NONE', round: 'ROUND', square: 'SQUARE' }[node.strokes[0]?.cap || 'butt'],
      strokeJoin: (node.strokes[0]?.join || 'miter').toUpperCase(),
      dashPattern: (node.strokes[0]?.dash || '').split(/[\s,]+/).filter(Boolean).map(Number),
      cornerRadius: same ? node.radii[0] : null,
      topLeftRadius: node.radii[0], topRightRadius: node.radii[1], bottomRightRadius: node.radii[2], bottomLeftRadius: node.radii[3],
      clipsContent: node.clip, effects: toFigmaEffects(node.effects),
      constraints: {
        horizontal: align(node.constraints?.horizontal, 'MIN'),
        vertical: align(node.constraints?.vertical, 'MIN'),
      },
      layoutMode: !layout || layout.mode === 'none' ? 'NONE' : layout.mode === 'horizontal' ? 'HORIZONTAL' : layout.mode === 'vertical' ? 'VERTICAL' : 'GRID',
      itemSpacing: layout && layout.mode !== 'none' ? layout.gap : 0,
      paddingTop: layout?.padding[0] ?? 0, paddingRight: layout?.padding[1] ?? 0, paddingBottom: layout?.padding[2] ?? 0, paddingLeft: layout?.padding[3] ?? 0,
      primaryAxisAlignItems: layout?.justify === 'space-between' ? 'SPACE_BETWEEN' : align(layout?.justify, 'MIN'),
      counterAxisAlignItems: align(layout?.align, 'MIN'),
      layoutSizingHorizontal: (sizing?.width || 'fixed').toUpperCase(),
      layoutSizingVertical: (sizing?.height || 'fixed').toUpperCase(),
      layoutAlign: sizing?.alignSelf ? (ALIGN_TO_FIGMA[sizing.alignSelf] || 'INHERIT') : 'INHERIT',
      layoutGrow: sizing?.width === 'fill' ? 1 : 0,
      layoutPositioning: sizing?.absolute ? 'ABSOLUTE' : 'AUTO',
      primaryAxisSizingMode: axisSizing(layout, sizing, 'primary'),
      counterAxisSizingMode: axisSizing(layout, sizing, 'counter'),
      layoutWrap: layout?.wrap ? 'WRAP' : 'NONE',
      counterAxisSpacing: layout?.lineGap ?? 0,
      minWidth: sizing?.minWidth ?? 0.01, maxWidth: sizing?.maxWidth ?? 1e7,
      minHeight: sizing?.minHeight ?? 0.01, maxHeight: sizing?.maxHeight ?? 1e7,
      fillStyleId: node.styleRefs?.fills ?? null,
      strokeStyleId: null,
      textStyleId: node.kind === 'text' ? node.styleRefs?.textStyle ?? null : null,
      effectStyleId: node.styleRefs?.effects ?? null,
      boundVariables: Object.fromEntries(Object.entries(node.bindings ?? {}).map(([path, id]) => [path === 'text' ? 'characters' : path === 'layout.gap' ? 'itemSpacing' : path, id])),
      characters: node.kind === 'text' ? node.text : '',
      fontSize: node.fontSize,
      fontName: node.kind === 'text' ? { family, style: styleName(node.textStyle?.weight ?? 400) } : null,
      textAlignHorizontal: node.kind === 'text' ? ({ start: 'LEFT', center: 'CENTER', end: 'RIGHT', justify: 'JUSTIFIED' } as Record<string, string>)[node.textStyle?.align || 'start'] || 'LEFT' : null,
      textAlignVertical: node.kind === 'text' ? ({ top: 'TOP', center: 'CENTER', bottom: 'BOTTOM' } as Record<string, string>)[node.textStyle?.verticalAlign || 'top'] || 'TOP' : null,
      lineHeight: node.kind === 'text' ? { unit: 'PERCENT', value: Math.round((node.textStyle?.lineHeight ?? 1.35) * 1000) / 10 } : null,
      letterSpacing: node.kind === 'text' ? { unit: 'PIXELS', value: node.textStyle?.letterSpacing ?? 0 } : null,
      textCase: node.kind === 'text' ? (node.textStyle?.textCase === 'upper' ? 'UPPER' : node.textStyle?.textCase === 'lower' ? 'LOWER' : 'ORIGINAL') : null,
      textDecoration: node.kind === 'text' ? (node.textRuns?.some(run => run.strikethrough) ? 'STRIKETHROUGH' : node.textRuns?.some(run => run.underline) ? 'UNDERLINE' : 'NONE') : null,
      textAutoResize: node.kind === 'text' ? textAutoResizeOf(node.textStyle, sizing) : null,
      paragraphSpacing: node.kind === 'text' ? node.textStyle?.paragraphSpacing ?? 0 : null,
      paragraphIndent: node.kind === 'text' ? node.textStyle?.paragraphIndent ?? 0 : null,
      pointCount: node.points, innerRadius: node.innerRadius,
      parentId: result.parentId ?? null, parentIsPage: result.parentId === result.pageId,
      childIds: node.children, mainComponentId: node.instance?.componentId ?? null,
    }
  }
  function pendingStyle(id: string) {
    for (let index = commands.length - 1; index >= 0; index--) {
      const command = commands[index]
      if ((command.type === 'styleCreate' || command.type === 'styleUpdate') && command.id === id) return command
    }
    return undefined
  }
  function styleRecord(id: string) {
    const pending = pendingStyle(id)
    if (pending?.type === 'styleCreate') return pending
    try {
      return execute('style.get', { styleId: id }, false) as { id: string; name: string; kind: 'paint' | 'text' | 'effect'; value: unknown }
    } catch (error) {
      if (error instanceof PluginApiError && error.message.includes('Unknown style')) return null
      throw error
    }
  }
  function styleView(id: string) {
    const style = styleRecord(id)
    if (!style) return null
    const text = style.kind === 'text' ? { ...defaultTextStyle(), ...(style.value as TextStyle) } : null
    const family = text ? (text.fontId === 'default' ? 'Noto Sans SC' : families()[text.fontId]?.family || 'Noto Sans SC') : ''
    return {
      id: style.id,
      type: style.kind === 'paint' ? 'PAINT' : style.kind === 'text' ? 'TEXT' : 'EFFECT',
      name: style.name,
      paints: style.kind === 'paint' && Array.isArray(style.value) ? toFigmaFills(style.value as Paint[], images, imageUrls) : [],
      effects: style.kind === 'effect' && Array.isArray(style.value) ? toFigmaEffects(style.value as Effect[]) : [],
      fontName: text ? { family, style: styleName(text.weight) } : null,
      fontSize: 16,
      letterSpacing: text ? { unit: 'PIXELS', value: text.letterSpacing } : null,
      lineHeight: text ? { unit: 'PERCENT', value: Math.round(text.lineHeight * 1000) / 10 } : null,
      textCase: text ? (text.textCase === 'upper' ? 'UPPER' : text.textCase === 'lower' ? 'LOWER' : 'ORIGINAL') : null,
      textDecoration: 'NONE',
      textAlignHorizontal: text ? ({ start: 'LEFT', center: 'CENTER', end: 'RIGHT', justify: 'JUSTIFIED' } as Record<string, string>)[text.align] || 'LEFT' : null,
      textAlignVertical: text ? ({ top: 'TOP', center: 'CENTER', bottom: 'BOTTOM' } as Record<string, string>)[text.verticalAlign || 'top'] || 'TOP' : null,
      textAutoResize: text ? (text.wrap ? 'HEIGHT' : 'WIDTH_AND_HEIGHT') : null,
      paragraphSpacing: text?.paragraphSpacing ?? 0,
      paragraphIndent: text?.paragraphIndent ?? 0,
    }
  }
  function writeStyle(id: string, patch: { name?: string; value?: unknown }) {
    const pending = pendingStyle(id)
    if (pending) {
      if (patch.name !== undefined) pending.name = patch.name
      if (patch.value !== undefined) pending.value = patch.value
      return
    }
    ensureRoom()
    commands.push({ type: 'styleUpdate', id, ...patch })
  }
  function patchStyle(id: string, body: Record<string, unknown>) {
    const current = styleRecord(id)
    if (!current) throw new PluginApiError('not_found', 'Style does not exist')
    if (typeof body.name === 'string') writeStyle(id, { name: shortText(body.name, 'name', 200) })
    if (current.kind === 'paint' && body.paints !== undefined) writeStyle(id, { value: mapFills(body.paints, images) })
    if (current.kind === 'effect' && body.effects !== undefined) writeStyle(id, { value: mapEffects(body.effects) })
    if (current.kind === 'text') {
      const text = { ...defaultTextStyle(), ...(typeof current.value === 'object' && current.value ? current.value as TextStyle : {}) }
      let changed = false
      if (body.fontName !== undefined) {
        const font = record(body.fontName, 'fontName')
        const resolved = requireFont(shortText(font.family, 'fontName.family', 200), shortText(String(font.style ?? 'Regular'), 'fontName.style', 80))
        text.fontId = resolved.fontId
        text.weight = resolved.weight
        changed = true
      }
      if (body.letterSpacing !== undefined) { text.letterSpacing = letterSpacingOf(body.letterSpacing, 16); changed = true }
      if (body.lineHeight !== undefined) { text.lineHeight = lineHeightOf(body.lineHeight, 16); changed = true }
      if (body.paragraphSpacing !== undefined) { text.paragraphSpacing = finite(body.paragraphSpacing, 'paragraphSpacing', 0, 10000); changed = true }
      if (body.paragraphIndent !== undefined) { text.paragraphIndent = finite(body.paragraphIndent, 'paragraphIndent', -10000, 10000); changed = true }
      if (body.textCase !== undefined) {
        if (body.textCase !== 'ORIGINAL' && body.textCase !== 'UPPER' && body.textCase !== 'LOWER')
          throw new PluginApiError('unsupported_api', `textCase ${String(body.textCase)} is not available`)
        text.textCase = body.textCase === 'UPPER' ? 'upper' : body.textCase === 'LOWER' ? 'lower' : 'original'
        changed = true
      }
      if (changed) writeStyle(id, { value: text })
    }
    return null
  }
  function variableKind(value: unknown) {
    const kind = ({ COLOR: 'color', FLOAT: 'number', NUMBER: 'number', BOOLEAN: 'boolean', STRING: 'string' } as Record<string, 'color' | 'number' | 'boolean' | 'string'>)[String(value)]
    if (!kind) throw new PluginApiError('unsupported_api', `Variable type ${String(value)} is not available`)
    return kind
  }
  function variableDefault(kind: 'color' | 'number' | 'boolean' | 'string') {
    if (kind === 'color') return '#000000'
    if (kind === 'number') return 0
    if (kind === 'boolean') return false
    return ''
  }
  function variableValue(value: unknown, kind: 'color' | 'number' | 'boolean' | 'string') {
    if (kind === 'color') return typeof value === 'string' ? shortText(value, 'color', 32) : figmaColorToHex(value).hex
    if (kind === 'number') return finite(value, 'value', -1e7, 1e7)
    if (kind === 'boolean') return boolean(value, 'value')
    return shortText(value, 'value', 100_000)
  }
  function collectionModes(id: string) {
    const pending = commands.find(command => command.type === 'collectionCreate' && command.id === id)
    if (pending?.type === 'collectionCreate') return pending.modes
    const listed = execute('collection.list', {}, false) as { id: string; modes: string[] }[]
    const found = listed.find(item => item.id === id)
    if (!found) throw new PluginApiError('not_found', 'Variable collection does not exist')
    return found.modes
  }
  function variableKindOf(id: string) {
    const pending = commands.find(command => command.type === 'variableCreate' && command.id === id)
    if (pending?.type === 'variableCreate') return pending.kind
    return (execute('variable.get', { variableId: id }, false) as { kind: 'color' | 'number' | 'boolean' | 'string' }).kind
  }
  function collectionView(id: string) {
    const pending = commands.find(command => command.type === 'collectionCreate' && command.id === id)
    if (pending?.type === 'collectionCreate') {
      return {
        id, name: pending.name, defaultModeId: pending.modes[0],
        modes: pending.modes.map(name => ({ modeId: name, name })),
        variableIds: commands.flatMap(command => command.type === 'variableCreate' && command.collectionId === id ? [command.id] : []),
      }
    }
    const listed = execute('collection.list', {}, false) as { id: string; name: string; modes: string[]; defaultMode: string }[]
    const found = listed.find(item => item.id === id)
    if (!found) return null
    const variables = execute('variable.list', { collectionId: id }, false) as { id: string }[]
    return { id, name: found.name, defaultModeId: found.defaultMode, modes: found.modes.map(name => ({ modeId: name, name })), variableIds: variables.map(item => item.id) }
  }
  function variableView(id: string) {
    const pending = commands.find(command => command.type === 'variableCreate' && command.id === id)
    if (pending?.type === 'variableCreate') {
      return { id, name: pending.name, collectionId: pending.collectionId, resolvedType: pending.kind === 'color' ? 'COLOR' : pending.kind === 'number' ? 'FLOAT' : pending.kind === 'boolean' ? 'BOOLEAN' : 'STRING' }
    }
    try {
      const record = execute('variable.get', { variableId: id }, false) as { id: string; name: string; collection: string; kind: string }
      return { id: record.id, name: record.name, collectionId: record.collection, resolvedType: record.kind === 'color' ? 'COLOR' : record.kind === 'number' ? 'FLOAT' : record.kind === 'boolean' ? 'BOOLEAN' : 'STRING' }
    } catch (error) {
      if (error instanceof PluginApiError && error.message.includes('Unknown variable')) return null
      throw error
    }
  }
  function documentView() {
    const doc = execute('document.get', {}, false) as { id: string; name: string; pages: { id: string; name: string; children: string[] }[] }
    const selection = execute('selection.get', {}, false) as { pageId: string; ids: string[] }
    return {
      id: doc.id, name: doc.name, currentPageId: selection.pageId, selection: selection.ids,
      pages: doc.pages.map(page => ({ id: page.id, name: page.name, childIds: page.children })),
    }
  }
  function ids(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
      throw new PluginApiError('invalid_value', `${label} must be an array of node ids`)
    return value as string[]
  }

  return {
    notifications, logs,
    get ui() { return ui }, get uiShown() { return uiShown }, get listening() { return listening }, get applying() { return applying > 0 },
    get closed() { return closed }, get closeMessage() { return closeMessage }, get flushes() { return flushes },     get pluginId() { return pluginId },
    flush,
    hasNetwork: () => networkJobs.length > 0,
    takeNetwork: () => networkJobs.shift() ?? null,
    call(op: string, payload: unknown): unknown {
      if (closed) throw new PluginClosed(closeMessage)
      calls += 1
      if (calls > PLUGIN_LIMITS.hostCalls) throw new PluginApiError('plugin_limit', `Plugin exceeded ${PLUGIN_LIMITS.hostCalls} host calls`)
      const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (op === 'log') {
        const message = String(body.message ?? '').slice(0, PLUGIN_LIMITS.logChars)
        if (logs.length < PLUGIN_LIMITS.logLines) logs.push(message)
        return null
      }
      if (op === 'notify') {
        const message = shortText(body.message ?? '', 'notify', PLUGIN_LIMITS.notifyChars)
        notifications.push(message)
        editor.notify(message)
        options.hooks?.onNotify?.(message)
        return null
      }
      if (op === 'close') {
        flush()
        closed = true
        closeMessage = shortText(body.message ?? '', 'closePlugin', PLUGIN_LIMITS.notifyChars)
        throw new PluginClosed(closeMessage)
      }
      if (op === 'meta') return {
        pluginId, command: options.command ?? null, editorType: 'figma', mode: 'default', fileKey: null,
      }
      if (op === 'listen') { listening = true; return null }
      if (op === 'commitUndo') { flush(); return null }
      if (op === 'showUI') {
        const html = typeof body.html === 'string' ? body.html : options.uiHtml
        if (!html) throw new PluginApiError('missing_ui', 'showUI needs HTML or a manifest ui file')
        if (new TextEncoder().encode(html).byteLength > PLUGIN_LIMITS.uiBytes)
          throw new PluginApiError('plugin_too_large', 'Plugin UI is too large')
        const visible = body.visible === undefined ? true : boolean(body.visible, 'visible')
        publishUi({
          html,
          title: body.title === undefined ? pluginName : shortText(body.title, 'title', 80),
          visible,
          width: clampSize(finite(body.width ?? ui?.width ?? 300, 'width', 1, 10000), 80, 800),
          height: clampSize(finite(body.height ?? ui?.height ?? 200, 'height', 1, 10000), 40, 800),
        })
        return null
      }
      if (op === 'uiResize' || op === 'uiShow' || op === 'uiHide' || op === 'uiClose') {
        if (!ui) throw new PluginApiError('missing_ui', 'showUI has not been called')
        const next = { ...ui }
        if (op === 'uiResize') {
          next.width = clampSize(finite(body.width, 'width', 1, 10000), 80, 800)
          next.height = clampSize(finite(body.height, 'height', 1, 10000), 40, 800)
        } else next.visible = op === 'uiShow'
        publishUi(next)
        return null
      }
      if (op === 'postMessage') { options.hooks?.onPostMessage?.(body.message); return null }
      if (op === 'viewportRead') {
        const origin = worldOrigin()
        return { zoom: camera().zoom, center: origin }
      }
      if (op === 'viewportZoom') {
        const zoom = finite(body.zoom, 'zoom', 0.02, 256)
        const origin = worldOrigin()
        editor.set({ view: { x: -origin.x * zoom, y: -origin.y * zoom, zoom } })
        return null
      }
      if (op === 'viewportCenter') {
        const x = finite(body.x, 'center.x', -1e7, 1e7)
        const y = finite(body.y, 'center.y', -1e7, 1e7)
        const zoom = camera().zoom || 1
        editor.set({ view: { x: -x * zoom, y: -y * zoom, zoom } })
        return null
      }
      if (op === 'viewportReveal') {
        flush()
        editor.requestReveal(ids(body.ids, 'scrollAndZoomIntoView'))
        return null
      }
      if (op === 'clientStorageGet') return clientStorageGet(storage, pluginId, body.key)
      if (op === 'clientStorageKeys') return clientStorageKeys(storage, pluginId)
      if (op === 'clientStorageSet') {
        if (body.kind === 'undefined') clientStorageSet(storage, pluginId, body.key, { kind: 'undefined' })
        else if (body.kind === 'bytes') {
          if (typeof body.part !== 'number' || typeof body.parts !== 'number' || typeof body.rawBytes !== 'number')
            throw new PluginApiError('invalid_value', 'clientStorage bytes are incomplete')
          clientStorageSet(storage, pluginId, body.key, {
            kind: 'bytes', part: body.part, parts: body.parts, rawBytes: body.rawBytes,
            base64: shortText(body.base64, 'clientStorage', 200_000),
          })
        } else {
          if (typeof body.json !== 'string') throw new PluginApiError('invalid_value', 'clientStorage value must be JSON')
          clientStorageSet(storage, pluginId, body.key, body.json)
        }
        return null
      }
      if (op === 'clientStorageDelete') { clientStorageDelete(storage, pluginId, body.key); return null }
      if (op === 'pluginDataGet' || op === 'pluginDataKeys' || op === 'pluginDataSet' || op === 'sharedPluginDataGet' || op === 'sharedPluginDataKeys' || op === 'sharedPluginDataSet') {
        const scope = dataScope(body.scope)
        const id = shortText(body.id, 'id', 80)
        assertDataTarget(scope, id)
        if (op === 'pluginDataSet' || op === 'sharedPluginDataSet') {
          loadPluginStore()
          if (op === 'pluginDataSet') pluginDataSet(pluginStore, scope, id, pluginId, body.key, body.value)
          else sharedPluginDataSet(pluginStore, scope, id, body.namespace, body.key, body.value)
          pluginStoreDirty = true
          return null
        }
        const stored = pluginStoreDirty ? pluginStore : readPluginData(editor.authoredDocument)
        if (op === 'pluginDataGet') return pluginDataGet(stored, scope, id, pluginId, body.key)
        if (op === 'pluginDataKeys') return pluginDataKeys(stored, scope, id, pluginId)
        if (op === 'sharedPluginDataGet') return sharedPluginDataGet(stored, scope, id, body.namespace, body.key)
        return sharedPluginDataKeys(stored, scope, id, body.namespace)
      }
      if (op === 'readDocument') { flush(); return documentView() }
      if (op === 'readNode') {
        flush()
        const id = shortText(body.id, 'id', 80)
        const doc = documentView()
        const page = doc.pages.find(item => item.id === id)
        if (page) return { type: 'PAGE', id: page.id, name: page.name, childIds: page.childIds }
        return nodeView(id)
      }
      if (op === 'children') {
        flush()
        const id = shortText(body.id, 'id', 80)
        const doc = documentView()
        const page = doc.pages.find(item => item.id === id)
        if (page) return { ids: page.childIds }
        const node = nodeView(id)
        return { ids: node?.childIds ?? [] }
      }
      if (op === 'fonts') { flush(); return [
        ...WEIGHT_NAMES.map(([, style]) => ({ fontName: { family: 'Noto Sans SC', style } })),
        ...Object.values(families()).map(font => ({ fontName: { family: font.family, style: 'Regular' } })),
      ] }
      if (op === 'loadFont') {
        requireFont(shortText(body.family, 'family', 200), shortText(body.style ?? 'Regular', 'style', 80))
        return null
      }
      if (op === 'create') {
        const kind = body.kind
        if (typeof kind !== 'string' || !KINDS.has(kind as Kind) || kind === 'slice' || kind === 'vector' || kind === 'group')
          throw new PluginApiError('unsupported_api', `Cannot create ${String(kind)}`)
        ensureRoom()
        const id = crypto.randomUUID()
        commands.push({ type: 'create', id, kind: kind as Kind, assignments: [] })
        return { id }
      }
      if (op === 'patch') {
        const id = shortText(body.id, 'id', 80)
        const props = record(body.props, 'props')
        for (const [key, value] of Object.entries(props)) {
          if (key === 'fillStyleId' || key === 'textStyleId' || key === 'effectStyleId') {
            const field = key === 'fillStyleId' ? 'fills' : key === 'textStyleId' ? 'textStyle' : 'effects'
            const styleId = value === null || value === '' ? null : shortText(value, key, 128)
            ensureRoom()
            commands.push({ type: 'styleApply', nodeId: id, field, styleId })
          } else write(id, key, value)
        }
        return null
      }
      if (op === 'resize') { write(shortText(body.id, 'id', 80), 'width', body.width); write(shortText(body.id, 'id', 80), 'height', body.height); return null }
      if (op === 'remove') { ensureRoom(); commands.push({ type: 'remove', id: shortText(body.id, 'id', 80) }); return null }
      if (op === 'move') {
        ensureRoom()
        const index = body.index
        if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0))
          throw new PluginApiError('invalid_value', 'index must be a non-negative integer')
        commands.push({ type: 'move', id: shortText(body.id, 'id', 80), parentId: shortText(body.parentId, 'parentId', 80), ...(index === undefined ? {} : { index }) })
        return null
      }
      if (op === 'selection') { ensureRoom(); commands.push({ type: 'selection', ids: ids(body.ids, 'selection') }); return null }
      if (op === 'setPage') { ensureRoom(); commands.push({ type: 'setPage', id: shortText(body.id, 'id', 80) }); return null }
      if (op === 'createPage') {
        ensureRoom()
        const id = crypto.randomUUID()
        commands.push({ type: 'createPage', id, name: body.name === undefined ? undefined : shortText(body.name, 'name', 200), makeCurrent: body.makeCurrent === true })
        return { id }
      }
      if (op === 'renamePage') { ensureRoom(); commands.push({ type: 'renamePage', id: shortText(body.id, 'id', 80), name: shortText(body.name, 'name', 200) }); return null }
      if (op === 'clone' || op === 'group' || op === 'ungroup' || op === 'component' || op === 'componentFromNode' || op === 'instance' || op === 'detach' || op === 'boolean') {
        flush()
        if (op === 'clone') {
          const duplicated = execute('batch.apply', { operations: [{ method: 'node.duplicate', params: { ids: [shortText(body.id, 'id', 80)] } }], label: `Plugin: ${pluginName}`.slice(0, 200) }, true) as { operations?: { result?: { ids?: string[] } }[] }
          flushes += 1
          const id = duplicated.operations?.[0]?.result?.ids?.[0]
          if (!id) throw new PluginApiError('plugin_failed', 'Clone did not return a node')
          return { id }
        }
        if (op === 'group') {
          const selected = ids(body.ids, 'group')
          const parentId = shortText(body.parentId, 'parentId', 80)
          for (const id of selected) {
            const parent = (execute('node.get', { id }, false) as { parentId?: string }).parentId
            if (parent !== parentId) throw new PluginApiError('invalid_parent', 'figma.group requires every node to already be a child of the parent')
          }
          return { id: resultId(batch([{ method: 'node.group', params: { ids: selected } }])) }
        }
        if (op === 'ungroup') {
          const ungrouped = batch([{ method: 'node.ungroup', params: { ids: [shortText(body.id, 'id', 80)] } }]) as { operations?: { result?: { ids?: string[] } }[] }
          return { ids: ungrouped.operations?.[0]?.result?.ids ?? [] }
        }
        if (op === 'component') {
          const id = crypto.randomUUID()
          batch([{ method: 'node.create', params: { id, kind: 'frame', width: 100, height: 100 } }, { method: 'component.create', params: { nodeIds: [id], ...(body.name ? { name: shortText(body.name, 'name', 200) } : {}) } }])
          return { id }
        }
        if (op === 'componentFromNode') return { id: resultId(batch([{ method: 'component.create', params: { nodeIds: [shortText(body.id, 'id', 80)] } }])) }
        if (op === 'instance') {
          const params: Record<string, unknown> = { componentId: shortText(body.componentId, 'componentId', 80), x: finite(body.x ?? 0, 'x', -1e7, 1e7), y: finite(body.y ?? 0, 'y', -1e7, 1e7) }
          if (body.parentId !== undefined) params.parentId = shortText(body.parentId, 'parentId', 80)
          return { id: resultId(batch([{ method: 'component.instantiate', params }])) }
        }
        if (op === 'detach') { batch([{ method: 'component.detach', params: { nodeId: shortText(body.id, 'id', 80) } }]); return null }
        const selected = ids(body.ids, 'boolean')
        if (selected.length < 2) throw new PluginApiError('invalid_value', 'Boolean operations need at least two nodes')
        const operation = String(body.operation)
        if (!['union', 'subtract', 'intersect', 'exclude'].includes(operation)) throw new PluginApiError('unsupported_api', `Boolean ${operation} is not available`)
        return { id: resultId(batch([{ method: 'vector.boolean.create', params: { ids: selected, operation } }])) }
      }
      if (op === 'svg') {
        const svg = shortText(body.svg, 'svg', 1_000_000)
        if (!/<svg[\s>]/i.test(svg)) throw new PluginApiError('invalid_value', 'createNodeFromSvg requires an <svg> element')
        flush()
        const imported = operationResult(execute('svg.import', { format: 'svg', content: svg, name: 'SVG' }, true))
        const roots = Array.isArray(imported.rootIds) ? imported.rootIds.filter((id): id is string => typeof id === 'string') : []
        if (!roots.length) throw new PluginApiError('plugin_failed', 'SVG import did not create a node')
        if (roots.length === 1) return { id: roots[0] }
        return { id: resultId(batch([{ method: 'node.group', params: { ids: roots } }])) }
      }
      if (op === 'base64Encode') {
        if (!Array.isArray(body.bytes) || body.bytes.length > 262144) throw new PluginApiError('plugin_limit', 'base64Encode input is too large')
        const bytes = new Uint8Array(body.bytes.length)
        for (let index = 0; index < body.bytes.length; index++) {
          const value = body.bytes[index]
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255)
            throw new PluginApiError('invalid_value', 'base64Encode expects bytes 0–255')
          bytes[index] = value
        }
        let text = ''
        for (const value of bytes) text += String.fromCharCode(value)
        return btoa(text)
      }
      if (op === 'base64Decode') {
        const data = shortText(body.data, 'base64', 400_000)
        if (data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) throw new PluginApiError('invalid_value', 'base64Decode expects base64 text')
        const binary = atob(data)
        return [...binary].map(character => character.charCodeAt(0))
      }
      if (op === 'styleList') {
        flush()
        const kind = body.kind
        if (kind !== 'paint' && kind !== 'text' && kind !== 'effect') throw new PluginApiError('invalid_value', 'Style kind is invalid')
        const listed = execute('style.list', { kind }, false) as Array<{ id: string }>
        return listed.map(item => styleView(item.id)).filter((item): item is NonNullable<typeof item> => !!item)
      }
      if (op === 'styleRead') {
        flush()
        return styleView(shortText(body.id, 'id', 128))
      }
      if (op === 'styleCreate') {
        const kind = body.kind
        if (kind !== 'paint' && kind !== 'text' && kind !== 'effect') throw new PluginApiError('invalid_value', 'Style kind is invalid')
        ensureRoom()
        const id = crypto.randomUUID()
        commands.push({
          type: 'styleCreate', id, kind,
          name: kind === 'paint' ? 'Paint' : kind === 'text' ? 'Text' : 'Effect',
          value: kind === 'text' ? defaultTextStyle() : [],
        })
        return { id }
      }
      if (op === 'stylePatch') return patchStyle(shortText(body.id, 'id', 128), body)
      if (op === 'styleDelete') {
        ensureRoom()
        commands.push({ type: 'styleDelete', id: shortText(body.id, 'id', 128) })
        return null
      }
      if (op === 'imageCreate') {
        const base64 = shortText(body.base64, 'image', 400_000)
        if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) throw new PluginApiError('invalid_value', 'createImage expects image bytes')
        const binary = atob(base64)
        if (binary.length > 262144) throw new PluginApiError('plugin_limit', 'Plugin images are limited to 256 KiB')
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
        const hash = imageContentId(bytes)
        const mime = imageMime(bytes)
        if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp')
          throw new PluginApiError('unsupported_api', 'createImage accepts PNG, JPEG, or WebP. The document does not admit a GIF data URL.')
        images.set(hash, { mime, bytes, base64 })
        imageUrls.set(dataUrlForImage(mime, base64), hash)
        return { hash }
      }
      if (op === 'imageFind' || op === 'imageBytes' || op === 'imageSize') {
        const hash = shortText(body.hash, 'hash', 80)
        let stored = images.get(hash)
        if (!stored) {
          for (const node of Object.values(editor.authoredDocument.nodes)) {
            for (const fill of [...node.fills, ...node.strokes.map(stroke => stroke.paint)]) {
              if (fill.kind !== 'image' || !fill.image) continue
              const decoded = bytesFromDataUrl(fill.image)
              if (!decoded) continue
              const id = imageContentId(decoded.bytes)
              let binary = ''
              for (const byte of decoded.bytes) binary += String.fromCharCode(byte)
              const next = { mime: decoded.mime, bytes: decoded.bytes, base64: btoa(binary) }
              images.set(id, next)
              imageUrls.set(fill.image, id)
              if (id === hash) stored = next
            }
          }
        }
        if (!stored) return op === 'imageFind' ? null : (() => { throw new PluginApiError('not_found', 'Unknown image hash') })()
        if (op === 'imageFind') return { hash }
        if (op === 'imageBytes') return stored.base64
        const size = imageSize(stored.bytes, stored.mime)
        if (!size.width || !size.height) throw new PluginApiError('unsupported_api', 'Image size is available for PNG, JPEG, and GIF bytes')
        return size
      }
      if (op === 'export') {
        flush()
        const id = shortText(body.id, 'id', 80)
        const format = String(body.format || 'PNG').toUpperCase()
        if (format !== 'SVG') throw new PluginApiError('unsupported_api', 'exportAsync supports SVG in this host. PNG, JPG, and PDF use the editor export panel.')
        const scale = body.scale === undefined ? undefined : finite(body.scale, 'scale', 0.01, 4)
        const exported = operationResult(execute('vector.export', { nodeIds: [id], textMode: 'path', fontMode: 'none', ...(scale === undefined ? {} : { scale }) }, false))
        const text = exported.content
        if (typeof text !== 'string' || !text) throw new PluginApiError('plugin_failed', 'SVG export did not return markup')
        return { text }
      }
      if (op === 'fetchBegin') {
        const decision = matchNetworkAccess(String(body.url ?? ''), networkDomains)
        if (!decision.ok) throw new PluginApiError('network_denied', decision.reason)
        const method = String(body.method || 'GET').toUpperCase()
        if (!PLUGIN_FETCH_METHODS.has(method)) throw new PluginApiError('invalid_value', 'fetch method is not allowed')
        let headers: Record<string, string>
        try { headers = pluginFetchHeaders(body.headers) } catch (error) { throw new PluginApiError('invalid_value', error instanceof Error ? error.message : String(error)) }
        const requestBody = body.body == null ? null : shortText(body.body, 'fetch body', 1_000_000)
        const id = finite(body.id, 'fetch id', 1, 1_000_000)
        networkJobs.push({ id, url: decision.url.toString(), method, headers, body: requestBody })
        return { id }
      }
      if (op === 'collectionList') {
        flush()
        const listed = execute('collection.list', {}, false) as { id: string }[]
        return listed.map(item => ({ id: item.id }))
      }
      if (op === 'collectionRead') {
        flush()
        return collectionView(shortText(body.id, 'id', 128))
      }
      if (op === 'collectionCreate') {
        ensureRoom()
        const id = crypto.randomUUID()
        commands.push({ type: 'collectionCreate', id, name: shortText(body.name, 'name', 200), modes: ['Mode 1'] })
        return { id }
      }
      if (op === 'collectionRename') {
        flush()
        execute('collection.update', { collectionId: shortText(body.id, 'id', 128), name: shortText(body.name, 'name', 200) }, true)
        return null
      }
      if (op === 'collectionAddMode') {
        flush()
        const id = shortText(body.id, 'id', 128)
        const name = shortText(body.name, 'mode', 80)
        execute('collection.addMode', { collectionId: id, mode: name }, true)
        return { modeId: name }
      }
      if (op === 'collectionRenameMode') {
        flush()
        execute('collection.renameMode', { collectionId: shortText(body.id, 'id', 128), mode: shortText(body.mode, 'mode', 80), name: shortText(body.name, 'name', 80) }, true)
        return null
      }
      if (op === 'collectionDelete') {
        flush()
        execute('collection.delete', { collectionId: shortText(body.id, 'id', 128) }, true)
        return null
      }
      if (op === 'variableList') {
        flush()
        const wanted = body.type == null ? null : variableKind(body.type)
        const listed = execute('variable.list', {}, false) as { id: string; kind: string }[]
        return listed.filter(item => !wanted || item.kind === wanted).map(item => ({ id: item.id }))
      }
      if (op === 'variableRead') {
        flush()
        return variableView(shortText(body.id, 'id', 128))
      }
      if (op === 'variableCreate') {
        const kind = variableKind(body.resolvedType)
        const collectionId = shortText(body.collectionId, 'collectionId', 128)
        const modes = collectionModes(collectionId)
        const values = Object.fromEntries(modes.map(mode => [mode, variableDefault(kind)]))
        ensureRoom()
        const id = crypto.randomUUID()
        commands.push({ type: 'variableCreate', id, name: shortText(body.name, 'name', 200), collectionId, kind, values })
        return { id }
      }
      if (op === 'variableRename') {
        flush()
        execute('variable.update', { variableId: shortText(body.id, 'id', 128), name: shortText(body.name, 'name', 200) }, true)
        return null
      }
      if (op === 'variableSet') {
        const id = shortText(body.id, 'id', 128)
        const mode = shortText(body.mode, 'mode', 80)
        const pending = commands.find(command => command.type === 'variableCreate' && command.id === id)
        const value = variableValue(body.value, pending && pending.type === 'variableCreate' ? pending.kind : variableKindOf(id))
        if (pending && pending.type === 'variableCreate') { pending.values[mode] = value; return null }
        ensureRoom()
        commands.push({ type: 'variableSet', id, mode, value })
        return null
      }
      if (op === 'variableDelete') {
        flush()
        execute('variable.delete', { variableId: shortText(body.id, 'id', 128) }, true)
        return null
      }
      if (op === 'variableBind') {
        const field = String(body.field || '')
        const path = field === 'characters' ? 'text' : field === 'itemSpacing' ? 'layout.gap' : field
        if (!['width', 'height', 'opacity', 'fontSize', 'text', 'visible', 'layout.gap'].includes(path))
          throw new PluginApiError('unsupported_api', `setBoundVariable(${field}) is not available`)
        ensureRoom()
        commands.push({ type: 'variableBind', nodeId: shortText(body.id, 'id', 80), path, variableId: body.variableId == null ? null : shortText(body.variableId, 'variableId', 128) })
        return null
      }
      throw new PluginApiError('unsupported_api', `${op} is not available on this plugin host`)
    },
  }
}
