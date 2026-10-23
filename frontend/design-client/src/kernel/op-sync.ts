/**
 * Fine-grained op sync: compiles a TS document edit (before/after states of
 * the editor draft, which stays the projection source) into a kernel op batch
 * that is applied through the binary sync protocol instead of replacing the
 * whole kernel document.
 *
 * The kernel op vocabulary (ops.rs) covers node scalars (name/visible/opacity/
 * transform/resize), facet-mediated fields (clip/mask/blend) and structural
 * insert/remove/reorder. Structural ops are expressed against an augmented
 * projection in which pages and the page list itself are store nodes, so
 * root-level layer operations have real parents. Node content the vocabulary
 * cannot name (fills, strokes, effects, text, network, …) rides as a
 * remove+insert pair carrying the full node: still an op batch and one undo
 * timeline entry, but coarse.
 *
 * Document/page metadata and edits this vocabulary cannot express require an
 * atomic full projection replacement. A no-op anchor cannot represent them:
 * it would advance undo depth while leaving imported font/page/color data stale.
 */
import type { Op } from './graph'
import { equalValue } from '../document-patch'
import { localEditProof } from '../local-edit-proof'
import type { DesignDocument, DesignNode, Page } from '../model'

/** Synthetic parent of the per-page pseudo nodes; never a real node id. */
export const PAGES_ROOT_ID = '\u0000forma-pages'

/** Kinds whose kernel facet set includes clip (mirror of facet.rs). */
const CLIP_FACET_KINDS = new Set([
  'frame', 'section', 'group', 'text',
  'rectangle', 'rect', 'ellipse', 'polygon', 'star', 'line', 'path', 'vector',
  'instance', 'boolean',
])
/** Kinds whose kernel facet set includes mask (mirror of facet.rs). */
const MASK_FACET_KINDS = new Set([
  'rectangle', 'rect', 'ellipse', 'polygon', 'star', 'line', 'path', 'vector',
])

function pseudoNode(id: string, name: string, children: string[]): DesignNode {
  return {
    id,
    name,
    kind: 'page' as DesignNode['kind'],
    transform: [1, 0, 0, 1, 0, 0],
    width: 0,
    height: 0,
    children,
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal',
    fills: [],
    strokes: [],
    effects: [],
    radii: [0, 0, 0, 0],
    smoothing: 0,
    clip: false,
    mask: false,
    points: 0,
    innerRadius: 0,
    text: '',
    fontSize: 28,
  }
}

/** Augmented node space: real nodes + page pseudo nodes + the pages root. */
type Augmented = {
  entries: Map<string, DesignNode>
  parentOf: Map<string, string>
}

function augment(document: DesignDocument): Augmented {
  const entries = new Map<string, DesignNode>()
  const parentOf = new Map<string, string>()
  entries.set(PAGES_ROOT_ID, pseudoNode(PAGES_ROOT_ID, PAGES_ROOT_ID, document.pages.map((p) => p.id)))
  for (const page of document.pages) {
    entries.set(page.id, pseudoNode(page.id, page.name, [...page.children]))
    parentOf.set(page.id, PAGES_ROOT_ID)
  }
  for (const [id, node] of Object.entries(document.nodes)) entries.set(id, node)
  const adopt = (id: string, parent: string) => {
    if (!parentOf.has(id)) parentOf.set(id, parent)
  }
  for (const page of document.pages) for (const child of page.children) adopt(child, page.id)
  for (const [id, node] of Object.entries(document.nodes))
    for (const child of node.children) adopt(child, id)
  return { entries, parentOf }
}

/** Open payload for the editing graph: the document plus the sync projection. */
export function augmentedDocumentJson(document: DesignDocument): string {
  const nodes: Record<string, unknown> = { ...document.nodes }
  for (const page of document.pages)
    nodes[page.id] = pseudoNode(page.id, page.name, [...page.children])
  nodes[PAGES_ROOT_ID] = pseudoNode(PAGES_ROOT_ID, PAGES_ROOT_ID, document.pages.map((p) => p.id))
  return JSON.stringify({ ...document, nodes })
}

/** Structural mirror of ops.rs apply for insert/remove/reorder, used to
 * compute insert indices against the exact mid-batch store state and to
 * verify the batch reproduces the after-structure before it is applied. */
class StructureSim {
  private readonly children = new Map<string, string[]>()
  constructor(entries: Map<string, DesignNode>) {
    for (const [id, node] of entries) this.children.set(id, [...node.children])
  }
  has(id: string) {
    return this.children.has(id)
  }
  list(id: string): string[] {
    return this.children.get(id) ?? []
  }
  snapshot(): [string, string[]][] {
    return [...this.children.entries()]
  }
  insert(parent: string, index: number, node: DesignNode) {
    if (this.children.has(node.id)) throw new Error(`op-sync: node ${node.id} already present`)
    const target = this.children.get(parent)
    if (!target) throw new Error(`op-sync: insert parent ${parent} missing`)
    this.children.set(node.id, [...node.children])
    target.splice(Math.min(index, target.length), 0, node.id)
  }
  remove(id: string) {
    if (!this.children.delete(id)) throw new Error(`op-sync: removed node ${id} missing`)
    for (const list of this.children.values()) {
      const at = list.indexOf(id)
      if (at >= 0) list.splice(at, 1)
    }
  }
  reorder(parent: string, from: number, to: number) {
    const list = this.children.get(parent)
    if (!list || from >= list.length) return
    const [moved] = list.splice(from, 1)
    list.splice(Math.min(to, list.length), 0, moved)
  }
}

/** Position maintaining final relative order against a subsequence list. */
function insertIndex(current: readonly string[], final: readonly string[], id: string): number {
  const before = new Set(final.slice(0, final.indexOf(id)))
  let index = 0
  for (const member of current) if (before.has(member)) index++
  return index
}

/** Decompose a same-set children permutation into reorder ops; null when the
 * sets differ (insert/remove splices or a replace pair handle those). */
function reorderOps(parent: string, current: readonly string[], final: readonly string[]): Op[] | null {
  if (current.length !== final.length || new Set(current).size !== current.length) return null
  const list = [...current]
  const ops: Op[] = []
  for (let k = 0; k < final.length; k++) {
    if (list[k] === final[k]) continue
    const from = list.indexOf(final[k], k)
    if (from < 0) return null
    const [moved] = list.splice(from, 1)
    list.splice(k, 0, moved)
    ops.push({ type: 'reorderChild', parent, from, to: k })
  }
  return ops
}

/** Node diffs expressible as scalar/facet ops; null when a pair is needed. */
function scalarOps(id: string, before: DesignNode, after: DesignNode): Op[] | null {
  const ops: Op[] = []
  let resize = false
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'id') continue
    if (key === 'children') {
      if (!equalValue(before.children, after.children)) return null
      continue
    }
    const differs = !equalValue(
      (before as unknown as Record<string, unknown>)[key],
      (after as unknown as Record<string, unknown>)[key],
    )
    if (!differs) continue
    if (key === 'name') ops.push({ type: 'setName', id, name: after.name })
    else if (key === 'visible') ops.push({ type: 'setVisible', id, visible: after.visible })
    else if (key === 'opacity') ops.push({ type: 'setOpacity', id, opacity: after.opacity })
    else if (key === 'transform') {
      if (
        after.transform.length !== 6 ||
        after.transform.some((v) => typeof v !== 'number' || !Number.isFinite(v))
      )
        return null
      ops.push({ type: 'setTransform', id, matrix: [...after.transform] })
    } else if (key === 'width' || key === 'height') {
      // Kernel resize rescales vector networks; only safe for network-free nodes.
      if (after.network) return null
      resize = true
    } else if (key === 'blend')
      ops.push({
        type: 'applyFacet',
        id,
        kind: 'blend',
        facet: { kind: 'blend', mode: after.blend, opacity: after.opacity },
      })
    else if (key === 'clip') {
      if (!CLIP_FACET_KINDS.has(after.kind)) return null
      ops.push({ type: 'applyFacet', id, kind: 'clip', facet: { kind: 'clip', on: after.clip } })
    } else if (key === 'mask' || key === 'maskType') {
      if (ops.some((op) => op.type === 'applyFacet' && op.kind === 'mask')) continue
      if (!MASK_FACET_KINDS.has(after.kind)) return null
      ops.push({
        type: 'applyFacet',
        id,
        kind: 'mask',
        facet: { kind: 'mask', on: after.mask, maskType: after.maskType },
      })
    } else return null
  }
  if (resize) ops.push({ type: 'resize', id, width: after.width, height: after.height })
  return ops
}

const stripChildren = (n: DesignNode): DesignNode => ({ ...n, children: [] })

export type CompiledEdit =
  | { mode: 'ops'; ops: Op[] }
  | { mode: 'replace'; reason: string }

/** Compile one committed edit. Callers must install the whole after-state for
 * `replace`; it is never safe to substitute an idempotent undo anchor. */
export function compileEditOps(before: DesignDocument, after: DesignDocument): CompiledEdit {
  // Page pseudo nodes do not update GraphApi.base.pages. Include every base
  // field, including unknown forward-compatible metadata, in this comparison.
  const { nodes: _beforeNodes, ...beforeBase } = before
  const { nodes: _afterNodes, ...afterBase } = after
  if (!equalValue(beforeBase, afterBase)) return replacement('document metadata changed')
  try {
    const local = localEditProof(before, after)
    if (local?.ids.length === 1) {
      const ops: Op[] = []
      let complete = true
      for (const id of local.ids) {
        const batch = scalarOps(id, before.nodes[id], after.nodes[id])
        if (!batch) { complete = false; break }
        ops.push(...batch)
      }
      // The proof excludes topology/ID/base-field changes. A single target
      // retains the old compiler's exact wire order without augmented parent
      // maps or a structural simulation. Multi-target batches keep the old
      // compiler: producer witness order is not node-map enumeration order.
      // Non-scalar payloads keep the normal exact remove/insert compiler.
      if (complete) return { mode: 'ops', ops }
    }
    return compile(before, after)
  } catch (error) {
    return replacement(`compile failed: ${String(error)}`)
  }
}

function replacement(reason: string): CompiledEdit {
  return { mode: 'replace', reason }
}

function compile(before: DesignDocument, after: DesignDocument): CompiledEdit {
  const from = augment(before)
  const to = augment(after)
  const sim = new StructureSim(from.entries)

  const removed: string[] = []
  const paired = new Set<string>()
  const scalar: Op[] = []

  for (const id of from.entries.keys()) if (!to.entries.has(id)) removed.push(id)

  for (const id of to.entries.keys()) {
    if (id === PAGES_ROOT_ID || !from.entries.has(id)) continue
    const a = from.entries.get(id)!
    const b = to.entries.get(id)!
    const parentMoved = from.parentOf.get(id) !== to.parentOf.get(id)
    if (!parentMoved) {
      const childrenEqual = equalValue(a.children, b.children)
      const restEqual = equalValue(stripChildren(a), stripChildren(b))
      if (restEqual) {
        // Pure membership/order change; child ops (or the reorder sweep)
        // move the list. The parent itself needs no content op.
        continue
      }
      if (childrenEqual) {
        if (from.parentOf.get(id) === PAGES_ROOT_ID) {
          // Page pseudo nodes carry only name and membership.
          const nameOnly = equalValue(stripChildren({ ...a, name: '' }), stripChildren({ ...b, name: '' }))
          if (nameOnly) {
            scalar.push({ type: 'setName', id, name: b.name })
            continue
          }
        } else {
          const ops = scalarOps(id, a, b)
          if (ops) {
            scalar.push(...ops)
            continue
          }
        }
      }
    }
    paired.add(id)
  }

  // Removals run deepest-first: the kernel inverts each op against the
  // mid-batch store, so a child's RemoveNode must run while its parent (which
  // may itself be removed or pair-replaced in this batch) is still present.
  const removalOps: Op[] = []
  const depth = (id: string): number => {
    let at = from.parentOf.get(id),
      count = 0
    const seen = new Set([id])
    while (at) {
      if (seen.has(at)) throw new Error(`op-sync: cyclic parent for ${id}`)
      seen.add(at)
      at = from.parentOf.get(at)
      count++
    }
    return count
  }
  const removalOrder = [...removed, ...paired].sort((a, b) => depth(b) - depth(a))
  for (const id of removalOrder) {
    sim.remove(id)
    removalOps.push({ type: 'removeNode', id })
  }

  // Inserts in dependency order; each carries only children already present,
  // later inserts splice themselves in at order-preserving positions.
  const insertOps: Op[] = []
  const pending = [...to.entries.keys()].filter((id) => !from.entries.has(id) || paired.has(id))
  let progress = true
  while (pending.length && progress) {
    progress = false
    for (let i = 0; i < pending.length; ) {
      const id = pending[i]
      const parent = to.parentOf.get(id)!
      if (parent !== PAGES_ROOT_ID && pending.includes(parent)) {
        i++
        continue
      }
      const node = to.entries.get(id)!
      const children = node.children.filter((child) => sim.has(child))
      const payload = { ...node, children }
      sim.insert(parent, insertIndex(sim.list(parent), to.entries.get(parent)!.children, id), payload)
      insertOps.push({
        type: 'insertNode',
        parent,
        index: sim.list(parent).indexOf(id),
        node: payload,
      })
      pending.splice(i, 1)
      progress = true
    }
  }
  if (pending.length) return replacement('unresolved insert parents')

  // Same-set permutations (pure layer/page reorders) land here, after every
  // insert has spliced into place.
  const reorderSweep: Op[] = []
  for (const [id, node] of to.entries) {
    if (equalValue(sim.list(id), node.children)) continue
    const ops = reorderOps(id, sim.list(id), node.children)
    if (!ops) return replacement(`structure mismatch at ${id}`)
    for (const op of ops) {
      reorderSweep.push(op)
      if (op.type === 'reorderChild') sim.reorder(op.parent, op.from, op.to)
    }
  }

  for (const id of to.entries.keys()) if (!sim.has(id)) return replacement(`missing ${id}`)
  for (const [id, list] of sim.snapshot())
    if (!to.entries.has(id) || !equalValue(list, to.entries.get(id)!.children))
      return replacement(`structure mismatch at ${id}`)
  for (const op of scalar)
    if (op.type !== 'reorderChild' && op.type !== 'insertNode' && !sim.has(op.id))
      return replacement(`scalar target ${JSON.stringify(op.type)} missing`)

  const ops = [...removalOps, ...insertOps, ...reorderSweep, ...scalar]
  return { mode: 'ops', ops }
}
