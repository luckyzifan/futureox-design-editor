import { exportSuffixHasForbiddenCharacters, MAX_LAYOUT_GRIDS, type ExportSetting, type LayoutGrid } from './model'
import type { PrototypeOverflow } from './prototype'

const exportFormats = new Map<string, ExportSetting['format']>([
  ['PNG', 'png'], ['JPG', 'jpeg'], ['JPEG', 'jpeg'], ['SVG', 'svg'], ['SVG_STRING', 'svg'],
  ['PDF', 'pdf'], ['WEBP', 'webp'], ['TIFF', 'tiff'],
])

export function figExportSettings(value: unknown): { settings: ExportSetting[]; incomplete: boolean } {
  const settings: ExportSetting[] = []
  if (!Array.isArray(value)) return { settings, incomplete: true }
  let incomplete = value.length > 16
  value.slice(0, 16).forEach((item, index) => {
    const format = exportFormats.get(item?.imageType)
    const constraint = item?.constraint
    const scale = !constraint ? 1 : ['SCALE', 'CONTENT_SCALE'].includes(constraint.type) ? constraint.value : undefined
    const suffix = item?.suffix ?? ''
    if (!format || !Number.isFinite(scale) || scale < 0 || scale > 128 || typeof suffix !== 'string' ||
        suffix.length > 80 || exportSuffixHasForbiddenCharacters(suffix)) {
      incomplete = true
      return
    }
    settings.push({ id: `fig-export-${index}`, format, scale, suffix })
    incomplete ||= item.useAbsoluteBounds === true || item.contentsOnly === false ||
      (item.colorProfile !== undefined && item.colorProfile !== 'DOCUMENT')
  })
  return { settings, incomplete }
}

const alignments = new Map<string, NonNullable<LayoutGrid['alignment']>>([
  ['MIN', 'start'], ['MAX', 'end'], ['CENTER', 'center'], ['STRETCH', 'stretch'],
])

export function figLayoutGrids(value: unknown): { grids: LayoutGrid[]; incomplete: boolean } {
  const grids: LayoutGrid[] = []
  if (!Array.isArray(value)) return { grids, incomplete: true }
  let incomplete = value.length > MAX_LAYOUT_GRIDS
  for (const grid of value.slice(0, MAX_LAYOUT_GRIDS)) {
    const alignment = grid?.pattern === 'GRID' ? 'start' : alignments.get(grid?.type)
    const axis = grid?.pattern === 'GRID' ? 'uniform' :
      grid?.pattern === 'STRIPES' ? grid.axis === 'X' ? 'column' : grid.axis === 'Y' ? 'row' : undefined : undefined
    const sectionSize = alignment === 'stretch' ? undefined : grid?.sectionSize
    const count = axis === 'uniform' || grid?.numSections === 0x7fffffff ? 0 : grid?.numSections
    const gutter = axis === 'uniform' ? 0 : grid?.gutterSize ?? 0
    const margin = alignment === 'center' || axis === 'uniform' ? 0 : grid?.offset ?? 0
    const { r = 1, g = 0, b = 0, a = 0.1 } = grid?.color ?? {}
    if (!axis || !alignment || !Number.isInteger(count) || count < 0 || count > 64 ||
        (alignment === 'stretch' ? !count : !Number.isFinite(sectionSize) || sectionSize < 0.01 || sectionSize > 1e7) ||
        ![gutter, margin].every(n => Number.isFinite(n) && n >= 0 && n <= 1e7) ||
        ![r, g, b, a].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
      incomplete = true
      continue
    }
    const color = '#' + [r, g, b].map(n => Math.round(n * 255).toString(16).padStart(2, '0')).join('')
    grids.push({ axis, alignment, ...(sectionSize === undefined ? {} : { sectionSize }), count, gutter, margin,
      color, opacity: a, visible: grid.visible !== false })
  }
  return { grids, incomplete }
}

export function figPrototypeOverflow(value: unknown): PrototypeOverflow | undefined {
  switch (value) {
    case 'NONE': case 'NO_SCROLLING': return 'none'
    case 'HORIZONTAL': case 'HORIZONTAL_SCROLLING': return 'horizontal'
    case 'VERTICAL': case 'VERTICAL_SCROLLING': return 'vertical'
    case 'BOTH': case 'HORIZONTAL_AND_VERTICAL': case 'HORIZONTAL_AND_VERTICAL_SCROLLING': return 'both'
  }
}
