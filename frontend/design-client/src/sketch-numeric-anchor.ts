type SketchGeometryField = 'x' | 'y' | 'width' | 'height'
export type SketchAnchor = 0 | 0.5 | 1

/** An anchor is input syntax only. The arithmetic parser still owns the number. */
export function sketchNumericAnchor(raw: string, field: SketchGeometryField): { expression: string; anchor: SketchAnchor } | undefined {
  const text = raw.trim()
  const last = text.at(-1)?.toLowerCase() ?? ''
  if (!last || !'lrtbcm'.includes(last)) return
  const expression = text.slice(0, -1).trimEnd()
  // A plain length ending in pt is still an ordinary numeric expression.
  if (!/(?:[0-9.)%]|px|pt|pc|in|mm|cm)$/i.test(expression)) return
  const horizontal = field === 'x' || field === 'width'
  if (last !== 'c' && last !== 'm' && !(horizontal ? 'lr' : 'tb').includes(last))
    throw new Error('该边缘后缀不适用于此字段')
  return { expression, anchor: last === 'c' || last === 'm' ? 0.5 : 'rb'.includes(last) ? 1 : 0 }
}
