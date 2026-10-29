import { animation_plan_json } from './generated/design-kernel/design_kernel'
import type { DesignDocument } from './model'
import { variableValue } from './design-system'
import { evaluate, tick, validateLogicActions, type Expr } from './prototype-logic'
export type PrototypeEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spring' | import('./animation').NamedEasing
export function isPrototypeEasing(value: unknown): value is PrototypeEasing {
  return typeof value === 'string' && (/^(linear|ease-in|ease-out|ease-in-out|spring)$/.test(value) ||
    /^ease-(in|out|in-out)-(sine|quad|cubic|quart|quint|expo|circ)$/.test(value))
}
export type OverlayPosition = {
  origin:
    | 'center'
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'middle-left'
    | 'middle-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right'
    | 'manual'
  x?: number
  y?: number
  padding: number
  background: boolean
}
/** Media command enum; mirrors the kernel's valid_media_action closed set. */
export type PrototypeMediaAction =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'stop'
  | 'previous'
  | 'next'
  | 'forward'
  | 'rewind'
export type PrototypeTransitionStyle = 'none'|'slide-left'|'slide-right'|'slide-top'|'slide-bottom'
export type PrototypeAction = {
  transitionStyle?: PrototypeTransitionStyle
  kind: 'navigate' | 'overlay' | 'back' | 'close-overlay' | 'scroll-to' | 'set-variable' | 'if'
  expression?: Expr
  thenActions?: PrototypeAction[]
  elseActions?: PrototypeAction[]
  target?: string
  value?: string | number | boolean
  durationMs?: number
  /** Transition easing, shared with the animation module's curve set. */
  easingCurve?: PrototypeEasing
  /** Overlay placement for overlay actions (kiwi OverlayPositionType). */
  overlayPosition?: OverlayPosition
  /* Names match the kernel's serde camelCase. The player executes variable
   * transitions, smart-animation gating, scroll and overlay placement;
   * unsupported media/component actions report an explicit playback error. */
  /** `targetVariable`: id of the variable an action binds. */
  targetVariable?: string
  /** `targetVariableModeId`: mode the bound variable resolves in. */
  targetVariableModeId?: string
  /** `targetVariableSetId`: variable-set membership (shape-validated only). */
  targetVariableSetId?: string
  /** `targetVariableSetKey`: stable key of a variable set. */
  targetVariableSetKey?: string
  /** `targetVariableData`: Figma VariableData alias ({id, modeId}); unknown keys tolerated. */
  targetVariableData?: { id?: string; modeId?: string } & Record<string, unknown>
  /** `mediaAction`: media command enum. */
  mediaAction?: PrototypeMediaAction
  /** `mediaSkipByAmount`: seconds to seek by (kernel bound 0..=1e6). */
  mediaSkipByAmount?: number
  /** `mediaSkipToTime`: absolute seek target in seconds (kernel bound 0..=1e6). */
  mediaSkipToTime?: number
  /** `transitionShouldSmartAnimate`: opt the transition into smart animate. */
  transitionShouldSmartAnimate?: boolean
  /** `transitionOverridesEnabled`: per-action transition overrides gate. */
  transitionOverridesEnabled?: boolean
  /** `transitionPreserveScroll`: keep scroll position across the transition. */
  transitionPreserveScroll?: boolean
  /** `transitionResetScrollPosition`: reset scroll on transition. */
  transitionResetScrollPosition?: boolean
  /** `transitionResetInteractiveComponents`: reset interactive component state. */
  transitionResetInteractiveComponents?: boolean
  /** `transitionDurationVar`: number variable supplying the duration. */
  transitionDurationVar?: string
  /** `transitionEasingVar`: variable supplying the easing curve. */
  transitionEasingVar?: string
}
/** True when any of the 15 recovered schema fields is set; mirrors the
 * kernel's Action::has_schema_extras (which gates schema version 12). */
export function hasSchemaExtras(a: PrototypeAction): boolean {
  return !!(
    a.targetVariable ||
    a.targetVariableModeId ||
    a.targetVariableSetId ||
    a.targetVariableSetKey ||
    a.targetVariableData ||
    a.mediaAction ||
    a.mediaSkipByAmount !== undefined ||
    a.mediaSkipToTime !== undefined ||
    a.transitionShouldSmartAnimate !== undefined ||
    a.transitionOverridesEnabled !== undefined ||
    a.transitionPreserveScroll !== undefined ||
    a.transitionResetScrollPosition !== undefined ||
    a.transitionResetInteractiveComponents !== undefined ||
    a.transitionDurationVar ||
    a.transitionEasingVar
  )
}
export type Interaction = {
  trigger: 'click' | 'hover' | 'leave' | 'after-delay'
  actions: PrototypeAction[]
  delayMs?: number
  condition?: { variable: string; equals: string | number | boolean }
}
export type Prototype = { startNode?: string; interactions: Record<string, Interaction[]> }
/** Remove only references invalidated by this edit; reject newly invalid input normally. */
export function prunePrototypeReferences(before: DesignDocument, after: DesignDocument) {
  const p = after.prototype
  if (!p) return
  const removed = new Set(Object.keys(before.nodes).filter((id) => !after.nodes[id]))
  if (!removed.size) return
  if (p.startNode && removed.has(p.startNode)) delete p.startNode
  for (const [id, events] of Object.entries(p.interactions)) {
    if (removed.has(id)) {
      delete p.interactions[id]
      continue
    }
    const retained = events.flatMap((event) => {
      const prune = (items: PrototypeAction[]): PrototypeAction[] => items.map(a => a.kind === 'if' ? {...a, thenActions: prune(a.thenActions || []), elseActions: prune(a.elseActions || [])} : a).filter(
        (action) =>
          !(
            ['navigate', 'overlay', 'scroll-to'].includes(action.kind) &&
            removed.has(action.target!)
          ),
      )
      const actions = prune(event.actions)
      return actions.length ? [{ ...event, actions }] : []
    })
    if (retained.length) p.interactions[id] = retained
    else delete p.interactions[id]
  }
}
export type PrototypeState = {
  /** Preview-session circuit breaker for timer/navigation cycles. Restart preview to reset. */
  eventCount?: number
  current: string
  history: string[]
  historyTransitions?: {style?: PrototypeTransitionStyle; duration: number; easing?: PrototypeEasing}[]
  overlays: string[]
  values: Record<string, string | number | boolean>
  modeValues?: Record<string, Record<string, string | number | boolean>>
  overlayPositions?: (OverlayPosition | undefined)[]
  navigation?: { serial: number; preserveScroll: boolean }
  scrollTarget?: string
  scrollRequest?: number
  transitionStyle?: PrototypeTransitionStyle
  transitionFrom?: string
  transitionSerial?: number
  transitionMs: number
  /** Easing of the in-flight transition (kernel curve-name set). */
  transitionEasing?: PrototypeEasing
  /** Animation plan for the in-flight frame transition: decoded from the
   * kernel's plan tree (magic-move matches, dissolve sides, frame delta). */
  transition?: {
    from: string
    to: string
    magicMove: { id: string; from: number[]; to: number[] }[]
    dissolveStart: string[]
    dissolveEnd: string[]
    frameDelta: [number, number]
  }
}
/** Map a linear time fraction through a prototype easing curve before it
 * reaches the kernel's plan sampler (which takes raw progress). The cubic
 * anchors mirror the animation module's canonical eases; "spring" is the
 * same underdamped solver family with the default animation spring. */
export function prototypeEase(kind: PrototypeEasing | undefined, t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  if (!kind || kind === 'linear') return t
  const named = /^ease-(in|out|in-out)-(sine|quad|cubic|quart|quint|expo|circ)$/.exec(kind)
  if (named) {
    const inward = (x: number) => {
      switch (named[2]) {
        case 'sine': return 1 - Math.cos(x * Math.PI / 2)
        case 'quad': return x * x
        case 'cubic': return x ** 3
        case 'quart': return x ** 4
        case 'quint': return x ** 5
        case 'expo': return x === 0 ? 0 : 2 ** (10 * x - 10)
        default: return 1 - Math.sqrt(Math.max(0, 1 - x * x))
      }
    }
    return named[1] === 'in' ? inward(t) : named[1] === 'out' ? 1 - inward(1-t) :
      t < .5 ? inward(2*t)/2 : 1-inward(2-2*t)/2
  }
  if (kind === 'spring') {
    // m*x'' + c*x' + k*(x-1) = 0, mass 1 / stiffness 170 / damping 18
    const omega = Math.sqrt(170),
      zeta = 18 / (2 * Math.sqrt(170)),
      time = t
    if (Math.abs(zeta - 1) < 1e-7) return 1 - (1 + omega * time) * Math.exp(-omega * time)
    if (zeta < 1) {
      const wo = omega * Math.sqrt(1 - zeta * zeta)
      return (
        1 -
        Math.exp(-zeta * omega * time) *
          (Math.cos(wo * time) + (zeta * omega * Math.sin(wo * time)) / wo)
      )
    }
    const r1 = -omega * (zeta - Math.sqrt(zeta * zeta - 1)),
      r2 = -omega * (zeta + Math.sqrt(zeta * zeta - 1))
    return 1 - (r2 * Math.exp(r1 * time) - r1 * Math.exp(r2 * time)) / (r2 - r1)
  }
  const bezier = (a: number, b: number, x: number) => {
    const q = 1 - x
    return 3 * q * q * x * a + 3 * q * x * x * b + x * x * x
  }
  // anchors follow the kernel/animation defaults (CSS canonical curves)
  const [x1, y1, x2, y2] =
    kind === 'ease-in' ? [0.42, 0, 1, 1] : kind === 'ease-out' ? [0, 0, 0.58, 1] : [0.42, 0, 0.58, 1]
  let lo = 0,
    hi = 1
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (bezier(x1, x2, mid) < t) lo = mid
    else hi = mid
  }
  return bezier(y1, y2, (lo + hi) / 2)
}
/** Isolate a preview frame visually while retaining every graph/resource
 * owner required by native document admission and component resolution. */
export function prototypeFrameView(doc: DesignDocument, root: string): {document: DesignDocument; pageId: string} {
  if (!doc.nodes[root]) throw new Error('原型目标已删除')
  const parents=new Map<string,string>()
  for (const p of doc.pages) for (const id of p.children) parents.set(id,p.id)
  for (const n of Object.values(doc.nodes)) for (const id of n.children) parents.set(id,n.id)
  const nodes={...doc.nodes};let at=root
  while (parents.has(at)) {
    const parent=parents.get(at)!, siblings=doc.nodes[parent]?.children || doc.pages.find(p=>p.id===parent)!.children
    for (const id of siblings) if(id!==at) nodes[id]={...nodes[id],visible:false}
    at=parent
  }
  if(!doc.pages.some(p=>p.id===at))throw new Error('原型目标不属于页面')
  return {document:{...doc,nodes},pageId:at}
}
export function initialPrototype(doc: DesignDocument): PrototypeState {
  const current = doc.prototype?.startNode || doc.pages[0].children[0]
  if (!current || !doc.nodes[current]) throw new Error('请先创建画板并设置原型起点')
  return { current, history: [], overlays: [], values: {}, transitionMs: 0 }
}
export function prototypeEvent(
  doc: DesignDocument,
  state: PrototypeState,
  id: string,
  trigger: Interaction['trigger'],
  only?: Interaction,
): PrototypeState {
  if ((state.eventCount ?? 0) >= 1024) throw new Error('Prototype preview event budget exceeded; restart preview to reset')
  const next = structuredClone(state)
  let applied = false
  const budget = { steps: 0 }
  for (const e of only ? [only] : doc.prototype?.interactions[id] || []) {
    if (e.trigger !== trigger) continue
    if (e.condition) {
      const s = doc.designSystem
      if (!s) throw new Error('条件变量不存在')
      const actual = variableValue(prototypeDocument(doc, next).designSystem!, e.condition.variable)
      if (actual !== e.condition.equals) continue
    }
    validateLogicActions(doc, e.actions)
    if (!e.actions.length) continue
    if (!applied) {
      next.transition = undefined
      next.transitionMs = 0
      next.transitionEasing = undefined
      next.transitionStyle = undefined
      next.transitionFrom = undefined
      applied = true
    }
    const execute = (actions: PrototypeAction[]) => { for (const authored of actions) {
      tick(budget)
      const read = (id: string) => variableValue(prototypeDocument(doc, next).designSystem!, id)
      if (authored.mediaAction || authored.mediaSkipByAmount !== undefined || authored.mediaSkipToTime !== undefined) throw new Error('当前原型画布不支持媒体播放动作，请移除媒体命令后重试')
      if (authored.transitionResetInteractiveComponents) throw new Error('当前原型画布不支持重置交互组件状态')
      if (authored.kind === 'if') { execute(evaluate(authored.expression!, read, budget) === true ? authored.thenActions! : authored.elseActions!); continue }
      const a = authored.expression ? { ...authored, value: evaluate(authored.expression, read, budget) } : authored
      if (a.mediaAction || a.mediaSkipByAmount !== undefined || a.mediaSkipToTime !== undefined)
        throw new Error('当前原型画布不支持媒体播放动作，请移除媒体命令后重试')
      if (a.transitionResetInteractiveComponents)
        throw new Error('当前原型画布不支持重置交互组件状态')
      const variable = (id: string) => {
        const system = prototypeDocument(doc, next).designSystem
        if (!system) throw new Error('过渡变量不存在')
        return variableValue(system, id)
      }
      if (['navigate', 'back', 'overlay', 'scroll-to'].includes(a.kind)) {
        const duration = a.transitionDurationVar ? variable(a.transitionDurationVar) : a.durationMs ?? 0
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 10000)
          throw new Error('过渡时长变量必须为 0–10000 毫秒')
        const easing = a.transitionEasingVar ? variable(a.transitionEasingVar) : a.easingCurve
        if (easing !== undefined && !isPrototypeEasing(easing)) throw new Error('过渡曲线变量不是支持的曲线名称')
        next.transitionMs = duration
        next.transitionEasing = easing
      }
      const navigate = (target: string, style = a.transitionStyle) => {
        next.transitionFrom = next.current
        next.transitionStyle = style
        next.transitionSerial = (next.transitionSerial ?? 0) + 1
        if (style === 'none') next.transitionMs = 0
        next.transition = style || a.transitionShouldSmartAnimate === false
          ? undefined : planTransition(doc, next.current, target)
        next.current = target
        next.overlays = []; next.overlayPositions = []
        next.scrollTarget = undefined
        next.navigation = { serial: (next.navigation?.serial ?? 0) + 1,
          preserveScroll: a.transitionPreserveScroll === true && a.transitionResetScrollPosition !== true }
      }
      if (['navigate', 'overlay', 'scroll-to'].includes(a.kind) && !doc.nodes[a.target || ''])
        throw new Error('原型目标已删除')
      switch (a.kind) {
        case 'navigate':
          if (next.history.length >= 256) throw new Error('Prototype navigation history budget exceeded')
          while ((next.historyTransitions ??= []).length < next.history.length) next.historyTransitions.push({duration:0})
          next.historyTransitions.push({style:a.transitionStyle,duration:next.transitionMs,easing:next.transitionEasing})
          next.history.push(next.current)
          navigate(a.target!)
          break
        case 'back':
          if (next.history.length) {
            const target = next.history.pop()!
            const previous = next.historyTransitions?.pop()
            const reverse: Partial<Record<PrototypeTransitionStyle,PrototypeTransitionStyle>> = {'slide-left':'slide-right','slide-right':'slide-left','slide-top':'slide-bottom','slide-bottom':'slide-top',none:'none'}
            if (previous && a.durationMs === undefined) next.transitionMs=previous.duration
            if (previous && a.easingCurve === undefined) next.transitionEasing=previous.easing
            navigate(target,a.transitionStyle ?? (previous?.style ? reverse[previous.style] : undefined))
          }
          next.overlays = []
          next.overlayPositions = []
          break
        case 'overlay':
          if (next.overlays.length >= 16) throw new Error('弹层超过 16 层')
          next.overlays.push(a.target!)
          ;(next.overlayPositions ??= []).push(a.overlayPosition)
          break
        case 'close-overlay':
          next.overlays.pop()
          next.overlayPositions?.pop()
          break
        case 'scroll-to':
          next.scrollTarget = a.target
          next.scrollRequest = (next.scrollRequest ?? 0) + 1
          break
        case 'set-variable': {
          const target = a.targetVariable || a.targetVariableData?.id || a.target!
          const v = doc.designSystem?.variables[target]
          if (!v || a.value === undefined)
            throw new Error('原型变量无效')
          if ((v.kind === 'number' && (typeof a.value !== 'number' || !Number.isFinite(a.value))) ||
            (v.kind === 'boolean' && typeof a.value !== 'boolean') ||
            (['string', 'color'].includes(v.kind) && typeof a.value !== 'string')) throw new Error('原型变量值类型不匹配')
          const mode = a.targetVariableModeId || a.targetVariableData?.modeId
          if (mode) {
            if (!doc.designSystem!.collections[v.collection].modes.includes(mode)) throw new Error('原型变量模式不存在')
            const modes = (next.modeValues ??= {})
            ;(modes[target] ??= {})[mode] = a.value
          } else next.values[target] = a.value
          break
        }
      }
    } }
    execute(e.actions)
  }
  if (applied) next.eventCount = (state.eventCount ?? 0) + 1
  return applied ? next : state
}
/** Decode the frame-pair animation plan from the kernel (best effort:
 * without the wasm module the transition simply carries no plan and the
 * player falls back to its CSS enter animation). */
function planTransition(doc: DesignDocument, from: string, to: string) {
  if (from === to || !doc.nodes[from] || !doc.nodes[to]) return undefined
  const plan = JSON.parse(animation_plan_json(JSON.stringify(doc), JSON.stringify(doc), from, to))
  return {
    from, to,
    magicMove: (plan.magicMove as [string,number[],number[]][]).map(([id,from,to])=>({id,from,to})),
    dissolveStart: plan.dissolveStart as string[],
    dissolveEnd: plan.dissolveEnd as string[],
    frameDelta: plan.framePairDragTranslationDelta as [number,number],
  }
}

export function prototypeDocument(doc: DesignDocument, state: PrototypeState): DesignDocument {
  if (!doc.designSystem || (!Object.keys(state.values).length && !Object.keys(state.modeValues || {}).length)) return doc
  const result = { ...doc, designSystem: structuredClone(doc.designSystem) }
  for (const [id, value] of Object.entries(state.values)) {
    const v = result.designSystem.variables[id]
    if (!v) throw new Error('原型变量不存在')
    const c = result.designSystem.collections[v.collection]
    v.values[result.designSystem.activeModes[v.collection] || c.defaultMode] = value
  }
  for (const [id, modes] of Object.entries(state.modeValues || {})) {
    const variable = result.designSystem.variables[id]
    if (!variable) throw new Error('原型变量不存在')
    Object.assign(variable.values, modes)
  }
  return result
}
