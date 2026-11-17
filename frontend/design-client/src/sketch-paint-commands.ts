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
