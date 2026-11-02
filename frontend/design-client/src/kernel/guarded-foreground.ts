import type { Bounds, DesignDocument } from '../model'
import { unionBounds, type SceneEntry } from '../geometry'

/** A later painter may read the moved foreground only within this deliberately
 * conservative envelope. Unknown/global dependencies cannot supply one. */
export function boundedBackdropRead(document: DesignDocument, entries: ReadonlyMap<string, SceneEntry>, id: string): Bounds | undefined {
  if (!entries.has(id)) return
  let halo = 0, backdrop = false
  const boxes: Bounds[] = []
  const pending = [id]
  while (pending.length) {
    const entry = entries.get(pending.pop()!)
    if (!entry) continue
    const n = document.nodes[entry.id]
    if (!n || n.blend !== 'normal' || n.mask || n.repeat || n.connector || n.textPath || n.instance || n.instanceOrigin ||
        n.component || n.componentSet || n.componentKey || Object.keys(n.bindings || {}).length ||
        Object.keys(n.variableModes || {}).length || Object.keys(n.styleRefs || {}).length ||
        n.fills.some(p => p.visible && p.blend !== 'normal') ||
        n.strokes.some(s => s.visible && s.paint.visible && s.paint.blend !== 'normal')) return
    const [a,b,c,d] = entry.matrix, scale = Math.max(Math.hypot(a,b), Math.hypot(c,d))
    if (![a,b,c,d,scale,...Object.values(entry.bounds)].every(Number.isFinite) || a*c+b*d !== 0) return
    for (const effect of n.effects.filter(effect => effect.visible)) {
      if (!['blur','gaussian-blur','shadow','inner-shadow','color-controls','background-blur'].includes(effect.kind) || effect.gradientBlur ||
          ![effect.radius,effect.x || 0,effect.y || 0,effect.spread || 0].every(Number.isFinite) || effect.radius < 0) return
      backdrop ||= effect.kind === 'background-blur'
      // Sum, rather than max, also covers chains and enclosing filter support.
      halo += (effect.radius*3 + Math.abs(effect.x || 0) + Math.abs(effect.y || 0) + Math.abs(effect.spread || 0))*scale
    }
    const pad = Math.max(0,...n.strokes.filter(s=>s.visible).map(s=>s.width*4))*scale
    boxes.push({x:entry.bounds.x-pad,y:entry.bounds.y-pad,width:entry.bounds.width+2*pad,height:entry.bounds.height+2*pad})
    pending.push(...n.children)
  }
  if (!backdrop) return
  const b = unionBounds(boxes)
  return {x:b.x-halo,y:b.y-halo,width:b.width+2*halo,height:b.height+2*halo}
}

/** Rechecked for every input, including poses sent to the worker's warm lease.
 * Entering a reader's support revokes the local capture before dispatch. */
export function guardedForegroundSafe(exclusions: readonly Bounds[] | undefined, roots: ReadonlyMap<string, Bounds> | undefined,
  ids: readonly string[], offsets: ReadonlyMap<string, {x:number;y:number}> | null,
  parents: ReadonlyMap<string, number[]> | undefined, scale: number) {
  if (!exclusions) return true
  if (!roots || !offsets || !Number.isFinite(scale) || scale <= 0) return false
  const edge = 2/scale
  return ids.every(id => {
    const b = roots.get(id), local = offsets.get(id), m = parents?.get(id) || [1,0,0,1]
    if (!b || !local) return false
    const dx=m[0]*local.x+m[2]*local.y,dy=m[1]*local.x+m[3]*local.y
    const x=b.x+Math.min(0,dx)-edge,y=b.y+Math.min(0,dy)-edge
    const right=b.x+b.width+Math.max(0,dx)+edge,bottom=b.y+b.height+Math.max(0,dy)+edge
    return [x,y,right,bottom].every(Number.isFinite) && exclusions.every(r=>right<r.x || bottom<r.y || x>r.x+r.width || y>r.y+r.height)
  })
}
