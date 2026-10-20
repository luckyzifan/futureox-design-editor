import { desktopPet, type PetMode } from './desktop-pet'
import { InterfaceSettings } from './AdaptivePanels'
import { interfacePreference } from './interface-preference'
import { LocalDiagnosticsPanel } from './LocalDiagnosticsPanel'
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { NudgeSettings } from './NudgeSettings'
import { nudgePreference } from './nudge-preference'
import { KeyboardProfileSettings } from './KeyboardProfileSettings'
import { shortcutPreference } from './shortcut-preference'
import { settingsPreference, useSettingsPersistence, type CanvasSetting } from './settings-preference'
import './settings-dialog.css'

type SettingsSection = 'input' | 'canvas' | 'saving' | 'diagnostics'
const sections: { id: SettingsSection; label: string }[] = [
  { id: 'input', label: '操作习惯' }, { id: 'canvas', label: '画布辅助' }, { id: 'saving', label: '保存与范围' }, { id: 'diagnostics', label: '错误日志' },
]
const canvasControls: { key: CanvasSetting; label: string; detail: string }[] = [
  { key: 'snap', label: '智能吸附', detail: '移动图层时对齐附近图层与参考线。' },
  { key: 'snapPixels', label: '吸附到像素网格', detail: '创建、移动和调整图层时使用像素对齐。' },
  { key: 'pixelGrid', label: '像素网格', detail: '缩放到 400% 及以上时显示单像素网格。' },
  { key: 'rulers', label: '标尺与参考线', detail: '显示标尺及文档参考线；参考线内容仍属于当前文档。' },
  { key: 'checkerboard', label: '棋盘格背景', detail: '用棋盘格查看透明区域，不改变页面背景颜色。' },
  { key: 'grid', label: '画布网格', detail: '显示画布的辅助网格，不写入导出的图像。' },
]

/** The parent binds bindEditorSettings(editor) for the complete Editor lifetime. */
export function SettingsDialog({ editor, onClose, desktop = false, returnFocus, workspaceControls, busy = false }: {
  editor: Editor
  onClose: () => void
  desktop?: boolean
  returnFocus?: HTMLElement | null
  workspaceControls?: ReactNode
  busy?: boolean
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const persistence = useSettingsPersistence()
  const petMode = useSyncExternalStore(desktopPet.subscribe, desktopPet.snapshot)
  const petStatus = useSyncExternalStore(desktopPet.subscribe, desktopPet.statusSnapshot)
  const nudgePersistence = useSyncExternalStore(nudgePreference.subscribe, nudgePreference.getPersistenceSnapshot)
  const id = useId(), dialog = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null), close = useRef(onClose), closing = useRef(false)
  const restoreTarget = useRef(returnFocus), [section, setSection] = useState<SettingsSection>('input')
  const [message, setMessage] = useState(''), [wheelTemporary, setWheelTemporary] = useState(false)
  const [keyboardReset, setKeyboardReset] = useState(0)
  close.current = onClose
  const dismiss = () => { if (!busy && !closing.current) { closing.current = true; close.current() } }
  const controls = () => [...(dialog.current?.querySelectorAll<HTMLElement>(
    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
  ) || [])].filter(element => element.tabIndex >= 0 && !element.closest('[hidden],[inert]') && element.getAttribute('aria-hidden') !== 'true')

  useLayoutEffect(() => {
    const previous = restoreTarget.current || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const bodyOverflow = document.body.style.overflow
    // Inert removes the background from keyboard and assistive-technology navigation.
    // Restore exact prior attributes, including a pre-existing inert owner.
    const background = [...document.body.children].filter(element => element !== backdrop.current)
      .map(element => ({ element, inert: element.getAttribute('inert') }))
    for (const { element } of background) element.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    ;(closeButton.current?.disabled ? dialog.current : closeButton.current)?.focus({ preventScroll: true })
    const retainFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) (closeButton.current?.disabled ? dialog.current : closeButton.current)?.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', retainFocus)
    return () => {
      document.removeEventListener('focusin', retainFocus)
      for (const { element, inert } of background) {
        if (inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', inert)
      }
      document.body.style.overflow = bodyOverflow
      const target = previous?.isConnected && !previous.closest('[inert]') && previous !== document.body
        ? previous : document.querySelector<HTMLElement>('[data-testid="canvas"]')
      target?.focus({ preventScroll: true })
    }
  }, [])

  const setWheel = (enabled: boolean) => {
    editor.setScrollWheelZoom(enabled)
    let persisted = false
    try { persisted = localStorage.getItem('forma-scroll-wheel-zoom') === String(enabled) } catch { /* Denied storage remains session-only. */ }
    setWheelTemporary(!persisted)
    return persisted
  }
  const restoreDefaults = () => {
    const petSaved = desktopPet.configure('off')
    const interfaceSaved = interfacePreference.reset()
    const canvasSaved = settingsPreference.reset()
    const keyboardSaved = shortcutPreference.set('figma-like')
    const nudgeSaved = nudgePreference.reset()
    const wheelSaved = setWheel(false)
    setKeyboardReset(value => value + 1)
    setMessage(petSaved && interfaceSaved && canvasSaved && keyboardSaved && nudgeSaved && wheelSaved ? '已恢复当前配置的偏好默认值。' : '已恢复默认值；部分偏好仅在本次会话生效。')
  }

  return createPortal(<div ref={backdrop} className="settings-backdrop"
    onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) dismiss() }}
    onPointerUp={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <section ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-busy={busy || undefined} aria-labelledby={`${id}-title`} aria-describedby={`${id}-scope`} tabIndex={-1}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') { event.preventDefault(); if (!event.repeat) dismiss(); return }
        if (event.key !== 'Tab') return
        const enabled = controls(), first = enabled[0], last = enabled.at(-1)
        if (!first) { event.preventDefault(); dialog.current?.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !enabled.includes(document.activeElement as HTMLElement))) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !enabled.includes(document.activeElement as HTMLElement))) {
          event.preventDefault(); first.focus()
        }
      }}>
      <header className="settings-header">
        <div><h2 id={`${id}-title`}>设置</h2><p id={`${id}-scope`}>当前应用偏好 · 更改立即生效，保存在当前应用配置中。</p></div>
        <button ref={closeButton} type="button" aria-label="关闭设置" disabled={busy} onClick={dismiss}>×</button>
      </header>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {sections.map(({ id: value, label }, index) => <button key={value} type="button" role="tab" id={`${id}-tab-${value}`}
            aria-controls={`${id}-panel-${value}`} aria-selected={section === value} tabIndex={section === value ? 0 : -1}
            onClick={() => setSection(value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
                : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + sections.length) % sections.length
              setSection(sections[next].id)
              document.getElementById(`${id}-tab-${sections[next].id}`)?.focus()
            }}>{label}</button>)}
        </div>
        <div className="settings-content">
          <section role="tabpanel" id={`${id}-panel-input`} aria-labelledby={`${id}-tab-input`} hidden={section !== 'input'}>
            <h3>键盘</h3>
            <KeyboardProfileSettings key={keyboardReset} />
            <NudgeSettings key={`nudge-${keyboardReset}`} />
            <h3>画布导航</h3>
            <label className="settings-toggle"><input type="checkbox" checked={state.scrollWheelZoom} aria-describedby={`${id}-wheel-help`}
              onChange={event => { setMessage(''); setWheel(event.target.checked) }} /><span>滚轮围绕鼠标缩放</span></label>
            <p className="settings-help" id={`${id}-wheel-help`}>关闭时，滚轮平移；Ctrl / ⌘＋滚轮及触控板捏合仍可缩放。空格拖动或 H 手形工具平移。</p>
          </section>
          <section role="tabpanel" id={`${id}-panel-canvas`} aria-labelledby={`${id}-tab-canvas`} hidden={section !== 'canvas'}>
            <InterfaceSettings />
            <h3>显示与吸附</h3>
            <p className="settings-help">与画布视图菜单共用同一组偏好。切换显示辅助不会修改文档内容或历史记录。</p>
            {canvasControls.map(({ key, label, detail }) => <div className="settings-control" key={key}>
              <label className="settings-toggle"><input type="checkbox" checked={!!state[key]} aria-describedby={`${id}-${key}-help`}
                onChange={event => { setMessage(''); editor.set({ [key]: event.target.checked }) }} /><span>{label}</span></label>
              <p id={`${id}-${key}-help`} className="settings-help">{detail}</p>
            </div>)}
          </section>
          <section role="tabpanel" id={`${id}-panel-saving`} aria-labelledby={`${id}-tab-saving`} hidden={section !== 'saving'}>
            {workspaceControls}
            {desktop && <div className="settings-control"><label htmlFor={`${id}-pet`}>Nomi 桌面伙伴</label>
              <select id={`${id}-pet`} value={petMode} onChange={event => { const saved = desktopPet.configure(event.target.value as PetMode); setMessage(saved ? '' : '桌面伙伴偏好仅在本次会话生效。') }}>
                <option value="off">关闭（默认）</option><option value="quiet">安静</option><option value="active">活跃</option>
              </select><p className="settings-help">可选的本机桌面伙伴。仅响应编辑、保存等操作状态，不读取文档内容；移动或缩放画布时暂停动作。模式为已保存的偏好，实际运行可能因桌面窗口或后端状态而变化。</p>
              {petStatus === 'unavailable' && <p className="settings-help" role="status">桌面伙伴暂不可用；编辑不受影响。请先关闭再开启。</p>}
              {petStatus === 'checking' && <p className="settings-help" role="status">正在确认桌面伙伴状态…</p>}
            </div>}
            <h3>当前保存方式</h3>
            {desktop ? <p>桌面端在修改停顿约 600 毫秒后安排本机恢复副本；支持本机文档库时，也会在完成编辑后保存到文档库。外部 .fd 文件请使用“保存”或“另存为”。</p>
              : <p>浏览器端在修改停顿约 350 毫秒后安排保存到本机浏览器文档库。首次恢复完成后才会开始自动保存；清除网站数据会影响本机文件，请定期导出 .fd 备份。</p>}
            <p className="settings-help">以上是当前保存机制的说明，间隔不可在此调整。待完成的输入、拖动、恢复失败或存储错误可能延后保存，请以工作区保存状态和错误提示为准。</p>
            <h3>偏好与文档</h3>
            <p>本页偏好保存在当前应用配置中，不会同步到其他设备。{desktop ? '独立打开的本地窗口使用各自配置，偏好不保证跨窗口共享或在新窗口中恢复。' : '使用其他浏览器或清除网站数据后，需要重新设置。'}文档色彩设置、页面背景与参考线内容属于各自文档，仍在对应文档工具中编辑。</p>
            <p className="settings-help">恢复默认值只重置本页的快捷键、微移步长、滚轮行为、画布辅助、桌面伙伴及界面偏好，不删除文档或修改渲染精度。</p>
          </section>
          <section role="tabpanel" id={`${id}-panel-diagnostics`} aria-labelledby={`${id}-tab-diagnostics`} hidden={section !== 'diagnostics'}>
            {section === 'diagnostics' && <LocalDiagnosticsPanel />}
          </section>
        </div>
      </div>
      <footer className="settings-footer">
        <div className="settings-status" role="status" aria-live="polite">
          {message || ((persistence === 'session-only' || nudgePersistence === 'session-only' || wheelTemporary) ? '当前存储不可用；部分偏好仅在本次会话生效。' : '更改立即生效。偏好会尝试保存在当前配置。')}
        </div>
        <div className="settings-actions"><button type="button" className="secondary" disabled={busy} onClick={restoreDefaults}>恢复偏好默认值</button><button type="button" className="primary" disabled={busy} onClick={dismiss}>完成</button></div>
      </footer>
    </section>
  </div>, document.body)
}
