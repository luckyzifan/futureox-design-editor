import type { SceneEntry } from './geometry'
import type { DesignNode } from './model'
import type { UiMode } from './interface-preference'
import { SELECTION_BLUE } from './selection-blue'

export const FRAME_TITLE_SIZE = 11
export const CANVAS_CHROME_FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif'
let frameTitleMeasure: OffscreenCanvasRenderingContext2D | null | undefined

export function cornerRadiusKind(node: DesignNode | undefined): boolean {
  return !!node && (node.kind === 'rectangle' || node.kind === 'frame' || node.kind === 'section') && !node.network
}

export function frameTitleShown(entry: SceneEntry, node: DesignNode, selected: ReadonlySet<string>, parent?: DesignNode, uiMode?: UiMode): boolean {
  if (node.kind !== 'frame' && node.kind !== 'section') return false
  if ((node.instance || node.instanceOrigin) && !selected.has(entry.id)) return false
  if (entry.depth === 0 || selected.has(entry.id)) return true
  return !!parent && selected.has(parent.id) && (parent.kind === 'section' || parent.kind === 'frame' && uiMode !== 'figma')
}

export function fitFrameTitle(text: string, width: number): string {
  if (frameTitleMeasure === undefined) {
    frameTitleMeasure = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
    if (frameTitleMeasure) frameTitleMeasure.font = `${FRAME_TITLE_SIZE}px ${CANVAS_CHROME_FONT}`
  }
  const measure = (value: string) => {
    if (!frameTitleMeasure) return FRAME_TITLE_SIZE * Array.from(value).length
    const { width, actualBoundingBoxRight } = frameTitleMeasure.measureText(value)
    return Math.max(width, actualBoundingBoxRight)
  }
  if (measure(text) <= width) return text
  if (measure('…') > width) return ''
  const characters = Array.from(text)
  let low = 0, high = characters.length - 1
  while (low < high) {
    const count = Math.ceil((low + high) / 2)
    if (measure(characters.slice(0, count).join('') + '…') <= width) low = count
    else high = count - 1
  }
  return characters.slice(0, low).join('') + '…'
}

export function sectionChipFill(node: DesignNode): string {
  const fill = [...node.fills].reverse().find(item => item.visible && item.kind === 'solid' && item.opacity > 0 && item.color)
  return fill?.color ?? '#e7e8ef'
}

export function sectionLabelColor(fill: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(fill.trim())
  if (!hex) return '#1e1e1e'
  const value = Number.parseInt(hex[1], 16)
  const red = (value >> 16) & 255
  const green = (value >> 8) & 255
  const blue = value & 255
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.45 ? '#ffffff' : '#1e1e1e'
}

export type FrameChrome = {
  offset: { x: number; y: number }
  color: string
  kind: 'frame-title' | 'section-title'
  chip?: string
}

export function frameChromeLabel(node: DesignNode, selected: boolean): FrameChrome {
  if (node.kind === 'section') {
    const chip = sectionChipFill(node)
    return { offset: { x: 6, y: -6 }, color: selected ? SELECTION_BLUE : sectionLabelColor(chip), kind: 'section-title', chip }
  }
  return { offset: { x: 0, y: -12 }, color: selected ? SELECTION_BLUE : '#73778b', kind: 'frame-title' }
}
