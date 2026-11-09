export const SELECTION_BLUE = '#4597f7'
/** Hover uses the same blue as the selection stroke. It has no handles and no size pill. */
export const HOVER_BLUE = SELECTION_BLUE
export const HOVER_STROKE_PX = 1
/** Screen pixels. Gaps5 measures the box at about 1pt. Members use the same hairline. */
export const SELECTION_UNION_STROKE_PX = 1
export const SELECTION_MEMBER_STROKE_PX = 1
export const SELECTION_HANDLE_PX = 8
/** White type on the selection-blue size chip under the box. */
export const SIZE_PILL_TEXT = '#ffffff'
/** Marquee wash measured on the Mac desktop drag. The border is the selection blue. */
export const MARQUEE_FILL = '#dce9f5'

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
