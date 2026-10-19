import { useEffect, useState } from 'react'
import type { WorkspaceRootBridge } from './desktop'

/** The renderer receives only a label and opaque selection capability. */
export function WorkspaceRootControls({ bridge, busy, onChoose }: {
  bridge: WorkspaceRootBridge; busy: boolean; onChoose: (original: boolean) => void
}) {
  const [refresh, setRefresh] = useState(0)
  const [checking, setChecking] = useState(true)
  const [state, setState] = useState<{ label: string; canSwitch: boolean; isDefault: boolean; error?: string }>({ label: '正在读取工作区…', canSwitch: false, isDefault: false })
  useEffect(() => {
    let active = true
    setChecking(true)
    void bridge.status().then(result => {
      if (!active) return
      if (result.status === 'ok') setState({ label: result.displayName, canSwitch: result.canSwitch, isDefault: result.isDefault })
      else setState({ label: '工作区不可用', canSwitch: false, isDefault: false, error: result.status === 'cancelled' ? '读取已取消' : result.message })
    }).catch(error => { if (active) setState({ label: '工作区不可用', canSwitch: false, isDefault: false, error: String(error) }) })
      .finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [bridge, refresh])
  return <section aria-label="本地工作区">
    <p>当前工作区：{state.label}</p>
    {state.error && <p role="alert">{state.error}</p>}
    <p>每个工作区保存多个设计文件，每个设计文件包含多个页面。切换前会检查未保存修改，然后重新打开应用。</p>
    {!state.canSwitch && !state.error && state.label !== '正在读取工作区…' && <p>请先关闭此应用的其他本地窗口，再切换工作区。</p>}
    <button type="button" disabled={busy || checking || !state.canSwitch} onClick={() => onChoose(false)}>切换本地工作区…</button>
    <button type="button" disabled={busy || checking || !state.canSwitch || state.isDefault} onClick={() => onChoose(true)}>打开原默认工作区</button>
    <button type="button" disabled={busy || checking} onClick={() => setRefresh(value => value + 1)}>重新检查窗口</button>
  </section>
}

/** Staging can be cancelled without closing the settings UI. Activation uses
 * the native close handshake, which owns dirty-document/recovery validation. */
export async function chooseWorkspaceRoot(bridge: WorkspaceRootBridge, original: boolean, beforeActivate: () => void): Promise<string | undefined> {
  const selection = await (original ? bridge.useDefault() : bridge.select())
  if (selection.status === 'cancelled') return
  if (selection.status !== 'ok') return selection.message
  beforeActivate()
  const activated = await bridge.activate({ selectionId: selection.selectionId })
  if (activated.status === 'error' || activated.status === 'conflict') return activated.message
  // restarting only acknowledges a requested close; it is not restart success.
}
