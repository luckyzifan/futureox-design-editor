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
const hiddenBorders = new WeakMap<Editor, { session: number; layers: Map<string, VisibilityRow[]> }>()

/** The inspector's border toggles own visibility; the paint inside a border
 * keeps its existing enabled flag. Remember the individual row choices. */
export function toggleSelectionBorders(editor: Editor) {
  const { doc, version } = editor.state
  const session = editor.sessionGeneration
  let remembered = hiddenBorders.get(editor)
  if (remembered?.session !== session) {
    remembered = { session, layers: new Map() }
    hiddenBorders.set(editor, remembered)
  }
  const targets = editor.topSelection().map(id => doc.nodes[id])
    .filter(node => node.strokes.length && !node.styleRefs?.strokes)
  const hide = targets.some(node => node.strokes.some(border => border.visible))
  const changes = new Map<string, VisibilityRow[]>()
  const saved = new Map<string, VisibilityRow[]>()
  for (const node of targets) {
    if (hide) {
      if (!node.strokes.some(border => border.visible)) continue
      saved.set(node.id, node.strokes.map(({ id, visible }) => ({ id, visible })))
      changes.set(node.id, node.strokes.map(({ id }) => ({ id, visible: false })))
    } else {
      const previous = remembered.layers.get(node.id)
      if (previous && previous.length === node.strokes.length &&
          previous.every(({ id }) => node.strokes.some(border => border.id === id))) changes.set(node.id, previous)
    }
  }
  if (!changes.size) return
  editor.updateProperties([...changes.keys()], node => {
    const next = changes.get(node.id)!
    for (const border of node.strokes) {
      const row = next.find(({ id }) => id === border.id)
      if (row) border.visible = row.visible
    }
  }, hide ? '隐藏描边' : '恢复描边')
  if (editor.sessionGeneration !== session || editor.state.version !== version + 1) return
  if (hide) for (const [id, rows] of saved) remembered.layers.set(id, rows)
}
