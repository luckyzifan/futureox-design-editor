import { FIGMA_TOP_LEVEL_FRAME_DUPLICATE_GAP as gap, applyDuplication, prepareDuplication } from './commands/duplication-command'
import type { Editor } from './engine'
import { allParents, apply, bounds, boxPoints, multiply, translate, worldMatrix, type ParentMap } from './geometry'
import { interfacePreference } from './interface-preference'
import { interactivePath } from './selection-hierarchy'
import { commitPendingEdits } from './pending-edits'
import { node, type DesignDocument, type DesignNode } from './model'
import { rememberFigmaFrameSize } from './figma-frame-size'

export type FrameSide = -1 | 1

function availableFrame(doc: DesignDocument, page: string, id: string, parents: ParentMap) {
  const frame = doc.nodes[id], ownerId = parents.get(id)
  const section = ownerId === page ? undefined : doc.nodes[ownerId ?? '']
  if (!frame || frame.kind !== 'frame' || frame.graphic || frame.instance || frame.instanceOrigin ||
      ownerId !== page && section?.kind !== 'section') return undefined
  const path = interactivePath(doc, page, id, false, parents)
  if (!path.length || path.some(id => {
    const node = doc.nodes[id]
    return node.locked || node.instance || node.instanceOrigin
  })) return undefined
  const owner = section ?? doc.pages.find(item => item.id === page)
  if (!owner || section?.layout && section.layout.mode !== 'none') return undefined
  return { frame, owner, section }
}

export function hoveredAdjacentFrame(doc: DesignDocument, page: string, hit: string | null, parents: ParentMap) {
  for (let id = hit ?? undefined; id && id !== page; id = parents.get(id))
    if (availableFrame(doc, page, id, parents)) return id
  return null
}

function localBox(node: DesignNode) {
  return bounds(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(node.transform, point)))
}

export function addAdjacentFigmaFrame(editor: Editor, source: string, side: FrameSide, empty: boolean): boolean {
  if (interfacePreference.getSnapshot().uiMode !== 'figma' || editor.state.tool !== 'frame' ||
      editor.state.busy || editor.interactionActive || !editor.settleOwnedPropertyPreview('edit') || !commitPendingEdits(editor)) return false
  const { doc, page } = editor.state
  const parents = allParents(doc)
  const scope = availableFrame(doc, page, source, parents)
  if (!scope) return false
  const { frame, owner, section } = scope
  const box = localBox(frame), offset = side * (box.width + gap)
  const front = (box: ReturnType<typeof localBox>) => side > 0 ? box.x : -(box.x + box.width)
  const copyFront = front(box) + Math.abs(offset)
  // Only frames in the same row and on the requested side participate.
  const neighbours = owner.children.flatMap(id => {
    const other = doc.nodes[id]
    if (id === source || other?.kind !== 'frame' || !other.visible) return []
    const boxOther = localBox(other)
    if (boxOther.y >= box.y + box.height || box.y >= boxOther.y + boxOther.height ||
        side * (boxOther.x + boxOther.width / 2 - box.x - box.width / 2) <= 0) return []
    return [{ id, box: boxOther }]
  }).sort((a, b) => front(a.box) - front(b.box))
  let reach = copyFront + box.width + gap
  const moves = new Map<string, number>()
  for (const other of neighbours) {
    const current = front(other.box)
    if (current >= reach) break
    if (doc.nodes[other.id].locked || doc.nodes[other.id].instanceOrigin) {
      editor.notify('相邻画板已锁定，无法让出空位')
      return false
    }
    moves.set(other.id, side * (reach - current))
    reach += other.box.width + gap
  }

  const matrix = section && worldMatrix(doc, section.id, parents)
  const blankFrame = empty ? node('frame', 0, 0, frame.width, frame.height) : undefined
  const selected: string[] = []
  try {
    const plan = blankFrame ? undefined : prepareDuplication(doc, [source], {
      kind: 'world-offset', x: matrix ? matrix[0] * offset : offset, y: matrix ? matrix[1] * offset : 0,
    }, { fresh: true, singleStep: true, mutable: false })
    const result = editor.change(empty ? '添加相邻空白画板' : '复制相邻画板', draft => {
      if (blankFrame) {
        blankFrame.transform = [...frame.transform]
        blankFrame.transform[4] += offset
        draft.nodes[blankFrame.id] = blankFrame
        const siblings = section ? draft.nodes[section.id].children : draft.pages.find(item => item.id === page)!.children
        siblings.splice(siblings.indexOf(source) + (side > 0 ? 1 : 0), 0, blankFrame.id)
        selected.push(blankFrame.id)
      } else selected.push(...applyDuplication(draft, plan!, side < 0).roots)
      for (const [id, delta] of moves) draft.nodes[id].transform[4] += delta
      if (section) {
        const next = draft.nodes[section.id]
        let left = 0, right = next.width
        for (const id of [...selected, ...moves.keys()]) {
          const box = localBox(draft.nodes[id])
          left = Math.min(left, box.x)
          right = Math.max(right, box.x + box.width)
        }
        if (left !== 0 || right !== next.width) {
          next.transform = multiply(next.transform, translate(left, 0))
          next.width = right - left
          for (const id of next.children) {
            const child = draft.nodes[id]
            child.transform[4] -= left
            if (child.constraints?.referenceWidth != null) child.constraints.referenceWidth = next.width
          }
        }
      }
    }, selected)
    if (result.status !== 'committed') return false
    rememberFigmaFrameSize(editor, selected[0])
    return true
  } catch (error) {
    editor.notify(String(error instanceof Error ? error.message : error))
    return false
  }
}
