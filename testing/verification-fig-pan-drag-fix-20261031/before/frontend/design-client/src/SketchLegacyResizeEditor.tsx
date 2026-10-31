import { useState } from 'react'
import type { SketchEditSession } from './sketch-edit-session'
/** Sizes are parent-native dimensions; only the native kernel decides eligibility. */
export function SketchLegacyResizeEditor({ controller, selected, blocked }: { controller: SketchEditSession; selected: string; blocked: boolean }) {
  const [width, setWidth] = useState(''), [height, setHeight] = useState('')
  const w = Number(width), h = Number(height)
  const valid = !!width.trim() && !!height.trim() && [w, h].every(v => Number.isFinite(v) && v >= 0.5 && v <= 1e9)
  if (!selected) return null
  return <fieldset disabled={blocked}>
    <legend>旧式自由容器尺寸</legend>
    <p>仅支持自由布局 group/artboard 与直接形状或 bitmap 叶层。按原生约束更新子层 frame；不改归一化路径点。嵌套容器、文本、Symbol、现代布局及不支持的变换会整体拒绝。</p>
    <label>新宽度<input type="number" min="0.5" max="1000000000" step="any" value={width} onChange={e => setWidth(e.target.value)} /></label>
    <label>新高度<input type="number" min="0.5" max="1000000000" step="any" value={height} onChange={e => setHeight(e.target.value)} /></label>
    <button type="button" disabled={blocked || !valid} onClick={() => { if (valid) void controller.resizeLegacyContainer(selected, w, h) }}>应用旧式容器尺寸</button>
    <p>失败不部分更新；成功可撤销/重做，需另存为新文件。当前值未自动读取。</p>
  </fieldset>
}
