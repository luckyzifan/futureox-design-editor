import { variableValue, type DesignSystem } from '../design-system'
import type { DesignDocument, DesignNode } from '../model'
import { AutomationError } from './types'
import type { DesignAutomationWarning } from './context'

type ColorUse = { id: string; mode: string; literal: string; aliasTargetKey?: string }

const MARKER = '\u0000'

/** Selection-scoped Sass for bound fill colors.
 * The substituted source is the flat CSS stylesheet: nesting, mixins, number
 * tokens, shared styles and inactive modes stay explicit warnings. */
export function createScssColorSession(
  document: DesignDocument,
  normalizeColor: (value: string) => string | undefined,
  onMismatch: () => void,
) {
  const system = document.designSystem
  const parent = new Map<string, string>()
  for (const node of Object.values(document.nodes)) for (const child of node.children) parent.set(child, node.id)
  const modeCache = new Map<string, Record<string, string>>()
  const uses = new Map<string, ColorUse>()

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

  const ensure = (id: string, modes: Record<string, string>, seen = new Set<string>()): string | undefined => {
    if (!system || seen.has(id) || seen.size >= 64) return
    const variable = system.variables[id]
    const collection = variable && system.collections[variable.collection]
    if (!variable || variable.kind !== 'color' || !collection) return
    const mode = modes[variable.collection] ?? collection.defaultMode
    const key = `${encodeURIComponent(id)}/${encodeURIComponent(mode)}`
    if (uses.has(key)) return key
    seen.add(id)
    const raw = variable.values[mode]
    if (raw && typeof raw === 'object' && typeof raw.alias === 'string') {
      const target = ensure(raw.alias, modes, seen)
      if (!target) return
      uses.set(key, { id, mode, literal: '', aliasTargetKey: target })
      return key
    }
    if (typeof raw !== 'string') return
    const literal = normalizeColor(raw)
    if (!literal) return
    uses.set(key, { id, mode, literal })
    return key
  }

  return {
    color(node: DesignNode | undefined, path: string, literal: string): string {
      const id = node?.bindings?.[path]
      if (!system || !node || !id || system.variables[id]?.kind !== 'color') return literal
      let resolved: string | undefined
      try { resolved = normalizeColor(String(variableValue(system, id, modesFor(node.id)))) } catch { resolved = undefined }
      if (resolved !== literal) {
        onMismatch()
        return literal
      }
      const key = ensure(id, modesFor(node.id))
      return key ? `${MARKER}${key}${MARKER}` : literal
    },
    render(rules: string[], entries: { node: DesignNode }[]): { scss: string; warnings: DesignAutomationWarning[] } {
      const idents = assignIdents(system, uses)
      const lines: string[] = []
      const emitted = new Set<string>()
      const emit = (key: string) => {
        if (emitted.has(key)) return
        const use = uses.get(key)
        const ident = idents.get(key)
        if (!use || !ident) throw new AutomationError('invalid_params', 'SCSS color substitution failed')
        if (use.aliasTargetKey) emit(use.aliasTargetKey)
        emitted.add(key)
        lines.push(use.aliasTargetKey ? `$${ident}: $${idents.get(use.aliasTargetKey)};` : `$${ident}: ${use.literal};`)
      }
      for (const key of [...uses.keys()].sort()) emit(key)
      const body = rules.map(rule => replaceMarkers(rule, idents))
      const scss = `${[...lines, ...body].join('\n')}\n`
      if (scss.includes(MARKER)) throw new AutomationError('invalid_params', 'SCSS color substitution failed')
      return { scss, warnings: omissionWarnings(system, uses, entries) }
    },
  }
}

function replaceMarkers(rule: string, idents: Map<string, string>): string {
  let result = '', cursor = 0
  while (cursor < rule.length) {
    const start = rule.indexOf(MARKER, cursor)
    if (start < 0) return result + rule.slice(cursor)
    const end = rule.indexOf(MARKER, start + MARKER.length)
    if (end < 0) throw new AutomationError('invalid_params', 'SCSS color substitution failed')
    const ident = idents.get(rule.slice(start + MARKER.length, end))
    if (!ident) throw new AutomationError('invalid_params', 'SCSS color substitution failed')
    result += `${rule.slice(cursor, start)}$${ident}`
    cursor = end + MARKER.length
  }
  return result
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

function assignIdents(system: DesignSystem | undefined, uses: Map<string, ColorUse>): Map<string, string> {
  const modesById = new Map<string, Set<string>>()
  for (const use of uses.values()) {
    const modes = modesById.get(use.id) ?? new Set<string>()
    modes.add(use.mode)
    modesById.set(use.id, modes)
  }
  const bases = new Map<string, string>()
  for (const [key, use] of uses) {
    const name = system?.variables[use.id]?.name ?? 'color'
    let base = sanitizeIdent(name) || `color-${hashId(use.id)}`
    if ((modesById.get(use.id)?.size ?? 0) > 1) base = `${base}-${sanitizeIdent(use.mode) || 'mode'}`.slice(0, 100)
    bases.set(key, base)
  }
  const taken = new Set<string>()
  const idents = new Map<string, string>()
  for (const key of [...bases.keys()].sort()) {
    let ident = bases.get(key)!
    if (taken.has(ident)) ident = `${ident}-${hashId(key)}`.slice(0, 120)
    let suffix = 2
    while (taken.has(ident)) ident = `${bases.get(key)}-${suffix++}`
    taken.add(ident)
    idents.set(key, ident)
  }
  return idents
}

function omissionWarnings(system: DesignSystem | undefined, uses: Map<string, ColorUse>, entries: { node: DesignNode }[]): DesignAutomationWarning[] {
  let numbers = false, booleans = false, textStyle = false, effectStyle = false, paintStyle = false, nesting = false
  const exported = new Set(entries.map(entry => entry.node.id))
  for (const { node } of entries) {
    if (node.children.some(id => exported.has(id))) nesting = true
    for (const path of Object.keys(node.bindings ?? {})) {
      if (path === 'visible') booleans = true
      else if (path !== 'text' && !path.endsWith('.color')) numbers = true
    }
    if (node.styleRefs?.textStyle) textStyle = true
    if (node.styleRefs?.effects) effectStyle = true
    if (node.styleRefs?.fills || node.styleRefs?.strokes) paintStyle = true
  }
  const usedModes = new Map<string, Set<string>>()
  for (const use of uses.values()) {
    const variable = system?.variables[use.id]
    if (!variable) continue
    const modes = usedModes.get(variable.collection) ?? new Set<string>()
    modes.add(use.mode)
    usedModes.set(variable.collection, modes)
  }
  const inactive = [...usedModes].some(([collectionId, modes]) => system?.collections[collectionId]?.modes.some(mode => !modes.has(mode)))
  const warnings: DesignAutomationWarning[] = []
  if (numbers) warnings.push({ code: 'SCSS_NUMBER_BINDINGS_OMITTED', message: 'Bound number variables stay numeric literals. This SCSS export only creates Sass variables for fill color bindings.' })
  if (booleans) warnings.push({ code: 'SCSS_BOOLEAN_BINDINGS_OMITTED', message: 'Bound boolean variables, including visibility, are not emitted as Sass booleans.' })
  if (textStyle) warnings.push({ code: 'SCSS_TEXT_STYLE_OMITTED', message: 'Shared text styles are inlined. This SCSS export does not create mixins or placeholders for them.' })
  if (effectStyle) warnings.push({ code: 'SCSS_EFFECT_STYLE_OMITTED', message: 'Shared effect styles are inlined. This SCSS export does not create mixins for shadows or blurs.' })
  if (paintStyle) warnings.push({ code: 'SCSS_PAINT_STYLE_OMITTED', message: 'Shared paint styles are inlined. This SCSS export does not create Sass variables or mixins from paint style names.' })
  if (nesting) warnings.push({ code: 'SCSS_NESTING_OMITTED', message: 'The selection tree stays a flat list of id rules. SCSS nesting is not emitted, so compiled selectors stay identical to the CSS export.' })
  if (inactive) warnings.push({ code: 'SCSS_INACTIVE_MODES_OMITTED', message: 'Only modes used by this selection become Sass variables. Other modes of the same collection are not emitted as maps or extra variables.' })
  return warnings
}
