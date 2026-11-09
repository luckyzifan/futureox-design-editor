export type NativeSourceBadgeStatus = {
  phase: string
  done: number
  total: number
}

/** Badge copy for the full-board canvas. A ready receipt is not “清晰” when
 * the picture on screen is a reprojected older frame, and “0 / N” is not
 * useful while that frame is still what the user sees. */
export function nativeSourceBadgeText(status: NativeSourceBadgeStatus, flags: {
  cpu: boolean
  openingMaterial: boolean
  previewRejected: boolean
  holdingFrame: boolean
  /** Preview gaps or a synthetic background fill are still holes, even when the camera matches. */
  holed?: boolean
}) {
  if (status.phase === 'ready') {
    if (flags.previewRejected || flags.holed) return '计算中'
    if (flags.openingMaterial) return '素材清晰 · 源文件仍在索引'
    return flags.cpu ? 'CPU · 已显示' : 'WebGPU · 清晰'
  }
  if (status.phase === 'limited') return '当前倍率为预览精度'
  if (status.phase === 'error') return '画板绘制未完成'
  if (status.phase === 'loading') return '正在准备完整画板…'
  if (status.phase === 'refining' && status.done === 0 && status.total > 0 && flags.holdingFrame) return '计算中'
  return `正在绘制 ${status.done} / ${status.total}`
}
