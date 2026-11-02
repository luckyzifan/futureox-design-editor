import { createEditorDesignAutomation } from '../automation'
import type { Editor } from '../engine'
import {
  defaultLayout, defaultSizing, defaultTextStyle, effect, paint, stroke,
  type AutoLayout, type Constraints, type DesignNode, type Effect, type Kind, type Matrix, type Paint, type Sizing, type Stroke, type TextStyle,
} from '../model'
import { figmaColorToHex, hexToFigmaColor } from './colors'
import { PluginApiError, PluginClosed } from './errors'
import { PLUGIN_LIMITS } from './limits'

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
}

type AutomationOp = { method: string; params?: Record<string, unknown> }
type Hooks = {
  onNotify?: (message: string) => void
  onUi?: (ui: PluginUiState) => void
  onPostMessage?: (message: unknown) => void
}
export type PluginUiState = { html: string; width: number; height: number }

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
function mapFill(value: unknown): Paint {
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
  if (type === 'GRADIENT_LINEAR') {
    const stops = fill.gradientStops
    if (!Array.isArray(stops) || stops.length < 2) throw new PluginApiError('invalid_value', 'GRADIENT_LINEAR needs at least two gradientStops')
    const mapped = stops.map(stop => {
      const item = record(stop, 'gradientStop')
      const color = figmaColorToHex(item.color)
      return { offset: finite(item.position, 'gradientStop.position', 0, 1), color: color.hex }
    })
    const made = paint(mapped[0].color, 'linear')
    made.opacity = opacity
    made.visible = visible
    made.stops = mapped
    made.angle = Array.isArray(fill.gradientTransform) ? angleOf(fill.gradientTransform) : 180
    return made
  }
  throw new PluginApiError('unsupported_api', `Fill ${String(type)} is not available. SOLID and GRADIENT_LINEAR are supported.`)
}
function angleOf(transform: unknown): number {
  if (!Array.isArray(transform) || !Array.isArray(transform[0]) || !Array.isArray(transform[1])) return 180
  const a = Number(transform[0][0])
  const b = Number(transform[1][0])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 180
  const degrees = Math.atan2(b, a) * 180 / Math.PI
  return Number.isFinite(degrees) ? degrees : 180
}
function mapFills(value: unknown): Paint[] {
  if (!Array.isArray(value) || value.length > 16) throw new PluginApiError('invalid_value', 'fills must be an array of at most 16 paints')
  return value.map(mapFill)
}
function mapStrokePaint(value: unknown): Paint {
  const fill = mapFill({ ...record(value, 'stroke'), type: record(value, 'stroke').type ?? 'SOLID' })
  if (fill.kind !== 'solid') throw new PluginApiError('unsupported_api', 'Only SOLID strokes are supported')
  return fill
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
function toFigmaFills(fills: Paint[]) {
  return fills.map(item => {
    if (item.kind === 'solid') return { type: 'SOLID', color: hexToFigmaColor(item.color), opacity: item.opacity, visible: item.visible }
    if (item.kind === 'linear') return {
      type: 'GRADIENT_LINEAR', opacity: item.opacity, visible: item.visible,
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

export function createPluginSession(editor: Editor, options: { name: string; uiHtml: string | null; hooks?: Hooks }) {
  const api = createEditorDesignAutomation(editor)
  const pluginName = options.name
  const documentId = editor.state.doc.id
  const sessionId = editor.sessionGeneration
  const commands: Command[] = []
  const notifications: string[] = []
  const logs: string[] = []
  let ui: PluginUiState | null = null
  let closed = false
  let closeMessage = ''
  let flushing = false
  let flushes = 0
  let calls = 0
  let fontFamilies: Record<string, { family: string }> | null = null

  function failIfReplaced() {
    if (editor.state.doc.id !== documentId || editor.sessionGeneration !== sessionId)
      throw new PluginApiError('document_changed', 'The open document changed while the plugin was running')
  }
  function execute(method: string, params: Record<string, unknown>, mutate: boolean) {
    failIfReplaced()
    const response = api.execute({
      method, params,
      ...(mutate ? { documentId, session: sessionId, expectedRevision: editor.state.version } : {}),
    })
    if (!response.ok) throw new PluginApiError(response.error.code, response.error.message)
    const result = response.result as { completion?: { superseded?: boolean } } | null
    if (result && typeof result === 'object' && result.completion?.superseded)
      throw new PluginApiError('document_changed', 'The document changed while the plugin was running')
    return response.result
  }
  function batch(operations: AutomationOp[]) {
    if (!operations.length) return null
    const label = `Plugin: ${pluginName}`.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)
    const result = execute('batch.apply', { operations, label }, true)
    flushes += 1
    return result
  }
  function resultId(result: unknown): string {
    const operations = (result as { operations?: { result?: { id?: string } }[] } | null)?.operations
    const id = operations?.[0]?.result?.id
    if (!id) throw new PluginApiError('plugin_failed', 'The editor did not return a new node id')
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
      if (command.type === 'move' || command.type === 'remove' || command.type === 'setPage' || command.type === 'createPage' || command.type === 'renamePage' || command.type === 'selection') break
      if ((command.type === 'create' || command.type === 'update') && command.id === id) return command
    }
    const update: Command = { type: 'update', id, assignments: [] }
    commands.push(update)
    return update
  }
  function write(id: string, key: string, value: unknown) {
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
  function defaults(kind: Kind): Working {
    const [width, height] = CREATE_SIZE[kind] ?? [100, 100]
    return {
      kind, transform: [1, 0, 0, 1, 0, 0], width, height, radii: [0, 0, 0, 0], strokes: [],
      layout: null, sizing: null, constraints: null, textStyle: kind === 'text' ? defaultTextStyle() : null,
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
    } else if (key === 'fills') patch.fills = mapFills(value)
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
      patch.text = shortText(value, 'characters', 100_000)
      patch.textRuns = []
    } else if (key === 'fontSize') {
      if (working.kind !== 'text') throw new PluginApiError('invalid_kind', 'fontSize is only available on text')
      patch.fontSize = finite(value, 'fontSize', 1, 4096)
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
    if (key === 'x' || key === 'y' || key === 'rotation') patch.transform = [...working.transform]
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
      } else if (command.type === 'renamePage') ops.push({ method: 'page.update', params: { id: command.id, patch: { name: command.name } } })
    }
    return ops
  }
  function flush() {
    if (flushing || !commands.length) return
    flushing = true
    const list = commands.splice(0)
    try { batch(compile(list, editor.state.page)) }
    finally { flushing = false }
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
      visible: node.visible, locked: node.locked, opacity: node.opacity, blendMode: BLEND_TO_FIGMA[node.blend] || 'NORMAL',
      fills: toFigmaFills(node.fills),
      strokes: node.strokes.map(item => ({ type: 'SOLID', color: hexToFigmaColor(item.paint.color), opacity: item.paint.opacity, visible: item.visible })),
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
      characters: node.kind === 'text' ? node.text : '',
      fontSize: node.fontSize,
      fontName: node.kind === 'text' ? { family, style: styleName(node.textStyle?.weight ?? 400) } : null,
      pointCount: node.points, innerRadius: node.innerRadius,
      parentId: result.parentId ?? null, parentIsPage: result.parentId === result.pageId,
      childIds: node.children, mainComponentId: node.instance?.componentId ?? null,
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
    notifications, logs, get ui() { return ui }, get closed() { return closed }, get closeMessage() { return closeMessage }, get flushes() { return flushes },
    flush, 
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
      if (op === 'showUI') {
        if (!options.uiHtml) throw new PluginApiError('missing_ui', 'This plugin has no ui.html')
        ui = { html: options.uiHtml, width: clampSize(finite(body.width ?? 300, 'width', 1, 10000), 80, 800), height: clampSize(finite(body.height ?? 200, 'height', 1, 10000), 40, 800) }
        options.hooks?.onUi?.(ui)
        return null
      }
      if (op === 'uiResize') {
        if (!ui) throw new PluginApiError('missing_ui', 'showUI has not been called')
        ui = { ...ui, width: clampSize(finite(body.width, 'width', 1, 10000), 80, 800), height: clampSize(finite(body.height, 'height', 1, 10000), 40, 800) }
        options.hooks?.onUi?.(ui)
        return null
      }
      if (op === 'postMessage') { options.hooks?.onPostMessage?.(body.message); return null }
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
        for (const [key, value] of Object.entries(props)) write(id, key, value)
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
      throw new PluginApiError('unsupported_api', `${op} is not available on this plugin host`)
    },
  }
}
