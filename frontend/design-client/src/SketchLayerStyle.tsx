import { useState } from 'react'
import { Link2Off, Plus, Upload } from 'lucide-react'
import { emptySystem } from './design-system'
import type { Editor } from './engine'
import { type DesignDocument, type DesignNode, uid } from './model'
import { commitPendingEdits } from './pending-edits'
import { usePropertyText } from './property-interface-messages'
import { applySketchLayerStyle, captureLayerStyle, copyLayerStyle, updateSketchLayerStyle } from './sketch-layer-style'

export function SketchLayerStyle({ editor, node }: { editor: Editor; node: DesignNode }) {
  const { tr, locale } = usePropertyText()
  const { doc } = editor.state, session = editor.sessionGeneration
  const styles = Object.entries(doc.designSystem?.styles || {}).filter(([, style]) => style.kind === 'paint')
  const current = styles.find(([id]) => id === node.styleRefs?.fills)
  const [creating, setCreating] = useState(false), [name, setName] = useState('')
  const [choosingUpdateTarget, setChoosingUpdateTarget] = useState(false)
  const canEdit = () => editor.state.doc.id === doc.id && editor.sessionGeneration === session &&
    editor.state.selection.length === 1 && editor.state.selection[0] === node.id &&
    !editor.state.busy && !editor.interactionActive && !node.locked && !node.instance && !node.instanceOrigin
  const change = (label: string, edit: (document: DesignDocument, selected: DesignNode) => void) => {
    if (!canEdit() || !commitPendingEdits(editor) || !canEdit()) return false
    return editor.change(label, draft => {
      const selected = draft.nodes[node.id]
      if (selected && !selected.locked) edit(draft, selected)
    }).status === 'committed'
  }
  const detach = () => {
    if (!current) return
    change('解除图层样式', (draft, selected) => {
      const shared = draft.designSystem?.styles[current[0]]
      if (shared?.kind !== 'paint' || selected.styleRefs?.fills !== current[0]) return
      copyLayerStyle(selected, shared)
      delete selected.styleRefs.fills
      if (!Object.keys(selected.styleRefs).length) delete selected.styleRefs
    })
  }
  const update = (id: string) => {
    if (canEdit() && updateSketchLayerStyle(editor, id)) setChoosingUpdateTarget(false)
  }
  return <div className="sketch-layer-style" data-testid="sketch-layer-style">
    <label>{tr('图层样式')}<select aria-label={tr('图层样式')} value={current?.[0] || ''} disabled={!canEdit()}
      onChange={event => {
        const id = event.target.value
        if (!id) { detach(); return }
        change('应用共享样式', (draft, selected) => {
          const style = draft.designSystem?.styles[id]
          if (style?.kind !== 'paint') return
          applySketchLayerStyle(selected, id, style)
        })
      }}>
      <option value="">{tr('无图层样式')}</option>
      {styles.map(([id, style]) => <option key={id} value={id}>{style.name}</option>)}
    </select></label>
    <div className="sketch-layer-style-actions">
      <button type="button" aria-label={tr('创建图层样式')} title={tr('创建图层样式')} disabled={!canEdit()}
        aria-expanded={creating} onClick={() => { setCreating(open => !open); setName('') }}>
        <Plus size={13} />{locale === 'en' ? 'Create' : '创建'}
      </button>
      <button type="button" aria-label={tr('更新图层样式')} title={tr('更新图层样式')} disabled={!styles.length || !canEdit()}
        onClick={() => {
          if (current) update(current[0])
          else setChoosingUpdateTarget(value => !value)
        }}>
        <Upload size={13} />{locale === 'en' ? 'Update' : '更新'}
      </button>
      <button type="button" aria-label={tr('解除图层样式')} title={tr('解除图层样式')} disabled={!current || !canEdit()} onClick={detach}>
        <Link2Off size={13} />{locale === 'en' ? 'Detach' : '解绑'}
      </button>
    </div>
    {choosingUpdateTarget && <label>{tr('用所选图层更新样式')}
      <select aria-label={tr('用所选图层更新样式')} value="" disabled={!canEdit()}
        onChange={event => { if (event.target.value) update(event.target.value) }}>
        <option value="" disabled>{tr('图层样式')}</option>
        {styles.map(([id, style]) => <option key={id} value={id}>{style.name}</option>)}
      </select>
    </label>}
    {creating && <form onSubmit={event => {
      event.preventDefault()
      const title = name.trim()
      if (!title) return
      if (change('保存共享样式', (draft, selected) => {
        const system = (draft.designSystem ??= emptySystem()), id = uid()
        const previous = system.styles[selected.styleRefs?.fills || '']
        if (previous?.kind === 'paint') copyLayerStyle(selected, previous)
        system.styles[id] = captureLayerStyle(selected, title)
        selected.styleRefs = { ...selected.styleRefs, fills: id }
        draft.schemaVersion = Math.max(12, draft.schemaVersion) as DesignDocument['schemaVersion']
      })) { setCreating(false); setName('') }
    }}>
      <input autoFocus aria-label={locale === 'en' ? 'Layer style name' : '图层样式名称'} value={name} maxLength={200}
        onChange={event => setName(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); setCreating(false) }
        }} />
      <button type="submit" disabled={!name.trim() || !canEdit()}>{locale === 'en' ? 'Save' : '保存'}</button>
    </form>}
  </div>
}
