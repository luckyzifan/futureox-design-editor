/** Free-content slots are authored trees owned by an instance, not component swaps. */
import { container, uid, type DesignDocument } from './model'
import { cloneValue } from './draft'
import { allParents, worldMatrix, multiply, inverse } from './geometry'
import { definitionOwner, templateMap } from './components'

const safe = (s: string) => !!s.trim() && s.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(s) && !/[\x00-\x1f\x7f]/.test(s)
function unlocked(d: DesignDocument, id: string) {
  const parents = allParents(d), seen = new Set<string>()
  for (let at: string | undefined = id; at && d.nodes[at]; at = parents.get(at)) {
    if (seen.has(at)) throw new Error('Cyclic slot ancestry')
    seen.add(at)
    if (d.nodes[at].locked) throw new Error('Slot content or ancestor is locked')
  }
}
export function slotContentIds(d: DesignDocument): Set<string> {
  const result = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (depth > 64) throw new Error('Slot content depth exceeded')
    if (result.has(id)) return
    result.add(id)
    d.nodes[id]?.children.forEach(c => walk(c, depth + 1))
  }
  for (const n of Object.values(d.nodes)) for (const roots of Object.values(n.instance?.slotContents || {})) roots.forEach(id => walk(id, 0))
  return result
}
export function declareSlot(d: DesignDocument, targetId: string, name: string, slotId = name) {
  if (!safe(name) || !safe(slotId)) throw new Error('Invalid slot name or ID')
  const owner = definitionOwner(d, targetId), target = d.nodes[targetId]
  if (!owner || owner === targetId || !container(target) || target.instance || target.instanceOrigin) throw new Error('Choose a container inside a main component')
  unlocked(d, targetId)
  const c = d.nodes[owner].component!, slots = c.slots ||= {}
  if (Object.keys(slots).length >= 128 && !slots[slotId]) throw new Error('Slot budget exceeded')
  const targetKey = target.componentKey || targetId
  for (const [id, slot] of Object.entries(slots)) if (id !== slotId && (slot.name === name || slot.targetKey === targetKey)) throw new Error('Duplicate slot name or target')
  // Nested declarations would hide each other's assignments.
  const parents = allParents(d), targets = templateMap(d, owner)
  for (const slot of Object.values(slots)) {
    const other = targets.get(slot.targetKey)
    for (const [a, b] of [[targetId, other], [other, targetId]]) {
      let at = a && parents.get(a)
      while (at && at !== owner) { if (at === b) throw new Error('Slots cannot be nested'); at = parents.get(at) }
    }
  }
  slots[slotId] = { name, targetKey }
  return slotId
}
export function assignSlot(d: DesignDocument, instanceId: string, slotId: string, roots: string[] | null) {
  const owner = d.nodes[instanceId], spec = owner?.instance
  if (!spec || owner.instanceOrigin || definitionOwner(d, instanceId)) throw new Error('Choose an outer instance outside a main component')
  const declaration = d.nodes[spec.componentId]?.component?.slots?.[slotId]
  if (!declaration) throw new Error('Unknown component slot')
  unlocked(d, instanceId)
  let host = Object.values(d.nodes).find(n => n.instanceOrigin?.owner === instanceId && n.instanceOrigin.key === declaration.targetKey)
  // A newly instantiated component in the same atomic MCP batch has not yet
  // been materialized. A transaction-local host provides legal ownership until
  // the kernel substitutes its deterministic generated host at commit.
  if (!host) {
    const sourceId = templateMap(d, spec.componentId).get(declaration.targetKey)
    if (!sourceId || !container(d.nodes[sourceId])) throw new Error('Missing slot target')
    host = cloneValue(d.nodes[sourceId]); host.id = uid(); host.children = []
    delete host.component; delete host.componentSet; delete host.componentKey; delete host.instance
    host.instanceOrigin = { owner: instanceId, key: declaration.targetKey, source: sourceId }
    d.nodes[host.id] = host; owner.children.push(host.id)
  }
  if (!host) throw new Error('Slot host is not materialized')
  unlocked(d, host.id)
  const parents = allParents(d), previous = spec.slotContents?.[slotId] || []
  const worlds = new Map([...previous, ...(roots || [])].filter(id => !!d.nodes[id]).map(id => [id, worldMatrix(d, id)]))
  if (roots && (roots.length > 20000 || new Set(roots).size !== roots.length)) throw new Error('Invalid slot roots')
  const allAssigned = slotContentIds(d)
  for (const id of roots || []) {
    const n = d.nodes[id]
    if (!n || n.instanceOrigin || n.component || n.componentSet || definitionOwner(d, id)) throw new Error('Slot content must be an authored subtree')
    unlocked(d, id)
    const visited = new Set<string>()
    const inspect = (child: string, depth: number) => {
      if (depth > 64 || visited.has(child)) throw new Error('Cyclic or oversized slot content')
      visited.add(child)
      const node = d.nodes[child]
      if (!node || node.locked || node.component || node.componentSet) throw new Error('Missing, locked, or component-definition content')
      node.children.forEach(c => inspect(c, depth + 1))
    }
    inspect(id, 0)
    if (allAssigned.has(id) && !previous.includes(id)) throw new Error('Content belongs to another slot')
    let at: string | undefined = host.id
    while (at) { if (at === id) throw new Error('Cyclic slot assignment'); at = parents.get(at) }
    at = parents.get(id)
    while (at) { if (roots?.includes(at)) throw new Error('Overlapping slot roots'); at = parents.get(at) }
  }
  // Replaced content is retained on the same page, never silently deleted.
  let pageId: string | undefined = instanceId
  while (pageId && parents.has(pageId)) pageId = parents.get(pageId)
  const page = d.pages.find(p => p.id === pageId)
  if (!page) throw new Error('Instance has no page')
  for (const id of previous) if (!roots?.includes(id) && d.nodes[id]) { page.children.push(id); d.nodes[id].transform = worlds.get(id)! }
  for (const id of roots || []) {
    const parent = parents.get(id), list = d.nodes[parent || '']?.children || d.pages.find(p => p.id === parent)?.children
    if (!list) throw new Error('Slot root has no parent')
    const at = list.indexOf(id); if (at >= 0) list.splice(at, 1)
    d.nodes[id].transform = multiply(inverse(worldMatrix(d, host.id)), worlds.get(id)!)
  }
  host.children = [...host.children.filter(id => !previous.includes(id) && !roots?.includes(id)), ...(roots || [])]
  spec.slotContents ||= {}
  if (roots === null) delete spec.slotContents[slotId]
  else spec.slotContents[slotId] = [...roots]
}
export function isSlotHost(d: DesignDocument, id: string): boolean {
  const o = d.nodes[id]?.instanceOrigin
  if (!o) return false
  const spec = d.nodes[o.owner]?.instance
  return !!spec && Object.values(d.nodes[spec.componentId]?.component?.slots || {}).some(s => s.targetKey === o.key)
}

export function removeSlot(d: DesignDocument, componentId: string, slotId: string) {
  const c = d.nodes[componentId]?.component
  if (!c?.slots?.[slotId]) throw new Error('Unknown component slot')
  unlocked(d, componentId)
  if (Object.values(d.nodes).some(n => n.instance?.componentId === componentId && Object.hasOwn(n.instance.slotContents || {}, slotId))) throw new Error('Reset or detach assigned instances before removing this slot')
  delete c.slots[slotId]
}
/** Release only a declared, actually owned root for normal delete/reparent operations. */
export function releaseSlotRoot(d: DesignDocument, id: string): boolean {
  const parent = allParents(d).get(id), origin = d.nodes[parent || '']?.instanceOrigin
  if (!origin || d.nodes[id]?.instanceOrigin) return false
  const spec = d.nodes[origin.owner]?.instance
  if (!spec) return false
  for (const [slot, roots] of Object.entries(spec.slotContents || {})) {
    if (d.nodes[spec.componentId]?.component?.slots?.[slot]?.targetKey === origin.key && roots.includes(id)) {
      spec.slotContents![slot] = roots.filter(root => root !== id)
      return true
    }
  }
  return false
}
