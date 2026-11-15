import type { Editor } from './engine'
import { defaultSizing, type DesignNode, type Sizing } from './model'
import { usePropertyText } from './property-interface-messages'
import { commonValue } from './selection-properties'
import { applyWholeTextStyle } from './text'

export function TextSizingControls({ editor, nodes, sketch = false }: {
  editor: Editor
  nodes: DesignNode[]
  sketch?: boolean
}) {
  const { tr } = usePropertyText()
  const setSizing = (patch: Partial<Sizing>) => editor.updateProperties(nodes.map(node => node.id), node => {
    node.sizing = { ...defaultSizing(), ...node.sizing, ...patch }
    applyWholeTextStyle(node, { wrap: node.sizing.width !== 'hug' })
  }, '调整文字尺寸模式')
  if (sketch) {
    const { doc } = editor.state, parents = editor.parentMap()
    const allowFill = nodes.every(node => {
      const container = doc.nodes[parents.get(node.id) || '']
      return !!container?.layout && container.layout.mode !== 'none' && !node.sizing?.absolute
    })
    return <div className="text-sizing-axes">
      {(['width', 'height'] as const).map(axis => {
        const mode = commonValue(nodes.map(node => node.sizing?.[axis] ?? 'fixed'))
        const label = tr(axis === 'width' ? '宽度模式' : '高度模式')
        return <label key={axis}><span>{tr(axis === 'width' ? '宽度' : '高度')}</span>
          <select aria-label={label} value={mode ?? ''} onChange={event => setSizing({ [axis]: event.target.value as Sizing['width'] })}>
            {mode === undefined && <option value="" disabled>{tr('混合')}</option>}
            <option value="fixed">{tr('固定')}</option>
            <option value="hug">{tr('适应')}</option>
            {(allowFill || mode === 'fill') && <option value="fill" disabled={!allowFill}>{tr('填满')}</option>}
          </select>
        </label>
      })}
    </div>
  }
  const mode = commonValue(nodes.map(node => node.sizing?.width === 'hug' ? 'width' :
    node.sizing?.height === 'hug' ? 'height' : 'fixed'))
  return <label className="labeled-select">{tr('文字尺寸')}
    <select aria-label={tr('文字尺寸模式')} value={mode ?? ''} onChange={event => {
      const next = event.target.value
      setSizing({ width: next === 'width' ? 'hug' : 'fixed', height: next === 'fixed' ? 'fixed' : 'hug' })
    }}>
      {mode === undefined && <option value="" disabled>{tr('混合')}</option>}
      <option value="width">{tr('自动宽度')}</option>
      <option value="height">{tr('自动高度')}</option>
      <option value="fixed">{tr('固定尺寸')}</option>
    </select>
  </label>
}
