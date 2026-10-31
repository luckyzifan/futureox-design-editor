import { freehand_json } from './generated/design-kernel/design_kernel'
import {
  node,
  paint,
  stroke,
  effect,
  type DesignNode,
  type Network,
  type Point,
  type WidthPoint,
} from './model'
export type FreehandSample = Point & { pressure: number }
export type FreehandTool = 'pencil' | 'brush' | 'marker' | 'washi-tape'
export type PencilSettings = { width: number; color: string; smoothing: number; pressure: boolean }
export const defaultPencil = (): PencilSettings => ({
  width: 1,
  color: '#000000',
  smoothing: 0.8,
  pressure: false,
})
export const defaultBrush = (): PencilSettings => ({
  width: 12,
  color: '#7451ca',
  smoothing: 0.8,
  pressure: true,
})
export const defaultMarker = ():PencilSettings=>({width:24,color:'#f6c944',smoothing:.8,pressure:false})
export const defaultTape = ():PencilSettings=>({width:32,color:'#9d8bd9',smoothing:.8,pressure:false})
export type FittedStroke = {
  network: Network
  widthProfile: WidthPoint[]
  origin: Point
  width: number
  height: number
  dotPressure: number | null
  inputSamples: number
}
export function fitFreehand(samples: FreehandSample[], tolerance: number): FittedStroke {
  return JSON.parse(freehand_json(JSON.stringify({ samples, tolerance, pressureTolerance: 0.015 })))
}
export function freehandNode(
  id: string,
  samples: FreehandSample[],
  settings: PencilSettings,
  zoom: number,
  tool?: FreehandTool,
): DesignNode {
  if (
    !Number.isFinite(settings.width) ||
    settings.width < 0.5 ||
    settings.width > 200 ||
    !/^#[0-9a-f]{6}$/i.test(settings.color) ||
    !Number.isFinite(settings.smoothing) || settings.smoothing <= 0 ||
    !Number.isFinite(zoom) || zoom <= 0
  )
    throw new Error('无效的画笔设置')
  const pressure = (tool === undefined || tool === 'brush') && settings.pressure
  const fitted = fitFreehand(
    pressure ? samples : samples.map((s) => ({ ...s, pressure: 0.5 })),
    Math.max(0.01, Math.min(20, settings.smoothing / zoom)),
  )
  if (fitted.dotPressure !== null) {
    const size = Math.max(0.01, settings.width * fitted.dotPressure * 2)
    const n = node('ellipse', fitted.origin.x - size / 2, fitted.origin.y - size / 2, size, size)
    n.id = id
    n.name = tool === 'brush' ? '画笔点' : '铅笔点'
    n.fills = [paint(settings.color)]
    if(tool==='marker')n.opacity=.4
    if(tool==='washi-tape')n.effects=[{...effect('noise'),opacity:.12,amount:.45}]
    n.strokes = []
    if (fitted.dotPressure === 0) n.opacity = 0
    return n
  }
  const n = node('vector', fitted.origin.x, fitted.origin.y, fitted.width, fitted.height)
  n.id = id
  n.name = tool === 'pencil' ? '铅笔路径' : pressure ? '压感手绘' : '手绘路径'
  n.network = fitted.network
  n.fills = []
  if(tool==='marker'){n.name='马克笔路径';n.opacity=.4}
  if(tool==='washi-tape'){n.name='和纸胶带';n.effects=[{...effect('noise'),opacity:.12,amount:.45}]}
  n.strokes = [{ ...stroke(settings.color, settings.width),...(tool==='washi-tape'?{cap:'square' as const,join:'bevel' as const}:{}), ...(pressure ? { widthProfile: fitted.widthProfile } : {}) }]
  return n
}
/** One pointer owns a stroke. Release events do not append a synthetic zero pressure. */
export class PencilInput {
  samples: FreehandSample[] = []
  private straightPrefix: number | null = null
  private straightSamples: FreehandSample[] = []
  constructor(
    readonly pointerId: number,
    readonly pressure: boolean,
  ) {}
  append(
    events: readonly {
      clientX: number
      clientY: number
      pressure: number
      pointerId: number
      pointerType: string
    }[],
    map: (p: { clientX: number; clientY: number }) => Point,
    release = false,
    straight = false,
  ) {
    if (!events.some(event => event.pointerId === this.pointerId)) return
    // Shift starts a straight segment at the current endpoint. Releasing Shift
    // freezes that segment and resumes freehand drawing. Original pressure
    // samples are retained and projected onto the segment, not reduced to two
    // endpoint pressures, so fitting still preserves pressure extrema.
    if (straight && this.straightPrefix === null) {
      this.straightPrefix = Math.max(0, this.samples.length - 1)
      this.straightSamples = this.samples.length ? [{ ...this.samples.at(-1)! }] : []
    } else if (!straight) { this.straightPrefix = null; this.straightSamples = [] }
    for (const event of events) {
      if (event.pointerId !== this.pointerId) continue
      const point = map(event)
      const target = this.straightPrefix === null ? this.samples : this.straightSamples
      const previous = target.at(-1)
      const pressure =
        release && previous
          ? previous.pressure
          : this.pressure && ['pen', 'touch'].includes(event.pointerType)
            ? event.pressure
            : 0.5
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(pressure))
        throw new Error('无效的指针采样')
      const samplePressure = Math.max(0, Math.min(1, pressure))
      if (previous && point.x === previous.x && point.y === previous.y) {
        if (!release) previous.pressure = Math.max(previous.pressure, samplePressure)
      } else {
        if (target.length + (this.straightPrefix ?? 0) >= 8192) throw new Error('单笔超过 8192 个采样点，请分段绘制')
        target.push({ ...point, pressure: samplePressure })
      }
    }
    if (this.straightPrefix !== null && this.straightSamples.length) {
      const first = this.straightSamples[0], last = this.straightSamples.at(-1)!
      const dx = last.x - first.x, dy = last.y - first.y, length2 = dx * dx + dy * dy
      const projected: FreehandSample[] = []
      for (let index = 0; index < this.straightSamples.length; index++) {
        const sample = this.straightSamples[index]
        const t = index === this.straightSamples.length - 1 ? 1 : length2 > 0
          ? Math.max(0, Math.min(1, ((sample.x - first.x) * dx + (sample.y - first.y) * dy) / length2)) : 0
        const next = { x: first.x + dx * t, y: first.y + dy * t, pressure: sample.pressure }
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) throw new Error('直线采样超出有效坐标范围')
        const previous = projected.at(-1)
        if (previous && previous.x === next.x && previous.y === next.y) previous.pressure = Math.max(previous.pressure, next.pressure)
        else projected.push(next)
      }
      this.samples = [...this.samples.slice(0, this.straightPrefix), ...projected]
    }
  }
}
