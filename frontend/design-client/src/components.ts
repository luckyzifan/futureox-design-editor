import { isSlotHost } from './component-slots'
import { cloneValue } from './draft'
import {
  node,
  uid,
  container,
  type DesignDocument,
  type DesignNode,
  type ComponentInstance,
  type ComponentProperty,
  type Point,
} from './model'
import { importFonts } from './text'
import { importDesignDependencies, remapDesignDependencies } from './design-system'
import {
  allParents,
  worldMatrix,
  multiply,
  inverse,
  translate,
  bounds,
  boxPoints,
  apply,
} from './geometry'
export const overrideFields = [
  'bindings',
  'styleRefs',
  'variableModes',
  'booleanOperation',
  'maskType',
  'name',
  'text',
  'fontSize',
  'textStyle',
  'textRuns',
  'visible',
  'locked',
  'opacity',
  'fills',
  'strokes',
  'effects',
  'radii',
  'smoothing',
  'arc',
  'cornerRadius',
  'constrainProportions',
  'exportSettings',
  'width',
  'height',
  'transform',
  'layout',
  'sizing',
  'constraints',
  'network',
  'points',
  'innerRadius',
  'clip',
  'mask',
] as const
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export function instanceOwner(d: DesignDocument, id: string): string | undefined {
  const n = d.nodes[id]
  return n?.instanceOrigin?.owner || (n?.instance ? id : undefined)
}
export function definitionOwner(d: DesignDocument, id: string): string | undefined {
  const parents = allParents(d)
  let at: string | undefined = id
  while (at && d.nodes[at]) {
    if (d.nodes[at].component) return at
    at = parents.get(at)
  }
  return undefined
}
export function templateMap(d: DesignDocument, root: string) {
  const result = new Map<string, string>()
  const visit = (id: string, key: string) => {
    const n = d.nodes[id]
    if (!n) return
    result.set(key, id)
    if (!n.instance)
      for (const child of n.children) visit(child, d.nodes[child].componentKey || child)
  }
  visit(root, '$root')
  return result
}
function editInstance(d: DesignDocument, owner: string, fn: (i: ComponentInstance) => void) {
  const n = d.nodes[owner]
  if (!n?.instance) throw new Error('实例引用无效')
  const instance = cloneValue(n.instance)
  fn(instance)
  d.nodes[owner] = { ...n, instance }
}
export function setOverride(
  d: DesignDocument,
  owner: string,
  key: string,
  values: Record<string, unknown>,
) {
  editInstance(d, owner, (i) => {
    i.overrides[key] = { ...i.overrides[key], ...cloneValue(values) }
  })
}
export function stampKeys(d: DesignDocument, root: string) {
  const walk = (id: string, first = false) => {
    const n = d.nodes[id]
    n.componentKey = first ? '$root' : n.componentKey || id
    if (!n.instance) for (const child of n.children) walk(child)
  }
  walk(root, true)
}
/** JSON-object key order is not identity. Arrays (including mode columns)
 * retain order. Used only to prove an exact design-system reference migration. */
function equivalentJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => equivalentJson(v, (b as unknown[])[i]))
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x)
  return keys.length === Object.keys(y).length && keys.every(key => Object.hasOwn(y, key) && equivalentJson(x[key], y[key]))
}
/** Prove complete bijective mode-key renames, including atomic API batches.
 * Every changed column must replace a removed name with a fresh name at the
 * same position, and the entire system must equal the corresponding exact
 * values/default/active remap. Reorders, merges and value edits are ambiguous
 * and retain normal override capture. Computed once per edit, not per node. */
function variableModeRenames(before: DesignDocument, after: DesignDocument) {
  const a = before.designSystem, b = after.designSystem
  if (!a || !b || a === b) return
  const maps = new Map<string, Map<string, string>>(), collections = { ...a.collections }
  for (const [id, old] of Object.entries(a.collections)) {
    const next = b.collections[id]
    if (!next || old.modes.length !== next.modes.length) return
    if (same(old.modes, next.modes)) continue
    const modes = new Map<string, string>()
    for (let i = 0; i < old.modes.length; i++) if (old.modes[i] !== next.modes[i]) {
      const from = old.modes[i], to = next.modes[i]
      if (next.modes.includes(from) || old.modes.includes(to)) return
      modes.set(from, to)
    }
    maps.set(id, modes)
    collections[id] = { ...old, modes: next.modes, defaultMode: modes.get(old.defaultMode) ?? old.defaultMode }
  }
  if (!maps.size) return
  const variables = Object.fromEntries(Object.entries(a.variables).map(([key, v]) => {
    const modes = maps.get(v.collection)
    return [key, modes ? { ...v, values: Object.fromEntries(Object.entries(v.values).map(([mode, value]) => [modes.get(mode) ?? mode, value])) } : v]
  }))
  const activeModes = Object.fromEntries(Object.entries(a.activeModes).map(([id, mode]) => [id, maps.get(id)?.get(mode) ?? mode]))
  if (!equivalentJson({ ...a, collections, variables, activeModes }, b)) return
  return maps
}
export function captureOverrides(before: DesignDocument, d: DesignDocument) {
  for (const n of Object.values(d.nodes)) if (n.instance?.slotContents) {
    for (const [slot, roots] of Object.entries(n.instance.slotContents)) {
      let remaining = roots.filter(id => !!d.nodes[id])
      const targetKey = d.nodes[n.instance.componentId]?.component?.slots?.[slot]?.targetKey
      const host = Object.values(d.nodes).find(host => host.instanceOrigin?.owner === n.id && host.instanceOrigin.key === targetKey)
      const ordered = host?.children.filter(id => remaining.includes(id))
      if (ordered?.length === remaining.length) remaining = ordered
      if (!same(remaining, roots)) editInstance(d, n.id, i => { i.slotContents![slot] = remaining })
    }
  }
  const modeRenames = variableModeRenames(before, d)
  const changedModeCollections = new Set(Object.keys(before.designSystem?.collections || {}).filter(id =>
    !same(before.designSystem?.collections[id].modes, d.designSystem?.collections[id]?.modes)))
  // A library release replaces its definitions. Do not turn those replacements
  // into user overrides or reject their regenerated instance children.
  const replaced = new Set<string>()
  const include = (id: string) => {
    if (replaced.has(id)) return
    replaced.add(id)
    before.nodes[id]?.children.forEach(include)
  }
  for (const [id, library] of Object.entries(before.designSystem?.libraries || {})) {
    const next = d.designSystem?.libraries[id]
    if (next && (library.version !== next.version || library.digest !== next.digest))
      library.componentIds.forEach(include)
  }
  const beforeParents = allParents(before),
    afterParents = allParents(d)
  for (const old of Object.values(before.nodes)) {
    if (replaced.has(old.id)) continue
    const owner = instanceOwner(before, old.id)
    if (!owner || !d.nodes[owner]?.instance) continue
    const next = d.nodes[old.id],
      key = old.instanceOrigin?.key || '$root'
    if (!next) {
      if (old.instanceOrigin) setOverride(d, owner, key, { visible: false })
      continue
    }
    if (old.instanceOrigin && beforeParents.get(old.id) !== afterParents.get(old.id))
      throw new Error('实例内部结构由主组件控制，请先分离实例')
    if (next.kind !== old.kind) throw new Error('请先分离实例，再改变图层类型')
    const remaining = old.children.filter((id) => next.children.includes(id))
    const assignedRoots = isSlotHost(d, old.id) ? new Set(Object.values(d.nodes[owner].instance?.slotContents || {}).flat()) : undefined
    const legalSlotEdit = assignedRoots && next.children.every(id => old.children.includes(id) || assignedRoots.has(id))
    if (!legalSlotEdit && !same(remaining, next.children) && !(old.instance && next.children.every(id => old.children.includes(id) || isSlotHost(d, id)))) throw new Error('实例内部结构由主组件控制，请先分离实例')
    const changed: Record<string, unknown> = {}
    for (const field of overrideFields) {
      if (key === '$root' && ['transform', 'visible', 'locked', 'constraints', 'variableModes'].includes(field))
        continue
      if (field === 'variableModes' && old.instanceOrigin && !modeRenames &&
        !Object.hasOwn(before.nodes[owner]?.instance?.overrides[key] || {}, 'variableModes') &&
        !Object.hasOwn(d.nodes[owner]?.instance?.overrides[key] || {}, 'variableModes') &&
        Object.entries(old.variableModes || {}).some(([id, mode]) => changedModeCollections.has(id) && next.variableModes?.[id] !== mode))
        throw new Error('变量模式重命名与其他设计系统修改无法安全合并；请分开操作以保留实例继承')
      if (field === 'variableModes' && old.instanceOrigin && modeRenames && old.variableModes &&
        !Object.hasOwn(before.nodes[owner]?.instance?.overrides[key] || {}, 'variableModes') &&
        !Object.hasOwn(d.nodes[owner]?.instance?.overrides[key] || {}, 'variableModes') &&
        equivalentJson(Object.fromEntries(Object.entries(old.variableModes).map(([id, mode]) => [id, modeRenames.get(id)?.get(mode) ?? mode])), next.variableModes)) continue
      if (!same(old[field], next[field]))
        changed[field] = cloneValue(
          next[field] ?? (['bindings', 'styleRefs', 'variableModes'].includes(field) ? {} : null),
        )
    }
    if (Object.keys(changed).length) {
      const props = d.nodes[d.nodes[owner].instance!.componentId]?.component?.properties || {}
      for (const [id, p] of Object.entries(props)) {
        const field =
          p.kind === 'text' ? 'text' : p.kind === 'boolean' ? 'visible' : 'swapComponent'
        if (p.targetKey === key && field in changed) {
          const value = changed[field] as string | boolean
          editInstance(d, owner, (i) => {
            i.propertyValues[id] = value
            if (i.overrides[key]) delete i.overrides[key][field]
          })
          delete changed[field]
        }
      }
      if (Object.keys(changed).length) setOverride(d, owner, key, changed)
    }
  }
  // Editing a bound layer in a main component changes that property's default.
  for (const root of Object.values(d.nodes).filter((n) => n.component)) {
    if (replaced.has(root.id)) continue
    const oldRoot = before.nodes[root.id]
    if (!oldRoot?.component) continue
    const targets = templateMap(d, root.id),
      oldTargets = templateMap(before, root.id)
    for (const [id, p] of Object.entries(root.component!.properties)) {
      const oldProp = oldRoot.component.properties[id]
      if (!oldProp || !same(oldProp.defaultValue, p.defaultValue)) continue
      const a = before.nodes[oldTargets.get(p.targetKey) || ''],
        b = d.nodes[targets.get(p.targetKey) || '']
      if (!a || !b) continue
      const old =
          p.kind === 'text' ? a.text : p.kind === 'boolean' ? a.visible : a.instance?.componentId,
        value =
          p.kind === 'text' ? b.text : p.kind === 'boolean' ? b.visible : b.instance?.componentId
      if (value !== undefined && !same(old, value)) {
        const component = cloneValue(d.nodes[root.id].component!)
        component.properties[id].defaultValue = value
        d.nodes[root.id] = { ...d.nodes[root.id], component }
      }
    }
  }
}
export function createMain(d: DesignDocument, ids: string[], page: string): string {
  if (!ids.length) throw new Error('请先选择图层')
  if (ids.some((id) => instanceOwner(d, id) || definitionOwner(d, id)))
    throw new Error('请先分离实例；主组件内部请插入实例')
  let root = ids[0]
  if (ids.length !== 1 || !container(d.nodes[root])) {
    const parents = allParents(d),
      parent = parents.get(ids[0]) || page
    if (ids.some((id) => (parents.get(id) || page) !== parent))
      throw new Error('请选择同一容器内的图层')
    const pm = worldMatrix(d, parent),
      points = ids.flatMap((id) =>
        boxPoints({ x: 0, y: 0, width: d.nodes[id].width, height: d.nodes[id].height }).map((p) =>
          apply(worldMatrix(d, id), p),
        ),
      ),
      b = bounds(points),
      n = node('frame', 0, 0, Math.max(1, b.width), Math.max(1, b.height))
    n.name = ids.length === 1 ? d.nodes[root].name : '组件'
    n.fills = []
    n.clip = false
    n.transform = multiply(inverse(pm), translate(b.x, b.y))
    const wm = multiply(pm, n.transform)
    const list = d.nodes[parent]?.children || d.pages.find((p) => p.id === parent)!.children
    const at = Math.min(...ids.map((id) => list.indexOf(id)))
    for (const id of ids) {
      d.nodes[id].transform = multiply(inverse(wm), worldMatrix(d, id))
      list.splice(list.indexOf(id), 1)
    }
    n.children = [...ids]
    d.nodes[n.id] = n
    list.splice(at, 0, n.id)
    root = n.id
  }
  const n = d.nodes[root]
  n.kind = 'frame'
  n.component = { variants: {}, properties: {} }
  delete n.componentSet
  stampKeys(d, root)
  return root
}
export function insertInstance(
  d: DesignDocument,
  componentId: string,
  page: string,
  position: Point,
  parent?: string,
): string {
  const source = d.nodes[componentId]
  if (!source?.component) throw new Error('组件不存在')
  const n = cloneValue(source)
  n.id = uid()
  n.children = []
  delete n.component
  delete n.componentSet
  delete n.componentKey
  delete n.instanceOrigin
  delete n.constraints
  // Main component modes are defaults, never authored instance-placement choices.
  delete n.variableModes
  n.visible = true
  n.locked = false
  n.transform = [1, 0, 0, 1, position.x, position.y]
  if (parent) n.transform = multiply(inverse(worldMatrix(d, parent)), n.transform)
  n.instance = { componentId, overrides: {}, propertyValues: {} }
  d.nodes[n.id] = n
  ;(parent ? d.nodes[parent].children : d.pages.find((p) => p.id === page)!.children).push(n.id)
  return n.id
}
export function detach(d: DesignDocument, id: string, previous = d) {
  const root = d.nodes[id]
  if (!root?.instance) return
  if (root.instanceOrigin) throw new Error('请先分离最外层实例')
  const component = d.nodes[root.instance.componentId] || previous.nodes[root.instance.componentId]
  const modes = cloneValue(
    root.instance.overrides.$root?.variableModes ?? {
      ...component?.variableModes,
      ...root.variableModes,
    },
  ) as Record<string, string>
  if (Object.keys(modes).length) root.variableModes = modes
  else delete root.variableModes
  const def = definitionOwner(d, allParents(d).get(id) || '')
  const prefix = def ? (root.componentKey || id) + '/' : ''
  for (const n of Object.values(d.nodes)) {
    if (n.instanceOrigin?.owner === id) {
      n.componentKey = prefix + n.instanceOrigin.key
      delete n.instanceOrigin
      delete n.instance
    }
  }
  delete root.instance
}
export function detachMissing(before: DesignDocument, d: DesignDocument) {
  let detached = false
  const dependencyCache = new Map<string, boolean>()
  const lostDependency = (id: string): boolean => {
    if (dependencyCache.has(id)) return dependencyCache.get(id)!
    if (!d.nodes[id]?.component) {
      dependencyCache.set(id, true)
      return true
    }
    dependencyCache.set(id, false)
    const definition = before.nodes[id]
    if (!definition?.component) return false
    for (const target of templateMap(before, id).values())
      for (const reference of instanceReferences(before, before.nodes[target]))
        if (lostDependency(reference)) {
          dependencyCache.set(id, true)
          return true
        }
    for (const p of Object.values(definition.component.properties))
      if (p.kind === 'instance-swap' && lostDependency(String(p.defaultValue))) {
        dependencyCache.set(id, true)
        return true
      }
    return false
  }
  // A removed nested definition may invalidate a swap/property binding. Preserve
  // customized appearances by detaching their owning instance in this operation.
  for (const n of Object.values(d.nodes))
    if (
      n.instance &&
      !n.instanceOrigin &&
      (Object.keys(n.instance.propertyValues).length ||
        Object.values(n.instance.overrides).some((fields) => Object.keys(fields).length)) &&
      lostDependency(n.instance.componentId)
    ) {
      detached = true
      detach(d, n.id, before)
    }
  for (const n of Object.values(d.nodes))
    if (
      n.instance &&
      !n.instanceOrigin &&
      instanceReferences(before, n).some((id) => !d.nodes[id]?.component)
    ) {
      detached = true
      detach(d, n.id, before)
    }
  for (const n of Object.values(d.nodes))
    if (n.instance && !d.nodes[n.instance.componentId]) {
      detached = true
      if (n.instanceOrigin) delete n.instance
      else detach(d, n.id, before)
    }
  for (const n of Object.values(d.nodes))
    if (n.component) {
      const keys = templateMap(d, n.id)
      const component = cloneValue(n.component)
      for (const [id, p] of Object.entries(component.properties)) {
        const target = d.nodes[keys.get(p.targetKey) || '']
        if (
          !target ||
          (p.kind === 'text' && target.kind !== 'text') ||
          (p.kind === 'instance-swap' && (!target.instance || !d.nodes[String(p.defaultValue)]))
        )
          delete component.properties[id]
      }
      d.nodes[n.id] = { ...n, component }
    }
  void before
  return detached
}
function semanticPaths(d: DesignDocument, root: string) {
  const result = new Map<string, string>()
  const walk = (id: string, path: string) => {
    const n = d.nodes[id]
    result.set(path, id)
    const occurrences = new Map<string, number>()
    for (const child of n.children) {
      const c = d.nodes[child],
        label = `${c.kind}:${c.name}`,
        index = occurrences.get(label) || 0
      occurrences.set(label, index + 1)
      walk(child, `${path}/${label}#${index}`)
    }
  }
  walk(root, '')
  return result
}
function layerKey(d: DesignDocument, root: string, id: string) {
  if (id === root) return '$root'
  const n = d.nodes[id]
  if (n.instanceOrigin) {
    const owner = d.nodes[n.instanceOrigin.owner]
    return `${owner.componentKey || owner.id}/${n.instanceOrigin.key}`
  }
  return n.componentKey || id
}
export function remapInstance(
  d: DesignDocument,
  spec: ComponentInstance,
  target: string,
): ComponentInstance {
  const next = cloneValue(spec),
    old = d.nodes[spec.componentId],
    fresh = d.nodes[target]
  if (!fresh?.component) throw new Error('替换目标不是主组件')
  next.componentId = target
  if (spec.slotContents) {
    next.slotContents = {}
    for (const [id, roots] of Object.entries(spec.slotContents)) {
      const slots = fresh.component.slots || {}
      const matching = slots[id] ? [id] : Object.keys(slots).filter(k => slots[k].name === old?.component?.slots?.[id]?.name)
      if (matching.length !== 1 || next.slotContents[matching[0]]) throw new Error('Target variant has no unambiguous matching content slot; reset or detach first')
      next.slotContents[matching[0]] = [...roots]
    }
  }
  if (old?.component) {
    const a = semanticPaths(d, old.id),
      b = semanticPaths(d, target),
      moves: { from: string; to: string; value: Record<string, unknown> }[] = []
    for (const [path, id] of a) {
      const matching = b.get(path)
      if (!matching) continue
      const from = layerKey(d, old.id, id),
        to = layerKey(d, target, matching)
      if (spec.overrides[from]) moves.push({ from, to, value: spec.overrides[from] })
    }
    for (const m of moves) if (m.from !== m.to) delete next.overrides[m.from]
    for (const m of moves) next.overrides[m.to] = cloneValue(m.value)
    const properties: { from: string; to: string; value: string | boolean }[] = []
    for (const [oldId, p] of Object.entries(old.component.properties)) {
      const targetId = Object.entries(fresh.component.properties).find(
        ([, q]) => q.name === p.name && q.kind === p.kind,
      )?.[0]
      if (targetId && Object.hasOwn(spec.propertyValues, oldId))
        properties.push({ from: oldId, to: targetId, value: spec.propertyValues[oldId] })
    }
    for (const m of properties) if (m.from !== m.to) delete next.propertyValues[m.from]
    for (const m of properties) next.propertyValues[m.to] = m.value
  }
  return next
}
export function swapInstance(d: DesignDocument, id: string, target: string) {
  const n = d.nodes[id]
  if (!n?.instance) throw new Error('请选择实例')
  const effective = cloneValue(n.instance)
  if (n.instanceOrigin) {
    const o = n.instanceOrigin
    for (const [k, v] of Object.entries(d.nodes[o.owner].instance!.overrides)) {
      if (k === o.key || k.startsWith(o.key + '/')) {
        const relative = k === o.key ? '$root' : k.slice(o.key.length + 1)
        effective.overrides[relative] = { ...effective.overrides[relative], ...v }
      }
    }
  }
  const remapped = remapInstance(d, effective, target)
  if (n.instanceOrigin) {
    const o = n.instanceOrigin
    editInstance(d, o.owner, (i) => {
      for (const k of Object.keys(i.overrides))
        if (k === o.key || k.startsWith(o.key + '/')) delete i.overrides[k]
      for (const [k, v] of Object.entries(remapped.overrides)) {
        const path = k === '$root' ? o.key : `${o.key}/${k}`
        i.overrides[path] = cloneValue(v)
      }
      i.overrides[o.key] = {
        ...i.overrides[o.key],
        swapComponent: target,
        propertyValues: remapped.propertyValues,
      }
    })
  } else {
    // The transaction still contains the previous generated host until the
    // kernel replaces it. Rebind its ownership key to the new declaration so
    // authored content remains parented during pre-materialization validation.
    for (const oldSlot of Object.keys(n.instance.slotContents || {})) {
      const oldKey = d.nodes[n.instance.componentId]?.component?.slots?.[oldSlot]?.targetKey
      const newSlots = d.nodes[target].component?.slots || {}
      const newSlot = newSlots[oldSlot] ? oldSlot : Object.keys(newSlots).find(slot => newSlots[slot].name === d.nodes[n.instance!.componentId]?.component?.slots?.[oldSlot]?.name)
      const newKey = newSlot && d.nodes[target].component?.slots?.[newSlot]?.targetKey
      if (oldKey && newKey && oldKey !== newKey) for (const host of Object.values(d.nodes)) {
        if (host.instanceOrigin?.owner === id && host.instanceOrigin.key === oldKey) host.instanceOrigin.key = newKey
      }
    }
    d.nodes[id] = { ...n, instance: remapped }
  }
}

export function resetInstance(d: DesignDocument, id: string) {
  const n = d.nodes[id],
    owner = instanceOwner(d, id)
  if (!owner) return
  if (id === owner) {
    editInstance(d, owner, (i) => {
      i.overrides = {}
      i.propertyValues = {}
    })
    delete d.nodes[owner].variableModes
  } else {
    const prefix = n.instanceOrigin!.key
    editInstance(d, owner, (i) => {
      for (const k of Object.keys(i.overrides))
        if (k === prefix || k.startsWith(prefix + '/')) delete i.overrides[k]
      const props = d.nodes[i.componentId].component!.properties
      for (const [key, p] of Object.entries(props))
        if (p.targetKey === prefix || p.targetKey.startsWith(prefix + '/'))
          delete i.propertyValues[key]
    })
  }
}
export function setProperty(d: DesignDocument, id: string, key: string, value: string | boolean) {
  const n = d.nodes[id]
  if (!n.instance) throw new Error('请选择实例')
  const p = d.nodes[n.instance.componentId]?.component?.properties[key]
  if (!p) throw new Error('组件属性不存在')
  const field = p.kind === 'text' ? 'text' : p.kind === 'boolean' ? 'visible' : 'swapComponent'
  if (n.instanceOrigin) {
    const o = n.instanceOrigin
    setOverride(d, o.owner, o.key, {
      propertyValues: {
        ...((d.nodes[o.owner].instance!.overrides[o.key]?.propertyValues || {}) as Record<
          string,
          string | boolean
        >),
        [key]: value,
      },
    })
    editInstance(d, o.owner, (i) => {
      const slot = `${o.key}/${p.targetKey}`
      if (i.overrides[slot]) delete i.overrides[slot][field]
    })
  } else
    editInstance(d, id, (i) => {
      i.propertyValues[key] = value
      if (i.overrides[p.targetKey]) delete i.overrides[p.targetKey][field]
    })
}
export function defineProperty(
  d: DesignDocument,
  target: string,
  kind: ComponentProperty['kind'],
  name: string,
) {
  const owner = definitionOwner(d, target)
  if (!owner || target === owner || d.nodes[target].instanceOrigin)
    throw new Error('请选择主组件内部的直接图层；嵌套属性请在其主组件中定义')
  stampKeys(d, owner)
  const n = d.nodes[target]
  const props = d.nodes[owner].component!.properties
  if (Object.values(props).some((p) => p.name === name)) throw new Error('属性名称已存在')
  const value = kind === 'text' ? n.text : kind === 'boolean' ? n.visible : n.instance?.componentId
  if (value === undefined) throw new Error('该图层不是嵌套实例')
  props[uid()] = {
    name: name.trim() || n.name,
    kind,
    targetKey: n.componentKey!,
    defaultValue: value,
  }
}
export function family(d: DesignDocument, componentId: string) {
  const parent = allParents(d).get(componentId)
  return parent && d.nodes[parent]?.componentSet ? d.nodes[parent] : undefined
}
export function cloneTree(d: DesignDocument, root: string): string {
  const ids = new Map<string, string>()
  const collect = (id: string) => {
    ids.set(id, uid())
    for (const c of d.nodes[id].children) collect(c)
  }
  collect(root)
  for (const [id, next] of ids) {
    const n = cloneValue(d.nodes[id])
    remapReferences(n, ids, d)
    n.id = next
    n.children = n.children.map((c) => ids.get(c)!)
    d.nodes[next] = n
  }
  return ids.get(root)!
}
function overrideComponent(
  source: DesignDocument,
  n: DesignNode,
  path: string,
  fields: Record<string, unknown>,
) {
  if (typeof fields.swapComponent === 'string') return fields.swapComponent
  if (!n.instance) return undefined
  if (path === '$root') return n.instance.componentId
  // A copied generated nested root has lifted relative override paths. Its
  // source document still stores those descendants under the outer owner.
  const origin = source.nodes[n.id]?.instanceOrigin
  const materialized = Object.values(source.nodes).find(
    (node) =>
      (node.instanceOrigin?.owner === n.id && node.instanceOrigin.key === path) ||
      (origin &&
        node.instanceOrigin?.owner === origin.owner &&
        node.instanceOrigin.key === `${origin.key}/${path}`),
  )
  if (materialized?.instance) return materialized.instance.componentId
  // Library/authored-only graphs need not have any generated descendants yet.
  // Follow template keys through nested instances, honoring ancestor swaps.
  let componentId = n.instance.componentId,
    instance = n.instance,
    prefix = ''
  const scopes = [{ prefix: '', instance }]
  for (const key of path.split('/')) {
    const values: Record<string, unknown> = { ...instance.propertyValues }
    for (const scope of [...scopes].reverse()) {
      const relative = prefix.slice(scope.prefix.length).replace(/^\//, '') || '$root'
      const overrides = scope.instance.overrides[relative]?.propertyValues
      if (overrides && typeof overrides === 'object') Object.assign(values, overrides)
    }
    const target = source.nodes[templateMap(source, componentId).get(key) || '']
    if (!target?.instance) return undefined
    const properties = source.nodes[componentId]?.component?.properties || {}
    componentId = target.instance.componentId
    for (const [id, property] of Object.entries(properties)) {
      const value = values[id] ?? property.defaultValue
      if (
        property.kind === 'instance-swap' &&
        property.targetKey === key &&
        typeof value === 'string'
      )
        componentId = value
    }
    prefix = prefix ? `${prefix}/${key}` : key
    for (const scope of [...scopes].reverse()) {
      const relative = prefix.slice(scope.prefix.length).replace(/^\//, '')
      const swap = scope.instance.overrides[relative]?.swapComponent
      if (typeof swap === 'string') componentId = swap
    }
    instance = target.instance
    scopes.push({ prefix, instance })
  }
  return componentId
}
export function remapReferences(n: DesignNode, ids: Map<string, string>, source: DesignDocument) {
  const mapped = (id: string) => ids.get(id) || id
  // Property values can be literal strings, including strings equal to a UUID.
  // Only instance-swap properties represent component references.
  const remapValues = (values: Record<string, unknown>, componentId: string | undefined) => {
    const properties = source.nodes[componentId || '']?.component?.properties || {}
    for (const [key, value] of Object.entries(values))
      if (properties[key]?.kind === 'instance-swap' && typeof value === 'string')
        values[key] = mapped(value)
  }
  if (n.instance) {
    const componentId = n.instance.componentId,
      overrideComponents = new Map(
        Object.entries(n.instance.overrides).map(([path, fields]) => [
          path,
          overrideComponent(source, n, path, fields),
        ]),
      )
    remapValues(n.instance.propertyValues, componentId)
    for (const [path, fields] of Object.entries(n.instance.overrides)) {
      if (fields.propertyValues && typeof fields.propertyValues === 'object') {
        const targetComponent = overrideComponents.get(path)
        remapValues(fields.propertyValues as Record<string, unknown>, targetComponent)
      }
      if (typeof fields.swapComponent === 'string')
        fields.swapComponent = mapped(fields.swapComponent)
    }
    if (n.instance.slotContents) for (const [slot, roots] of Object.entries(n.instance.slotContents)) n.instance.slotContents[slot] = roots.map(mapped)
    n.instance.componentId = mapped(componentId)
  }
  if (n.instanceOrigin) {
    n.instanceOrigin.owner = ids.get(n.instanceOrigin.owner) || n.instanceOrigin.owner
    n.instanceOrigin.source = ids.get(n.instanceOrigin.source) || n.instanceOrigin.source
  }
  if (n.component)
    for (const p of Object.values(n.component.properties))
      if (p.kind === 'instance-swap' && typeof p.defaultValue === 'string')
        p.defaultValue = ids.get(p.defaultValue) || p.defaultValue
}
export function variantSet(d: DesignDocument, ids: string[], page: string): string {
  if (!ids.length || ids.some((id) => !d.nodes[id].component)) throw new Error('请选择主组件')
  const parents = allParents(d),
    parent = parents.get(ids[0]) || page
  if (ids.some((id) => (parents.get(id) || page) !== parent))
    throw new Error('组件必须位于同一容器')
  const list = d.nodes[parent]?.children || d.pages.find((p) => p.id === parent)!.children
  if (d.nodes[parent]?.componentSet) return parent
  const pm = worldMatrix(d, parent),
    b = bounds(
      ids.flatMap((id) =>
        boxPoints({ x: 0, y: 0, width: d.nodes[id].width, height: d.nodes[id].height }).map((p) =>
          apply(worldMatrix(d, id), p),
        ),
      ),
    ),
    set = node('section', 0, 0, b.width + 48, b.height + 72)
  set.name = `${d.nodes[ids[0]].name} 组件集`
  set.fills = []
  set.componentSet = true
  set.transform = multiply(inverse(pm), translate(b.x - 24, b.y - 48))
  const wm = multiply(pm, set.transform),
    at = Math.min(...ids.map((id) => list.indexOf(id)))
  ids.forEach((id, i) => {
    d.nodes[id].transform = multiply(inverse(wm), worldMatrix(d, id))
    d.nodes[id].component!.variants = { 状态: i === 0 ? '默认' : `变体 ${i + 1}` }
    list.splice(list.indexOf(id), 1)
  })
  set.children = [...ids]
  d.nodes[set.id] = set
  list.splice(at, 0, set.id)
  return set.id
}
export function addVariant(d: DesignDocument, id: string, page: string) {
  const setId = family(d, id)?.id || variantSet(d, [id], page)
  stampKeys(d, id)
  const copy = cloneTree(d, id),
    n = d.nodes[copy],
    set = d.nodes[setId],
    axis = Object.keys(n.component!.variants)[0] || '状态'
  let index = set.children.length + 1
  while (set.children.some((id) => d.nodes[id].component!.variants[axis] === `变体 ${index}`))
    index++
  n.component!.variants[axis] = `变体 ${index}`
  n.name = `${d.nodes[id].name} / 变体 ${index}`
  n.transform[4] += n.width + 32
  set.width = Math.max(set.width, n.transform[4] + n.width + 24)
  set.children.push(copy)
  return copy
}
export function switchVariant(d: DesignDocument, instanceId: string, axis: string, value: string) {
  const n = d.nodes[instanceId],
    source = d.nodes[n.instance?.componentId || ''],
    set = source && family(d, source.id)
  if (!set) throw new Error('实例没有组件集')
  const candidates = set.children.filter((id) => d.nodes[id].component!.variants[axis] === value)
  if (!candidates.length) throw new Error('没有对应的变体')
  const props = source.component!.variants
  const score = (id: string) =>
    Object.entries(props).filter(
      ([key, v]) => key !== axis && d.nodes[id].component!.variants[key] === v,
    ).length
  candidates.sort((a, b) => score(b) - score(a))
  swapInstance(d, instanceId, candidates[0])
}
export function instanceReferences(doc: DesignDocument, n: DesignNode): string[] {
  if (!n.instance) return []
  const refs = new Set([n.instance.componentId])
  const add = (v: unknown) => {
    if (typeof v === 'string' && doc.nodes[v]?.component) refs.add(v)
  }
  const addValues = (values: Record<string, unknown>, componentId: string | undefined) => {
    const properties = doc.nodes[componentId || '']?.component?.properties || {}
    for (const [id, value] of Object.entries(values))
      if (properties[id]?.kind === 'instance-swap') add(value)
  }
  addValues(n.instance.propertyValues || {}, n.instance.componentId)
  for (const [path, fields] of Object.entries(n.instance.overrides || {})) {
    add(fields.swapComponent)
    if (fields.propertyValues && typeof fields.propertyValues === 'object')
      addValues(
        fields.propertyValues as Record<string, unknown>,
        overrideComponent(doc, n, path, fields),
      )
  }
  return [...refs]
}
/** Import the complete authored component closure once per paste, sharing one
 * resource map with the selected layers. Existing cross-document IDs never
 * establish component identity, even when their visible fields happen to match. */
function importDependencies(
  d: DesignDocument,
  source: DesignDocument,
  nodes: DesignNode[],
  copiedIds: Map<string, string>,
  componentIds: string[],
) {
  const needed = new Set<string>(),
    parents = allParents(source),
    sameDocument = d.id === source.id,
    copiedComponents = new Set(nodes.filter((n) => n.component).map((n) => n.id))
  const componentRoot = (id: string) => {
    const parent = parents.get(id)
    return parent && source.nodes[parent]?.componentSet ? parent : id
  }
  const references = (n: DesignNode) => [
    ...instanceReferences(source, n),
    ...Object.values(n.component?.properties || {})
      .filter((p) => p.kind === 'instance-swap')
      .map((p) => String(p.defaultValue)),
  ]
  const pending: string[] = []
  const requireComponent = (id: string) => {
    if (copiedIds.has(id) && copiedComponents.has(id)) return
    if (sameDocument && d.nodes[id]?.component) return
    if (!source.nodes[id]?.component) throw new Error('剪贴板缺少组件定义')
    pending.push(componentRoot(id))
  }
  componentIds.forEach(requireComponent)
  nodes.flatMap(references).forEach(requireComponent)
  while (pending.length) {
    const id = pending.pop()!
    if (needed.has(id)) continue
    const n = source.nodes[id]
    if (!n) throw new Error('剪贴板缺少组件定义')
    // Instance descendants are regenerated from authored definitions by the kernel.
    if (n.instanceOrigin) continue
    needed.add(id)
    pending.push(...n.children)
    references(n).forEach(requireComponent)
  }
  const definitionIds = new Map<string, string>(),
    reserved = new Set([
      ...Object.keys(d.nodes),
      ...d.pages.map((p) => p.id),
      ...Object.keys(source.nodes),
      ...copiedIds.values(),
    ])
  for (const id of needed) {
    let local = id
    if (d.nodes[id] || d.pages.some((p) => p.id === id) || copiedIds.has(id)) {
      do {
        local = uid()
      } while (reserved.has(local))
    }
    reserved.add(local)
    definitionIds.set(id, local)
  }
  const nodeIds = new Map([...copiedIds, ...definitionIds]),
    importedNodes = [...needed].map((id) => source.nodes[id]),
    designSystem = importDesignDependencies(d, source, [...nodes, ...importedNodes])
  const fontNodes = [...nodes, ...importedNodes].flatMap((n) => [
    n,
    ...Object.values(n.instance?.overrides || {}).map((fields) => ({
      ...n,
      textStyle: (fields.textStyle ?? undefined) as DesignNode['textStyle'],
      textRuns: (fields.textRuns ?? undefined) as DesignNode['textRuns'],
    })),
  ])
  importFonts(d, { ...source, fonts: cloneValue(source.fonts) }, fontNodes)
  if (!needed.size) return { nodeIds, designSystem }
  let page = d.pages.find((p) => p.name === '组件资源')
  if (!page) {
    page = { id: uid(), name: '组件资源', children: [], background: '#eeeff3' }
    d.pages.push(page)
  }
  for (const id of needed) {
    const n = cloneValue(source.nodes[id])
    remapReferences(n, nodeIds, source)
    remapDesignDependencies(n, designSystem)
    n.id = definitionIds.get(id)!
    n.children = n.children
      .filter((child) => needed.has(child))
      .map((child) => definitionIds.get(child)!)
    // Template keys remain source identities across collision remapping.
    n.componentKey ??= id
    d.nodes[n.id] = n
    const parent = parents.get(id)
    if (!parent || !needed.has(parent)) page.children.push(n.id)
  }
  return { nodeIds, designSystem }
}
export function importClipboardDependencies(
  d: DesignDocument,
  source: DesignDocument,
  nodes: DesignNode[],
  copiedIds: Map<string, string>,
) {
  return importDependencies(d, source, nodes, copiedIds, [])
}
export function importDefinitions(d: DesignDocument, source: DesignDocument, componentId: string) {
  const { nodeIds } = importDependencies(d, source, [], new Map(), [componentId])
  return nodeIds.get(componentId) || componentId
}
