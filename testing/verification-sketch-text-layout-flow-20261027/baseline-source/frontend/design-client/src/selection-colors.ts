import type { DesignDocument, DesignNode } from './model'

export type ColorUse = { id: string; path: string; field: string; linked: boolean }
export type SelectionColor = { color: string; uses: ColorUse[] }

export function selectionColors(document: DesignDocument, selection: readonly string[]): SelectionColor[] {
  const seen = new Set<string>(), colors = new Map<string, SelectionColor>()
  const visit = (id: string) => {
    const n = document.nodes[id]
    if (!n || seen.has(id)) return
    seen.add(id)
    const add = (color: string | undefined, path: string, field: string) => {
      if (!color) return
      const key = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : color
      const group = colors.get(key) || { color, uses: [] }
      group.uses.push({ id, path, field, linked: !!n.bindings?.[path] || !!n.styleRefs?.[field] })
      colors.set(key, group)
    }
    const paint = (p: DesignNode['fills'][number], path: string, field: string) => {
      if (p.kind === 'solid') add(p.color, `${path}.color`, field)
      if (['linear', 'radial', 'angular', 'diamond'].includes(p.kind)) p.stops.forEach((stop, i) => add(stop.color, `${path}.stops.${i}.color`, field))
    }
    n.fills.forEach((p, i) => paint(p, `fills.${i}`, 'fills'))
    n.strokes.forEach((s, i) => paint(s.paint, `strokes.${i}.paint`, 'strokes'))
    n.effects.forEach((effect, i) => { if (['shadow', 'inner-shadow', 'noise'].includes(effect.kind)) add(effect.color, `effects.${i}.color`, 'effects') })
    n.textRuns?.forEach((run, i) => add(run.color, `textRuns.${i}.color`, 'textRuns'))
    n.children.forEach(visit)
  }
  selection.forEach(visit)
  return [...colors.values()]
}

export function replaceSelectionColor(node: DesignNode, uses: ColorUse[], color: string, detach = false) {
  for (const use of uses.filter(use => use.id === node.id)) {
    if (use.linked && !detach) throw new Error('请先将引用颜色转为本地颜色')
    if (detach) {
      if (node.bindings) { delete node.bindings[use.path]; if (!Object.keys(node.bindings).length) delete node.bindings }
      if (node.styleRefs) { delete node.styleRefs[use.field]; if (!Object.keys(node.styleRefs).length) delete node.styleRefs }
    }
    const path = use.path.split('.'), last = path.pop()!
    let at: any = node
    for (const key of path) at = at?.[key]
    if (!at || typeof at[last] !== 'string') throw new Error('选区颜色位置已变化')
    at[last] = color
  }
}
