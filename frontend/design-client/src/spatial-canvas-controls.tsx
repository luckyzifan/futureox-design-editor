import type { PointerEvent } from 'react'
import type { SpatialPivotPlane } from './kernel/picking'
import type { InterfaceLocale } from './interface-preference'
import type { Point, SpatialPose } from './model'
import { SELECTION_BLUE } from './selection-blue'

export type SpatialHandle = 'origin' | 'rotateX' | 'rotateY' | 'rotateZ'

export function spatialPivotPoint([origin, x, y]: SpatialPivotPlane, [u, v]: SpatialPose['origin']): Point | null {
  const at = (i: number) => origin[i] + u * (x[i] - origin[i]) + v * (y[i] - origin[i])
  const w = at(2)
  if (!(w > 0)) return null
  const point = { x: at(0) / w, y: at(1) / w }
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
}

/** Solve the pointer location in the same homogeneous plane provided by Rust. */
function spatialPivotOrigin([origin, x, y]: SpatialPivotPlane, point: Point): SpatialPose['origin'] | null {
  const ax = x[0] - origin[0] - point.x * (x[2] - origin[2])
  const ay = x[1] - origin[1] - point.y * (x[2] - origin[2])
  const bx = y[0] - origin[0] - point.x * (y[2] - origin[2])
  const by = y[1] - origin[1] - point.y * (y[2] - origin[2])
  const px = point.x * origin[2] - origin[0], py = point.y * origin[2] - origin[1]
  const determinant = ax * by - ay * bx
  const scale = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by))
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= scale * scale * 1e-12) return null
  const u = (px * by - py * bx) / determinant, v = (ax * py - ay * px) / determinant
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null
  return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))]
}

export function spatialPoseAfterDrag(
  pose: SpatialPose,
  handle: SpatialHandle,
  plane: SpatialPivotPlane,
  pivot: Point,
  start: Point,
  pointer: Point,
  zoom: number,
  snap: boolean,
): SpatialPose | null {
  if (handle === 'origin') {
    const origin = spatialPivotOrigin(plane, { x: pointer.x - start.x + pivot.x, y: pointer.y - start.y + pivot.y })
    return origin ? { ...pose, origin } : null
  }
  let delta = handle === 'rotateX' ? (pointer.y - start.y) * zoom : (pointer.x - start.x) * zoom
  if (handle === 'rotateZ') {
    const before = Math.atan2(start.y - pivot.y, start.x - pivot.x)
    const after = Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x)
    delta = Math.atan2(Math.sin(after - before), Math.cos(after - before)) * 180 / Math.PI
  }
  const next = pose[handle] + delta
  const rounded = snap ? Math.round(next / 15) * 15 : next
  return { ...pose, [handle]: Math.max(-36000, Math.min(36000, rounded)) }
}

const axes = [
  { axis: 'X', handle: 'rotateX', x: 36, y: 0, cursor: 'ns-resize' },
  { axis: 'Y', handle: 'rotateY', x: 0, y: 36, cursor: 'ew-resize' },
  { axis: 'Z', handle: 'rotateZ', x: -26, y: -26, cursor: 'grab' },
] as const

export function SpatialCanvasControls({ pivot, zoom, locale, onStart }: {
  pivot: Point
  zoom: number
  locale: InterfaceLocale
  onStart: (event: PointerEvent<SVGGElement>, handle: SpatialHandle) => void
}) {
  const origin = locale === 'en' ? 'Move 3D origin' : '移动 3D 原点'
  const anchor = (dx: number, dy: number) => ({ 'data-anchor-x': pivot.x + dx / zoom, 'data-anchor-y': pivot.y + dy / zoom })
  return <g data-testid="spatial-transform-handles" shapeRendering="crispEdges" transform={`translate(${pivot.x} ${pivot.y}) scale(${1 / zoom})`}>
    {axes.map(({ axis, handle, x, y, cursor }) => {
      const label = locale === 'en' ? `Rotate about ${axis}` : `绕 ${axis} 轴旋转`
      return <g key={axis}>
        <line x2={x} y2={y} stroke={SELECTION_BLUE} strokeWidth={1} pointerEvents="none" />
        <g data-testid={`spatial-rotate-${axis.toLowerCase()}`} {...anchor(x, y)} transform={`translate(${x} ${y})`}
          aria-label={label} style={{ cursor }} onPointerDown={event => onStart(event, handle)}>
          <circle r={10.5} fill={SELECTION_BLUE} pointerEvents="all" />
          <circle r={9.5} fill="white" pointerEvents="none" />
          <text textAnchor="middle" dy=".35em" fontSize={11} fill={SELECTION_BLUE} pointerEvents="none">{axis}</text>
          <title>{label}</title>
        </g>
      </g>
    })}
    <g data-testid="spatial-origin" {...anchor(0, 0)} aria-label={origin} style={{ cursor: 'move' }}
      onPointerDown={event => onStart(event, 'origin')}>
      <circle r={10} fill="transparent" pointerEvents="all" />
      <circle r={5} fill="white" stroke={SELECTION_BLUE} pointerEvents="none" />
      <path d="M-8 0H8 M0 -8V8" stroke={SELECTION_BLUE} pointerEvents="none" />
      <title>{origin}</title>
    </g>
  </g>
}
