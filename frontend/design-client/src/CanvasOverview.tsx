import { useMemo } from 'react'
import type { Editor, View } from './engine'
import { unionBounds, type SceneEntry } from './geometry'
import type { Bounds } from './model'

const SIZE = { width: 156, height: 112 }

export function CanvasOverview({ editor, entries, view, size, contentBounds, label }: {
  editor: Editor
  entries: readonly SceneEntry[]
  view: View
  size: { width: number; height: number }
  contentBounds?: Bounds
  label: string
}) {
  const roots = useMemo(() => entries.filter(entry => entry.depth === 0), [entries])
  const content = useMemo(() => contentBounds ?? unionBounds(roots.map(entry => entry.bounds)), [contentBounds, roots])
  const zoom = Math.min((SIZE.width - 16) / Math.max(content.width, 1), (SIZE.height - 16) / Math.max(content.height, 1))
  const camera = {
    zoom,
    x: SIZE.width / 2 - (content.x + content.width / 2) * zoom,
    y: SIZE.height / 2 - (content.y + content.height / 2) * zoom,
  }
  if (!(content.width > 0 || content.height > 0)) return null
  const map = (b: Bounds) => ({
    x: camera.x + b.x * camera.zoom,
    y: camera.y + b.y * camera.zoom,
    width: Math.max(1, b.width * camera.zoom),
    height: Math.max(1, b.height * camera.zoom),
  })
  const viewport = map({ x: -view.x / view.zoom, y: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom })
  return <svg className="canvas-overview" width={SIZE.width} height={SIZE.height}
    role="group" aria-label={label} data-testid="canvas-overview" tabIndex={0}
    onPointerDown={event => { event.stopPropagation() }}
    onPointerMove={event => { event.stopPropagation() }}
    onDoubleClick={event => { event.stopPropagation() }}
    onClick={event => {
      if (editor.interactionActive) return
      const rect = event.currentTarget.getBoundingClientRect()
      const x = (event.clientX - rect.left - camera.x) / camera.zoom
      const y = (event.clientY - rect.top - camera.y) / camera.zoom
      const current = editor.flushPendingView()
      editor.set({ view: { ...current, x: size.width / 2 - x * current.zoom, y: size.height / 2 - y * current.zoom } })
    }}
    onKeyDown={event => {
      const x = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0
      const y = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
      if ((!x && !y) || editor.interactionActive) return
      event.preventDefault()
      event.stopPropagation()
      const current = editor.flushPendingView()
      editor.set({ view: { ...current, x: current.x + x * size.width * .25, y: current.y + y * size.height * .25 } })
    }}>
    {!contentBounds && roots.length <= 256
      ? roots.map(entry => <rect key={entry.id} {...map(entry.bounds)} className="canvas-overview-layer" />)
      : <rect {...map(content)} className="canvas-overview-layer" />}
    <rect {...viewport} className="canvas-overview-viewport" />
  </svg>
}
