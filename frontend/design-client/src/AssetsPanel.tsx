import { useState } from 'react'
import { ActionContextMenu } from './ActionContextMenu'
import type { Editor } from './engine'
import { componentSources, family } from './components'
import { dispatchEditorCommand } from './editor-commands'
import { usePropertyText } from './property-interface-messages'
import { interfacePreference, useInterfacePreferences } from './interface-preference'
import { armComponentPlacement, cancelComponentPlacement } from './component-placement'
import { activateTool } from './tool-activation'
import { hasPendingEdits } from './pending-edits'

export function AssetsPanel({ editor }: { editor: Editor }) {
  const { tr } = usePropertyText()
  const { uiMode } = useInterfacePreferences()
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState<{
    id: string; point: { x: number; y: number }; trigger: HTMLButtonElement
    document: string; page: string; session: number
  } | null>(null)
  const doc = editor.state.doc
  const items = componentSources(doc).filter(
    (n) =>
      `${n.name} ${family(doc, n.id)?.name || ''}`.toLowerCase().includes(search.toLowerCase()),
  )
  const currentMenu = uiMode === 'figma' && menu && editor.sessionGeneration === menu.session &&
    doc.id === menu.document && editor.state.page === menu.page && doc.nodes[menu.id]?.component ? menu : null
  const openMenu = (id: string, trigger: HTMLButtonElement, x: number, y: number) => {
    cancelComponentPlacement(editor)
    setMenu({ id, trigger, point: { x, y }, document: doc.id, page: editor.state.page, session: editor.sessionGeneration })
  }
  const place = async () => {
    setMenu(null)
    if (!currentMenu) return
    await activateTool(editor, 'select')
    if (interfacePreference.getSnapshot().uiMode !== 'figma' ||
        editor.sessionGeneration !== currentMenu.session || editor.state.doc.id !== currentMenu.document ||
        editor.state.page !== currentMenu.page || hasPendingEdits(editor)) return
    if (armComponentPlacement(editor, currentMenu.id)) {
      document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
      editor.notify(tr('点击画布放置组件实例，按 Esc 取消'))
    }
  }
  const reveal = () => {
    setMenu(null)
    if (!currentMenu) return
    // The command router leaves keyboard ownership with a focused menu.
    currentMenu.trigger.focus({ preventScroll: true })
    void dispatchEditorCommand(editor, 'jump-to-node', { nodeId: currentMenu.id })
  }
  return (
    <div className="assets-panel">
      <input
        aria-label={tr('搜索组件')}
        placeholder={tr('搜索本地组件…')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <button
        className="text-button"
        disabled={!editor.state.selection.length}
        onClick={() => void dispatchEditorCommand(editor, 'create-component')}
      >
        {tr('◇ 从选择创建组件')}
      </button>
      <p className="muted">{tr('点击插入，或拖入画布')}</p>
      {items.map((n) => (
        <button
          className="component-asset"
          draggable
          key={n.id}
          aria-haspopup={uiMode === 'figma' ? 'menu' : undefined}
          onContextMenu={event => {
            if (uiMode !== 'figma') return
            event.preventDefault(); event.stopPropagation()
            const box = event.currentTarget.getBoundingClientRect()
            if (event.clientX || event.clientY) openMenu(n.id, event.currentTarget, event.clientX, event.clientY)
            else openMenu(n.id, event.currentTarget, box.left, box.bottom)
          }}
          onKeyDown={event => {
            if (uiMode !== 'figma' || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
            event.preventDefault(); event.stopPropagation()
            const box = event.currentTarget.getBoundingClientRect()
            openMenu(n.id, event.currentTarget, box.left, box.bottom)
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-forma-component', n.id)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => editor.insertComponent(n.id)}
        >
          <strong title={n.name}>◇ {n.name}</strong>
          <small>
            {family(doc, n.id)?.name || tr('本地组件')}
            {Object.keys(n.component!.variants).length
              ? ` · ${Object.values(n.component!.variants).join(' / ')}`
              : ''}
          </small>
        </button>
      ))}
      {currentMenu && <ActionContextMenu point={currentMenu.point} returnFocus={currentMenu.trigger}
        label={tr('组件操作')} onClose={() => setMenu(null)}>
        <button type="button" role="menuitem" onClick={() => void place()}>{tr('插入实例')}</button>
        <button type="button" role="menuitem" onClick={reveal}>{tr('查看主组件')}</button>
      </ActionContextMenu>}
      {!items.length && <p className="muted">{tr('暂无匹配的组件')}</p>}
    </div>
  )
}
