import { useEffect, useRef, useState } from 'react'
import type { Editor } from '../engine'
import type { DesktopBridge } from '../desktop'
import { agentAvailability, type AgentAvailability } from './agent-availability'
import { applyAgentOperations } from './apply-operations'
import { requestTurn, snapshotContext, type AgentTurn } from './agent-client'
import { compareUserFile, sketchRoundTripGaps, type DesignGap } from './format-gap'
import type { AgentTargetDetail } from './target-event'
import './design-agent.css'

type Row = { id: string; role: 'user' | 'agent' | 'plan' | 'tool'; text: string; status?: string }

function rowsFrom(turn: AgentTurn, previous: Row[]): Row[] {
  const next = [...previous]
  for (const item of turn.items) {
    const type = String(item.type || '')
    const id = String(item.id || `${type}-${next.length}`)
    if (type === 'UserMessage') next.push({ id, role: 'user', text: String(item.text || '') })
    else if (type === 'Plan') next.push({ id, role: 'plan', text: String(item.text || '') })
    else if (type === 'AgentMessage') next.push({ id, role: 'agent', text: String(item.text || '') })
    else if (type === 'McpToolCall') next.push({ id, role: 'tool', text: `${item.tool} · ${item.status}`, status: String(item.status || '') })
  }
  return next
}

export default function DesignAgentPanel({ editor, desktop, onClose, endpoint, initial, onImport, active = true }: {
  editor: Editor
  desktop?: DesktopBridge | null
  onClose(): void
  endpoint?: string
  initial?: AgentTargetDetail | null
  onImport?: (file: File, mode: 'open' | 'append') => void
  active?: boolean
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [input, setInput] = useState(initial?.prompt || '')
  const [target, setTarget] = useState(initial?.pageId || editor.state.page)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gaps, setGaps] = useState<DesignGap[]>([])
  const [gapLabel, setGapLabel] = useState('')
  const [assistant, setAssistant] = useState('')
  const [availability, setAvailability] = useState<AgentAvailability | { tone: 'pending'; text: string } | null>(null)
  const session = useRef(`page-${crypto.randomUUID()}`)
  const sentInitial = useRef(false)
  const history = useRef<string[]>([])
  const file = useRef<HTMLInputElement>(null)
  const chosen = useRef<File | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pageName = editor.state.doc.pages.find(page => page.id === target)?.name || '当前页'
  useEffect(() => {
    if (!active || !desktop?.designAgent) return undefined
    let live = true
    setAvailability({ tone: 'pending', text: '正在连接本机设计助手…' })
    void desktop.designAgent.status().then(result => {
      if (live) setAvailability(agentAvailability(result))
    }).catch(failure => {
      if (live) setAvailability({ tone: 'error', text: failure instanceof Error ? failure.message : '设计助手不可用' })
    })
    return () => { live = false }
  }, [active, desktop])

  const send = async (message: string, pageId = target) => {
    const text = message.trim()
    if (!text || busy) return
    setBusy(true); setError(''); setInput('')
    try {
      const turn = await requestTurn(desktop, endpoint, {
        session_id: session.current,
        message: text,
        history: history.current,
        context: snapshotContext(editor, pageId),
      })
      history.current = [...history.current, text].slice(-12)
      setAssistant(turn.assistant)
      setRows(current => rowsFrom(turn, current))
      if (turn.targetPageId && editor.state.doc.pages.some(page => page.id === turn.targetPageId)) setTarget(turn.targetPageId)
      if (turn.operations.length) {
        const applied = await applyAgentOperations(editor, turn.operations, turn.skills.includes('detail-adjust') ? '细节调整' : '一键出图', turn.mutationId)
        if (!applied.ok) throw new Error(applied.error?.message || '操作没有写入画布')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '设计助手失败')
    } finally { setBusy(false) }
  }

  const appliedTarget = useRef<AgentTargetDetail | null>(null)
  useEffect(() => {
    if (!initial?.pageId || appliedTarget.current === initial) return
    appliedTarget.current = initial
    setTarget(initial.pageId)
    if (!initial.prompt) return
    if (initial.send === false) setInput(initial.prompt)
    else void send(initial.prompt, initial.pageId)
  }, [initial])
  const freshConversation = () => {
    session.current = `page-${crypto.randomUUID()}`
    history.current = []
    sentInitial.current = false
    setRows([]); setInput(''); setAssistant(''); setError(''); setGaps([]); setGapLabel('')
  }
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [rows, busy])

  const compare = async () => {
    const selected = chosen.current
    if (!selected) { setError('先选择一个 .fig 或 .sketch 文件'); return }
    setBusy(true); setError('')
    try {
      const found = await compareUserFile(editor.state.doc, selected)
      setGaps(found); setGapLabel(selected.name)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '比较失败') }
    finally { setBusy(false) }
  }
  const roundTrip = () => {
    setError('')
    try {
      const report = sketchRoundTripGaps(editor.state.doc)
      setGaps(report.gaps); setGapLabel('当前文档 Sketch 往返')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Sketch 导出失败') }
  }

  return <aside className="design-agent-panel" aria-label="设计助手">
    <header className="design-agent-header">
      <h2>设计助手</h2>
      <button type="button" onClick={freshConversation}>新对话</button>
      <button type="button" aria-pressed="true" onClick={onClose}>切换</button>
    </header>
    {availability?.text && <p className={`design-agent-mode is-${availability.tone}`} role={availability.tone === 'error' ? 'alert' : 'status'} data-agent-mode={availability.tone}>{availability.text}</p>}
    <p className="design-agent-target">默认改「{pageName}」。点名其他页面时，助手会改那一页。</p>
    {assistant && <p role="status">模型：{assistant}</p>}
    <div className="design-agent-log" ref={scroller} aria-live="polite">
      {rows.length === 0 && <p className="design-agent-empty">用一键出图生成一整页，或悬停页面列表里的 AI 做定向修改。</p>}
      {rows.map(row => <article key={row.id} className={`design-agent-row is-${row.role}`} data-status={row.status || ''}>
        <span>{row.role === 'user' ? '你' : row.role === 'plan' ? '计划' : row.role === 'tool' ? '操作' : '助手'}</span>
        <p>{row.text}</p>
      </article>)}
    </div>
    <details className="design-agent-compare">
      <summary>导入导出与 Fig / Sketch 差距</summary>
      <label className="design-agent-file">选择文件<input ref={file} aria-label="选择 Fig 或 Sketch" type="file" accept=".fig,.sketch" disabled={busy}
        onChange={event => { chosen.current = event.target.files?.[0] || null }} /></label>
      <div className="design-ai-actions">
        <button type="button" disabled={busy} onClick={() => void compare()}>查看差距</button>
        <button type="button" disabled={busy || !chosen.current} onClick={() => { const selected = chosen.current; if (selected) onImport?.(selected, 'append') }}>追加导入</button>
        <button type="button" disabled={busy || !chosen.current} onClick={() => { const selected = chosen.current; if (selected) onImport?.(selected, 'open') }}>打开为文档</button>
        <button type="button" disabled={busy} onClick={roundTrip}>导出 Sketch 并比较往返</button>
      </div>
      {gapLabel && <p role="status">{gapLabel}{gaps.length ? ` · ${gaps.length} 处差距` : ' · 没有列出差距'}</p>}
      {!!gaps.length && <ul>{gaps.map(gap => <li key={`${gap.code}-${gap.detail}`}>{gap.detail}</li>)}</ul>}
    </details>
    <form className="design-agent-composer" onSubmit={event => { event.preventDefault(); void send(input) }}>
      <div className="design-ai-actions">
        <button type="button" disabled={busy} onClick={() => void send(input.trim() || '一键出图：做一个可编辑的产品落地页，标题、副标题和三个卖点')}>一键出图</button>
        <button type="button" disabled={busy} onClick={() => void send(input.trim() || '细节调整：把这一页的标题对比加强，圆角 20')}>细节调整</button>
      </div>
      <label>对话<textarea aria-label="设计对话" rows={3} value={input} disabled={busy} maxLength={4000}
        onChange={event => setInput(event.target.value)} placeholder="例如：做一个咖啡品牌落地页，标题秋日特惠，卖点：产地、烘焙、门店" /></label>
      <div className="design-ai-actions">
        <button type="submit" className="primary" disabled={busy || !input.trim()}>发送</button>
        {busy && <span role="status">正在执行…</span>}
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  </aside>
}
