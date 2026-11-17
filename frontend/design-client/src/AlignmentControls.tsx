import { usePropertyText } from './property-interface-messages'
import { AlignLeft, AlignCenterHorizontal, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical, FlipHorizontal2, FlipVertical2, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, MoreHorizontal, Grid2X2 } from 'lucide-react'
import type { Editor } from './engine'
import { alignmentAvailability, alignSelection, canTidySelection, previewTidy, tidySelection } from './alignment-availability'
import { useInterfacePreferences } from './interface-preference'
import { dispatchEditorCommand } from './editor-commands'

export function FlipControls({ editor }: { editor: Editor }) {
  const { tr } = usePropertyText()
  const disabled = editor.state.busy || editor.interactionActive || !editor.topSelection().length
  return <>
    {([['flip-horizontal', '水平翻转', FlipHorizontal2], ['flip-vertical', '垂直翻转', FlipVertical2]] as const).map(([command, title, Icon]) =>
      <button type="button" key={command} title={tr(title)} aria-label={tr(title)} disabled={disabled}
        onClick={() => void dispatchEditorCommand(editor, command)}><Icon size={16}/></button>)}
  </>
}

export function AlignmentControls({ editor, compact = false }: { editor: Editor; compact?: boolean }) {
  const { tr } = usePropertyText()
  const { uiMode, locale } = useInterfacePreferences()
  const availability = alignmentAvailability(editor)
  const tidyLabel = locale === 'en' ? 'Tidy' : '整理'
  const positions = [
    ['x', 'start', '左对齐', AlignLeft], ['x', 'center', '水平居中', AlignCenterHorizontal], ['x', 'end', '右对齐', AlignRight],
    ['y', 'start', '顶对齐', AlignStartVertical], ['y', 'center', '垂直居中', AlignCenterVertical], ['y', 'end', '底对齐', AlignEndVertical],
    ['x', 'distribute', '水平等距分布', AlignHorizontalDistributeCenter], ['y', 'distribute', '垂直等距分布', AlignVerticalDistributeCenter],
  ] as const
  const buttons = (controls: readonly typeof positions[number][]) => controls.map(([axis, mode, title, Icon]) => <button
    type="button" key={`${axis}:${mode}`} title={tr(title)} aria-label={tr(title)}
    disabled={!availability[mode === 'distribute' ? 'distribute' : 'align']}
    onClick={event => {
      alignSelection(editor, axis, mode)
      event.currentTarget.closest('details')?.removeAttribute('open')
    }}><Icon size={16}/></button>)
  return <div className={`alignment-controls${compact ? ' compact-alignment' : ''}`} role="group" aria-label={tr(compact ? "对齐" : "对齐与翻转")}>
    {buttons(compact ? positions.slice(0, 6) : positions)}
    {compact ? <details className="alignment-more" onKeyDown={event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return
      event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus()
    }}>
      <summary aria-label={tr("更多对齐选项")} title={tr("更多对齐选项")}><MoreHorizontal size={16}/></summary>
      <div>{buttons(positions.slice(6))}</div>
    </details> : <FlipControls editor={editor}/>}
    {compact && uiMode === 'sketch' && <button type="button" title={tidyLabel} aria-label={tidyLabel}
      disabled={!canTidySelection(editor, availability.distribute)} onPointerEnter={() => previewTidy(editor)}
      onPointerLeave={() => editor.setLiveArrangement(null)} onBlur={() => editor.setLiveArrangement(null)}
      onClick={() => tidySelection(editor)}><Grid2X2 size={16} /></button>}
  </div>
}
