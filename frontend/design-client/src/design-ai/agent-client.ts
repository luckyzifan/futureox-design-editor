import type { DesktopBridge } from '../desktop'
import type { Editor } from '../engine'

export type AgentTurn = {
  sessionId: string
  skills: string[]
  items: Array<Record<string, unknown>>
  operations: Array<{ method: string; params: Record<string, unknown> }>
  mutationId: string
  assistant: string
  targetPageId: string
  summary: string
}

export function snapshotContext(editor: Editor, targetPageId: string) {
  const doc = editor.state.doc
  const nodes: Array<Record<string, unknown>> = []
  const visit = (pageId: string, id: string, parentId: string | null, depth: number) => {
    const node = doc.nodes[id]
    if (!node || nodes.length >= 64) return
    nodes.push({
      id, page_id: pageId, parent_id: parentId, name: node.name, kind: node.kind,
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
    })
    if (depth < 3) node.children.forEach(child => visit(pageId, child, id, depth + 1))
  }
  for (const page of doc.pages) page.children.forEach(id => visit(page.id, id, null, 0))
  return {
    current_page_id: editor.state.page,
    target_page_id: targetPageId,
    pages: doc.pages.map(page => ({ id: page.id, name: page.name })),
    nodes,
    selection: editor.state.selection,
  }
}

function cornerRadius(radii: [number, number, number, number]) {
  const [a, b, c, d] = radii
  if (!a && !b && !c && !d) return undefined
  return a === b && b === c && c === d ? String(a) : `${a},${b},${c},${d}`
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
