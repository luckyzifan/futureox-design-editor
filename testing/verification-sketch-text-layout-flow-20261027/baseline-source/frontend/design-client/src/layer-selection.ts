export function layerSelection(rows: readonly string[], selection: readonly string[], target: string, anchor: string | null,
  modifiers: { range?: boolean; toggle?: boolean } = {}): string[] {
  const end = rows.indexOf(target), start = anchor ? rows.indexOf(anchor) : -1
  if (modifiers.range && start >= 0 && end >= 0) {
    const range = rows.slice(Math.min(start, end), Math.max(start, end) + 1)
    return modifiers.toggle ? [...new Set([...selection, ...range])] : range
  }
  if (modifiers.toggle) return selection.includes(target) ? selection.filter((id) => id !== target) : [...selection, target]
  return [target]
}
