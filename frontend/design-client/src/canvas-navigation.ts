import type { Editor } from './engine'
import type { Bounds, DesignDocument, Point } from './model'
import { allParents, scene, type SceneEntry } from './geometry'
import { fitBounds, type CanvasSize } from './canvas-camera'

export type PrototypeLink = {
  id: string
  sourceId: string
  targetId: string
  from: Point
  to: Point
  c1: Point
  c2: Point
  offPage: boolean
  label?: string
}

export function pageOfNode(doc: DesignDocument, id: string): string | null {
  if (!doc.nodes[id]) return null
  const parents = allParents(doc)
  const pages = new Set(doc.pages.map(page => page.id))
  let at: string | undefined = id
  const seen = new Set<string>()
  while (at && !seen.has(at)) {
    seen.add(at)
    const parent = parents.get(at)
    if (parent && pages.has(parent)) return parent
    at = parent
  }
  return null
}

function rowSort(a: Bounds, b: Bounds): number {
  const band = Math.min(a.height, b.height) * 0.5
  if (Math.abs(a.y - b.y) > band) return a.y - b.y
  if (a.x !== b.x) return a.x - b.x
  return 0
}

/** Top-level frames and sections in Figma's canvas reading order. */
export function orderedFrames(doc: DesignDocument, pageId: string): { id: string; bounds: Bounds }[] {
  return scene(doc, pageId)
    .filter(entry => entry.depth === 0 && doc.nodes[entry.id]?.visible && (doc.nodes[entry.id].kind === 'frame' || doc.nodes[entry.id].kind === 'section'))
    .map(entry => ({ id: entry.id, bounds: entry.bounds }))
    .sort((a, b) => rowSort(a.bounds, b.bounds) || (a.id < b.id ? -1 : 1))
}

export function prototypeLinks(doc: DesignDocument, pageId: string, entries: readonly SceneEntry[] = scene(doc, pageId)): PrototypeLink[] {
  const onPage = new Map(entries.map(entry => [entry.id, entry]))
  const interactions = doc.prototype?.interactions || {}
  const links: PrototypeLink[] = []
  for (const [sourceId, events] of Object.entries(interactions)) {
    const source = onPage.get(sourceId)
    if (!source) continue
    events.forEach((event, eventIndex) => {
      event.actions.forEach((action, actionIndex) => {
        if (!action.target || !['navigate', 'overlay', 'scroll-to'].includes(action.kind) || !doc.nodes[action.target]) return
        const target = onPage.get(action.target)
        const from = { x: source.bounds.x + source.bounds.width, y: source.bounds.y + source.bounds.height / 2 }
        const to = target
          ? { x: target.bounds.x, y: target.bounds.y + target.bounds.height / 2 }
          : { x: from.x + 72, y: from.y }
        const bend = Math.max(48, Math.abs(to.x - from.x) * 0.45)
        const page = pageOfNode(doc, action.target)
        links.push({
          id: `${sourceId}:${eventIndex}:${actionIndex}`,
          sourceId,
          targetId: action.target,
          from,
          to,
          c1: { x: from.x + bend, y: from.y },
          c2: { x: to.x - bend, y: to.y },
          offPage: !target,
          label: !target && page ? doc.pages.find(item => item.id === page)?.name : undefined,
        })
      })
    })
  }
  return links
}

function cubic(link: PrototypeLink, t: number): Point {
  const u = 1 - t
  const uu = u * u, tt = t * t
  return {
    x: uu * u * link.from.x + 3 * uu * t * link.c1.x + 3 * u * tt * link.c2.x + tt * t * link.to.x,
    y: uu * u * link.from.y + 3 * uu * t * link.c1.y + 3 * u * tt * link.c2.y + tt * t * link.to.y,
  }
}

export function hitPrototypeLink(links: readonly PrototypeLink[], point: Point, zoom: number): PrototypeLink | null {
  const tolerance = 8 / Math.max(zoom, 0.02)
  for (const link of links) {
    for (let step = 0; step <= 24; step++) {
      const sample = cubic(link, step / 24)
      if (Math.hypot(sample.x - point.x, sample.y - point.y) <= tolerance) return link
    }
  }
  return null
}

export function hitPrototypeHead(link: PrototypeLink, point: Point, zoom: number): boolean {
  return Math.hypot(link.to.x - point.x, link.to.y - point.y) <= 12 / Math.max(zoom, 0.02)
}

/** Select a node and fit it. Switches page when the target lives elsewhere. */
export function jumpToNode(editor: Editor, id: string, size: CanvasSize): boolean {
  const node = editor.state.doc.nodes[id]
  if (!node) return false
  const page = pageOfNode(editor.state.doc, id)
  if (!page) return false
  if (page !== editor.state.page && !editor.switchPage(page)) return false
  if (editor.state.doc.nodes[id] !== node && !editor.state.doc.nodes[id]) return false
  editor.select([id])
  const entry = editor.entries().find(item => item.id === id)
  if (!entry) return true
  editor.set({ view: fitBounds(entry.bounds, size) })
  return true
}

/** Figma Mac N / Shift+N: zoom to the next or previous top-level frame. */
export function jumpFrame(editor: Editor, direction: 1 | -1, size: CanvasSize): boolean {
  const frames = orderedFrames(editor.state.doc, editor.state.page)
  if (!frames.length) return false
  const parents = allParents(editor.state.doc)
  let current: string | undefined = editor.state.selection[0]
  const seen = new Set<string>()
  while (current && !seen.has(current) && !frames.some(frame => frame.id === current)) {
    seen.add(current)
    current = parents.get(current)
  }
  const index = frames.findIndex(frame => frame.id === current)
  const next = index < 0 ? frames[direction > 0 ? 0 : frames.length - 1] : frames[index + direction]
  if (!next) return false
  editor.select([next.id])
  editor.set({ view: fitBounds(next.bounds, size) })
  return true
}

/** Move to the adjacent document page. Each page keeps the camera it last had. */
export function jumpPage(editor: Editor, direction: 1 | -1): boolean {
  const pages = editor.state.doc.pages
  const index = pages.findIndex(page => page.id === editor.state.page)
  const next = pages[index + direction]
  if (!next) return false
  return editor.switchPage(next.id)
}
