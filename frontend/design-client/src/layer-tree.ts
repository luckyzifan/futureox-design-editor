import type { DesignDocument } from './model'

export function layerTreeRows(doc: DesignDocument, pageId: string, collapsed: ReadonlySet<string>, search: string) {
  const query = search.trim().toLocaleLowerCase(), matches = new Set<string>(), included = new Set<string>()
  const roots = doc.pages.find(page => page.id === pageId)?.children || []
  const scan = (id: string, ancestors: string[]) => {
    const n = doc.nodes[id]; if (!n) return
    if (n.name.toLocaleLowerCase().includes(query)) {
      matches.add(id); included.add(id); ancestors.forEach(parent => included.add(parent))
    }
    for (const child of n.children) scan(child, [...ancestors, id])
  }
  if (query) roots.forEach(id => scan(id, []))
  const rows: { id: string; depth: number; context: boolean }[] = []
  const visit = (id: string, depth: number) => {
    const n = doc.nodes[id]; if (!n || (query && !included.has(id))) return
    rows.push({ id, depth, context: !!query && !matches.has(id) })
    if (query || !collapsed.has(id)) [...n.children].reverse().forEach(child => visit(child, depth + 1))
  }
  ;[...roots].reverse().forEach(id => visit(id, 0))
  return rows
}
