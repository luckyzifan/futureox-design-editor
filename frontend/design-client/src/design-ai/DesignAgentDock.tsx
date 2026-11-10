import { useSyncExternalStore } from 'react'
import type { Editor } from '../engine'
import type { DesktopBridge } from '../desktop'
import { getAgentDock, setAgentDockOpen, subscribeAgentDock } from './design-agent-dock'
import DesignAgentPanel from './DesignAgentPanel'
import './design-agent.css'

/** The chat stays mounted while hidden so toggling the dock does not start a new session. */
export function DesignAgentDock({ editor, desktop, onImport }: {
  editor: Editor
  desktop?: DesktopBridge | null
  onImport?: (file: File, mode: 'open' | 'append') => void
}) {
  const dock = useSyncExternalStore(subscribeAgentDock, getAgentDock)
  return <div id="design-agent-dock" className="design-agent-dock" hidden={!dock.open}>
    <DesignAgentPanel editor={editor} desktop={desktop} initial={dock.initial} onImport={onImport} active={dock.open}
      onClose={() => setAgentDockOpen(false)} />
  </div>
}
