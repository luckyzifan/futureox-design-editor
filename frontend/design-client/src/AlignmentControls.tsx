import { AlignLeft, AlignCenterHorizontal, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical, FlipHorizontal2, FlipVertical2, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter } from 'lucide-react'
import type { Editor } from './engine'
import { allParents } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { commitPendingEdits } from './pending-edits'

export function AlignmentControls({ editor }: { editor: Editor }) {
  const ids = editor.topSelection(), parents = allParents(editor.state.doc)
  const disabled = editor.state.busy || editor.interactionActive || !ids.length
  const alignable = ids.length > 1 || !!editor.state.doc.nodes[parents.get(ids[0]) || '']
  return <div className="alignment-controls" role="group" aria-label="对齐与翻转">
    {([
      ['x', 'start', '左对齐', AlignLeft], ['x', 'center', '水平居中', AlignCenterHorizontal], ['x', 'end', '右对齐', AlignRight],
      ['y', 'start', '顶对齐', AlignStartVertical], ['y', 'center', '垂直居中', AlignCenterVertical], ['y', 'end', '底对齐', AlignEndVertical],
      ['x', 'distribute', '水平等距分布', AlignHorizontalDistributeCenter], ['y', 'distribute', '垂直等距分布', AlignVerticalDistributeCenter],
    ] as const).map(([axis, mode, title, Icon]) => <button type="button" key={title} title={title} aria-label={title}
      disabled={disabled || !alignable || (mode === 'distribute' && ids.length < 3)}
      onClick={() => { if (commitPendingEdits(editor)) editor.align(axis, mode) }}><Icon size={16}/></button>)}
    {([['flip-horizontal', '水平翻转', FlipHorizontal2], ['flip-vertical', '垂直翻转', FlipVertical2]] as const).map(([command, title, Icon]) =>
      <button type="button" key={command} title={title} aria-label={title} disabled={disabled}
        onClick={() => void dispatchEditorCommand(editor, command)}><Icon size={16}/></button>)}
  </div>
}
