import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from '../engine'
import type { DesktopBridge } from '../desktop'
import { agentAvailability, AGENT_CONNECTION_CHANGED, type AgentAvailability } from './agent-availability'
import { applyAgentOperations, explainApplyFailure, type AgentFence } from './apply-operations'
import { assistantStatus, cancelTurn, requestTurn, snapshotContext, type AgentTurn } from './agent-client'
import { compareUserFile, sketchRoundTripGaps, type DesignGap } from './format-gap'
import type { AgentTargetDetail } from './target-event'
import './design-agent.css'
import { useProfessionalDialogText } from '../professional-dialog-messages'

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
  const { locale, tr } = useProfessionalDialogText()
  const snapshot = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const [rows, setRows] = useState<Row[]>([])
  const [input, setInput] = useState(initial?.prompt || '')
  const [pinned, setPinned] = useState<string | null>(initial?.pageId ?? null)
  const pinnedDocument = useRef(editor.state.doc.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failurePrompt, setFailurePrompt] = useState<{ message: string; pageId: string } | null>(null)
  const [gaps, setGaps] = useState<DesignGap[]>([])
  const [gapLabel, setGapLabel] = useState('')
  const [actor, setActor] = useState('')
  const [availability, setAvailability] = useState<AgentAvailability | { tone: 'pending'; text: string } | null>(null)
  const session = useRef(`page-${crypto.randomUUID()}`)
  const sentInitial = useRef(false)
  const history = useRef<string[]>([])
  const generation = useRef(0)
  const file = useRef<HTMLInputElement>(null)
  const chosen = useRef<File | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const target = pinned && pinnedDocument.current === snapshot.doc.id ? pinned : snapshot.page
  const page = snapshot.doc.pages.find(item => item.id === target)
  const followingCurrent = target === snapshot.page

  useEffect(() => {
    if (!active || !desktop?.designAgent) return undefined
    let live = true
    let request = 0
    const refresh = () => {
      const ticket = ++request
      setAvailability({ tone: 'pending', text: '正在连接本机设计助手…' })
      void desktop.designAgent!.status().then(result => {
        if (live && ticket === request) setAvailability(agentAvailability(result))
      }).catch(failure => {
        if (live && ticket === request) setAvailability({ tone: 'error', text: failure instanceof Error ? failure.message : '设计助手不可用' })
      })
    }
    refresh()
    window.addEventListener(AGENT_CONNECTION_CHANGED, refresh)
    return () => { live = false; window.removeEventListener(AGENT_CONNECTION_CHANGED, refresh) }
  }, [active, desktop])

  const send = async (message: string, pageId = target, options?: { useLocalRules?: boolean }) => {
    const text = message.trim()
    if (!text || busy) return
    if (!editor.state.doc.pages.some(page => page.id === pageId)) {
      setError('指定的页面不在当前文档中')
      return
    }
    const ticket = generation.current
    const sessionId = session.current
    const context = snapshotContext(editor, pageId, text)
    const fence: AgentFence = { documentId: context.document_id, session: context.session, revision: context.revision }
    setBusy(true); setError(''); setFailurePrompt(null); setInput('')
    try {
      const turn = await requestTurn(desktop, endpoint, {
        session_id: sessionId,
        message: text,
        history: history.current,
        context,
        use_local_rules: options?.useLocalRules === true,
      })
      if (ticket !== generation.current) return
      history.current = [...history.current, text].slice(-12)
      if (turn.failure) {
        setActor(assistantStatus(turn.assistant, turn.failure))
        setError(turn.failure.message)
        setFailurePrompt({ message: text, pageId })
        setRows(current => rowsFrom(turn, current))
        return
      }
      if (turn.operations.length) {
        const applied = await applyAgentOperations(editor, turn.operations, turn.skills.includes('detail-adjust') ? '细节调整' : '一键出图', turn.mutationId, fence)
        if (ticket !== generation.current) return
        if (!applied.ok) {
          const reason = explainApplyFailure(applied.error)
          setError(reason)
          setActor('')
          setRows(current => [...current, { id: `user-${crypto.randomUUID()}`, role: 'user', text }, { id: `conflict-${crypto.randomUUID()}`, role: 'agent', text: reason }])
          return
        }
      }
      if (ticket !== generation.current) return
      setActor(assistantStatus(turn.assistant, null))
      setRows(current => rowsFrom(turn, current))
      const failed = !turn.operations.length ? turn.items.find(item => String(item.type) === 'McpToolCall' && String(item.status) === 'Failed') : undefined
      if (failed) setError(String(failed.error || turn.summary || '操作没有执行'))
      if (turn.targetPageId && editor.state.doc.pages.some(page => page.id === turn.targetPageId)) {
        pinnedDocument.current = editor.state.doc.id
        setPinned(turn.targetPageId)
      }
    } catch (failure) {
      if (ticket !== generation.current) return
      setError(failure instanceof Error ? failure.message : '设计助手失败')
    } finally { if (ticket === generation.current) setBusy(false) }
  }

  const appliedTarget = useRef<AgentTargetDetail | null>(null)
  useEffect(() => {
    if (!initial?.pageId || appliedTarget.current === initial) return
    appliedTarget.current = initial
    pinnedDocument.current = editor.state.doc.id
    if (!editor.state.doc.pages.some(page => page.id === initial.pageId)) {
      setPinned(initial.pageId)
      setError('指定的页面不在当前文档中')
      return
    }
    setPinned(initial.pageId)
    if (!initial.prompt) return
    if (initial.send === false) setInput(initial.prompt)
    else void send(initial.prompt, initial.pageId)
  }, [initial])
  const freshConversation = () => {
    const previous = session.current
    generation.current += 1
    session.current = `page-${crypto.randomUUID()}`
    history.current = []
    sentInitial.current = false
    setRows([]); setInput(''); setActor(''); setError(''); setFailurePrompt(null); setGaps([]); setGapLabel(''); setBusy(false)
    void cancelTurn(desktop, endpoint, previous)
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

  const targetLine = !page
    ? tr('指定页面已不存在')
    : locale === 'en'
      ? `${followingCurrent ? 'Edits' : 'Will edit'} “${page.name}”. ${tr('点名其他页面时，助手会改那一页。')}`
      : `${followingCurrent ? '默认改' : '将修改'}「${page.name}」。${tr('点名其他页面时，助手会改那一页。')}`
  return <aside className="design-agent-panel" aria-label={tr('设计助手')}>
    <header className="design-agent-header">
      <h2>{tr('设计助手')}</h2>
      <button type="button" onClick={freshConversation}>{tr('新对话')}</button>
      <button type="button" aria-pressed="true" onClick={onClose}>{tr('切换')}</button>
    </header>
    {availability?.text && <p className={`design-agent-mode is-${availability.tone}`} role={availability.tone === 'error' ? 'alert' : 'status'} data-agent-mode={availability.tone}>{tr(availability.text)}</p>}
    <p className="design-agent-target" data-target-page={target}>{targetLine}</p>
    {actor && <p role="status">{tr(actor)}</p>}
    <div className="design-agent-log" ref={scroller} aria-live="polite">
      {rows.length === 0 && <p className="design-agent-empty">{tr('用一键出图生成一整页，或悬停页面列表里的 AI 做定向修改。')}</p>}
      {rows.map(row => <article key={row.id} className={`design-agent-row is-${row.role}`} data-status={row.status || ''}>
        <span>{locale === 'en' ? (row.role === 'user' ? 'You' : row.role === 'plan' ? 'Plan' : row.role === 'tool' ? 'Action' : 'Assistant') : (row.role === 'user' ? '你' : row.role === 'plan' ? '计划' : row.role === 'tool' ? '操作' : '助手')}</span>
        <p>{row.text}</p>
      </article>)}
    </div>
    <details className="design-agent-compare">
      <summary>{tr('导入导出与 Fig / Sketch 差距')}</summary>
      <label className="design-agent-file">{tr('选择文件')}<input ref={file} aria-label={tr('选择 Fig 或 Sketch')} type="file" accept=".fig,.sketch" disabled={busy}
        onChange={event => { chosen.current = event.target.files?.[0] || null }} /></label>
      <div className="design-ai-actions">
        <button type="button" disabled={busy} onClick={() => void compare()}>{tr('查看差距')}</button>
        <button type="button" disabled={busy || !chosen.current} onClick={() => { const selected = chosen.current; if (selected) onImport?.(selected, 'append') }}>{tr('追加导入')}</button>
        <button type="button" disabled={busy || !chosen.current} onClick={() => { const selected = chosen.current; if (selected) onImport?.(selected, 'open') }}>{tr('打开为文档')}</button>
        <button type="button" disabled={busy} onClick={roundTrip}>{tr('导出 Sketch 并比较往返')}</button>
      </div>
      {gapLabel && <p role="status">{tr(gapLabel)}{gaps.length ? tr(` · ${gaps.length} 处差距`) : tr(' · 没有列出差距')}</p>}
      {!!gaps.length && <ul>{gaps.map(gap => <li key={`${gap.code}-${gap.detail}`}>{tr(gap.detail)}</li>)}</ul>}
    </details>
    <form className="design-agent-composer" onSubmit={event => { event.preventDefault(); void send(input) }}>
      <div className="design-ai-actions">
        <button type="button" disabled={busy} onClick={() => void send(input.trim() || tr('一键出图：做一个可编辑的产品落地页，标题、副标题和三个卖点'))}>{tr('一键出图')}</button>
        <button type="button" disabled={busy} onClick={() => void send(input.trim() || tr('细节调整：把这一页的标题对比加强，圆角 20'))}>{tr('细节调整')}</button>
      </div>
      <label>{tr('对话')}<textarea aria-label={tr('设计对话')} rows={3} value={input} disabled={busy} maxLength={4000}
        onChange={event => setInput(event.target.value)} placeholder={tr('例如：做一个咖啡品牌落地页，标题秋日特惠，卖点：产地、烘焙、门店')} /></label>
      <div className="design-ai-actions">
        <button type="submit" className="primary" disabled={busy || !input.trim()}>{tr('发送')}</button>
        {busy && <span role="status">{tr('正在执行…')}</span>}
      </div>
      {error && <p className="design-agent-failure" role="alert">{tr(error)}</p>}
      {failurePrompt && <div className="design-ai-actions">
        <button type="button" disabled={busy} onClick={() => void send(failurePrompt.message, failurePrompt.pageId)}>{tr('重试')}</button>
        <button type="button" disabled={busy} onClick={() => void send(failurePrompt.message, failurePrompt.pageId, { useLocalRules: true })}>{tr('使用本机规则模板')}</button>
      </div>}
    </form>
  </aside>
}
