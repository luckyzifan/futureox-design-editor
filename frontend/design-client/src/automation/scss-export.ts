import { variableValue, type DesignSystem, type VariableValue } from '../design-system'
import type { DesignDocument, DesignNode } from '../model'
import { AutomationError } from './types'
import type { DesignAutomationWarning } from './context'

type TokenKind = 'color' | 'number' | 'boolean'
type TokenUse = {
  id: string
  mode: string
  kind: TokenKind
  literal: string
  aliasTargetKey?: string
  modes: Record<string, string>
}
type PaintUse = { styleId: string; literal: string }
type MixinKind = 'text' | 'effect'

const MARKER = '\u0000'

/** Selection-scoped Sass layered on the flat CSS export.
 * Variables stay unitless, mixins expand in place, and nested rules use
 * `@at-root` so the compiled selectors stay the flat id rules. */
export function createScssColorSession(
  document: DesignDocument,
  normalizeColor: (value: string) => string | undefined,
  report: { colorMismatch(): void; numberMismatch(): void },
  formatNumber: (value: number) => string,
) {
  const system = document.designSystem
  const parent = new Map<string, string>()
  for (const node of Object.values(document.nodes)) for (const child of node.children) parent.set(child, node.id)
  const modeCache = new Map<string, Record<string, string>>()
  const uses = new Map<string, TokenUse>()
  const referenced = new Set<string>()
  const paintUses = new Map<string, PaintUse>()
  const mixins: { ident: string; body: string }[] = []
  const mixinIds = new Map<string, string>()
  const mixinTaken = new Set<string>()
  const textMixed = new Set<string>()
  let effectOmitted = false
  let booleanMismatch = false
  let inactiveSkipped = false

  const modesFor = (id: string): Record<string, string> => {
    const cached = modeCache.get(id)
    if (cached) return cached
    const chain: string[] = []
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) {
      seen.add(current)
      chain.push(current)
      current = parent.get(current)
    }
    chain.reverse()
    const modes: Record<string, string> = { ...system?.activeModes }
    for (const currentId of chain) {
      const node = document.nodes[currentId]
      if (!node) continue
      const override = node.instance?.overrides.$root
      if (override && Object.hasOwn(override, 'variableModes')) {
        const selected = stringRecord(override.variableModes)
        if (selected) Object.assign(modes, selected)
        continue
      }
      if (node.instance) {
        const template = document.nodes[node.instance.componentId]
        if (template?.variableModes) Object.assign(modes, template.variableModes)
      }
      if (node.variableModes) Object.assign(modes, node.variableModes)
    }
    modeCache.set(id, modes)
    return modes
  }

  const ensure = (id: string, modes: Record<string, string>, kind: TokenKind, seen = new Set<string>()): string | undefined => {
    if (!system || seen.has(id) || seen.size >= 64) return
    const variable = system.variables[id]
    const collection = variable && system.collections[variable.collection]
    if (!variable || variable.kind !== kind || !collection) return
    const mode = modes[variable.collection] ?? collection.defaultMode
    const key = `${encodeURIComponent(id)}/${encodeURIComponent(mode)}`
    if (uses.has(key)) return key
    seen.add(id)
    const raw = variable.values[mode]
    const stored = { ...modes }
    if (raw && typeof raw === 'object' && typeof (raw as { alias?: unknown }).alias === 'string') {
      const target = ensure((raw as { alias: string }).alias, modes, kind, seen)
      if (!target) return
      uses.set(key, { id, mode, kind, literal: '', aliasTargetKey: target, modes: stored })
      return key
    }
    const literal = literalOf(kind, raw, normalizeColor, formatNumber)
    if (literal === undefined) return
    uses.set(key, { id, mode, kind, literal, modes: stored })
    return key
  }

  const markReferenced = (key: string) => {
    const seen = new Set<string>()
    let current: string | undefined = key
    while (current && !seen.has(current)) {
      seen.add(current)
      referenced.add(current)
      current = uses.get(current)?.aliasTargetKey
    }
  }

  const claimMixin = (styleId: string, styleName: string, kind: MixinKind, body: string): string => {
    const cacheKey = `${kind}\0${styleId}\0${body}`
    const existing = mixinIds.get(cacheKey)
    if (existing) return `@include ${existing}`
    const fallback = kind === 'text' ? 'text' : 'effect'
    const base = (sanitizeIdent(styleName) || `${fallback}-${hashId(styleId)}`).slice(0, 80)
    let ident = base
    if (mixinTaken.has(ident)) ident = `${base}-${hashId(cacheKey)}`.slice(0, 120)
    let suffix = 2
    while (mixinTaken.has(ident)) ident = `${base}-${suffix++}`
    mixinTaken.add(ident)
    mixinIds.set(cacheKey, ident)
    mixins.push({ ident, body })
    return `@include ${ident}`
  }

  return {
    color(node: DesignNode | undefined, path: string, literal: string): string {
      const id = node?.bindings?.[path]
      if (!system || !node || !id || system.variables[id]?.kind !== 'color') return literal
      let resolved: string | undefined
      try { resolved = normalizeColor(String(variableValue(system, id, modesFor(node.id)))) } catch { resolved = undefined }
      if (resolved !== literal) {
        report.colorMismatch()
        return literal
      }
      const key = ensure(id, modesFor(node.id), 'color')
      if (!key) return literal
      markReferenced(key)
      return `${MARKER}c:${key}${MARKER}`
    },
    number(node: DesignNode, path: string, value: number, unit: 'px' | 'none' | 'percent', cssLiteral: string): string {
      const id = node.bindings?.[path]
      if (!system || !id || system.variables[id]?.kind !== 'number') return cssLiteral
      const modes = modesFor(node.id)
      let resolved: unknown
      try { resolved = variableValue(system, id, modes) } catch { resolved = undefined }
      const formatted = typeof resolved === 'number' && Number.isFinite(resolved) ? formatNumber(resolved) : undefined
      if (formatted === undefined || formatted !== formatNumber(value) || expectedLiteral(value, unit, formatNumber) !== cssLiteral) {
        report.numberMismatch()
        return cssLiteral
      }
      const key = ensure(id, modes, 'number')
      if (!key) return cssLiteral
      markReferenced(key)
      const prefix = unit === 'px' ? 'p' : unit === 'percent' ? 'r' : 'u'
      return `${MARKER}${prefix}:${key}${MARKER}`
    },
    boolean(node: DesignNode, path: string) {
      const id = node.bindings?.[path]
      if (!system || !id || system.variables[id]?.kind !== 'boolean') return
      let resolved: unknown
      try { resolved = variableValue(system, id, modesFor(node.id)) } catch { resolved = undefined }
      if (typeof resolved !== 'boolean' || resolved !== node.visible) {
        booleanMismatch = true
        return
      }
      const key = ensure(id, modesFor(node.id), 'boolean')
      if (!key) {
        booleanMismatch = true
        return
      }
      markReferenced(key)
    },
    fillColor(node: DesignNode, index: number, literal: string): string | undefined {
      const styleId = node.styleRefs?.fills
      if (!system || !styleId) return
      const style = system.styles[styleId]
      if (!style || !plainSolidPaints(style)) return
      const paint = (style.value as { visible?: boolean; color?: string }[])[index]
      if (!paint || paint.visible === false || typeof paint.color !== 'string') return
      const color = normalizeColor(paint.color)
      if (!color || color !== literal) return
      const key = `${encodeURIComponent(styleId)}/${index}`
      paintUses.set(key, { styleId, literal: color })
      return `${MARKER}s:${key}${MARKER}`
    },
    applyText(styleId: string, styleName: string, styleCss: string[], parts: { css: string; scss: string }[]): string[] {
      const styleByProp = new Map(styleCss.map(decl => [decl.slice(0, decl.indexOf(':')), decl]))
      const kinds = parts.map(part => {
        const prop = part.css.slice(0, part.css.indexOf(':'))
        if (prop === 'font-size') return 'keep' as const
        return styleByProp.get(prop) === part.css && part.scss === part.css ? 'mixin' as const : 'keep' as const
      })
      let bestStart = -1, bestLen = 0
      for (let i = 0; i < kinds.length; i++) {
        if (kinds[i] !== 'mixin') continue
        let end = i
        while (end < kinds.length && kinds[end] === 'mixin') end++
        if (end - i > bestLen) { bestStart = i; bestLen = end - i }
        i = end - 1
      }
      if (bestLen === 0) return parts.map(part => part.scss)
      textMixed.add(styleId)
      const include = claimMixin(styleId, styleName, 'text', parts.slice(bestStart, bestStart + bestLen).map(part => part.css).join(';'))
      const out: string[] = []
      for (let i = 0; i < parts.length; i++) {
        if (i === bestStart) out.push(include)
        if (i >= bestStart && i < bestStart + bestLen) continue
        out.push(parts[i].scss)
      }
      return out
    },
    effectScss(styleId: string, styleName: string, styleCss: string[], nodeCss: string[]): string[] {
      if (!styleCss.length || styleCss.join(';') !== nodeCss.join(';')) {
        if (styleCss.length) effectOmitted = true
        return nodeCss
      }
      return [claimMixin(styleId, styleName, 'effect', nodeCss.join(';'))]
    },
    render(rules: { scss: string; nodeId?: string }[], entries: { node: DesignNode; parentId: string | null }[]): { scss: string; warnings: DesignAutomationWarning[] } {
      addInactiveModes(system, uses, referenced, ensure, () => { inactiveSkipped = true })
      const idents = assignIdents(system, uses, referenced)
      const paintIdents = assignPaintIdents(system, paintUses, new Set(idents.values()))
      const lines: string[] = []
      const emitted = new Set<string>()
      const emit = (key: string) => {
        if (emitted.has(key)) return
        const use = uses.get(key)
        const ident = idents.get(key)
        if (!use || !ident) throw new AutomationError('invalid_params', 'SCSS substitution failed')
        if (use.aliasTargetKey) emit(use.aliasTargetKey)
        emitted.add(key)
        lines.push(use.aliasTargetKey ? `$${ident}: $${idents.get(use.aliasTargetKey)};` : `$${ident}: ${use.literal};`)
      }
      for (const key of [...uses.keys()].sort()) emit(key)
      for (const key of [...paintIdents.keys()].sort()) lines.push(`$${paintIdents.get(key)}: ${paintUses.get(key)!.literal};`)
      for (const mixin of mixins) lines.push(`@mixin ${mixin.ident}{${mixin.body}}`)
      const replacements = new Map<string, string>()
      for (const [key, ident] of idents) {
        const use = uses.get(key)!
        if (use.kind === 'color') replacements.set(`c:${key}`, `$${ident}`)
        if (use.kind === 'number') {
          replacements.set(`p:${key}`, `#{$${ident}}px`)
          replacements.set(`u:${key}`, `$${ident}`)
          replacements.set(`r:${key}`, `#{$${ident} * 100%}`)
        }
      }
      for (const [key, ident] of paintIdents) replacements.set(`s:${key}`, `$${ident}`)
      const replaced = rules.map(rule => ({ ...rule, scss: replaceMarkers(rule.scss, replacements) }))
      const nested = nestRules(replaced, entries)
      const scss = `${[...lines, ...nested.rules].join('\n')}\n`
      if (scss.includes(MARKER)) throw new AutomationError('invalid_params', 'SCSS substitution failed')
      return { scss, warnings: omissionWarnings(entries, { paintUses, textMixed, effectOmitted, booleanMismatch, inactiveSkipped, nested: nested.nested }) }
    },
  }
}

function literalOf(kind: TokenKind, raw: VariableValue | undefined, normalizeColor: (value: string) => string | undefined, formatNumber: (value: number) => string): string | undefined {
  if (kind === 'color' && typeof raw === 'string') return normalizeColor(raw)
  if (kind === 'number' && typeof raw === 'number' && Number.isFinite(raw)) return formatNumber(raw)
  if (kind === 'boolean' && typeof raw === 'boolean') return raw ? 'true' : 'false'
  return undefined
}

function expectedLiteral(value: number, unit: 'px' | 'none' | 'percent', formatNumber: (value: number) => string): string {
  if (unit === 'px') return `${formatNumber(value)}px`
  if (unit === 'none') return formatNumber(value)
  return `${formatNumber(Math.max(0, Math.min(1, value)) * 100)}%`
}

function plainSolidPaints(style: DesignSystem['styles'][string]): boolean {
  if (style.kind !== 'paint' || style.strokes?.length || style.effects?.length || !Array.isArray(style.value) || !style.value.length) return false
  return style.value.every(paint => !!paint && typeof paint === 'object' && (paint as { kind?: string }).kind === 'solid' && typeof (paint as { color?: unknown }).color === 'string')
}

function addInactiveModes(
  system: DesignSystem | undefined,
  uses: Map<string, TokenUse>,
  referenced: Set<string>,
  ensure: (id: string, modes: Record<string, string>, kind: TokenKind) => string | undefined,
  onSkip: () => void,
) {
  if (!system) return
  const seen = new Set<string>()
  for (const key of [...referenced]) {
    const use = uses.get(key)
    if (!use || seen.has(use.id)) continue
    seen.add(use.id)
    const variable = system.variables[use.id]
    const collection = variable && system.collections[variable.collection]
    if (!collection) continue
    const used = new Set<string>()
    for (const ref of referenced) if (uses.get(ref)?.id === use.id) used.add(uses.get(ref)!.mode)
    for (const mode of collection.modes) {
      if (used.has(mode)) continue
      const modes = { ...use.modes, [variable.collection]: mode }
      if (!ensure(use.id, modes, use.kind)) onSkip()
    }
  }
}

function replaceMarkers(rule: string, replacements: Map<string, string>): string {
  let result = '', cursor = 0
  while (cursor < rule.length) {
    const start = rule.indexOf(MARKER, cursor)
    if (start < 0) return result + rule.slice(cursor)
    const end = rule.indexOf(MARKER, start + MARKER.length)
    if (end < 0) throw new AutomationError('invalid_params', 'SCSS substitution failed')
    const replacement = replacements.get(rule.slice(start + MARKER.length, end))
    if (replacement === undefined) throw new AutomationError('invalid_params', 'SCSS substitution failed')
    result += `${rule.slice(cursor, start)}${replacement}`
    cursor = end + MARKER.length
  }
  return result
}

function nestRules(rules: { scss: string; nodeId?: string }[], entries: { node: DesignNode; parentId: string | null }[]): { rules: string[]; nested: boolean } {
  const included = new Set(entries.map(entry => entry.node.id))
  const nodeRule = new Map<string, string>()
  for (const rule of rules) if (rule.nodeId) nodeRule.set(rule.nodeId, rule.scss)
  const children = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.parentId || !included.has(entry.parentId) || !nodeRule.has(entry.node.id)) continue
    const list = children.get(entry.parentId) ?? []
    list.push(entry.node.id)
    children.set(entry.parentId, list)
  }
  const nested = new Set<string>()
  for (const ids of children.values()) for (const id of ids) nested.add(id)
  const emit = (id: string): string => {
    const rule = nodeRule.get(id)
    if (!rule) throw new AutomationError('invalid_params', 'SCSS nesting failed')
    const kids = children.get(id) ?? []
    if (!kids.length) return rule
    const open = rule.lastIndexOf('{')
    if (open < 0 || !rule.endsWith('}')) throw new AutomationError('invalid_params', 'SCSS nesting failed')
    const body = rule.slice(open + 1, -1)
    const nestedKids = kids.map(kid => `@at-root ${emit(kid)}`).join(';')
    return `${rule.slice(0, open + 1)}${body}${body && nestedKids ? ';' : ''}${nestedKids}}`
  }
  const out: string[] = []
  for (const rule of rules) {
    if (!rule.nodeId) { out.push(rule.scss); continue }
    if (nested.has(rule.nodeId)) continue
    out.push(emit(rule.nodeId))
  }
  return { rules: out, nested: nested.size > 0 }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return
    result[key] = item
  }
  return result
}

function sanitizeIdent(value: string): string {
  const clean = value.normalize('NFKC')
  // Keep ordinary token names. Anything else, including CSS punctuation, becomes a hash.
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[ /._-][A-Za-z0-9]+)*$/.test(clean)) return ''
  return clean.replace(/[ /._-]+/g, '-').slice(0, 80)
}

function hashId(id: string): string {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  return (hash >>> 0).toString(36)
}

function assignIdents(system: DesignSystem | undefined, uses: Map<string, TokenUse>, referenced: Set<string>): Map<string, string> {
  const modesById = new Map<string, Set<string>>()
  for (const key of referenced) {
    const use = uses.get(key)
    if (!use) continue
    const modes = modesById.get(use.id) ?? new Set<string>()
    modes.add(use.mode)
    modesById.set(use.id, modes)
  }
  const bases = new Map<string, string>()
  for (const [key, use] of uses) {
    const name = system?.variables[use.id]?.name ?? use.kind
    const fallback = use.kind === 'color' ? 'color' : use.kind === 'number' ? 'number' : 'flag'
    let base = sanitizeIdent(name) || `${fallback}-${hashId(use.id)}`
    if (!referenced.has(key) || (modesById.get(use.id)?.size ?? 0) > 1) base = `${base}-${sanitizeIdent(use.mode) || 'mode'}`.slice(0, 100)
    bases.set(key, base)
  }
  const taken = new Set<string>()
  const idents = new Map<string, string>()
  const order = [...referenced].sort().concat([...uses.keys()].filter(key => !referenced.has(key)).sort())
  for (const key of order) {
    let ident = bases.get(key)!
    if (taken.has(ident)) ident = `${ident}-${hashId(key)}`.slice(0, 120)
    let suffix = 2
    const base = bases.get(key)!
    while (taken.has(ident)) ident = `${base}-${suffix++}`
    taken.add(ident)
    idents.set(key, ident)
  }
  return idents
}

function assignPaintIdents(system: DesignSystem | undefined, uses: Map<string, PaintUse>, taken: Set<string>): Map<string, string> {
  const byStyle = new Map<string, string[]>()
  for (const [key, use] of uses) {
    const list = byStyle.get(use.styleId) ?? []
    list.push(key)
    byStyle.set(use.styleId, list)
  }
  const idents = new Map<string, string>()
  for (const styleId of [...byStyle.keys()].sort()) {
    const keys = byStyle.get(styleId)!.sort()
    const name = sanitizeIdent(system?.styles[styleId]?.name ?? '') || `paint-${hashId(styleId)}`
    keys.forEach((key, index) => {
      let base = keys.length > 1 ? `${name}-${index + 1}` : name
      let ident = base
      if (taken.has(ident)) ident = `${ident}-${hashId(key)}`.slice(0, 120)
      let suffix = 2
      while (taken.has(ident)) ident = `${base}-${suffix++}`
      taken.add(ident)
      idents.set(key, ident)
    })
  }
  return idents
}

function omissionWarnings(
  entries: { node: DesignNode }[],
  state: {
    paintUses: Map<string, PaintUse>
    textMixed: Set<string>
    effectOmitted: boolean
    booleanMismatch: boolean
    inactiveSkipped: boolean
    nested: boolean
  },
): DesignAutomationWarning[] {
  const emittedPaint = new Set([...state.paintUses.values()].map(use => use.styleId))
  let paintOmitted = false, textOmitted = false, nestingPossible = false
  const exported = new Set(entries.map(entry => entry.node.id))
  for (const { node } of entries) {
    if (node.children.some(id => exported.has(id))) nestingPossible = true
    const fills = node.styleRefs?.fills
    const strokes = node.styleRefs?.strokes
    if (strokes || (fills && !emittedPaint.has(fills))) paintOmitted = true
    if (node.styleRefs?.textStyle && !state.textMixed.has(node.styleRefs.textStyle)) textOmitted = true
  }
  const warnings: DesignAutomationWarning[] = []
  if (state.booleanMismatch) warnings.push({ code: 'SCSS_BOOLEAN_MISMATCH', message: 'A bound boolean did not match the resolved visibility, so no Sass boolean was emitted for it.' })
  if (textOmitted) warnings.push({ code: 'SCSS_TEXT_STYLE_OMITTED', message: 'A shared text style had no reusable declarations for this selection, so its typography stayed inline.' })
  if (state.effectOmitted) warnings.push({ code: 'SCSS_EFFECT_STYLE_OMITTED', message: 'A shared effect style did not match the exported shadow or blur declarations, so those declarations stayed inline.' })
  if (paintOmitted) warnings.push({ code: 'SCSS_PAINT_STYLE_OMITTED', message: 'A shared paint style was not a single solid fill, or was not the color used by the selection, so it stayed inline.' })
  if (nestingPossible && !state.nested) warnings.push({ code: 'SCSS_NESTING_OMITTED', message: 'The selection tree stays a flat list of id rules.' })
  if (state.inactiveSkipped) warnings.push({ code: 'SCSS_INACTIVE_MODES_OMITTED', message: 'A mode of a selection variable could not be represented as a Sass value and was left out.' })
  return warnings
}
