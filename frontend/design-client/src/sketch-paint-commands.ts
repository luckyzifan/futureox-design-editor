import type { Editor } from './engine'
import { stroke, uid, type DesignNode } from './model'

function supportsPaintSwap(node: DesignNode) {
  return node.kind !== 'line' && node.kind !== 'slice' && !node.instanceOrigin &&
    !node.styleRefs?.fills && !node.styleRefs?.strokes && !node.textRuns?.some(run => run.color !== undefined) &&
    !Object.keys(node.bindings ?? {}).some(path => /^(fills|strokes)(\.|$)/.test(path)) &&
    node.fills.every(fill => fill.kind !== 'image') && node.strokes.every(border => border.paint.kind !== 'image')
}

export function selectedPaintSwap(editor: Editor) {
  const ids = editor.topSelection(true)
  const { doc } = editor.state
  const targets = ids.map(id => doc.nodes[id]).filter(node => node.fills.length || node.strokes.length)
  return ids.length === editor.topSelection().length && targets.every(supportsPaintSwap) ? targets : null
}

export function swapSelectionPaints(editor: Editor, rejection: string) {
  const targets = selectedPaintSwap(editor)
  if (!targets) { editor.notify(rejection); return }
  if (!targets.length) return
  editor.change('交换填充和描边', draft => {
    for (const node of targets) {
      const { fills, strokes } = node
      draft.nodes[node.id].fills = strokes.map((border, index) => ({
        ...border.paint,
        id: fills[index]?.id ?? uid(),
        visible: border.visible && border.paint.visible,
      }))
      draft.nodes[node.id].strokes = fills.map((fill, index) => {
        const border = strokes[index] ?? stroke()
        return { ...border, visible: fill.visible, paint: { ...fill, id: border.paint.id, visible: true } }
      })
    }
  })
}

type VisibilityRow = { id: string; visible: boolean }
type PaintStack = 'fills' | 'strokes'
const hiddenPaint = new WeakMap<Editor, {
  session: number
  fills: Map<string, VisibilityRow[]>
  strokes: Map<string, VisibilityRow[]>
}>()

/** Each row keeps its own enabled state when the selected stack is restored. */
export function toggleSketchPaintVisibility(editor: Editor, stack: PaintStack) {
  const { doc, version } = editor.state
  const session = editor.sessionGeneration
  let remembered = hiddenPaint.get(editor)
  if (remembered?.session !== session) {
    remembered = { session, fills: new Map(), strokes: new Map() }
    hiddenPaint.set(editor, remembered)
  }
  const targets = editor.topSelection().map(id => doc.nodes[id])
    .filter(node => node[stack].length && (!node.styleRefs?.[stack] || stack === 'fills' && node.sketchLayerStyleOverridden))
  const hide = targets.some(node => node[stack].some(row => row.visible))
  const changes = new Map<string, VisibilityRow[]>()
  const saved = new Map<string, VisibilityRow[]>()
  for (const node of targets) {
    const rows = node[stack]
    if (hide) {
      if (!rows.some(row => row.visible)) continue
      saved.set(node.id, rows.map(({ id, visible }) => ({ id, visible })))
      changes.set(node.id, rows.map(({ id }) => ({ id, visible: false })))
    } else {
      const previous = remembered[stack].get(node.id)
      if (previous && previous.length === rows.length &&
          previous.every(({ id }) => rows.some(row => row.id === id))) changes.set(node.id, previous)
    }
  }
  if (!changes.size) return
  editor.updateProperties([...changes.keys()], node => {
    const next = changes.get(node.id)!
    for (const row of node[stack]) {
      const state = next.find(({ id }) => id === row.id)
      if (state) row.visible = state.visible
    }
  }, `${hide ? '隐藏' : '恢复'}${stack === 'fills' ? '填充' : '描边'}`)
  if (editor.sessionGeneration !== session || editor.state.version !== version + 1) return
  if (hide) for (const [id, rows] of saved) remembered[stack].set(id, rows)
}
