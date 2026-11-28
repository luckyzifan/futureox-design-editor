/** Local Figma-shaped design context.
 *
 * Figma's get_design_context answers with React + Tailwind source plus
 * structured metadata. Futureox has no Figma cloud file, Code Connect registry,
 * or Figma renderer. This module therefore derives a *local* React/Tailwind
 * approximation from the bounded `context.get` result and the local variable
 * and style catalogs. Every field that cannot be represented in that
 * approximation is listed in `unmapped`; nothing is synthesized or silently
 * dropped. It is not Figma output and does not claim pixel or component parity.
 */

import { isRecord } from './framing.mjs'

export const DESIGN_CONTEXT_FORMAT = 'futureox.figma-design-context.v1'
export const DESIGN_CONTEXT_NODE_LIMIT = 40
const MAX_UNMAPPED = 200
const MAX_VALUE_CHARS = 200
const MAX_CODE_BYTES = 60 * 1024

const STANDARD_BLENDS = new Map([
  ['multiply', 'mix-blend-multiply'], ['screen', 'mix-blend-screen'], ['overlay', 'mix-blend-overlay'],
  ['darken', 'mix-blend-darken'], ['lighten', 'mix-blend-lighten'], ['color-dodge', 'mix-blend-color-dodge'],
  ['color-burn', 'mix-blend-color-burn'], ['hard-light', 'mix-blend-hard-light'], ['soft-light', 'mix-blend-soft-light'],
  ['difference', 'mix-blend-difference'], ['exclusion', 'mix-blend-exclusion'], ['hue', 'mix-blend-hue'],
  ['saturation', 'mix-blend-saturation'], ['color', 'mix-blend-color'], ['luminosity', 'mix-blend-luminosity'],
])

const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const round = value => Math.round(value * 1000) / 1000
const unit = value => `${round(finite(value))}px`
const percent = value => `${round(Math.max(0, Math.min(1, finite(value, 1))) * 100)}%`
const hex = value => typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toLowerCase() : null
const list = value => Array.isArray(value) ? value : []
const record = value => isRecord(value) ? value : {}

function boundedValue(value) {
  if (value === undefined) return undefined
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
  } catch { return '[unserializable]' }
}

function normalizePaint(paint) {
  if (!isRecord(paint)) return null
  return {
    kind: typeof paint.kind === 'string' ? paint.kind : 'unknown',
    color: hex(paint.color),
    opacity: Number.isFinite(paint.opacity) ? paint.opacity : 1,
    visible: paint.visible !== false,
    angle: Number.isFinite(paint.angle) ? paint.angle : 0,
    stops: list(paint.stops).slice(0, 32).map(stop => ({
      offset: finite(stop?.offset), color: hex(stop?.color) ?? '#000000',
    })),
    ...(typeof paint.assetId === 'string' ? { assetId: paint.assetId } : {}),
    ...(typeof paint.id === 'string' ? { paintId: paint.id } : {}),
  }
}

function normalizeStroke(stroke) {
  if (!isRecord(stroke)) return null
  return {
    width: finite(stroke.width),
    align: typeof stroke.align === 'string' ? stroke.align : 'center',
    visible: stroke.visible !== false,
    paint: normalizePaint(stroke.paint),
  }
}

function normalizeEffect(effect) {
  if (!isRecord(effect)) return null
  return {
    kind: typeof effect.kind === 'string' ? effect.kind : 'unknown',
    visible: effect.visible !== false,
    radius: finite(effect.radius), x: finite(effect.x), y: finite(effect.y), spread: finite(effect.spread),
    color: hex(effect.color), opacity: Number.isFinite(effect.opacity) ? effect.opacity : 1,
    amount: finite(effect.amount),
  }
}

function normalizeLayout(layout) {
  const source = record(layout)
  const mode = ['horizontal', 'vertical', 'grid'].includes(source.mode) ? source.mode : 'none'
  return {
    mode,
    gap: finite(source.gap), lineGap: finite(source.lineGap),
    padding: list(source.padding).slice(0, 4).map(value => finite(value)),
    wrap: source.wrap === true, reverseFlow: source.reverseFlow === true,
    justify: typeof source.justify === 'string' ? source.justify : 'start',
    align: typeof source.align === 'string' ? source.align : 'start',
    columns: Math.max(0, Math.floor(finite(source.columns))),
    ...(source.stackingOrder !== undefined ? { stackingOrder: source.stackingOrder } : {}),
    ...(source.bordersAffectLayout !== undefined ? { bordersAffectLayout: source.bordersAffectLayout } : {}),
  }
}

function normalizeText(text) {
  if (!isRecord(text)) return null
  const style = record(text.style)
  return {
    content: typeof text.content === 'string' ? text.content : '',
    characters: Math.max(0, Math.floor(finite(text.characters))),
    truncated: text.truncated === true,
    fontSize: finite(text.fontSize),
    style: {
      fontId: typeof style.fontId === 'string' ? style.fontId : undefined,
      weight: finite(style.weight), lineHeight: finite(style.lineHeight),
      lineHeightPixels: Number.isFinite(style.lineHeightPixels) ? style.lineHeightPixels : undefined,
      letterSpacing: finite(style.letterSpacing),
      align: typeof style.align === 'string' ? style.align : undefined,
      textCase: typeof style.textCase === 'string' ? style.textCase : undefined,
      wrap: typeof style.wrap === 'boolean' ? style.wrap : undefined,
      direction: typeof style.direction === 'string' ? style.direction : undefined,
      verticalAlign: typeof style.verticalAlign === 'string' ? style.verticalAlign : undefined,
    },
    runs: list(text.runs).length,
  }
}

function normalizeNode(entry) {
  const geometry = record(entry.geometry)
  const transform = list(geometry.transform).length === 6 ? geometry.transform.map(value => finite(value, 0)) : [1, 0, 0, 1, 0, 0]
  const shape = record(entry.shape)
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : '',
    type: typeof entry.kind === 'string' ? entry.kind : 'node',
    parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
    rect: {
      x: round(transform[4]), y: round(transform[5]),
      width: round(finite(geometry.width, finite(entry.width))), height: round(finite(geometry.height, finite(entry.height))),
    },
    transform,
    visible: entry.visible !== false,
    opacity: Number.isFinite(entry.opacity) ? entry.opacity : 1,
    blend: typeof entry.blend === 'string' ? entry.blend : 'normal',
    layout: normalizeLayout(entry.layout),
    fills: list(entry.fills).slice(0, 16).map(normalizePaint).filter(Boolean),
    strokes: list(entry.strokes).slice(0, 16).map(normalizeStroke).filter(Boolean),
    effects: list(entry.effects).slice(0, 16).map(normalizeEffect).filter(Boolean),
    radii: list(shape.radii).slice(0, 4).map(value => finite(value)),
    clip: shape.clip === true,
    mask: shape.mask === true,
    maskType: typeof shape.maskType === 'string' ? shape.maskType : undefined,
    booleanOperation: typeof shape.booleanOperation === 'string' ? shape.booleanOperation : undefined,
    text: normalizeText(entry.text),
    sizing: record(entry.sizing),
    constraints: record(entry.constraints),
    components: record(entry.components),
    tokens: record(entry.tokens),
    children: [],
    classes: [],
  }
}

function paddingClasses(padding) {
  if (padding.length !== 4) return []
  const [top, right, bottom, left] = padding
  if (![top, right, bottom, left].every(value => Number.isFinite(value))) return []
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return []
  if (top === right && right === bottom && bottom === left) return [`p-[${unit(top)}]`]
  return [
    ...(top ? [`pt-[${unit(top)}]`] : []), ...(right ? [`pr-[${unit(right)}]`] : []),
    ...(bottom ? [`pb-[${unit(bottom)}]`] : []), ...(left ? [`pl-[${unit(left)}]`] : []),
  ]
}

function justifyClass(value) {
  return {
    start: 'justify-start', center: 'justify-center', end: 'justify-end', stretch: 'justify-stretch',
    'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly',
    'unsafe-center': 'justify-center', 'unsafe-end': 'justify-end',
  }[value]
}

function alignClass(value) {
  return {
    start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch',
    'unsafe-center': 'items-center', 'unsafe-end': 'items-end',
  }[value]
}

function paintClasses(kind, paint) {
  if (!paint || paint.visible === false) return []
  const color = paint.color
  if (paint.kind === 'solid' && color) {
    const opacity = paint.opacity < 1 ? `/${Math.max(1, Math.round(paint.opacity * 100))}` : ''
    return [`${kind}-[${color}]${opacity}`]
  }
  if (kind === 'bg' && paint.kind === 'linear' && paint.stops.length >= 2) {
    const stops = paint.stops.map(stop => `${stop.color}_${percent(stop.offset)}`).join(',')
    const angle = round(finite(paint.angle))
    return [`bg-[linear-gradient(${angle}deg,${stops})]`]
  }
  return []
}

/** Build the bounded local context. The caller owns the Design API fences and
 * supplies only a successful context.get result plus optional catalogs. */
export function buildLocalDesignContext({ context, variables, styles, options = {} } = {}) {
  if (!isRecord(context) || !Array.isArray(context.nodes)) throw new TypeError('Design context requires a context.get result')
  const entries = new Map()
  const order = []
  for (const raw of context.nodes.slice(0, 500)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) continue
    if (entries.has(raw.id)) continue
    entries.set(raw.id, normalizeNode(raw))
    order.push(raw.id)
  }
  const unmapped = []
  let unmappedCount = 0
  const mark = (nodeId, field, reason, value) => {
    unmappedCount += 1
    if (unmapped.length >= MAX_UNMAPPED) return
    const bounded = boundedValue(value)
    unmapped.push({ nodeId, field, reason, ...(bounded === undefined ? {} : { value: bounded }) })
  }

  const childrenOf = new Map()
  const roots = []
  for (const id of order) {
    const node = entries.get(id)
    if (node.parentId && entries.has(node.parentId)) {
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, [])
      childrenOf.get(node.parentId).push(id)
    } else roots.push(id)
  }
  const requestedRoots = list(context.rootIds).filter(id => entries.has(id))
  const rootIds = [...new Set(requestedRoots.length ? requestedRoots : roots)]

  const variablesList = catalog(variables, 'variables')
  const stylesList = catalog(styles, 'styles')
  const variableById = new Map(variablesList.map(entry => [entry.id, entry]))
  const styleById = new Map(stylesList.map(entry => [entry.id, entry]))
  const usedVariables = new Set()
  const usedStyles = new Set()

  const build = (id, parentLayout, depth) => {
    const node = entries.get(id)
    const children = (childrenOf.get(id) ?? []).map(child => build(child, node.layout, depth + 1)).filter(Boolean)
    node.children = children
    const nodeId = node.id

    if (!node.visible) node.classes.push('hidden')
    if (node.opacity < 1) node.classes.push(`opacity-[${round(node.opacity)}]`)
    if (node.blend === 'pass-through') mark(nodeId, 'blend', 'pass-through group blending has no single CSS equivalent', node.blend)
    else if (node.blend !== 'normal') {
      const mapped = STANDARD_BLENDS.get(node.blend)
      if (mapped) node.classes.push(mapped)
      else mark(nodeId, 'blend', 'CSS has no equivalent blend mode', node.blend)
    }

    const mode = node.layout.mode
    if (mode === 'horizontal') node.classes.push('flex', 'flex-row', ...(node.layout.reverseFlow ? ['flex-row-reverse'] : []))
    else if (mode === 'vertical') node.classes.push('flex', 'flex-col', ...(node.layout.reverseFlow ? ['flex-col-reverse'] : []))
    else if (mode === 'grid') {
      node.classes.push('grid')
      if (node.layout.columns > 0) node.classes.push(`grid-cols-[repeat(${node.layout.columns},minmax(0,1fr))]`)
    } else node.classes.push('relative')
    if (mode !== 'none') {
      if (node.layout.gap) node.classes.push(`gap-[${unit(node.layout.gap)}]`)
      if (node.layout.lineGap && node.layout.lineGap !== node.layout.gap) node.classes.push(`gap-y-[${unit(node.layout.lineGap)}]`)
      if (node.layout.wrap) node.classes.push('flex-wrap')
      const justify = justifyClass(node.layout.justify), align = alignClass(node.layout.align)
      if (justify) node.classes.push(justify)
      if (align) node.classes.push(align)
      node.classes.push(...paddingClasses(node.layout.padding))
      if (node.layout.stackingOrder !== undefined) mark(nodeId, 'layout.stackingOrder', 'paint stacking order is not represented by flex/grid classes', node.layout.stackingOrder)
      if (node.layout.bordersAffectLayout !== undefined) mark(nodeId, 'layout.bordersAffectLayout', 'border layout mode is not represented by Tailwind classes', node.layout.bordersAffectLayout)
    } else if (parentLayout.mode === 'none') {
      node.classes.push('absolute', `left-[${unit(node.rect.x)}]`, `top-[${unit(node.rect.y)}]`)
    }
    node.classes.push(`w-[${unit(node.rect.width)}]`, `h-[${unit(node.rect.height)}]`)

    if (node.text) {
      const text = node.text
      if (text.fontSize > 0) node.classes.push(`text-[${unit(text.fontSize)}]`)
      if (text.style.weight > 0) node.classes.push(`font-[${Math.round(text.style.weight)}]`)
      if (text.style.lineHeightPixels !== undefined) node.classes.push(`leading-[${unit(text.style.lineHeightPixels)}]`)
      else if (text.style.lineHeight > 0) node.classes.push(`leading-[${round(text.style.lineHeight)}]`)
      if (text.style.letterSpacing) node.classes.push(`tracking-[${unit(text.style.letterSpacing)}]`)
      const align = { start: 'text-left', center: 'text-center', end: 'text-right', justify: 'text-justify' }[text.style.align]
      if (align) node.classes.push(align)
      const textCase = {
        upper: 'uppercase', lower: 'lowercase', title: 'capitalize', original: 'normal-case',
        smallCaps: '[font-variant-caps:small-caps]', smallCapsForced: '[font-variant-caps:all-small-caps]',
      }[text.style.textCase]
      if (textCase) node.classes.push(textCase)
      if (text.style.wrap === false) node.classes.push('whitespace-nowrap')
      if (text.truncated) mark(nodeId, 'text.content', 'context truncated the text content; the JSX contains only the returned prefix', text.characters)
      if (text.runs > 1) mark(nodeId, 'text.runs', 'per-run rich text is not represented in plain JSX text', text.runs)
      if (text.style.fontId) mark(nodeId, 'text.style.fontId', 'the context carries a local fontId, not a CSS font family name', text.style.fontId)
      if (text.style.verticalAlign && text.style.verticalAlign !== 'top') mark(nodeId, 'text.style.verticalAlign', 'vertical text alignment is not mapped to Tailwind', text.style.verticalAlign)
      if (text.style.direction === 'rtl' || text.style.direction === 'ltr') node.classes.push(text.style.direction === 'rtl' ? 'text-right' : 'text-left')
    }

    const textPaint = node.text ? node.fills.find(fill => fill.visible && fill.kind === 'solid') : undefined
    if (node.text) {
      if (textPaint) node.classes.push(...paintClasses('text', textPaint))
      else if (node.fills.some(fill => fill.visible)) mark(nodeId, 'fills', 'text paint is not a solid color; no text color class was generated', node.fills)
    } else {
      const visible = node.fills.filter(fill => fill.visible)
      const first = visible[0]
      if (first) {
        const classes = paintClasses('bg', first)
        node.classes.push(...classes)
        if (!classes.length) mark(nodeId, 'fills[0]', 'paint kind has no Tailwind background equivalent', first)
        if (visible.length > 1) mark(nodeId, 'fills', 'only the first paint layer maps to a background; stacked paints are not represented', visible.length)
      }
    }

    const stroke = node.strokes.find(item => item.visible && item.width > 0)
    if (stroke) {
      const classes = paintClasses('border', stroke.paint)
      if (classes.length) {
        node.classes.push(`border-[${unit(stroke.width)}]`, ...classes)
        if (stroke.align !== 'center') mark(nodeId, 'strokes[0].align', 'CSS borders do not reproduce inside/outside stroke alignment', stroke.align)
      } else mark(nodeId, 'strokes[0]', 'stroke paint has no Tailwind border equivalent', stroke.paint)
      if (node.strokes.filter(item => item.visible && item.width > 0).length > 1) mark(nodeId, 'strokes', 'only the first visible stroke maps to a border', node.strokes.length)
    }
    for (const effect of node.effects.filter(item => item.visible)) mark(nodeId, 'effects', 'effects are not silently approximated as Tailwind shadows or filters', effect.kind)

    const radii = node.radii.length === 4 ? node.radii : []
    if (radii.some(value => value > 0)) {
      if (radii.every(value => value === radii[0])) node.classes.push(`rounded-[${unit(radii[0])}]`)
      else node.classes.push(`rounded-tl-[${unit(radii[0])}]`, `rounded-tr-[${unit(radii[1])}]`, `rounded-br-[${unit(radii[2])}]`, `rounded-bl-[${unit(radii[3])}]`)
    }
    if (node.clip) node.classes.push('overflow-hidden')
    if (node.mask) mark(nodeId, 'mask', 'masking is not represented in the JSX approximation', node.maskType ?? true)
    if (node.booleanOperation) mark(nodeId, 'booleanOperation', 'boolean path operations are not represented in JSX', node.booleanOperation)
    if (!['frame', 'group', 'section', 'rectangle', 'ellipse', 'text'].includes(node.type)) mark(nodeId, 'type', 'vector/shape geometry is not reproduced by the JSX approximation', node.type)
    if (Object.keys(node.components).length) mark(nodeId, 'components', 'component/instance semantics and Code Connect are unavailable', node.components)
    const sizing = node.sizing
    if (['fill', 'hug', 'relative'].includes(sizing.width) || ['fill', 'hug', 'relative'].includes(sizing.height))
      mark(nodeId, 'sizing', 'responsive sizing is not inferred; the JSX uses the current computed bounds', { width: sizing.width, height: sizing.height })
    if (Object.keys(node.constraints).length) mark(nodeId, 'constraints', 'responsive constraints are not represented in the JSX approximation', node.constraints)

    const bindings = record(node.tokens.bindings)
    const styleRefs = record(node.tokens.styleRefs)
    for (const [field, variableId] of Object.entries(bindings)) {
      if (typeof variableId !== 'string') continue
      usedVariables.add(variableId)
      if (!variableById.has(variableId)) mark(nodeId, `tokens.bindings.${field}`, 'variable binding has no definition in the local catalog', variableId)
    }
    for (const [field, styleId] of Object.entries(styleRefs)) {
      if (typeof styleId !== 'string') continue
      usedStyles.add(styleId)
      if (!styleById.has(styleId)) mark(nodeId, `tokens.styleRefs.${field}`, 'shared style reference has no definition in the local catalog', styleId)
    }
    return node
  }

  const tree = rootIds.map(id => build(id, { mode: 'none' }, 0)).filter(Boolean)
  const page = {
    id: typeof context.page?.id === 'string' ? context.page.id : undefined,
    name: typeof context.page?.name === 'string' ? context.page.name : '',
    background: hex(context.page?.background),
  }
  const classNames = [...new Set(tree.flatMap(collectClasses))]
  const code = renderJsx(page, tree)
  const pagination = isRecord(context.pagination) ? {
    offset: context.pagination.offset, returned: context.pagination.returned, total: context.pagination.total,
    limit: context.pagination.limit, nextCursor: context.pagination.nextCursor ?? null,
  } : null
  const warnings = [
    { code: 'LOCAL_REACT_TAILWIND_APPROXIMATION', message: 'React JSX and Tailwind classes are derived from this local document context. They are not Figma React/Tailwind output and make no pixel or component parity claim.' },
    ...(options.excludeScreenshot === true ? [] : [{ code: 'SCREENSHOT_OMITTED', message: 'get_design_context does not embed a screenshot; call get_screenshot for local CPU pixels.' }]),
    ...(options.disableCodeConnect === true ? [] : [{ code: 'CODE_CONNECT_UNAVAILABLE', message: 'No Code Connect registry is configured; component mappings are not available.' }]),
  ]
  if (list(context.warnings).length) warnings.push(...context.warnings)
  if (unmappedCount > unmapped.length) warnings.push({ code: 'UNMAPPED_TRUNCATED', message: `unmapped lists the first ${unmapped.length} of ${unmappedCount} unmapped fields.` })
  const frameworks = list(options.clientFrameworks).filter(value => typeof value === 'string')
  if (frameworks.length && !frameworks.some(value => /react|javascript|typescript/i.test(value)))
    warnings.push({ code: 'FRAMEWORK_NOT_MATCHED', message: `Requested clientFrameworks (${frameworks.join(', ')}) do not match the local React JSX output.` })
  const result = {
    format: DESIGN_CONTEXT_FORMAT,
    language: 'jsx',
    fidelity: 'local-react-tailwind-approximation',
    notFigmaOutput: true,
    note: 'Structured local React/Tailwind approximation from context.get. Unmapped fields are listed explicitly; no Figma cloud, Code Connect, or pixel parity is claimed.',
    page,
    nodeId: options.nodeId ?? null,
    fileKeyIgnored: options.fileKey !== undefined,
    clientFrameworks: frameworks.length ? frameworks : undefined,
    clientLanguages: list(options.clientLanguages).filter(value => typeof value === 'string'),
    forceCode: options.forceCode === true,
    tree: { page, roots: tree },
    variables: variablesList.slice(0, 256),
    styles: stylesList.slice(0, 256),
    usedVariables: [...usedVariables].slice(0, 256),
    usedStyles: [...usedStyles].slice(0, 256),
    code,
    tailwind: { version: 3, classes: classNames.slice(0, 512), arbitraryValues: true },
    unmapped,
    warnings: warnings.slice(0, 64),
    nodeCount: entries.size,
    pagination,
    nextCursor: pagination?.nextCursor ?? null,
    truncated: Boolean(pagination?.nextCursor),
    modelText: Buffer.byteLength(code) <= MAX_CODE_BYTES ? code : `Local design context with ${entries.size} nodes. The generated JSX exceeds the model-text budget; read result.code or page with cursor.`,
  }
  return result
}

function catalog(value, field) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.[field]) ? value[field] : Array.isArray(value?.items) ? value.items : []
  return entries.filter(isRecord).map(entry => ({ ...entry })).slice(0, 256)
}

function collectClasses(node) {
  return [...node.classes, ...node.children.flatMap(collectClasses)]
}

function renderJsx(page, roots) {
  if (!roots.length) return 'export default function Design() {\n  return null\n}\n'
  const pageClasses = ['relative', ...(page.background ? [`bg-[${page.background}]`] : [])]
  const body = roots.map(node => renderNode(node, 4)).join('\n')
  return `export default function Design() {\n  return (\n    <div data-node-id=${JSON.stringify(page.id ?? 'page')} className="${pageClasses.join(' ')}">\n${body}\n    </div>\n  )\n}\n`
}

function renderNode(node, depth) {
  const indent = ' '.repeat(depth)
  const element = node.type === 'text' ? 'p' : 'div'
  const attributes = [`data-node-id=${JSON.stringify(node.id)}`]
  if (node.classes.length) attributes.push(`className="${node.classes.join(' ')}"`)
  const text = node.text && node.text.content ? `{${JSON.stringify(node.text.content)}}` : ''
  const children = node.children.map(child => renderNode(child, depth + 2))
  if (!text && !children.length) return `${indent}<${element} ${attributes.join(' ')} />`
  const inner = [text, ...children].filter(Boolean).join('\n')
  return `${indent}<${element} ${attributes.join(' ')}>\n${inner}\n${indent}</${element}>`
}