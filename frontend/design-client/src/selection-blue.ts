/** One selection blue for the canvas, frame titles, hover, and handles.
 * It is the workspace accent, so a selected frame and its outline read as the same mark. */
export const SELECTION_BLUE = '#3459d4'
/** Screen pixels. A single object and a multi-select union use the thicker stroke; each member is a hairline. */
export const SELECTION_UNION_STROKE_PX = 2
export const SELECTION_MEMBER_STROKE_PX = 1
export const SELECTION_HANDLE_PX = 8

export function selectionOutlinePlan(count: number) {
  return {
    color: SELECTION_BLUE,
    unionStrokePx: SELECTION_UNION_STROKE_PX,
    memberStrokePx: count > 1 ? SELECTION_MEMBER_STROKE_PX : 0,
    handles: count > 0,
    handlePx: SELECTION_HANDLE_PX,
  }
}
