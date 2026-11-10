/** Classify a Sketch admission failure so the open flow can locate a library. */
export type SketchLibraryGap = {
  kind: 'symbol' | 'style'
  /** The user can still supply a local .sketch library and retry admission. */
  canAttach: boolean
}

export function sketchLibraryGap(error: string): SketchLibraryGap | null {
  const text = error.trim()
  const symbol = text.includes('缺失的外部库符号')
  const style = text.includes('缺失的外部库样式')
  if (!symbol && !style) return null
  if (text.includes('损坏的覆盖引用') && !symbol && !style) return null
  return {
    kind: style && !symbol ? 'style' : 'symbol',
    canAttach: !text.includes('未展开'),
  }
}
