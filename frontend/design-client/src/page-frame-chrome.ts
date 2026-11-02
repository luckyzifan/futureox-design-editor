import type { SceneEntry } from './geometry'
import type { DesignNode } from './model'

export function cornerRadiusKind(node: DesignNode | undefined): boolean {
  return !!node && (node.kind === 'rectangle' || node.kind === 'frame' || node.kind === 'section') && !node.network
}

/** Top-level frames and sections always show a name. A selected frame or
 * section also shows the names of its direct child frames and sections. */
export function frameTitleShown(entry: SceneEntry, node: DesignNode, selected: ReadonlySet<string>, parent?: DesignNode): boolean {
  if (node.kind !== 'frame' && node.kind !== 'section') return false
  if ((node.instance || node.instanceOrigin) && !selected.has(entry.id)) return false
  if (entry.depth === 0 || selected.has(entry.id)) return true
  return !!parent && selected.has(parent.id) && (parent.kind === 'frame' || parent.kind === 'section')
}

/** Frames with no visible paint still need a boundary on the canvas. */
export function frameHairline(node: DesignNode): boolean {
  return node.kind === 'frame' && node.visible && !node.fills.some(fill => fill.visible && fill.opacity > 0)
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
    return { offset: { x: 6, y: -6 }, color: selected ? '#0d99ff' : sectionLabelColor(chip), kind: 'section-title', chip }
  }
  return { offset: { x: 0, y: -12 }, color: selected ? '#0d99ff' : '#73778b', kind: 'frame-title' }
}
