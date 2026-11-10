/** Classify a Sketch admission failure so open can locate a library without guessing. */
export type SketchLibraryGap = {
  kind: 'symbol' | 'style'
  /** A local .sketch library can still be attached. Unread members are not a located absence. */
  canAttach: boolean
}

export type SketchOpenBlock =
  | SketchLibraryGap
  | { kind: 'corrupt' | 'unmapped'; canAttach: false }

export function sketchLibraryGap(error: string): SketchLibraryGap | null {
  const block = sketchOpenBlock(error)
  return block && (block.kind === 'symbol' || block.kind === 'style') ? block : null
}

/** A diagnosis can name the other two failures in order to exclude them. */
function affirms(text: string, phrase: string): boolean {
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(phrase, from)
    if (at < 0) return false
    if (!text.slice(Math.max(0, at - 2), at).endsWith('不是')) return true
    from = at + phrase.length
  }
  return false
}

export function sketchOpenBlock(error: string): SketchOpenBlock | null {
  const text = error.trim()
  if (!text) return null
  const symbol = affirms(text, '缺失的外部库符号')
  const style = affirms(text, '缺失的外部库样式')
  if (symbol || style) {
    return {
      kind: symbol ? 'symbol' : 'style',
      canAttach: !text.includes('未展开'),
    }
  }
  if (affirms(text, '损坏的覆盖引用') || text.includes('could not be resolved')) return { kind: 'corrupt', canAttach: false }
  if (affirms(text, '无法映射的字段') || text.includes('no supported editable mapping')) return { kind: 'unmapped', canAttach: false }
  return null
}
