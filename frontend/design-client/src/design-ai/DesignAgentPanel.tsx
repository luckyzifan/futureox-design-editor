import type { Editor } from '../engine'
import type { DesktopBridge } from '../desktop'
import { modalKeyDown } from '../modal-keyboard'
import { DesignImageAssistant } from './DesignImageAssistant'
import './design-agent.css'

export default function DesignAgentPanel({ editor, desktop, onClose }: { editor: Editor; desktop?: DesktopBridge | null; onClose(): void }) {
  return <div className="modal-backdrop"><section className="remote-modal design-agent-panel" role="dialog" aria-modal="true" aria-label="设计助手"
    onKeyDown={event => modalKeyDown(event, onClose)}>
    <h2>设计助手<button autoFocus type="button" onClick={onClose}>关闭</button></h2>
    <DesignImageAssistant editor={editor} bridge={desktop?.designAi}/>
  </section></div>
}
