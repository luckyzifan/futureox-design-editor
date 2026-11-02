/** One selection blue for the canvas box, frame titles, handles, and the size pill.
 * It is the workspace accent, so a selected frame and its outline read as the same mark.
 * Mac desktop Figma uses a bright blue box; this is that blue in this product. */
export const SELECTION_BLUE = '#3459d4'
/** Hover is the same blue lifted toward white. A 1px hairline in this color
 * cannot be read as the 2px selection box or as a multi-select member outline. */
export const HOVER_BLUE = '#859be5'
export const HOVER_STROKE_PX = 1
/** Screen pixels. A single object and a multi-select union use the thicker stroke; each member is a hairline. */
export const SELECTION_UNION_STROKE_PX = 2
export const SELECTION_MEMBER_STROKE_PX = 1
export const SELECTION_HANDLE_PX = 8
/** White type on the selection-blue size chip under the box. */
export const SIZE_PILL_TEXT = '#ffffff'
/** Translucent selection blue for the drag marquee. */
export const MARQUEE_FILL = '#3459d419'

export function srgbUnit(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1]
}

export function selectionOutlinePlan(count: number) {
  return {
    color: SELECTION_BLUE,
    hoverColor: HOVER_BLUE,
    unionStrokePx: SELECTION_UNION_STROKE_PX,
    memberStrokePx: count > 1 ? SELECTION_MEMBER_STROKE_PX : 0,
    hoverStrokePx: HOVER_STROKE_PX,
    handles: count > 0,
    handlePx: SELECTION_HANDLE_PX,
    sizePill: count > 0 ? 'accent' as const : null,
    sizePillText: SIZE_PILL_TEXT,
  }
}
