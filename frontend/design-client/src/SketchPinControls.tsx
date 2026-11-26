import { useState } from 'react'
import { ActionContextMenu } from './ActionContextMenu'
import { dispatchEditorCommand } from './editor-commands'
import type { Editor } from './engine'
import { editSketchPin, setSketchPinPreset } from './layout-constraints'
import type { DesignNode } from './model'
import { usePropertyText } from './property-interface-messages'

const edges = [
  ['top', 'vertical', 'start', '顶部'],
  ['left', 'horizontal', 'start', '左侧'],
  ['right', 'horizontal', 'end', '右侧'],
  ['bottom', 'vertical', 'end', '底部'],
] as const

const presets = [
  ['all', '钉扎全部边'],
  ['none', '取消全部钉扎'],
  ['default', '恢复默认钉扎'],
] as const

export function SketchPinControls({ editor, node, disabled }: { editor: Editor; node: DesignNode; disabled: boolean }) {
  const { tr } = usePropertyText()
  const [menu, setMenu] = useState<{ point: { x: number; y: number }; trigger: HTMLElement | null; version: number } | null>(null)
  const activeMenu = !disabled && menu?.version === editor.state.version ? menu : null
  const autoPin = () => void dispatchEditorCommand(editor, 'auto-pin-selection')
  const menuAction = (action: () => void) => {
    if (!activeMenu) return
    setMenu(null)
    activeMenu.trigger?.focus({ preventScroll: true })
    action()
  }
  return <div className="constraint-box sketch-constraint-box" role="group" aria-label={tr('父画板尺寸约束')}
    onContextMenu={event => {
      if (disabled) return
      event.preventDefault()
      event.stopPropagation()
      const button = (event.target instanceof Element ? event.target.closest('button') : null)
        ?? event.currentTarget.querySelector<HTMLButtonElement>('.edge-center')
      setMenu({ point: { x: event.clientX, y: event.clientY }, trigger: button, version: editor.state.version })
    }}
    onKeyDown={event => {
      if (disabled || event.repeat || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      event.stopPropagation()
      if (!(event.target instanceof HTMLElement)) return
      const bounds = event.target.getBoundingClientRect()
      setMenu({ point: { x: bounds.left, y: bounds.bottom }, trigger: event.target, version: editor.state.version })
    }}>
    {edges.map(([edge, axis, anchor, label]) => {
      const current = node.constraints?.[axis]
      return <button type="button" key={edge} className={`constraint-edge edge-${edge}`} aria-label={tr(label)}
        title={tr('按住 Option 修改此轴的钉扎')} aria-pressed={current === anchor || current === 'stretch'} disabled={disabled}
        onClick={event => {
          const alternate = event.altKey
          editor.updateProperties([node.id], target => editSketchPin(target, axis, anchor, alternate), '修改约束')
        }} />
    })}
    <button type="button" className="constraint-edge edge-center" aria-label={tr('自动固定选区')}
      title={tr('自动固定选区')} onClick={autoPin} disabled={disabled}><span aria-hidden="true">A</span></button>
    {activeMenu && <ActionContextMenu point={activeMenu.point} label={tr('钉扎操作')}
      returnFocus={activeMenu.trigger} onClose={() => setMenu(null)}>
      <button type="button" role="menuitem" onClick={() => menuAction(autoPin)}>{tr('自动固定选区')}</button>
      {presets.map(([value, label]) => <button type="button" role="menuitem" key={value}
        onClick={() => menuAction(() => {
          editor.updateProperties([node.id], target => setSketchPinPreset(target, value), '修改约束')
        })}>
        {tr(label)}
      </button>)}
    </ActionContextMenu>}
  </div>
}
