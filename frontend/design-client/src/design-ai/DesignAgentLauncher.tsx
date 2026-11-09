import { useEffect, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { Sparkles } from 'lucide-react'
import type { Editor } from '../engine'
import type { DesktopBridge } from '../desktop'
import { commitPendingEdits } from '../pending-edits'
import { getAgentDock, openAgentDock, setAgentDockOpen, subscribeAgentDock } from './design-agent-dock'
import { AGENT_TARGET_EVENT, type AgentTargetDetail } from './target-event'

export function DesignAgentLauncher({ editor, disabled }: {
  editor: Editor
  desktop?: DesktopBridge | null
  disabled: boolean
  onImport?: (file: File, mode: 'open' | 'append') => void
}) {
  const open = useSyncExternalStore(subscribeAgentDock, () => getAgentDock().open)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (disabled) setAgentDockOpen(false) }, [disabled])
  useEffect(() => {
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<AgentTargetDetail>).detail
      if (!detail?.pageId || disabled) return
      if (!editor.state.busy && !editor.interactionActive && commitPendingEdits(editor)) openAgentDock(detail)
    }
    window.addEventListener(AGENT_TARGET_EVENT, onTarget)
    return () => window.removeEventListener(AGENT_TARGET_EVENT, onTarget)
  }, [disabled, editor])
  return <button type="button" className="design-agent-toggle" ref={trigger} aria-label="设计助手" title="设计助手"
    aria-pressed={open} aria-expanded={open} aria-controls="design-agent-dock" disabled={disabled}
    onClick={() => {
      if (open) { setAgentDockOpen(false); return }
      if (!editor.state.busy && !editor.interactionActive && commitPendingEdits(editor)) openAgentDock()
    }}><Sparkles size={16}/><span>设计助手</span></button>
}
