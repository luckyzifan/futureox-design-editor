import {sourceBitmap} from './source-bitmap'
import { assertDocumentStructure } from './document-capacity'
import { hasSchema15Features } from './schema-features'
import { validateRepeat, validateRepeatDocument, type RepeatTransform } from './repeat-transforms'
import { hasLogic, validateLogicActions } from './prototype-logic'
import { validateFdCompatibility, type FdCompatibility } from './fd-extensions'
import { validateVectorBrush } from './vector-brush'
import { validStroke, validProfiles } from './stroke-profile'
import type { AnimationClip } from './animation'
import { validColor, validColorSettings, type ColorSettings } from './color'
export const MAX_GRADIENT_STOPS = 64
export type Point = { x: number; y: number }
export type Matrix = [number, number, number, number, number, number]
export type Bounds = { x: number; y: number; width: number; height: number }
export type RulerGuide = {id:string;axis:'x'|'y';position:number}
export type Kind =
  | 'slice'
  | 'frame'
  | 'section'
  | 'group'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'line'
  | 'vector'
  | 'text'
export const blendModes = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'linear-burn',
  'linear-dodge',
] as const
export type Blend = (typeof blendModes)[number]
export type NodeBlend = Blend | 'pass-through'
/** Image paint adjustments, Figma imageColorAdjust uniforms
 * (imageColorAdjustPaint): field names and order follow
 * `struct UniformBlock{…globalTint,globalColor,globalShadows,globalHighlights,
 * globalExposure,globalTemperature,globalContrast,highlightShadowThreshold…}`.
 * All sliders span [-1,1]; the shader itself clamps globalColor to that range. */
export type ImageAdjust = {
  exposure: number
  contrast: number
  temperature: number
  tint: number
  highlights: number
  shadows: number
  color: number
  highlightShadowThreshold?: number
}
export const defaultImageAdjust = (): ImageAdjust => ({
  exposure: 0,
  contrast: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  color: 0,
  highlightShadowThreshold: 0.5,
})
export const isIdentityImageAdjust = (a: ImageAdjust): boolean =>
  !a.exposure && !a.contrast && !a.temperature && !a.tint && !a.highlights && !a.shadows && !a.color
export type PatternTileMode = 'none' | 'grid' | 'stagger_horizontal' | 'stagger_vertical'
export type PatternTile = {
  mode: PatternTileMode
  /** Cell period in node-local px per axis; 0 = the image's native extent
   * (the shader's `patternTexSizePixels`). */
  size: [number, number]
  /** `offsetPixels` in node-local px (`patternBoundsOffsetPixels` folds in:
   * same pre-repeat translation, opposite sign). */
  offset: [number, number]
  /** Pins the scaled image box to the fill on each axis. The trailing
   * spacing gap is outside that box, and rotation is about the pin. */
  alignment?: ['start'|'center'|'end', 'start'|'center'|'end']
  /** Uniform scale of the native image. Omitted means 1. Explicit `size` is not scaled again. */
  scale?: number
  /** Pattern rotation in degrees, applied before the repeat. */
  rotation?: number
  /** Transparent gap after the scaled image, in node-local pixels. */
  spacing?: [number, number]
}
export const defaultPatternTile = (): PatternTile => ({ mode: 'grid', size: [0, 0], offset: [0, 0] })
export type Paint = {
  id: string
  kind: 'solid' | 'linear' | 'radial' | 'image' | 'angular' | 'diamond'
  transform?: Matrix
  color: string
  opacity: number
  visible: boolean
  angle: number
  stops: { offset: number; color: string }[]
  image?: string
  fit: 'cover' | 'contain' | 'stretch'
  blend: Blend
  /** Image adjustments (schema 13, image paints only); absent = identity. */
  adjust?: ImageAdjust
  /** Pattern tiling (schema 14, image paints only); absent = single
   * placement, `mode: 'none'` renders the same way. */
  tile?: PatternTile
}
export type WidthPoint = { position: number; left: number; right: number }
export type StrokeMarker = 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond' | 'square' | 'bar'
export type Stroke = {
  startMarker?: StrokeMarker
  endMarker?: StrokeMarker
  id: string
  paint: Paint
  width: number
  align: 'inside' | 'center' | 'outside'
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  dash: string
  dashOffset?: number
  widthProfile?: WidthPoint[]
  visible: boolean
}
export type ColorControls = { space?: 'srgb' | 'display-p3'; brightness: number; contrast: number; saturation: number; hue: number }
export const defaultColorControls = (): ColorControls => ({ space:'srgb', brightness: 0, contrast: 1, saturation: 1, hue: 0 })
export function validColorControls(c: unknown): c is ColorControls {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false
  const v = c as ColorControls
  return Object.keys(c).every(k => ['space','brightness','contrast','saturation','hue'].includes(k)) &&
    (v.space === undefined || ['srgb','display-p3'].includes(v.space)) &&
    [v.brightness,v.contrast,v.saturation,v.hue].every(Number.isFinite) &&
    v.brightness >= -1 && v.brightness <= 1 && v.contrast >= 0 && v.contrast <= 4 &&
    v.saturation >= 0 && v.saturation <= 4 && Math.abs(v.hue) <= 1e7
}
const usesColorControls = (e: Effect) => e.kind === 'color-controls' || e.colorControls != null
const usesSpatialBlur = (e: Effect) => e.kind === 'gaussian-blur' || e.kind === 'motion-blur'
const usesZoomBlur = (e: Effect) => e.kind === 'zoom-blur'

function findDocumentEffect(d: DesignDocument, nodes: DesignNode[], match: (e: Effect) => boolean): Effect | undefined {
  const find = (list: unknown): Effect | undefined => Array.isArray(list) ? list.find(e => e && match(e)) : undefined
  for (const n of nodes) {
    const own = find(n.effects)
    if (own) return own
    if (n.instance?.overrides) for (const o of Object.values(n.instance.overrides)) {
      const effect = find(o.effects)
      if (effect) return effect
    }
  }
  let animated: Effect | undefined
  if (d.animations?.some(clip => clip.tracks.some(track => track.keyframes.some(key => {
    animated = find(key.value.effects)
    return !!animated
  })))) return animated
  for (const style of Object.values(d.designSystem?.styles ?? {})) {
    const effect = find(style.effects) ?? (style.kind === 'effect' ? find(style.value) : undefined)
    if (effect) return effect
  }
}
export function hasSchema17Features(d: DesignDocument): boolean {
  return !!findDocumentEffect(d, Object.values(d.nodes), usesColorControls)
}
export function hasSchema18Features(d: DesignDocument): boolean {
  return !!findDocumentEffect(d, Object.values(d.nodes), usesSpatialBlur)
}
export function hasSchema19Features(d: DesignDocument): boolean {
  return !!findDocumentEffect(d, Object.values(d.nodes), usesZoomBlur)
}
export function hasSchema21Features(d: DesignDocument): boolean {
  const runs = (r: any) => Array.isArray(r) && r.some(run => run && (run.letterSpacing !== undefined || run.lineHeight !== undefined))
  return Object.values(d.nodes).some(n => runs(n.textRuns) || Object.values(n.instance?.overrides || {}).some(o => runs(o.textRuns)))
}
export function hasSchema20Features(d: DesignDocument, nodes = Object.values(d.nodes)): boolean {
  const action = (a: import('./prototype').PrototypeAction): boolean => a.transitionStyle !== undefined || !!a.thenActions?.some(action) || !!a.elseActions?.some(action)
  if (Object.values(d.prototype?.interactions||{}).some(es=>es.some(e=>e.actions.some(action)))) return true
  const style = (s: any) => s?.verticalAlign !== undefined && s.verticalAlign !== 'top'
  const runs = (r: any) => Array.isArray(r) && r.some(r=>r?.paragraph != null)
  return nodes.some(n => style(n.textStyle) || runs(n.textRuns) ||
    (n.instance?.overrides && Object.values(n.instance.overrides).some(o => style(o.textStyle) || runs(o.textRuns))))
    || Object.values(d.designSystem?.styles||{}).some(s=>s.kind==='text'&&style(s.value))
}
export type ZoomBlur = {amount:number;center:[number,number]}
export function validZoomBlur(value:unknown):value is ZoomBlur {
  if(!value || typeof value!=='object' || Array.isArray(value))return false
  const z=value as ZoomBlur
  return Object.keys(value).every(k=>['amount','center'].includes(k)) && Number.isFinite(z.amount) && z.amount>=0 && z.amount<=1000 &&
    Array.isArray(z.center) && z.center.length===2 && z.center.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)
}
export type Effect = {
  zoomBlur?: ZoomBlur
  motionAngle?: number
  colorControls?: ColorControls
  id: string
  kind: 'shadow' | 'inner-shadow' | 'blur' | 'background-blur' | 'glass' | 'noise' | 'texture' | 'color-controls' | 'gaussian-blur' | 'motion-blur' | 'zoom-blur'
  visible: boolean
  radius: number
  x: number
  y: number
  spread: number
  color: string
  opacity: number
  amount: number
  glass?: {
    bevelSize?: number
    depth: number
    refraction: number
    dispersion: number
    lightAngle: number
    lightIntensity: number
  }
  texture?: { noiseSize: [number, number]; clipToShape: boolean; noise?: 'figma' | 'gabor' | 'perlin' }
  gradientBlur?: {start:[number,number];end:[number,number];startCount:number;endCount:number;smooth:boolean}
  /** kiwi Effect.showShadowBehindNode. Preserved on import; shadow clipping does not branch on it yet. */
  showShadowBehindNode?: boolean
}
export type Vertex = Point & { id: string }
export type Edge = { id: string; from: string; to: string; c1?: Point; c2?: Point }
export type Network = { filledFaces?:string[][]; vertices: Vertex[]; edges: Edge[]; fillRule: 'evenodd' | 'nonzero' }
export type LayoutAlign =
  | 'start'
  | 'center'
  | 'end'
  | 'stretch'
  | 'space-between'
  | 'space-around'
  | 'space-evenly'
  | 'unsafe-center'
  | 'unsafe-end'
export type AutoLayout = {
  mode: 'none' | 'horizontal' | 'vertical' | 'grid'
  gap: number
  lineGap: number
  padding: [number, number, number, number]
  wrap: boolean
  justify: LayoutAlign
  align: LayoutAlign
  columns: number
  fillRows: boolean
}
export type Sizing = {
  width: 'fixed' | 'hug' | 'fill'
  height: 'fixed' | 'hug' | 'fill'
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
  absolute: boolean
  alignSelf: LayoutAlign | null
  columnSpan: number
  rowSpan: number
}
export type ConstraintAnchor = 'start' | 'center' | 'end' | 'stretch' | 'scale'
export type Constraints = {
  horizontal: ConstraintAnchor
  vertical: ConstraintAnchor
  referenceWidth?: number | null
  referenceHeight?: number | null
}
/** Authored layout grid overlay on a frame (Sketch grid/layout dicts,
 * Figma layoutGrids). Track sizes derive from the frame extent:
 * (extent - 2*margin - (count-1)*gutter) / count, so "uniform" yields
 * square cells on both axes. */
export type LayoutGrid = {
  axis: 'column' | 'row' | 'uniform'
  count: number
  gutter: number
  margin: number
  color: string
  visible: boolean
  opacity: number
}
export const defaultLayoutGrid = (): LayoutGrid => ({
  axis: 'column',
  count: 12,
  gutter: 20,
  margin: 0,
  color: '#ff0000',
  visible: true,
  opacity: 0.1,
})
export const defaultLayout = (): AutoLayout => ({
  mode: 'horizontal',
  gap: 12,
  lineGap: 12,
  padding: [16, 16, 16, 16],
  wrap: false,
  justify: 'start',
  align: 'start',
  columns: 3,
  fillRows: false,
})
export const defaultSizing = (): Sizing => ({
  width: 'fixed',
  height: 'fixed',
  minWidth: 0.01,
  minHeight: 0.01,
  maxWidth: 1e7,
  maxHeight: 1e7,
  absolute: false,
  alignSelf: null,
  columnSpan: 1,
  rowSpan: 1,
})
export type EllipseArc = { startAngle: number; sweepAngle: number; innerRadius: number }
export type CurveCommand = {move:[number,number]}|{line:[number,number]}|{quad:[number,number,number,number]}|{cubic:[number,number,number,number,number,number]}|'close'
export type VectorGeometry = {fillRule:'evenodd'|'nonzero';fill:CurveCommand[];stroke?:CurveCommand[]}
export type ExportSetting = { id: string; format: 'png' | 'svg' | 'jpeg' | 'jpg' | 'webp' | 'pdf' | 'pdf-vector' | 'tiff' | 'eps'; scale: number; suffix: string }
export function exportSuffixHasForbiddenCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) || '\\/:*?"<>|'.includes(character)
  })
}
export type ConnectorEndpoint={point:Point;nodeId?:string;anchor?:Point}
export type DesignNode = {
  vectorGeometry?: VectorGeometry
  vectorBrush?: import('./vector-brush').VectorBrush
  guides?: RulerGuide[]
  textPath?: {network:Network;offset:number;normal:number;reverse:boolean}
  pathOffset?:number
  connector?: {from:ConnectorEndpoint;to:ConnectorEndpoint;style:'straight'|'elbow'}
  board?: {kind:string;rows?:number;columns?:number;language?:string}
  repeat?: RepeatTransform
  layoutGrid?: LayoutGrid

  exportSettings?: ExportSetting[]
  arc?: EllipseArc
  cornerRadius?: number
  constrainProportions?: boolean
  booleanOperation?: 'union' | 'subtract' | 'intersect' | 'exclude' | 'compoundNonzero' | 'compoundEvenodd'
  bindings?: Record<string, string>
  styleRefs?: Record<string, string>
  /** Local collection selections, inherited by descendants. Instance roots keep authored placement only. */
  variableModes?: Record<string, string>
  maskType?: 'alpha' | 'luminance' | 'outline' | 'shape'
  maskChain?: 'start' | 'break'
  id: string
  name: string
  kind: Kind
  transform: Matrix
  width: number
  height: number
  children: string[]
  visible: boolean
  locked: boolean
  opacity: number
  blend: NodeBlend
  fills: Paint[]
  strokes: Stroke[]
  effects: Effect[]
  radii: [number, number, number, number]
  smoothing: number
  clip: boolean
  mask: boolean
  points: number
  innerRadius: number
  network?: Network
  text: string
  fontSize: number
  textStyle?: TextStyle
  textRuns?: TextRun[]
  layout?: AutoLayout
  sizing?: Sizing
  constraints?: Constraints
  component?: { variants: Record<string, string>; properties: Record<string, ComponentProperty>; slots?: Record<string, { name: string; targetKey: string }> }
  componentSet?: boolean
  componentKey?: string
  instance?: ComponentInstance
  instanceOrigin?: { owner: string; key: string; source: string }
}
export type TextStyle = {
  verticalAlign?: 'top' | 'center' | 'bottom'
  textCase?: 'original' | 'upper' | 'lower'
  paragraphSpacing?: number
  paragraphIndent?: number
  fontId: string
  fallbacks: string[]
  weight: number
  lineHeight: number
  /** Sketch fixed line boxes use `nearest-point`. Omitted keeps unrounded half-leading. */
  lineBoxBaseline?: '' | 'nearest-point'
  /** Sketch text with no authored line box uses the font's own line metrics. */
  lineHeightAuto?: boolean
  letterSpacing: number
  wrap: boolean
  align: 'start' | 'center' | 'end' | 'justify'
  direction: 'auto' | 'ltr' | 'rtl'
  /** OpenType feature toggles in harfbuzz syntax ("-liga", "kern", "ss01"). */
  features?: string[]
  /** Variation axes beyond the reserved wght, e.g. [{tag:'wdth',value:75}]. */
  variations?: { tag: string; value: number }[]
  /** Vertical CJK writing (upright CJK, rotated Latin runs). */
  writingMode?: 'horizontal' | 'vertical'
}
export type TextParagraph = { align: 'start'|'center'|'end'|'justify'; minimumLineHeight: number; maximumLineHeight: number; spacing: number; indent: number }
export function validTextParagraph(p: TextParagraph): boolean {
  return !!p && ['start','center','end','justify'].includes(p.align)
    && [p.minimumLineHeight,p.maximumLineHeight,p.spacing].every(v=>Number.isFinite(v)&&v>=0&&v<=10000)
    && Number.isFinite(p.indent)&&Math.abs(p.indent)<=10000
    && (p.maximumLineHeight===0||p.maximumLineHeight>=p.minimumLineHeight)
}
export type TextRun = {
  paragraph?: TextParagraph
  textCase?: 'original' | 'upper' | 'lower'
  color?: string
  underline?: boolean
  strikethrough?: boolean
  link?: string
  start: number
  end: number
  fontId?: string
  fontSize?: number
  weight?: number
  /** Design pixels added after each cluster in the run. */
  letterSpacing?: number
  /** Multiplier of this run's font size. Overrides the node line-height floor on lines that use it. */
  lineHeight?: number
}
export const defaultTextStyle = (): TextStyle => ({
  fontId: 'default',
  fallbacks: [],
  weight: 400,
  lineHeight: 1.35,
  letterSpacing: 0,
  wrap: false,
  align: 'start',
  direction: 'auto',
})
export type ComponentProperty = {
  name: string
  kind: 'text' | 'boolean' | 'instance-swap'
  targetKey: string
  /** Other layers that receive the same property value. */
  alsoTargets?: string[]
  /** Kept from the file even though no layer reference was present. */
  unbound?: boolean
  defaultValue: string | boolean
}
export type ComponentInstance = {
  slotContents?: Record<string, string[]>
  componentId: string
  overrides: Record<string, Record<string, unknown>>
  propertyValues: Record<string, string | boolean>
}
export type Page = { id: string; name: string; children: string[]; background: string; guides?:RulerGuide[] }
export type LocalReview = {id:string;pageId:string;position:Point;nodeId?:string;kind:'comment'|'annotation';resolved:boolean;messages:{id:string;author:string;text:string;createdAt:number}[]}
export type DesignDocument = {
  fdCompatibility?: FdCompatibility | null
  reviews?: LocalReview[]
  designSystem?: import('./design-system').DesignSystem
  prototype?: import('./prototype').Prototype
  colorManagement?: ColorSettings
  rasterProfile?: 'analytic' | 'figma' | 'figmaSoftware'
  fonts?: Record<string, { family: string; data: string; index?: number; postscript?: string }>
  animations?: AnimationClip[]
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21
  id: string
  name: string
  pages: Page[]
  nodes: Record<string, DesignNode>
}
export const uid = () => crypto.randomUUID()
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0]
export const container = (n: DesignNode) => ['frame', 'section', 'group'].includes(n.kind)
export const maskChild = (doc: DesignDocument, n: DesignNode) =>
  n.booleanOperation
    ? undefined
    : n.children.map((id) => doc.nodes[id]).find((child) => child?.mask && child.visible)
export const paint = (color = '#818cf8', kind: Paint['kind'] = 'solid'): Paint => ({
  id: uid(),
  kind,
  color,
  opacity: 1,
  visible: true,
  angle: 90,
  stops: [
    { offset: 0, color },
    { offset: 1, color: '#f5b8dc' },
  ],
  fit: 'cover',
  blend: 'normal',
})
export const stroke = (color = '#303344', width = 2): Stroke => ({
  id: uid(),
  paint: paint(color),
  width,
  align: 'center',
  cap: 'round',
  join: 'round',
  dash: '',
  visible: true,
})
export const effect = (kind: Effect['kind']): Effect => ({
  id: uid(),
  kind,
  visible: true,
  radius: kind === 'glass' ? 12 : kind === 'texture' ? 2 : 8,
  x: 0,
  y: kind === 'shadow' ? 8 : 0,
  spread: 0,
  color: '#172033',
  opacity: kind === 'noise' ? 0.2 : kind === 'glass' ? 0.5 : 0.25,
  amount: kind === 'glass' ? 14 : kind === 'texture' ? 3 : 0.65,
  ...(kind === 'zoom-blur' ? {zoomBlur:{amount:10,center:[0.5,0.5] as [number,number]},radius:0,amount:0,opacity:1} : {}),
  ...(kind === 'motion-blur' ? {motionAngle:0} : {}),
  ...(kind === 'color-controls' ? { colorControls: defaultColorControls(), radius: 0, amount: 0, opacity: 1 } : {}),
  ...(kind === 'glass'
    ? { glass: { depth: 8, refraction: 0.5, dispersion: 0.3, lightAngle: 45, lightIntensity: 0.5 } }
    : {}),
  ...(kind === 'texture'
    ? { texture: { noiseSize: [8, 8] as [number, number], clipToShape: true } }
    : {}),
})
const names: Record<Kind, string> = {
  slice: '切片',
  frame: '画板',
  section: '分区',
  group: '编组',
  rectangle: '矩形',
  ellipse: '椭圆',
  polygon: '多边形',
  star: '星形',
  line: '直线',
  vector: '矢量',
  text: '文字',
}
export function node(kind: Kind, x = 0, y = 0, width = 160, height = 120): DesignNode {
  return {
    id: uid(),
    kind,
    name: names[kind],
    transform: [1, 0, 0, 1, x, y],
    width,
    height,
    children: [],
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal',
    fills:
      kind === 'slice' || kind === 'line' || kind === 'vector' || kind === 'group'
        ? []
        : [paint(kind === 'frame' ? '#ffffff' : kind === 'section' ? '#e7e8ef' : '#818cf8')],
    strokes: kind === 'line' || kind === 'vector' ? [stroke()] : [],
    effects: [],
    radii: [0, 0, 0, 0],
    smoothing: 0,
    clip: kind === 'frame',
    mask: false,
    points: kind === 'star' ? 5 : 3,
    innerRadius: 0.45,
    text: '双击编辑文字',
    fontSize: 28,
  }
}
export function blank(name = '未命名设计'): DesignDocument {
  return {
    schemaVersion: 2,
    rasterProfile: 'analytic',
    id: uid(),
    name,
    pages: [{ id: uid(), name: '页面 1', children: [], background: '#f5f5f5' }],
    nodes: {},
  }
}
export function demo(): DesignDocument {
  const d = blank('futureox-desgin · 探索画布')
  d.schemaVersion = 5
  const p = d.pages[0]
  p.name = '探索画布'
  const add = (n: DesignNode, parent?: DesignNode) => {
    d.nodes[n.id] = n
    ;(parent ? parent.children : p.children).push(n.id)
    return n
  }
  const section = add(node('section', 40, 35, 1150, 720))
  section.name = '01 / 视觉探索'
  section.fills = [paint('#e4e6ed')]
  section.radii = [24, 24, 24, 24]
  const board = add(node('frame', 30, 45, 700, 570), section)
  board.name = 'futureox-desgin / 工作空间'
  board.radii = [22, 22, 22, 22]
  board.effects = [effect('shadow')]
  const title = add(node('text', 45, 40, 540, 65), board)
  title.text = '让想法，自由生长。'
  title.fontSize = 38
  title.fills = [paint('#222438')]
  const sub = add(node('text', 47, 110, 570, 38), board)
  sub.text = '在无限画布上，构建属于你的下一种可能。'
  sub.fontSize = 16
  sub.fills = [paint('#828595')]
  const card = add(node('rectangle', 42, 180, 610, 245), board)
  card.radii = [22, 22, 22, 22]
  card.fills = [paint('#8073dd', 'linear')]
  card.fills[0].stops = [
    { offset: 0, color: '#666fda' },
    { offset: 0.6, color: '#a098e7' },
    { offset: 1, color: '#efc0d7' },
  ]
  const ball = add(node('ellipse', 320, 215, 180, 180), board)
  ball.fills = [paint('#ffcfae', 'radial')]
  ball.fills[0].stops = [
    { offset: 0, color: '#fff1d9' },
    { offset: 1, color: '#ed99b0' },
  ]
  const star = add(node('star', 120, 245, 125, 125), board)
  star.fills = [paint('#fff7e0')]
  star.transform = [0.96, 0.28, -0.28, 0.96, 120, 245]
  star.innerRadius = 0.65
  const glass = add(node('rectangle', 380, 290, 235, 100), board)
  glass.radii = [18, 18, 18, 18]
  glass.fills = [{ ...paint('#ffffff'), opacity: 0.14 }]
  glass.effects = [effect('glass')]
  glass.strokes = [{ ...stroke('#ffffff', 1), paint: { ...paint('#ffffff'), opacity: 0.5 } }]
  const caption = add(node('text', 410, 323, 180, 42), board)
  caption.text = 'Ideas in motion'
  caption.fontSize = 20
  caption.fills = [paint('#ffffff')]
  const foot = add(node('text', 45, 472, 550, 40), board)
  foot.text = '设计 · 编辑 · 创造'
  foot.fontSize = 18
  foot.fills = [paint('#686d85')]
  const small = add(node('frame', 760, 45, 355, 570), section)
  small.name = '色彩与材质'
  small.radii = [22, 22, 22, 22]
  small.fills = [paint('#faf9f5')]
  const st = add(node('text', 30, 35, 300, 50), small)
  st.text = '随心组合'
  st.fontSize = 27
  st.fills = [paint('#282b3d')]
  ;['#c8c0ee', '#f3ccac', '#b5d2cc'].forEach((c, i) => {
    const a = add(node('rectangle', 30 + i * 101, 110, 90, 110), small)
    a.radii = [16, 16, 16, 16]
    a.fills = [paint(c)]
  })
  const texture = add(node('rectangle', 30, 250, 293, 220), small)
  texture.radii = [20, 20, 20, 20]
  texture.fills = [paint('#cfbca5', 'linear')]
  texture.effects = [{ ...effect('noise'), opacity: 0.18, amount: 0.75 }]
  const hint = add(node('text', 48, 335, 250, 70), small)
  hint.text = 'Make space\nfor something new.'
  hint.fontSize = 24
  hint.fills = [paint('#4b4139')]
  return d
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const wellFormed = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}
export function copyName(name: string, suffix: string) {
  let result = ''
  for (const character of name) {
    if (result.length + character.length + suffix.length > 200) break
    result += character
  }
  return result + suffix
}
/** Empty node maps are legacy-compatible; an explicit override (even {}) has semantics. */
export function hasLocalTools(d:DesignDocument){return !!d.reviews?.length || Object.values(d.nodes).some(n=>!!n.board||!!n.connector||!!n.textPath||!!n.pathOffset||n.kind==='slice'||n.network?.filledFaces!==undefined||n.exportSettings?.some(s=>!['png','svg'].includes(s.format)))}
export function hasRulerGuides(d:DesignDocument){return d.pages.some(p=>!!p.guides?.length)||Object.values(d.nodes).some(n=>!!n.guides?.length)}
/** Schema-12 authored layout grids (Sketch grid/layout dicts, Figma layoutGrids). */
export function hasLayoutGrids(d: Pick<DesignDocument, 'nodes'>): boolean {
  return Object.values(d.nodes).some(n => n?.layoutGrid != null)
}
export function hasGradientBlur(d: Pick<DesignDocument,'nodes'|'animations'|'designSystem'>): boolean {
  return Object.values(d.nodes).some(n => n.effects.some(e => e.gradientBlur) || Object.values(n.instance?.overrides || {}).some(o => Array.isArray(o.effects) && o.effects.some((e: Effect)=>e.gradientBlur))) || !!d.animations?.some(c=>c.tracks.some(t=>t.keyframes.some(k=>k.value.effects.some(e=>e.gradientBlur)))) || Object.values(d.designSystem?.styles || {}).some(s=>s.kind==='effect' && Array.isArray(s.value) && s.value.some(e=>e.gradientBlur))
}
export function hasLocalVariableModes(d: Pick<DesignDocument, 'nodes'>): boolean {
  return Object.values(d.nodes).some(
    (n) =>
      Object.keys(n.variableModes || {}).length > 0 ||
      Object.values(n.instance?.overrides || {}).some(
        (fields) => isObject(fields) && Object.hasOwn(fields, 'variableModes'),
      ),
  )
}
/** Validate before resolution as well as on save, including preview fast paths. */
/** Schema-13 authored image adjustments (Figma imageColorAdjust). */
export function hasImageAdjusts(d: Pick<DesignDocument,'nodes'|'animations'|'designSystem'>): boolean {
  const adjusted = (paints: unknown) =>
    Array.isArray(paints) && paints.some((p: Paint) => p?.kind === 'image' && p.adjust != null)
  return Object.values(d.nodes).some(
      (n) =>
        adjusted(n?.fills) ||
        adjusted(n?.strokes?.map((s: Stroke) => s?.paint)) ||
        Object.values(n?.instance?.overrides || {}).some(
          (fields) => isObject(fields) && (adjusted(fields.fills) || adjusted(fields.strokes)),
        ),
    ) ||
    !!d.animations?.some(c => c.tracks.some(t => t.keyframes.some(k => adjusted(k.value.fills) || adjusted(k.value.strokes.map((s: Stroke) => s.paint))))) ||
    Object.values(d.designSystem?.styles || {}).some(s => s.kind === 'paint' && Array.isArray(s.value) && adjusted(s.value))
}
/** Schema-14 authored pattern tiling (pattern fill). */
export function hasPatternTiles(d: Pick<DesignDocument,'nodes'|'animations'|'designSystem'>): boolean {
  const tiled = (paints: unknown) =>
    Array.isArray(paints) && paints.some((p: Paint) => p?.kind === 'image' && p.tile != null)
  return Object.values(d.nodes).some(
      (n) =>
        tiled(n?.fills) ||
        tiled(n?.strokes?.map((s: Stroke) => s?.paint)) ||
        Object.values(n?.instance?.overrides || {}).some(
          (fields) => isObject(fields) && (tiled(fields.fills) || tiled(fields.strokes)),
        ),
    ) ||
    !!d.animations?.some(c => c.tracks.some(t => t.keyframes.some(k => tiled(k.value.fills) || tiled(k.value.strokes.map((s: Stroke) => s.paint))))) ||
    Object.values(d.designSystem?.styles || {}).some(s => s.kind === 'paint' && Array.isArray(s.value) && tiled(s.value))
}
export function validateVariableModes(d: DesignDocument) {
  validateNodeVariableModes(d, Object.values(d.nodes))
}
function validateNodeVariableModes(d: DesignDocument, nodes: DesignNode[]) {
  if (d.schemaVersion < 6 && hasLocalVariableModes(d))
    throw new Error('局部变量模式需要设计文件版本 6')
  const validateModes = (modes: unknown) => {
    if (
      !isObject(modes) ||
      Object.keys(modes).length > 128 ||
      Object.entries(modes).some(([id, mode]) => {
        const collection = d.designSystem?.collections?.[id]
        return (
          typeof mode !== 'string' ||
          !Object.hasOwn(d.designSystem?.collections || {}, id) ||
          !Array.isArray(collection?.modes) ||
          !collection.modes.includes(mode)
        )
      })
    )
      throw new Error('局部变量模式或集合无效')
  }
  for (const n of nodes) {
    if (n?.variableModes !== undefined) validateModes(n.variableModes)
    if (n?.instance?.overrides) for (const fields of Object.values(n.instance.overrides)) {
      if (!isObject(fields)) throw new Error('实例覆盖数据无效')
      if (Object.hasOwn(fields, 'variableModes')) {
        if (!d.designSystem) throw new Error('局部变量模式覆盖需要设计系统')
        validateModes(fields.variableModes)
      }
    }
  }
}
/** Local numeric contract shared by full admission and immutable transform edits. */
export function validNodeTransform(value: unknown): value is Matrix {
  if (!Array.isArray(value) || value.length !== 6) return false
  for (let i = 0; i < 6; i++) {
    const v = value[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) return false
  }
  return Math.abs(value[0] * value[3] - value[1] * value[2]) >= 1e-9
}

// Dense local wire IDs are common in imported paths. Reuse their immutable
// alphabet only after checking every actual ID in order. Arbitrary IDs retain
// exact Set membership, including duplicate detection.
function networkIndex(prefix: string) {
  const ids = Array.from({ length: 256 }, (_, i) => prefix + i)
  return { ids, positions: new Map(ids.map((id, i) => [id, i])) }
}
const vertexIndex = networkIndex('v'), edgeIndex = networkIndex('e'), numericIndex = networkIndex('')

function networkIdDomain(rows: { id: string }[], index: ReturnType<typeof networkIndex>) {
  const table = rows[0]?.id === '0' ? numericIndex : index
  const size = rows.length
  let indexed = size <= table.ids.length
  for (let i = 0; indexed && i < size; i++) indexed = rows[i]?.id === table.ids[i]
  if (indexed) return { size, has: (id: string) => (table.positions.get(id) ?? Infinity) < size }
  return new Set(rows.map(row => row.id))
}
/** Page-scoped admission of an already valid document. Cold pages are not rechecked. */
export type DocumentValidationScope = { pageId: string; ids: readonly string[] }
export function validateDocument(value: unknown, scope?: DocumentValidationScope): DesignDocument {
  if (
    !isObject(value) ||
    ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].includes(value.schemaVersion as number) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.pages) ||
    !isObject(value.nodes)
  )
    throw new Error('无效的设计文件或不支持的格式版本')
  validateFdCompatibility(value.fdCompatibility)
  const d = value as unknown as DesignDocument
  // Reuse one local enumeration while retaining every validation below.
  // This is not a cached validity certificate for mutable document objects.
  // A page scope validates the edited nodes only. The caller has already proved
  // the previous snapshot and that this edit did not retarget cold pages.
  const entries = scope
    ? scope.ids.filter(id => d.nodes[id]).map(id => [id, d.nodes[id]] as [string, DesignNode])
    : Object.entries(d.nodes)
  const nodes = entries.map(([, node]) => node)
  const featureDoc = scope ? { ...d, nodes: Object.fromEntries(entries) } as DesignDocument : d
  const nodeIds=entries.map(([id])=>id)
  let guideCount=0
  const validateGuides=(guides:unknown,frame=true)=>{
    if(guides===undefined)return
    if(!Array.isArray(guides)||guides.length>1000||(guides.length&&(d.schemaVersion<11||!frame)))throw new Error('参考线需要版本11，且只能属于页面/画板/分区')
    const ids=new Set<string>()
    for(const g of guides){if(!isObject(g)||typeof g.id!=='string'||!g.id||g.id.length>128||ids.has(g.id)||!['x','y'].includes(String(g.axis))||typeof g.position!=='number'||!Number.isFinite(g.position)||Math.abs(g.position)>1e7||Object.keys(g).some(k=>!['id','axis','position'].includes(k)))throw new Error('无效参考线');ids.add(g.id)}
    guideCount+=guides.length;if(guideCount>20000)throw new Error('参考线数量超限')
  }
  for(const page of d.pages)validateGuides(page?.guides)
  if (d.rasterProfile !== undefined && !['analytic', 'figma', 'figmaSoftware'].includes(d.rasterProfile))
    throw new Error('未知的文档渲染模式')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuid.test(d.id) || !d.name.trim() || d.name.length > 200 || !wellFormed(d.name))
    throw new Error('文档标识或名称无效')
  if(d.reviews!==undefined){
    if(!Array.isArray(d.reviews)||d.reviews.length>2000||(d.reviews.length&&d.schemaVersion<10))throw new Error('本地评论需要版本10')
    const ids=new Set<string>()
    for(const r of d.reviews){
      if(!r||typeof r.id!=='string'||!r.id||r.id.length>128||ids.has(r.id)||!r.position||![r.position.x,r.position.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1e7)||!d.pages.some(p=>p.id===r.pageId)||(r.nodeId!==undefined&&!d.nodes[r.nodeId])||!['comment','annotation'].includes(r.kind)||typeof r.resolved!=='boolean'||!Array.isArray(r.messages)||!r.messages.length||r.messages.length>1000)throw new Error('本地评论无效')
      ids.add(r.id)
      for(const m of r.messages){if(!m||typeof m.id!=='string'||!m.id||m.id.length>128||ids.has(m.id)||typeof m.author!=='string'||!m.author||m.author.length>200||typeof m.text!=='string'||!m.text.trim()||m.text.length>10000||!Number.isSafeInteger(m.createdAt)||m.createdAt<0)throw new Error('本地评论消息无效');ids.add(m.id)}
    }
  }
  if(d.schemaVersion<10&&hasLocalTools(featureDoc))throw new Error('本地扩展工具需要设计文件版本10')
  validateNodeVariableModes(featureDoc, nodes)
  if (d.schemaVersion < 9 && hasGradientBlur(featureDoc)) throw new Error('渐变模糊需要设计文件版本 9')
  if (d.schemaVersion < 13 && hasImageAdjusts(featureDoc)) throw new Error('图片调整需要设计文件版本 13')
  if (d.schemaVersion < 14 && hasPatternTiles(featureDoc)) throw new Error('图案平铺需要设计文件版本 14')
  if (d.schemaVersion < 20 && hasSchema20Features(featureDoc, nodes)) throw new Error('段落和文本垂直对齐需要设计文件版本 20')
  if (d.schemaVersion < 19) {
    const unsupported = findDocumentEffect(d, nodes, e => usesZoomBlur(e) ||
      (d.schemaVersion < 18 && usesSpatialBlur(e)) || (d.schemaVersion < 17 && usesColorControls(e)))
    if (unsupported) {
      if (usesZoomBlur(unsupported)) throw new Error('缩放模糊需要设计文件版本 19')
      if (usesSpatialBlur(unsupported) && d.schemaVersion < 18) throw new Error('高斯与运动模糊需要设计文件版本 18')
      throw new Error('颜色调整需要设计文件版本 17')
    }
  }
  if (d.schemaVersion < 15 && hasSchema15Features(featureDoc)) throw new Error('此设计功能需要设计文件版本 15')
  if (d.schemaVersion < 8 && (hasStrokeMarkers(featureDoc) || hasLayerExports(featureDoc))) throw new Error('描边端点需要设计文件版本 8')
  if (d.schemaVersion < 21 && hasSchema21Features(featureDoc)) throw new Error('片段字距或行高需要设计文件版本 21')
  // Mirror scene::Document::validate and animation::validate schema gates.
  // This pre-initialization boundary is not a replacement for full Rust validation.
  for (const events of Object.values(d.prototype?.interactions || {})) for (const event of events) {
    if (hasLogic(event.actions) && d.schemaVersion < 15) throw new Error('Prototype logic requires schema 15')
    validateLogicActions(d, event.actions)
  }
  if (d.schemaVersion < 4 && (d.designSystem != null || d.prototype != null))
    throw new Error('设计系统和原型需要设计文件版本 4')
  const hasMaterialParameters = (effects: unknown) =>
    Array.isArray(effects) && effects.some((e) => isObject(e) && (e.glass != null || e.texture != null))
  if (d.schemaVersion < 5 && (
    Object.values(d.designSystem?.styles || {}).some((s) => s?.kind === 'effect' && hasMaterialParameters(s.value)) ||
    (Array.isArray(d.animations) && d.animations.some((c) =>
      Array.isArray(c?.tracks) && c.tracks.some((t) =>
        Array.isArray(t?.keyframes) && t.keyframes.some((k) => hasMaterialParameters(k?.value?.effects)))))
  )) throw new Error('材质参数需要设计文件版本 5')
  if (
    d.fonts !== undefined &&
    (!isObject(d.fonts) ||
      Object.keys(d.fonts).length > 32 ||
      Object.entries(d.fonts).some(
        ([id, font]) =>
          id === 'default' ||
          !id ||
          new TextEncoder().encode(id).length > 128 ||
          !wellFormed(id) ||
          !isObject(font) ||
          typeof font.family !== 'string' ||
          !font.family.trim() ||
          font.family.length > 200 ||
          !wellFormed(font.family) ||
          typeof font.data !== 'string' ||
          font.data.length > 28 * 1024 * 1024 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(font.data),
      ))
  )
    throw new Error('字体资源无效或超过限制')
  assertDocumentStructure(scope ? Math.max(entries.length, 1) : entries.length, d.pages.length)
  const seen = new Set<string>()
  if (
    d.colorManagement !== undefined &&
    (d.schemaVersion < 3 ||
      d.rasterProfile === 'analytic' ||
      !validColorSettings(d.colorManagement))
  )
    throw new Error('广色域/HDR 配置无效，或文件版本不支持')
  // Imported palettes repeat across fills, stops and strokes. Only immutable
  // color strings share a positive result, within this document's color mode.
  const managed = !!d.colorManagement, knownColors = new Set<string>()
  const color = { test: (value: unknown) => {
    if (typeof value !== 'string') return false
    if (knownColors.has(value)) return true
    if (!validColor(value, managed)) return false
    if (knownColors.size < 1024) knownColors.add(value)
    return true
  } }
  const finite = (n: unknown, min = -1e7, max = 1e7) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
  const validAdjust = (a: unknown) =>
    isObject(a) &&
    Object.keys(a).every((k) =>
      ['exposure', 'contrast', 'temperature', 'tint', 'highlights', 'shadows', 'color', 'highlightShadowThreshold'].includes(k),
    ) &&
    ['exposure', 'contrast', 'temperature', 'tint', 'highlights', 'shadows', 'color'].every(
      (k) => a[k] === undefined || finite(a[k], -1, 1),
    ) &&
    (a.highlightShadowThreshold === undefined || finite(a.highlightShadowThreshold, 0, 1))
  const validTile = (t: unknown) =>
    isObject(t) &&
    Object.keys(t).every((k) => ['mode', 'size', 'offset', 'alignment', 'scale', 'rotation', 'spacing'].includes(k)) &&
    ['mode', 'size', 'offset'].every((k) => Object.hasOwn(t, k)) &&
    ['none', 'grid', 'stagger_horizontal', 'stagger_vertical'].includes(t.mode as string) &&
    Array.isArray(t.size) && t.size.length === 2 &&
    Array.isArray(t.offset) && t.offset.length === 2 &&
    (t.size as unknown[]).every((v) => finite(v, 0)) &&
    (t.offset as unknown[]).every((v) => finite(v)) &&
    (t.alignment === undefined || (Array.isArray(t.alignment) && t.alignment.length === 2 &&
      t.alignment.every(value => ['start','center','end'].includes(value)))) &&
    (t.scale === undefined || finite(t.scale, Number.MIN_VALUE, 1e6)) &&
    (t.rotation === undefined || finite(t.rotation, -1e6, 1e6)) &&
    (t.spacing === undefined || (Array.isArray(t.spacing) && t.spacing.length === 2 && t.spacing.every(value => finite(value, 0, 1e7))))
  const validPaint = (p: Paint) =>
    p &&
    ['solid', 'linear', 'radial', 'image', 'angular', 'diamond'].includes(p.kind) &&
    color.test(p.color) &&
    blendModes.includes(p.blend ?? 'normal') &&
    finite(p.opacity, 0, 1) &&
    finite(p.angle) &&
    (p.fit === undefined || ['cover', 'contain', 'stretch'].includes(p.fit)) &&
    (p.adjust === undefined || (p.kind === 'image' && validAdjust(p.adjust))) &&
    (p.tile === undefined || (p.kind === 'image' && validTile(p.tile))) &&
    (p.transform == null || (
      Array.isArray(p.transform) && p.transform.length === 6 &&
      p.transform.every((v) => finite(v)) &&
      Math.abs(p.transform[0] * p.transform[3] - p.transform[1] * p.transform[2]) >= 1e-12
    )) &&
    Array.isArray(p.stops) &&
    (!['linear', 'radial', 'angular', 'diamond'].includes(p.kind) || p.stops.length >= 2) &&
    p.stops.length <= MAX_GRADIENT_STOPS &&
    p.stops.every((s) => finite(s.offset, 0, 1) && color.test(s.color)) &&
    (!p.image || !!sourceBitmap(p.image) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image))
  const paints = (list: Paint[]) => Array.isArray(list) && list.length <= 16 && list.every(validPaint)
  const defaultStyle = defaultTextStyle()
  let segmenter: Intl.Segmenter | undefined
  function validateText(n: DesignNode) {
    const style = n?.textStyle === undefined ? defaultStyle : { ...defaultStyle, ...n.textStyle }
    const cases = [style.textCase, ...(n.textRuns || []).map(r => r.textCase)]
    if (cases.some(c => c !== undefined && !['original','upper','lower'].includes(c))) throw Error('文字大小写属性无效')
    if (d.schemaVersion < 15 && (cases.some(c => c !== undefined && c !== 'original') || n.textRuns?.some(r=>r.textCase !== undefined))) throw Error('文字显示大小写需要设计文件版本 15')
    if (
      n?.textStyle !== undefined &&
      (!isObject(n.textStyle) ||
        !finite(style.weight, 1, 1000) ||
        !finite(style.lineHeight, 0.1, 10) ||
        !finite(style.letterSpacing, -1000, 1000) ||
        typeof style.wrap !== 'boolean' ||
        !['start', 'center', 'end', 'justify'].includes(style.align) ||
        !['top','center','bottom'].includes(style.verticalAlign ?? 'top') ||
        !['auto', 'ltr', 'rtl'].includes(style.direction) ||
        !Array.isArray(style.fallbacks) ||
        style.fallbacks.length > 16 ||
        [style.fontId, ...style.fallbacks].some(
          (id) =>
            typeof id !== 'string' ||
            (id !== 'default' && (!d.fonts || !Object.hasOwn(d.fonts, id))),
        ))
    )
      throw new Error('文字样式或字体引用无效')
    if (n?.textRuns !== undefined) {
      if (!Array.isArray(n.textRuns) || n.textRuns.length > 4096 || typeof n.text !== 'string')
        throw new Error('文字样式区间无效')
      const boundaries = new Set([0, n.text.length])
      if (n.textRuns.length) {
        segmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
        for (const part of segmenter.segment(n.text)) boundaries.add(part.index)
      }
      let end = 0
      for (const run of n.textRuns) {
        if (
          !isObject(run) ||
          !boundaries.has(run.start) ||
          !boundaries.has(run.end) ||
          run.start < end ||
          (run.paragraph !== undefined && !validTextParagraph(run.paragraph)) ||
          run.start >= run.end ||
          (run.fontSize !== undefined && !finite(run.fontSize, 1, 4096)) ||
          (run.weight !== undefined && !finite(run.weight, 1, 1000)) ||
          (run.letterSpacing !== undefined && !finite(run.letterSpacing, -1000, 1000)) ||
          (run.lineHeight !== undefined && !finite(run.lineHeight, 0.1, 10)) ||
          (run.fontId !== undefined &&
            run.fontId !== 'default' &&
            (!d.fonts || !Object.hasOwn(d.fonts, run.fontId)))
        )
          throw new Error('文字样式区间必须位于完整字素边界')
        end = run.end
      }
    }
  }
  const constraintModes = ['start', 'center', 'end', 'stretch', 'scale']
  let hasRepeat = false
  for (let index = 0; index < nodes.length; index++) {
    const id = nodeIds[index], n = nodes[index]
    if (n.guides !== undefined) validateGuides(n.guides, n.kind === 'frame' || n.kind === 'section')
    if (n.kind === 'slice' && (d.schemaVersion < 10 || n.fills.length || n.strokes.length || n.effects.length || n.children.length || n.network || n.mask))
      throw new Error('切片需要版本10，且不能包含绘制内容')
    if (n.pathOffset !== undefined && (!Number.isFinite(n.pathOffset) || Math.abs(n.pathOffset) > 10000 ||
        (n.pathOffset !== 0 && (d.schemaVersion < 10 || ['text', 'frame', 'section', 'group', 'slice'].includes(n.kind)))))
      throw new Error('路径偏移数据无效')
    if (n.vectorBrush !== undefined) validateVectorBrush(n)
    if (n.repeat !== undefined) {
      hasRepeat = true
      if (d.schemaVersion < 15) throw Error('重复变换需要版本 15')
      validateRepeat(n.repeat)
    }
    // Layout grids mirror scene.rs: schema-12 frames only, finite ranges
    // and a parseable color.
    if (n?.layoutGrid !== undefined) {
      const g = { ...defaultLayoutGrid(), ...n.layoutGrid }
      if (
        d.schemaVersion < 12 ||
        n.kind !== 'frame' ||
        !['column', 'row', 'uniform'].includes(g.axis) ||
        !Number.isInteger(g.count) ||
        !(g.count >= 1 && g.count <= 64) ||
        !finite(g.gutter, 0) ||
        !finite(g.margin, 0) ||
        !finite(g.opacity, 0, 1) ||
        typeof g.visible !== 'boolean' ||
        !color.test(g.color)
      )
        throw new Error('布局网格需要版本12，且只能属于画板')
    }
    if (n?.exportSettings !== undefined) {
      const settings = n.exportSettings
      if (!Array.isArray(settings) || settings.length > 16 || new Set(settings.map(s => s?.id)).size !== settings.length || settings.some(s =>
        !s || typeof s.id !== 'string' || !s.id || !wellFormed(s.id) || new TextEncoder().encode(s.id).length > 128 || !['png','svg','jpeg','jpg','webp','pdf','pdf-vector','tiff','eps'].includes(s.format) ||
        !finite(s.scale,0,128) || typeof s.suffix !== 'string' || !wellFormed(s.suffix) || s.suffix.length>80 || exportSuffixHasForbiddenCharacters(s.suffix))) throw new Error('图层导出设置无效')
      if(settings.length && d.schemaVersion<8) throw new Error('图层导出设置需要设计文件版本 8')
    }
    if (d.schemaVersion < 7 && (n?.arc != null || (n?.cornerRadius ?? 0) !== 0 || n?.constrainProportions))
      throw new Error('参数化图形和比例锁定需要设计文件版本 7')
    if (n?.constrainProportions !== undefined && typeof n.constrainProportions !== 'boolean')
      throw new Error('比例锁定属性无效')
    if (!finite(n?.cornerRadius ?? 0, 0) || ((n?.cornerRadius ?? 0) !== 0 && (!['polygon', 'star'].includes(n.kind) || n.network != null)))
      throw new Error('多边形圆角无效')
    if (n?.arc != null && (!isObject(n.arc) || n.kind !== 'ellipse' || n.network != null ||
      !finite(n.arc.startAngle) || !finite(n.arc.sweepAngle, -Math.PI * 2, Math.PI * 2) ||
      !finite(n.arc.innerRadius, 0, 1) || Object.keys(n.arc).some(k => !['startAngle', 'sweepAngle', 'innerRadius'].includes(k))))
      throw new Error('椭圆圆弧参数无效')
    // Match the kernel's Option<String>: omitted/null is the legacy default;
    // either explicit mask mode is extended authoring and requires schema 4.
    if (n?.maskChain != null && (d.schemaVersion < 4 || !['start', 'break'].includes(n.maskChain)))
      throw new Error('蒙版链无效或文档版本低于 4')
    if (n?.maskType != null) {
      if (!['alpha', 'luminance', 'outline', 'shape'].includes(n.maskType)) throw new Error('蒙版类型无效')
      if (d.schemaVersion < 4) throw new Error('显式蒙版类型需要设计文件版本 4')
    }
    // Node::requires_schema4 applies even to currently invisible/inactive content.
    const extendedPaint = (p: Paint) => p && (p.transform != null || p.kind === 'angular' || p.kind === 'diamond')
    if (d.schemaVersion < 4 && (
      n?.booleanOperation != null || Object.keys(n?.bindings || {}).length > 0 || Object.keys(n?.styleRefs || {}).length > 0 ||
      (Array.isArray(n?.textRuns) && n.textRuns.some((r) => r && (r.color != null || r.link != null || r.underline === true || r.strikethrough === true))) ||
      (n?.textStyle && ((n.textStyle.paragraphSpacing ?? 0) !== 0 || (n.textStyle.paragraphIndent ?? 0) !== 0 || n.textStyle.align === 'justify')) ||
      (Array.isArray(n?.fills) && n.fills.some(extendedPaint)) ||
      (Array.isArray(n?.strokes) && n.strokes.some((s) => extendedPaint(s?.paint)))
    )) throw new Error('扩展编辑属性需要设计文件版本 4')
    if (d.schemaVersion < 5 && hasMaterialParameters(n?.effects))
      throw new Error('材质参数需要设计文件版本 5')
    if (n.textStyle !== undefined || n.textRuns !== undefined) validateText(n)
    if (
      !n ||
      n.id !== id ||
      !uuid.test(id) ||
      !Object.hasOwn(names, n.kind) ||
      !validNodeTransform(n.transform) ||
      // Import admission follows Rust's positive f64 extent contract. UI
      // resize minimums must not reject thin source groups/components.
      !finite(n.width, Number.MIN_VALUE) ||
      !finite(n.height, Number.MIN_VALUE) ||
      !Array.isArray(n.children) ||
      (!container(n) && !n.booleanOperation && n.children.length) ||
      !paints(n.fills) ||
      !Array.isArray(n.strokes) ||
      n.strokes.length > 16 ||
      !n.strokes.every((s) => validStroke(s) && validPaint(s.paint)) ||
      !validProfiles(n) ||
      !Array.isArray(n.effects) ||
      n.effects.length > 16 ||
      !n.effects.every(
        (e) =>
          [
            'shadow',
            'inner-shadow',
            'blur',
            'background-blur',
            'glass',
            'noise',
            'texture',
            'color-controls',
            'gaussian-blur',
            'motion-blur', 'zoom-blur',
          ].includes(e.kind) &&
          (e.showShadowBehindNode === undefined || typeof e.showShadowBehindNode === 'boolean') &&
          (e.zoomBlur == null ? e.kind!=='zoom-blur' : (e.kind==='zoom-blur' && validZoomBlur(e.zoomBlur) && e.radius===0 && !e.colorControls && !e.glass && !e.texture && !e.gradientBlur)) &&
          (e.motionAngle === undefined || (finite(e.motionAngle,-1e7,1e7) && (e.kind==='motion-blur'||e.motionAngle===0))) &&
          (e.kind !== 'color-controls' || e.colorControls != null) &&
          (e.colorControls == null || (d.schemaVersion >= 17 && (['color-controls','background-blur'].includes(e.kind) || e.kind==='glass' && !!e.glass) && validColorControls(e.colorControls) && !e.texture && !e.gradientBlur)) &&
          finite(e.radius, 0, 1000) &&
          [e.x, e.y, e.spread, e.amount].every((v) => finite(v)) &&
          finite(e.opacity, 0, 1) &&
          (!e.gradientBlur || (e.kind === 'blur' && !e.glass && !e.texture &&
            [e.gradientBlur.start,e.gradientBlur.end].every(a=>Array.isArray(a)&&a.length===2&&a.every(v=>finite(v,-1e7,1e7))) &&
            [e.gradientBlur.startCount,e.gradientBlur.endCount].every(v=>finite(v,0,64)) && typeof e.gradientBlur.smooth==='boolean')) &&
          (!e.glass ||
            (e.kind === 'glass' &&
              !e.texture &&
              finite(e.glass.depth, 1, 1000) &&
              (e.glass.bevelSize === undefined || finite(e.glass.bevelSize, 0.001, 1000)) &&
              finite(e.glass.lightAngle, -1e7, 1e7) &&
              [e.glass.refraction, e.glass.dispersion, e.glass.lightIntensity].every((v) =>
                finite(v, 0, 1),
              ))) &&
          (!e.texture ||
            (e.kind === 'texture' &&
              !e.glass &&
              Array.isArray(e.texture.noiseSize) &&
              e.texture.noiseSize.length === 2 &&
              e.texture.noiseSize.every((v) => finite(v, 0.001, 10000)) &&
              typeof e.texture.clipToShape === 'boolean' &&
              (e.texture.noise === undefined || ['figma', 'gabor', 'perlin'].includes(e.texture.noise)))) &&
          color.test(e.color),
      ) ||
      !Array.isArray(n.radii) ||
      n.radii.length !== 4 ||
      !n.radii.every((v) => finite(v, 0)) ||
      !finite(n.smoothing, 0, 1) ||
      !finite(n.opacity, 0, 1) ||
      (n.blend !== 'pass-through' && !blendModes.includes(n.blend ?? 'normal')) ||
      !finite(n.points, n.kind === 'polygon' || n.kind === 'star' ? 3 : 0, 128) ||
      !finite(n.innerRadius, n.kind === 'star' ? 0.01 : 0, 1) ||
      typeof n.name !== 'string' ||
      !wellFormed(n.name) ||
      typeof n.text !== 'string' ||
      !wellFormed(n.text) ||
      n.text.length > 100000 ||
      !finite(n.fontSize, 1, 4096)
    )
      throw new Error(`图层数据无效：${id}`)
    if (n.layout !== undefined) {
      if (!isObject(n.layout) || !container(n)) throw new Error('自动布局只能应用于容器')
      const l = { ...defaultLayout(), ...n.layout }
      if (
        !['none', 'horizontal', 'vertical', 'grid'].includes(l.mode) ||
        !finite(l.gap, -1e5, 1e5) ||
        !finite(l.lineGap, -1e5, 1e5) ||
        !Array.isArray(l.padding) ||
        l.padding.length !== 4 ||
        !l.padding.every((v) => finite(v, 0, 1e5)) ||
        typeof l.wrap !== 'boolean' ||
        typeof l.fillRows !== 'boolean' ||
        !Number.isInteger(l.columns) ||
        !finite(l.columns, 1, 64) ||
        ![
          'start',
          'center',
          'end',
          'stretch',
          'space-between',
          'space-around',
          'space-evenly', 'unsafe-center', 'unsafe-end',
        ].includes(l.justify) ||
        !['start', 'center', 'end', 'stretch', 'unsafe-center', 'unsafe-end'].includes(l.align)
      )
        throw new Error('自动布局参数无效')
    }
    if (n.sizing !== undefined) {
      if (!isObject(n.sizing)) throw new Error('尺寸配置无效')
      const z = { ...defaultSizing(), ...n.sizing }
      if (
        !['fixed', 'hug', 'fill'].includes(z.width) ||
        !['fixed', 'hug', 'fill'].includes(z.height) ||
        !finite(z.minWidth, 0.01) ||
        !finite(z.minHeight, 0.01) ||
        !finite(z.maxWidth, z.minWidth) ||
        !finite(z.maxHeight, z.minHeight) ||
        typeof z.absolute !== 'boolean' ||
        (z.alignSelf !== null && !['start', 'center', 'end', 'stretch'].includes(z.alignSelf)) ||
        ![z.rowSpan, z.columnSpan].every((v) => Number.isInteger(v) && finite(v, 1, 64))
      )
        throw new Error('响应式尺寸参数无效')
      if (
        (z.width === 'hug' || z.height === 'hug') &&
        n.kind !== 'text' &&
        (!n.layout || n.layout.mode === 'none')
      )
        throw new Error('内容自适应需要文本或自动布局')
    }
    if (n.constraints !== undefined) {
      if (!isObject(n.constraints)) throw new Error('约束配置无效')
      const c = n.constraints
      if (
        !constraintModes.includes(c.horizontal ?? 'start') || !constraintModes.includes(c.vertical ?? 'start') ||
        (c.referenceWidth != null && !finite(c.referenceWidth, 0.01)) ||
        (c.referenceHeight != null && !finite(c.referenceHeight, 0.01))
      )
        throw new Error('约束参数无效')
    }
    if (n.network) {
      const g = n.network
      if (
        !Array.isArray(g.vertices) ||
        !Array.isArray(g.edges) ||
        g.vertices.length > 10000 ||
        g.edges.length > 20000
      )
        throw new Error('矢量网络超过限制')
      const vertices = networkIdDomain(g.vertices, vertexIndex), edges = networkIdDomain(g.edges, edgeIndex)
      if (g.filledFaces !== undefined && (d.schemaVersion < 10 || !Array.isArray(g.filledFaces) ||
          g.filledFaces.length > 10000 || g.filledFaces.some(face => !Array.isArray(face) || face.length > 10000 ||
            face.some(edgeId => Number.isNaN(edgeId) || !edges.has(edgeId)))))
        throw new Error('矢量区域填充数据无效')
      if (vertices.size !== g.vertices.length || edges.size !== g.edges.length ||
          !g.vertices.every(v => finite(v.x) && finite(v.y)) ||
          !g.edges.every(e => vertices.has(e.from) && vertices.has(e.to) &&
            (!e.c1 || finite(e.c1.x) && finite(e.c1.y)) && (!e.c2 || finite(e.c2.x) && finite(e.c2.y))))
        throw new Error('矢量网络引用无效')
    }
    if(n.vectorGeometry!==undefined) {
      const geometry=n.vectorGeometry
      if(d.schemaVersion<16||n.kind!=='vector'||n.network||n.vectorBrush||!isObject(geometry)||Object.keys(geometry).some(key=>!['fillRule','fill','stroke'].includes(key))||!['evenodd','nonzero'].includes(geometry.fillRule)||!Array.isArray(geometry.fill)||(geometry.stroke!==undefined&&!Array.isArray(geometry.stroke))||geometry.fill.length+(geometry.stroke?.length??0)>131072)throw Error('矢量路径需要版本 16，且必须只有一个权威几何表示')
      // Missing stroke reuses this exact fill array. Validate each carrier once,
      // and avoid allocating an entries array and opcode map per curve. Dense
      // imported geometry still visits every coordinate on every admission.
      for(const curves of geometry.stroke===undefined||geometry.stroke===geometry.fill?[geometry.fill]:[geometry.fill,geometry.stroke])for(const curve of curves){
        if(curve==='close')continue
        if(!isObject(curve))throw Error('矢量曲线命令无效')
        const keys=Object.keys(curve)
        if(keys.length!==1)throw Error('矢量曲线命令无效')
        const op=keys[0],values=(curve as Record<string,unknown>)[op],length=op==='move'||op==='line'?2:op==='quad'?4:op==='cubic'?6:0
        if(!length||!Array.isArray(values)||values.length!==length||!values.every(v=>finite(v)))throw Error('矢量曲线坐标无效')
      }
    }
    if (n.component !== undefined) {
      if (
        !isObject(n.component) ||
        !container(n) ||
        n.instance ||
        n.instanceOrigin ||
        n.componentSet
      )
        throw new Error('主组件数据无效')
      if (n.component.variants !== undefined && !isObject(n.component.variants))
        throw new Error('变体属性无效')
      if (n.component.properties !== undefined && !isObject(n.component.properties))
        throw new Error('组件属性无效')
    }
    if (
      n.componentSet !== undefined &&
      (typeof n.componentSet !== 'boolean' || (n.componentSet && !container(n)))
    )
      throw new Error('组件集数据无效')
    if (
      n.componentKey !== undefined &&
      (typeof n.componentKey !== 'string' || !n.componentKey || n.componentKey.length > 4096)
    )
      throw new Error('组件图层标识无效')
    if (n.instance !== undefined) {
      if (
        !isObject(n.instance) ||
        typeof n.instance.componentId !== 'string' ||
        !d.nodes[n.instance.componentId]?.component ||
        (n.instance.overrides !== undefined && !isObject(n.instance.overrides)) ||
        (n.instance.propertyValues !== undefined && !isObject(n.instance.propertyValues))
      )
        throw new Error('实例引用或覆盖数据无效')
    }
    if (n.instanceOrigin !== undefined) {
      const o = n.instanceOrigin
      if (
        !isObject(o) ||
        typeof o.owner !== 'string' ||
        !d.nodes[o.owner]?.instance ||
        typeof o.key !== 'string' ||
        !o.key ||
        o.key.length > 4096 ||
        typeof o.source !== 'string'
      )
        throw new Error('实例图层来源无效')
    }
  }
  if (hasRepeat) validateRepeatDocument(d)
  const visit = (id: string, depth: number) => {
    if (depth > 64 || seen.has(id) || !d.nodes[id])
      throw new Error('图层结构包含循环、重复或无效引用')
    seen.add(id)
    d.nodes[id].children.forEach((c) => visit(c, depth + 1))
  }
  const pages = new Set<string>()
  for (const p of d.pages) {
    if (
      !p ||
      typeof p.id !== 'string' ||
      !uuid.test(p.id) ||
      pages.has(p.id) ||
      typeof p.name !== 'string' ||
      !wellFormed(p.name) ||
      !color.test(p.background) ||
      !Array.isArray(p.children)
    )
      throw new Error('页面数据无效')
    pages.add(p.id)
    if (!scope) p.children.forEach((id) => visit(id, 0))
  }
  if (scope) {
    if (!pages.has(scope.pageId)) throw new Error('页面数据无效')
    for (const id of scope.ids) if (!d.nodes[id]) throw new Error('文件包含未归属页面的图层')
    return d
  }
  if (seen.size !== nodes.length) throw new Error('文件包含未归属页面的图层')
  return d
}

// Structural edits must remain renderable before publishing a new snapshot.
// Keep this cheaper than validating every paint during each pointer update.
export function validateStructure(doc: DesignDocument) {
  const count = Object.keys(doc.nodes).length
  assertDocumentStructure(count, doc.pages.length)
  const seen = new Set<string>()
  const visit = (id: string, depth: number) => {
    if (depth > 64) throw new Error('图层嵌套最多支持 64 层；本次操作未应用')
    const n = doc.nodes[id]
    if (!n || seen.has(id)) throw new Error('图层结构包含无效或重复引用；本次操作未应用')
    seen.add(id)
    for (const child of n.children) visit(child, depth + 1)
  }
  for (const page of doc.pages) for (const root of page.children) visit(root, 0)
  if (seen.size !== count) throw new Error('存在未归属页面的图层；本次操作未应用')
}

export function hasStrokeMarkers(d: DesignDocument): boolean {
  const marked = (value: unknown) => Array.isArray(value) && value.some(s => s &&
    ((s.startMarker != null && s.startMarker !== 'none') || (s.endMarker != null && s.endMarker !== 'none')))
  return Object.values(d.nodes).some(n => marked(n.strokes) || Object.values(n.instance?.overrides || {}).some(o => marked(o.strokes))) ||
    !!d.animations?.some(c => c.tracks.some(t => t.keyframes.some(k => marked(k.value.strokes))))
}

export function hasLayerExports(d: DesignDocument): boolean {
  return Object.values(d.nodes).some(n => n.exportSettings?.length || Object.values(n.instance?.overrides || {}).some(o => Array.isArray(o.exportSettings) && o.exportSettings.length))
}
