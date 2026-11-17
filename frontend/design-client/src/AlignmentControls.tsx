import { usePropertyText } from './property-interface-messages'
import { useEffect, useRef, useState } from 'react'
import { AlignLeft, AlignCenterHorizontal, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical, FlipHorizontal2, FlipVertical2, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, MoreHorizontal, Grid2X2 } from 'lucide-react'
import type { Editor } from './engine'
import { alignmentAvailability, alignSelection, canTidySelection, previewAlignment, previewTidy, tidySelection } from './alignment-availability'
import { useInterfacePreferences } from './interface-preference'
import { dispatchEditorCommand } from './editor-commands'

export function FlipControls({ editor }: { editor: Editor }) {
  const { tr } = usePropertyText()
  const { uiMode, figmaPropertyLabels } = useInterfacePreferences()
  const showLabels = uiMode === 'figma' && figmaPropertyLabels
  const disabled = editor.state.busy || editor.interactionActive || !editor.topSelection().length
  return <>
    {([['flip-horizontal', '水平翻转', FlipHorizontal2], ['flip-vertical', '垂直翻转', FlipVertical2]] as const).map(([command, title, Icon]) =>
      <button type="button" key={command} title={tr(title)} aria-label={tr(title)} disabled={disabled}
        onClick={() => void dispatchEditorCommand(editor, command)}><Icon size={16}/>
        {showLabels && <span className="property-control-caption" aria-hidden="true">{tr(title)}</span>}</button>)}
  </>
}

export function AlignmentControls({ editor, compact = false }: { editor: Editor; compact?: boolean }) {
  const { tr } = usePropertyText()
  const { uiMode, locale, figmaPropertyLabels } = useInterfacePreferences()
  const availability = alignmentAvailability(editor)
  const sketch = uiMode === 'sketch'
  const showLabels = !sketch && figmaPropertyLabels
  const [optionHeld, setOptionHeld] = useState(false)
  const hovered = useRef<{ axis: 'x' | 'y'; mode: 'start' | 'center' | 'end' | 'distribute' } | null>(null)
  const clear = () => {
    hovered.current = null
    editor.setLiveArrangement(null)
  }
  const clearPreview = sketch ? clear : undefined
  useEffect(() => {
    if (!sketch) { setOptionHeld(false); return }
    const modifiers = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hovered.current = null
      if (event.key !== 'Alt') return
      setOptionHeld(event.altKey)
      const control = hovered.current
      if (control && control.mode !== 'distribute') previewAlignment(editor, control.axis, control.mode, event.altKey)
    }
    const blur = () => {
      hovered.current = null
      setOptionHeld(false)
      editor.setLiveArrangement(null)
    }
    window.addEventListener('keydown', modifiers, true)
    window.addEventListener('keyup', modifiers, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', modifiers, true)
      window.removeEventListener('keyup', modifiers, true)
      window.removeEventListener('blur', blur)
      hovered.current = null
    }
  }, [editor, sketch])
  const canAttemptFrame = sketch && optionHeld && !!editor.state.selection.length &&
    !editor.state.busy && !editor.interactionActive
  const tidyLabel = locale === 'en' ? 'Tidy' : '整理'
  const positions = [
    ['x', 'start', '左对齐', AlignLeft], ['x', 'center', '水平居中', AlignCenterHorizontal], ['x', 'end', '右对齐', AlignRight],
    ['y', 'start', '顶对齐', AlignStartVertical], ['y', 'center', '垂直居中', AlignCenterVertical], ['y', 'end', '底对齐', AlignEndVertical],
    ['x', 'distribute', '水平等距分布', AlignHorizontalDistributeCenter], ['y', 'distribute', '垂直等距分布', AlignVerticalDistributeCenter],
  ] as const
  const buttons = (controls: readonly typeof positions[number][]) => controls.map(([axis, mode, title, Icon]) => <button
    type="button" key={`${axis}:${mode}`} title={tr(title)} aria-label={tr(title)}
    disabled={mode === 'distribute' ? !availability.distribute : !availability.align && !canAttemptFrame}
    onPointerEnter={sketch ? event => {
      hovered.current = { axis, mode }
      setOptionHeld(event.altKey)
      previewAlignment(editor, axis, mode, event.altKey && mode !== 'distribute')
    } : undefined}
    onPointerLeave={clearPreview} onBlur={clearPreview}
    onClick={event => {
      hovered.current = null
      alignSelection(editor, axis, mode, sketch && event.altKey && mode !== 'distribute')
      event.currentTarget.closest('details')?.removeAttribute('open')
    }}><Icon size={16}/>
      {showLabels && <span className="property-control-caption" aria-hidden="true">{tr(title)}</span>}</button>)
  return <div className={`alignment-controls${compact ? ' compact-alignment' : ''}`} role="group" data-property-labels={showLabels || undefined} aria-label={tr(compact ? "对齐" : "对齐与翻转")}>
    {buttons(compact ? positions.slice(0, 6) : positions)}
    {compact ? <details className="alignment-more" onKeyDown={event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return
      clearPreview?.()
      event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus()
    }}>
      <summary aria-label={tr("更多对齐选项")} title={tr("更多对齐选项")}><MoreHorizontal size={16}/>
        {showLabels && <span className="property-control-caption" aria-hidden="true">{tr("更多对齐选项")}</span>}</summary>
      <div>{buttons(positions.slice(6))}</div>
    </details> : <FlipControls editor={editor}/>}
    {compact && sketch && <button type="button" title={tidyLabel} aria-label={tidyLabel}
      disabled={!canTidySelection(editor, availability.distribute)} onPointerEnter={() => previewTidy(editor)}
      onPointerLeave={clearPreview} onBlur={clearPreview}
      onClick={() => tidySelection(editor)}><Grid2X2 size={16} /></button>}
  </div>
}
