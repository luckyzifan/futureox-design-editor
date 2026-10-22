import { usePropertyText } from './property-interface-messages'
import { AlignLeft, AlignCenterHorizontal, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical, FlipHorizontal2, FlipVertical2, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter } from 'lucide-react'
import type { Editor } from './engine'
import { alignmentAvailability, alignSelection } from './alignment-availability'
import { dispatchEditorCommand } from './editor-commands'

export function AlignmentControls({ editor }: { editor: Editor }) {
  const { tr } = usePropertyText()
  const ids = editor.topSelection(), availability = alignmentAvailability(editor)
  const disabled = editor.state.busy || editor.interactionActive || !ids.length
  return <div className="alignment-controls" role="group" aria-label={tr("对齐与翻转")}>
    {([
      ['x', 'start', '左对齐', AlignLeft], ['x', 'center', '水平居中', AlignCenterHorizontal], ['x', 'end', '右对齐', AlignRight],
      ['y', 'start', '顶对齐', AlignStartVertical], ['y', 'center', '垂直居中', AlignCenterVertical], ['y', 'end', '底对齐', AlignEndVertical],
      ['x', 'distribute', '水平等距分布', AlignHorizontalDistributeCenter], ['y', 'distribute', '垂直等距分布', AlignVerticalDistributeCenter],
    ] as const).map(([axis, mode, title, Icon]) => <button type="button" key={`${axis}:${mode}`} title={tr(title)} aria-label={tr(title)}
      disabled={!availability[mode === 'distribute' ? 'distribute' : 'align']}
      onClick={() => alignSelection(editor, axis, mode)}><Icon size={16}/></button>)}
    {([['flip-horizontal', '水平翻转', FlipHorizontal2], ['flip-vertical', '垂直翻转', FlipVertical2]] as const).map(([command, title, Icon]) =>
      <button type="button" key={command} title={tr(title)} aria-label={tr(title)} disabled={disabled}
        onClick={() => void dispatchEditorCommand(editor, command)}><Icon size={16}/></button>)}
  </div>
}
