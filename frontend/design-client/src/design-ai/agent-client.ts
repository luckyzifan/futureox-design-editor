import type { DesktopBridge } from '../desktop'
import type { Editor } from '../engine'
import type { DesignDocument, DesignNode } from '../model'

export type AgentFailure = { code: string; status?: number; message: string }

export type AgentTurn = {
  sessionId: string
  skills: string[]
  items: Array<Record<string, unknown>>
  operations: Array<{ method: string; params: Record<string, unknown> }>
  mutationId: string
  assistant: string
  targetPageId: string
  summary: string
  documentId?: string
  session?: number
  revision?: number
  failure?: AgentFailure | null
}

/** Payload bound for one assistant turn. Depth may reach a targeted node inside this count. */
export const AGENT_CONTEXT_NODE_LIMIT = 64
const AGENT_CONTEXT_DEPTH = 64
const AGENT_CONTEXT_GRAPH = 100_000

type IndexedNode = { id: string; parentId: string | null; depth: number; pageId: string }

export function assistantLabel(assistant: string): string {
  if (assistant === 'local-rules' || assistant === 'grok-local' || assistant.includes('fallback-local')) return '本机规则模板'
  if (assistant.startsWith('ccswitch:')) return 'CC Switch 上游'
  if (assistant === 'token-plan') return '已配置的 Token plan'
  if (assistant === 'api') return '已配置的模型'
  return assistant
}

export function assistantStatus(assistant: string, failure?: AgentFailure | null): string {
  if (failure) return '任务状态：模型服务失败，画布没有修改。'
  const label = assistantLabel(assistant)
  if (label === '本机规则模板') return '执行者：本机规则模板。这不是已配置模型的结果。'
  return `执行者：${label}`
}

export function snapshotContext(editor: Editor, targetPageId: string, message = '') {
  const doc = editor.state.doc
  const targetKnown = doc.pages.some(page => page.id === targetPageId)
  const indexed = targetKnown ? indexPage(doc, targetPageId) : []
  const byId = new Map(indexed.map(item => [item.id, item]))
  const titles = indexed.filter(item => {
    const node = doc.nodes[item.id]
    return node?.kind === 'text' && node.name.includes('标题')
  })
  const chosen: string[] = []
  const add = (id: string) => {
    if (chosen.length >= AGENT_CONTEXT_NODE_LIMIT || chosen.includes(id) || !byId.has(id)) return
    chosen.push(id)
  }
  const addWithAncestors = (id: string) => {
    add(id)
    for (const ancestor of ancestorIds(indexed, id)) add(ancestor)
  }
  if (message.includes('标题')) for (const title of titles) addWithAncestors(title.id)
  for (const id of editor.state.selection) if (byId.has(id)) addWithAncestors(id)
  if (!message.includes('标题')) for (const title of titles) addWithAncestors(title.id)
  for (const item of indexed) add(item.id)
  const nodes = chosen.map(id => nodeSnapshot(doc.nodes[id], byId.get(id)!))
  if (targetKnown && nodes.length < AGENT_CONTEXT_NODE_LIMIT) {
    for (const page of doc.pages) {
      if (page.id === targetPageId || nodes.length >= AGENT_CONTEXT_NODE_LIMIT) continue
      for (const item of indexPage(doc, page.id)) {
        if (nodes.length >= AGENT_CONTEXT_NODE_LIMIT) break
        if (nodes.some(node => node.id === item.id)) continue
        const node = doc.nodes[item.id]
        if (node) nodes.push(nodeSnapshot(node, item))
      }
    }
  }
  const omissions: string[] = []
  if (indexed.length > chosen.length) omissions.push(`目标页还有 ${indexed.length - chosen.length} 个图层没有进入这次上下文（上限 ${AGENT_CONTEXT_NODE_LIMIT}）。`)
  if (titles.some(item => !chosen.includes(item.id))) omissions.push('目标页的标题没有全部进入这次上下文。被省略不等于页面里没有标题。')
  return {
    current_page_id: editor.state.page,
    target_page_id: targetPageId,
    pages: doc.pages.map(page => ({ id: page.id, name: page.name })),
    nodes,
    selection: editor.state.selection,
    omissions,
    document_id: doc.id,
    session: editor.sessionGeneration,
    revision: editor.state.version,
  }
}

function indexPage(doc: DesignDocument, pageId: string): IndexedNode[] {
  const page = doc.pages.find(item => item.id === pageId)
  if (!page) return []
  const out: IndexedNode[] = []
  const stack = [...page.children].reverse().map(id => ({ id, parentId: null as string | null, depth: 0 }))
  const seen = new Set<string>()
  while (stack.length && seen.size < AGENT_CONTEXT_GRAPH) {
    const item = stack.pop()!
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const node = doc.nodes[item.id]
    if (!node) continue
    out.push({ ...item, pageId })
    if (item.depth >= AGENT_CONTEXT_DEPTH) continue
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push({ id: node.children[index], parentId: item.id, depth: item.depth + 1 })
  }
  return out
}

function ancestorIds(items: IndexedNode[], id: string): string[] {
  const parent = new Map(items.map(item => [item.id, item.parentId]))
  const chain: string[] = []
  const seen = new Set<string>()
  let at = parent.get(id) ?? null
  while (at && !seen.has(at)) {
    seen.add(at)
    chain.push(at)
    at = parent.get(at) ?? null
  }
  return chain
}

function nodeSnapshot(node: DesignNode, item: IndexedNode) {
  return {
    id: node.id, page_id: item.pageId, parent_id: item.parentId, name: node.name, kind: node.kind,
    x: node.transform[4], y: node.transform[5], width: node.width, height: node.height,
    text: node.kind === 'text' ? node.text : undefined,
    fill: node.fills.find(fill => fill.visible && fill.kind === 'solid')?.color,
    stroke: node.strokes.find(stroke => stroke.visible && stroke.paint.kind === 'solid')?.paint.color,
    stroke_width: node.strokes.find(stroke => stroke.visible)?.width,
    stroke_align: node.strokes.find(stroke => stroke.visible)?.align,
    stroke_cap: node.strokes.find(stroke => stroke.visible)?.cap,
    stroke_join: node.strokes.find(stroke => stroke.visible)?.join,
    stroke_dash: node.strokes.find(stroke => stroke.visible)?.dash || undefined,
    opacity: node.opacity === 1 ? undefined : node.opacity,
    corner_radius: cornerRadius(node.radii),
    font_size: node.kind === 'text' ? node.fontSize : undefined,
    font_id: node.kind === 'text' ? node.textStyle?.fontId : undefined,
  }
}

function cornerRadius(radii: [number, number, number, number]) {
  const [a, b, c, d] = radii
  if (!a && !b && !c && !d) return undefined
  return a === b && b === c && c === d ? String(a) : `${a},${b},${c},${d}`
}

export async function cancelTurn(desktop: DesktopBridge | null | undefined, endpoint: string | undefined, sessionId: string) {
  try {
    if (desktop?.designAgent) {
      await desktop.designAgent.cancel({ sessionId })
      return
    }
    const root = (endpoint || '/api/agent').replace(/\/$/, '')
    await fetch(`${root}/v1/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })
  } catch {
    // A missed cancel still cannot apply: the caller drops a response from an older conversation.
  }
}

export async function requestTurn(desktop: DesktopBridge | null | undefined, endpoint: string | undefined, body: Record<string, unknown>): Promise<AgentTurn> {
  if (desktop?.designAgent) {
    const result = await desktop.designAgent.turn(body)
    if (result.status !== 'ok') throw new Error('message' in result ? result.message : '助手没有返回结果')
    return result.turn as AgentTurn
  }
  const root = (endpoint || '/api/agent').replace(/\/$/, '')
  const response = await fetch(`${root}/v1/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json() as AgentTurn & { error?: string }
  if (!response.ok) throw new Error(payload.error || '设计助手服务没有就绪')
  return payload
}
