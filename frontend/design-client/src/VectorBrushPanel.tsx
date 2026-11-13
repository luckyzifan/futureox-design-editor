import { useState } from 'react'
import type { Editor } from './engine'
import { useProfessionalDialogText } from './professional-dialog-messages'
import { paint, type DesignNode } from './model'
import { defaultVectorBrush, type VectorBrush } from './vector-brush'
import { kernelSvgPaths } from './kernel/picking'
import { pathNetwork } from './path-network'
import { NumberField } from './fields'

/** Shared by the Web and Electron inspector. Embedded source is a snapshot;
 * selecting a new source replaces that snapshot without losing the guide. */
export function VectorBrushPanel({ editor, node }: { editor: Editor; node: DesignNode }) {
  const { tr } = useProfessionalDialogText()
  const [source, setSource] = useState('')
  const [sourceJson, setSourceJson] = useState('')
  const [open, setOpen] = useState(false)
  if (node.kind !== 'vector' || !node.network) return null
  const brush = node.vectorBrush
  const update = (change: Partial<VectorBrush>) => editor.updateProperties([node.id], n => { if (n.vectorBrush) Object.assign(n.vectorBrush, change) }, '修改矢量笔刷')
  const attempt = (action: () => void) => { try { action() } catch (error) { editor.notify(String(error)) } }
  const candidates = open || brush ? Object.values(editor.state.doc.nodes).filter(n => n.id !== node.id && n.kind === 'vector' && n.network?.fillRule === 'nonzero' && !n.vectorBrush && n.fills.some(f => f.visible !== false)) : []
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{tr('矢量笔刷')} {brush ? `· ${brush.mode}` : ''}</summary>
    <p>{tr('源图形使用当前图层的填充。Scatter 保留贝塞尔曲线。Stretch 在同向直线上是精确仿射；曲线、拐角、尖点和闭合路径按有界弧长与法线映射。')}</p>
    <select aria-label={tr('笔刷源图形')} value={source} onChange={e => setSource(e.target.value)}><option value="">{tr('选择闭合非零填充矢量源')}</option>{candidates.map(n => <option key={n.id} value={n.id}>{n.name || n.id}</option>)}</select>
    <button disabled={!source} onClick={() => attempt(() => {
      const network = editor.state.doc.nodes[source]?.network
      if (!network) throw new Error('源图形已不存在')
      editor.updateProperties([node.id], n => { n.network!.fillRule = 'nonzero'; n.vectorBrush = brush ? { ...brush, source: structuredClone(network) } : defaultVectorBrush(network); if (!n.fills.length) n.fills = [paint('#426bdf')] }, '应用矢量笔刷')
    })}>{tr(brush ? '替换源快照' : '应用 Scatter 笔刷')}</button>
    {brush && <>
      <select aria-label={tr('矢量笔刷模式')} value={brush.mode} onChange={e => attempt(() => update({ mode: e.target.value as VectorBrush['mode'] }))}><option value="scatter">{tr('Scatter 散布')}</option><option value="stretch">{tr('Stretch 拉伸')}</option></select>
      <NumberField label="笔刷宽度" value={brush.width} min={.001} max={10000} onChange={width => update({ width })}/>
      {brush.mode === 'scatter' && <>
        <NumberField label="散布间距" value={brush.spacing} min={.001} max={1e7} onChange={spacing => update({ spacing })}/>
        <NumberField label="随机种子" value={brush.seed} min={0} max={4294967295} onChange={seed => update({ seed: Math.round(seed) })}/>
        <NumberField label="旋转角度" value={brush.rotation * 180 / Math.PI} min={-360} max={360} onChange={v => update({ rotation: v * Math.PI / 180 })}/>
        <NumberField label="旋转随机范围" value={brush.rotationVariance * 180 / Math.PI} min={0} max={360} onChange={v => update({ rotationVariance: v * Math.PI / 180 })}/>
        <NumberField label="缩放随机范围 %" value={brush.scaleVariance * 100} min={0} max={99} onChange={v => update({ scaleVariance: v / 100 })}/>
        <NumberField label="法线散布范围" value={brush.scatter} min={0} max={10000} onChange={scatter => update({ scatter })}/>
        <label><input type="checkbox" checked={brush.followTangent} onChange={e => update({ followTangent: e.target.checked })}/>{tr('跟随路径方向')}</label>
      </>}
      <details><summary>{tr('编辑嵌入源网络')}</summary><button onClick={() => setSourceJson(JSON.stringify(brush.source, null, 2))}>{tr('载入源数据')}</button><textarea aria-label={tr('笔刷源网络 JSON')} value={sourceJson} onChange={e => setSourceJson(e.target.value)}/><button onClick={() => attempt(() => update({ source: JSON.parse(sourceJson) }))}>{tr('保存源编辑')}</button></details>
      <button onClick={() => editor.updateProperties([node.id], n => { delete n.vectorBrush }, '移除矢量笔刷')}>{tr('移除笔刷，保留路径')}</button>
      <button onClick={() => attempt(() => {
        const paths = kernelSvgPaths(node)
        if (!paths) throw new Error('矢量内核尚未就绪')
        const network = pathNetwork(paths.fill)
        editor.updateProperties([node.id], n => { n.network = network; delete n.vectorBrush }, '展开矢量笔刷（可撤销）')
      })}>{tr('展开为可编辑轮廓（可撤销）')}</button>
      <p>{tr('保存保留路径、源快照和随机种子。散布与曲线 Stretch 共用同一弧长预算；尖点按确定的法线转角闭合。多色源和孔洞仍不支持。预算耗尽会拒绝而不是放粗。')}</p>
    </>}
  </details>
}
