import type { Editor } from '../engine'
import type { DesignDocument } from '../model'
import type { PluginCommit, PluginSnapshot, PluginTurn } from './protocol'

const snapshotBytes = 32 * 1024 * 1024

export function snapshotFromEditor(editor: Editor): PluginSnapshot {
  if (editor.interactionActive) throw new Error('画布正在编辑，插件未运行。')
  const doc = editor.state.doc
  const view = editor.effectiveView()
  const pages = structuredClone(doc.pages)
  const nodes = structuredClone(doc.nodes)
  if (new TextEncoder().encode(JSON.stringify({ pages, nodes })).byteLength > snapshotBytes) {
    throw new Error('当前文档超过插件快照上限（32MB），未运行插件。')
  }
  return {
    documentId: doc.id,
    documentName: doc.name,
    revision: editor.state.version,
    pageId: editor.state.page,
    pages,
    nodes,
    selection: editor.state.selection.filter(id => nodes[id]),
    viewport: { x: view.x, y: view.y, zoom: view.zoom },
  }
}

export function pluginEditLabel(name: string) {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
  return `插件 ${clean || 'plugin'}`
}

export function commitPluginResult(
  editor: Editor,
  label: string,
  expected: { documentId: string; revision: number },
  turn: PluginTurn,
) {
  const reject = (message: string) => {
    editor.notify(message)
    return { status: 'rejected' as const, revision: editor.state.version, message }
  }
  if (editor.interactionActive) return reject('画布正在编辑，插件修改已丢弃。')
  if (editor.state.doc.id !== expected.documentId || editor.state.version !== expected.revision) {
    return reject('文档已变化，插件修改已丢弃。')
  }
  const commit = turn.commit
  const surviving = new Set(Object.keys(editor.state.doc.nodes))
  for (const id of commit.deleted) surviving.delete(id)
  for (const id of Object.keys(commit.upserts)) surviving.add(id)
  const selection = commit.selection.filter(id => surviving.has(id))
  const pages = commit.pages ?? editor.state.doc.pages
  if (!pages.some(page => page.id === commit.pageId)) return reject('插件页面不存在，修改已丢弃。')
  let result: { status: 'committed' | 'unchanged' | 'rejected' | 'preview'; revision: number; message?: string }
  if (commit.mutated) {
    result = editor.change(label, doc => {
      applyPluginCommit(doc, commit)
    }, selection)
  } else {
    result = { status: 'unchanged', revision: editor.state.version }
    editor.set({
      selection: selection.filter(id => editor.state.doc.nodes[id]),
      page: commit.pageId,
    })
  }
  if (result.status !== 'committed' && result.status !== 'unchanged') {
    return { status: 'rejected' as const, revision: result.revision, message: result.message ?? '插件修改被拒绝。' }
  }
  if (result.status === 'committed' && editor.state.page !== commit.pageId) editor.set({ page: commit.pageId })
  const reveal = commit.reveal.filter(id => editor.state.doc.nodes[id])
  if (reveal.length) editor.requestReveal(reveal)
  const notes = [...turn.notifications, turn.closeMessage].filter((note): note is string => !!note)
  if (notes.length) editor.notify(notes.join(' '))
  return { status: result.status, revision: editor.state.version, message: notes.join(' ') }
}

export function applyPluginCommit(doc: DesignDocument, commit: PluginCommit) {
  if (commit.pages) doc.pages = commit.pages
  for (const id of commit.deleted) delete doc.nodes[id]
  for (const [id, sceneNode] of Object.entries(commit.upserts)) doc.nodes[id] = sceneNode
  const needsSchema4 = Object.values(doc.nodes).some(sceneNode =>
    Object.keys(sceneNode.bindings ?? {}).some(key => key.startsWith('figmaPlugin:')) ||
    sceneNode.fills.some(item => item.transform != null || item.kind === 'angular' || item.kind === 'diamond') ||
    sceneNode.strokes.some(item => item.paint.transform != null || item.paint.kind === 'angular' || item.paint.kind === 'diamond'))
  if (needsSchema4) doc.schemaVersion = Math.max(doc.schemaVersion, 4) as DesignDocument['schemaVersion']
}
