import { Crosshair, Play, Trash2 } from 'lucide-react'
import { useId, useMemo } from 'react'
import { jumpToNode } from './canvas-navigation'
import { DraftInput } from './DraftInput'
import type { Editor } from './engine'
import { validFlowName, type DesignDocument } from './model'
import { commitPendingEdits } from './pending-edits'
import {
  addPrototypeFlow, outerPrototypeFrame, prototypeFlowsOnPage, removePrototypeFlow, updatePrototypeFlow,
} from './prototype-flows'
import { useProfessionalDialogText } from './professional-dialog-messages'

export function PrototypeFlowsPanel({ editor, doc, pageId, selection, onPreview }: {
  editor: Editor
  doc: DesignDocument
  pageId: string
  selection: readonly string[]
  onPreview: (startNode?: string) => void
}) {
  const { locale, tr } = useProfessionalDialogText()
  const en = locale === 'en'
  const title = en ? 'Prototype flows' : '原型流程'
  const id = useId()
  const flows = useMemo(() => prototypeFlowsOnPage(doc, pageId), [doc, pageId])
  const selected = selection.length === 1 ? doc.nodes[selection[0]] : undefined
  const canAdd = selected?.kind === 'frame' && !selected.locked && !flows.some(flow => flow.startNode === selected.id) &&
    outerPrototypeFrame(doc, selected.id, editor.parentMap()) === selected.id
  const occupied = new Set(flows.map(flow => flow.startNode))
  const page = doc.pages.find(page => page.id === pageId)
  const freeFrames = page?.children.filter(id => doc.nodes[id]?.kind === 'frame' && !doc.nodes[id].locked && !occupied.has(id)) ?? []
  const run = (next: () => void) => {
    if (!editor.state.busy && !editor.interactionActive && commitPendingEdits(editor)) next()
  }
  return <section className="prototype-flows" aria-labelledby={id}>
    <header>
      <h3 id={id}>{title}</h3>
      <button type="button" disabled={!canAdd} onClick={() => run(() =>
        editor.change('添加流程起点', draft => addPrototypeFlow(draft, pageId, selected!.id)))}>
        {en ? 'Add starting point' : '添加流程起点'}
      </button>
    </header>
    {flows.map(flow => <div className="prototype-flow" key={flow.id} data-flow-start={flow.startNode}>
      <DraftInput editor={editor} aria-label={en ? `Flow name · ${flow.name}` : `流程名称 · ${flow.name}`}
        value={flow.name} normalize={value => value.trim()} validate={validFlowName} onCommit={value => {
          editor.change('重命名原型流程', draft => updatePrototypeFlow(draft, pageId, flow.id, { name: value }))
        }} />
      <label className="prototype-flow-start">
        {en ? 'Start' : '起点'}
        <select aria-label={en ? `Starting frame · ${flow.name}` : `流程起点 · ${flow.name}`} value={flow.startNode}
          onChange={event => {
            const startNode = event.currentTarget.value
            run(() => editor.change('移动原型流程起点', draft => updatePrototypeFlow(draft, pageId, flow.id, { startNode })))
          }}>
          {[flow.startNode, ...freeFrames].map(frame => <option key={frame} value={frame}>{doc.nodes[frame].name}</option>)}
        </select>
      </label>
      <div className="prototype-flow-actions">
        <button type="button" aria-label={en ? `Preview ${flow.name}` : `预览 ${flow.name}`}
          onClick={() => run(() => onPreview(flow.startNode))}><Play size={14} aria-hidden="true" />{en ? 'Preview' : '预览'}</button>
        <button type="button" aria-label={en ? `Select frame · ${flow.name}` : `定位起点 · ${flow.name}`} onClick={() => run(() => {
          const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]')
          if (canvas) jumpToNode(editor, flow.startNode, { width: canvas.clientWidth, height: canvas.clientHeight })
        })}><Crosshair size={14} aria-hidden="true" /></button>
        <button type="button" aria-label={en ? `Remove flow · ${flow.name}` : `移除流程 · ${flow.name}`}
          onClick={() => run(() => editor.change('移除原型流程', draft => removePrototypeFlow(draft, pageId, flow.id)))}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>)}
    {flows.length === 0 && <button type="button" disabled={!page?.children.length} onClick={() => run(() => onPreview())}>
      {tr('播放原型')}
    </button>}
  </section>
}
