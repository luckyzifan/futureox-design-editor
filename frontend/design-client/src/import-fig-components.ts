import type { ComponentProperty, DesignDocument, Effect, Paint, Stroke } from './model'
import { defaultLayout, defaultSizing, defaultTextStyle } from './model'
import type { FigReceipts } from './import-fig-nodes'
const guid = (g: any): string => typeof g === 'string' ? g : g ? `${g.sessionID}:${g.localID}` : ''
function literal(kind: ComponentProperty['kind'], value: any, ids: Map<string,string>): string | boolean {
  if (kind === 'boolean' && typeof value?.boolValue === 'boolean') return value.boolValue
  if (kind === 'text' && typeof value?.textValue?.characters === 'string') return value.textValue.characters
  if (kind === 'instance-swap' && ids.has(guid(value?.guidValue))) return ids.get(guid(value.guidValue))!
  throw new Error('FIG 组件属性缺少可执行的常量值；原文件未修改')
}
/** `value` is the authored literal. `varValue.value` is that literal after
 * Figma resolved it. An alias is still a variable, not a value to run. */
function assignmentLiteral(kind: ComponentProperty['kind'], assignment: any, ids: Map<string, string>): string | boolean | undefined {
  for (const value of [assignment?.value, assignment?.varValue?.value]) {
    if (!value || typeof value !== 'object') continue
    try { return literal(kind, value, ids) } catch { /* the other carrier may hold the literal */ }
    if (kind === 'instance-swap') {
      const swapped = ids.get(guid(value.symbolIdValue?.guid))
      if (swapped) return swapped
    }
  }
}
function overridePropertyValues(doc: DesignDocument, properties: Record<string, ComponentProperty>, assignments: any, ids: Map<string, string>, warnings?: { add(message: string): unknown }) {
  const values: Record<string, string | boolean> = {}
  if (!Array.isArray(assignments)) {
    warnings?.add('FIG 实例覆盖 componentPropAssignments 暂不能执行，其余覆盖已保留')
    return values
  }
  for (const assignment of assignments) {
    const key = guid(assignment?.defID)
    const property = properties[key]
    if (!property) { warnings?.add(`FIG 组件属性赋值 ${key} 缺少定义，已跳过`); continue }
    const value = assignmentLiteral(property.kind, assignment, ids)
    if (value === undefined || (property.kind === 'instance-swap' && !doc.nodes[String(value)]?.component)) {
      warnings?.add(`FIG 组件属性赋值 ${key} 暂不能执行，其余覆盖已保留`)
      continue
    }
    values[key] = value
  }
  return values
}
function overrideProperties(doc: DesignDocument, records: Map<string, any>, ids: Map<string, string>, reverse: Map<string, string>, component: { properties: Record<string, ComponentProperty> }, path: string, resolved: string[]) {
  if (path === '$root') return component.properties
  const targetId = resolved.at(-1)
  const record = targetId ? records.get(reverse.get(targetId) || '') : undefined
  if (record?.type !== 'INSTANCE') return
  const symbolId = ids.get(guid(record.symbolData?.symbolID))
  return symbolId ? doc.nodes[symbolId]?.component?.properties : undefined
}
/** Resolve after assembly so property references name actual template layers. */
const NULL_STYLE = new Set(['4294967295:4294967295', '0:0'])
const STROKE_INPUTS = ['strokeWeight','strokeAlign','strokeCap','strokeJoin','dashPattern','borderStrokeWeightsIndependent','borderTopWeight','borderRightWeight','borderBottomWeight','borderLeftWeight']
const LAYOUT_KEYS = ['stackMode','stackSpacing','stackCounterSpacing','stackHorizontalPadding','stackVerticalPadding','stackPaddingRight','stackPaddingBottom','stackPadding','stackWrap','stackPrimaryAlignItems','stackCounterAlignItems','stackPrimarySizing','stackCounterSizing','stackPositioning','stackChildPrimaryGrow','stackChildAlignSelf','minSize','maxSize','horizontalConstraint','verticalConstraint']
const FONT_KEYS = ['fontVariantCommonLigatures','fontVariantContextualLigatures','fontVariantDiscretionaryLigatures','fontVariantHistoricalLigatures','fontVariantOrdinal','fontVariantSlashedZero','fontVariantNumericFigure','fontVariantNumericSpacing','fontVariantNumericFraction','fontVariantCaps','fontVariantPosition','toggledOnOTFeatures','toggledOffOTFeatures','fontVariations']
const BINDING_FIELDS: Record<string, string> = {
  WIDTH: 'width', HEIGHT: 'height', OPACITY: 'opacity', VISIBLE: 'visible', TEXT_DATA: 'text', CHARACTERS: 'text',
  FONT_SIZE: 'fontSize', FONT_WEIGHT: 'textStyle.weight', STACK_SPACING: 'layout.gap', ITEM_SPACING: 'layout.gap',
  STACK_COUNTER_SPACING: 'layout.lineGap', LETTER_SPACING: 'textStyle.letterSpacing', LINE_HEIGHT: 'textStyle.lineHeight',
}
const STYLE_FIELDS: Record<string, { field: string; type: string }> = {
  styleIdForFill: { field: 'fills', type: 'FILL' },
  styleIdForStrokeFill: { field: 'strokes', type: 'STROKE' },
  styleIdForEffect: { field: 'effects', type: 'EFFECT' },
  styleIdForText: { field: 'textStyle', type: 'TEXT' },
}

function claimAddress(addresses: Map<string, string>, blocked: Set<string>, key: string, id: string) {
  if (!key || key === '0:0' || blocked.has(key)) return
  const existing = addresses.get(key)
  if (existing && existing !== id) {
    addresses.delete(key)
    blocked.add(key)
    return
  }
  if (!existing) addresses.set(key, id)
}

function symbolAddresses(records: Map<string, any>, reverse: Map<string, string>, descendants: Set<string>) {
  const addresses = new Map<string, string>()
  const blocked = new Set<string>()
  for (const nodeId of descendants) {
    claimAddress(addresses, blocked, nodeId, nodeId)
    const source = reverse.get(nodeId)
    if (!source) continue
    claimAddress(addresses, blocked, source, nodeId)
    const record = records.get(source)
    const overrideKey = guid(record?.overrideKey)
    if (overrideKey) claimAddress(addresses, blocked, overrideKey, nodeId)
    const own = guid(record?.guid)
    if (own) claimAddress(addresses, blocked, own, nodeId)
  }
  return addresses
}

function resolveOverridePath(addressesByComponent: Map<string, Map<string, string>>, records: Map<string, any>, ids: Map<string, string>, reverse: Map<string, string>, componentId: string, parts: string[]) {
  let component = componentId
  const resolved: string[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    const source = reverse.get(component)
    const own = guid(records.get(source || '')?.overrideKey)
    if (part === component || part === source || (own && part === own)) {
      if (index + 1 === parts.length) return resolved.length ? resolved : ['$root']
      continue
    }
    const id = addressesByComponent.get(component)?.get(part) || addressesByComponent.get(component)?.get(ids.get(part) || '')
    if (!id) return
    resolved.push(id)
    if (index + 1 === parts.length) break
    const nested = reverse.get(id)
    const next = ids.get(guid(records.get(nested || '')?.symbolData?.symbolID))
    if (!next) return
    component = next
  }
  return resolved
}

export function importFigComponents(doc: DesignDocument, records: Map<string,any>, ids: Map<string,string>, toPaint: (p:any)=>Paint, strokesOf: (record:any)=>Stroke[], warnings?: { add(message: string): unknown }, receipts?: FigReceipts, effectsOf?: (record: any) => Effect[]) {
  for (const [sourceId, r] of records) {
    const n=doc.nodes[ids.get(sourceId)!]
    if (!n || r.type!=='SYMBOL') continue
    const pending=[...n.children],descendants=new Set<string>()
    while(pending.length) {
      const id=pending.pop()!
      if(descendants.has(id))throw new Error('FIG 组件模板存在循环引用')
      descendants.add(id)
      if(!doc.nodes[id]?.instance)pending.push(...(doc.nodes[id]?.children||[]))
    }
    n.component={variants:{},properties:{}}
    for(const def of r.componentPropDefs||[]) {
      if(def.isDeleted)continue
      if(def.type==='VARIANT')continue
      const kinds={BOOL:'boolean',TEXT:'text',INSTANCE_SWAP:'instance-swap'} as const
      const kind=kinds[def.type as keyof typeof kinds]
      if(!kind){warnings?.add(`FIG 组件属性 ${def.type} 暂不能执行，组件已保留`);continue}
      const field={boolean:'VISIBLE',text:'TEXT_DATA','instance-swap':'OVERRIDDEN_SYMBOL_ID'}[kind],key=guid(def.id)
      const targets=[...records].filter(([source,record])=>descendants.has(ids.get(source)!) &&
        record.componentPropRefs?.some((ref:any)=>!ref.isDeleted && guid(ref.defID)===key && ref.componentPropNodeField===field))
      let defaultValue: string | boolean
      try { defaultValue = literal(kind, def.initialValue, ids) }
      catch (error) { warnings?.add(error instanceof Error ? error.message : String(error)); continue }
      if (!targets.length) {
        n.component.properties[key] = { name: def.name || key, kind, targetKey: '', unbound: true, defaultValue }
        continue
      }
      const depth = new Map<string, number>()
      const walk = (id: string, level: number) => {
        if (depth.has(id) || level > 64) return
        depth.set(id, level)
        for (const child of doc.nodes[id]?.children || []) walk(child, level + 1)
      }
      walk(n.id, 0)
      const ordered = targets.map(([source]) => doc.nodes[ids.get(source)!]).filter(Boolean)
        .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))
      const keyOf = (target: { componentKey?: string; id: string }) => target.componentKey || target.id
      const [primary, ...rest] = ordered
      const property: ComponentProperty = { name: def.name || key, kind, targetKey: keyOf(primary), defaultValue }
      if (rest.length) property.alsoTargets = [...new Set(rest.map(keyOf))].filter(item => item !== property.targetKey)
      n.component.properties[key] = property
    }
  }
  const variables = variableCatalog(records)
  const reverse = new Map([...ids].map(([source, id]) => [id, source]))
  const addressesByComponent = new Map<string, Map<string, string>>()
  for (const [sourceId, record] of records) {
    if (record.type !== 'SYMBOL') continue
    const rootId = ids.get(sourceId)
    const root = rootId && doc.nodes[rootId]
    if (!root) continue
    const pending = [...root.children]
    const descendants = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (descendants.has(id)) break
      descendants.add(id)
      if (!doc.nodes[id]?.instance) pending.push(...(doc.nodes[id]?.children || []))
    }
    addressesByComponent.set(root.id, symbolAddresses(records, reverse, descendants))
  }
  for(const [sourceId,r] of records) {
    const n=doc.nodes[ids.get(sourceId)!]
    if(!n || r.type!=='INSTANCE')continue
    const componentId=ids.get(guid(r.symbolData?.symbolID)),component=componentId && doc.nodes[componentId]?.component
    if(!componentId || !component){
      warnings?.add('FIG 实例缺少嵌入的主组件，已按普通画板保留')
      n.instance={componentId:componentId||'',overrides:{},propertyValues:{}}
      continue
    }
    n.instance={componentId,overrides:{},propertyValues:{}}
    for(const assignment of r.componentPropAssignments||r.symbolData?.componentPropAssignments||[]) {
      const key=guid(assignment.defID),property=component.properties[key]
      if(!property){warnings?.add(`FIG 组件属性赋值 ${key} 缺少定义，已跳过`);continue}
      const value = assignmentLiteral(property.kind, assignment, ids)
      if (value === undefined || (property.kind === 'instance-swap' && !doc.nodes[String(value)]?.component)) {
        warnings?.add('FIG 组件属性缺少可执行的常量值；原文件未修改')
        continue
      }
      n.instance.propertyValues[key] = value
    }
    const retained: unknown[] = []
    for(const override of r.symbolData?.symbolOverrides||[]) {
      const sourcePath=override.guidPath?.guids || (override.overrideKey?[override.overrideKey]:[])
      const parts=sourcePath.map((g:any)=>guid(g)).filter(Boolean)
      const resolved: string[] | undefined = parts.length ? resolveOverridePath(addressesByComponent, records, ids, reverse, componentId, parts) : undefined
      const path = resolved?.join('/') || parts.map((part: string) => ids.get(part) || part).join('/') || '$root'
      const targetId = path === '$root' ? componentId : resolved ? resolved.at(-1)! : ''
      const target = doc.nodes[targetId]
      const sourceKey = [...ids].find(([, id]) => id === targetId)?.[0]
      const source = sourceKey ? records.get(sourceKey) : undefined
      const fields:Record<string,unknown>={}
      const skip = new Set(['guidPath','overrideKey','styleID','guid','phase','parentIndex','type','cornerRadius','cornerSmoothing','size','textData','effects','textTracking','exportSettings','pluginData','derivedTextData','variableConsumptionMap','parameterConsumptionMap','variableModeBySetMap','stackReverseZIndex','styleIdForGrid','componentPropAssignments',...STROKE_INPUTS,...LAYOUT_KEYS,...Object.keys(STYLE_FIELDS),...FONT_KEYS,'textAlignHorizontal','textAlignVertical','textAutoResize','lineHeight','letterSpacing','paragraphSpacing','paragraphIndent','textCase','fontName','textDecoration','rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomRightCornerRadius','rectangleBottomLeftCornerRadius'])
      for(const [key,value] of Object.entries(override)) {
        if(Array.isArray(override.strokePaints) && STROKE_INPUTS.includes(key)) continue
        if(skip.has(key)) continue
        if(['name','visible','opacity','fontSize'].includes(key)) fields[key]=value
        else if(key==='proportionsConstrained' && typeof value==='boolean') fields.constrainProportions=value
        else if(key==='proportionsConstrained') warnings?.add('FIG 实例覆盖 proportionsConstrained 暂不能执行，其余覆盖已保留')
        else if(key==='textData') fields.text=(value as any)?.characters??''
        else if(key==='fillPaints') fields.fills=(value as any[]).map(toPaint)
        else if(key==='strokePaints') fields.strokes=strokesOf(override)
        else if(key==='symbolID' || key==='overriddenSymbolID') {
          const swapped = ids.get(guid(value))
          if(swapped && doc.nodes[swapped]?.component) fields.swapComponent = swapped
          else warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
        }
        else warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
      }
      if(override.pluginData !== undefined) warnings?.add('FIG 实例覆盖 pluginData 暂不能执行，其余覆盖已保留')
      if(override.componentPropAssignments !== undefined) {
        const props = resolved ? overrideProperties(doc, records, ids, reverse, component, path, resolved) : undefined
        if(!props) warnings?.add('FIG 实例覆盖 componentPropAssignments 暂不能执行，其余覆盖已保留')
        else {
          const values = overridePropertyValues(doc, props, override.componentPropAssignments, ids, warnings)
          if(Object.keys(values).length) fields.propertyValues = { ...(fields.propertyValues as Record<string, string | boolean> | undefined), ...values }
        }
      }
      if(override.derivedTextData !== undefined) warnings?.add('FIG 实例覆盖 derivedTextData 暂不能执行，其余覆盖已保留')
      if(override.styleIdForGrid !== undefined) warnings?.add('FIG 实例覆盖 styleIdForGrid 暂不能执行，其余覆盖已保留')
      applySize(fields, override, warnings)
      applyCorners(fields, override, target, warnings)
      applyExport(fields, override, warnings)
      applyText(fields, override, target, warnings)
      applyEffects(fields, override, effectsOf, warnings)
      applyLayout(fields, override, target, source, records, warnings)
      applyStyles(fields, override, target, source, records, ids, warnings)
      if(Array.isArray(override.strokePaints)) fields.strokes = strokesOf(override)
      else if(STROKE_INPUTS.some(key => override[key] !== undefined)) applyStrokeAttrs(fields, override, target, warnings)
      const kept = applyConsumption(fields, override, variables, warnings)
      if(override.exportSettings !== undefined) kept.exportSettings = override.exportSettings
      if(Object.keys(kept).length) retained.push({ path: parts.join('/') || path, ...kept })
      const previousValues = n.instance.overrides[path]?.propertyValues
      if(fields.propertyValues && previousValues && typeof previousValues === 'object') {
        fields.propertyValues = { ...(previousValues as Record<string, string | boolean>), ...(fields.propertyValues as Record<string, string | boolean>) }
      }
      n.instance.overrides[path] = { ...(n.instance.overrides[path] || {}), ...fields }
    }
    if(retained.length && receipts && ids.get(sourceId)) {
      const current = receipts.get(n.id) ?? {}
      current.figOverrideVariableConsumption = JSON.stringify(retained)
      receipts.set(n.id, current)
    }
  }
}

function finite(value: unknown, lo: number, hi: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi
}

function applySize(fields: Record<string, unknown>, override: any, warnings?: { add(message: string): unknown }) {
  if(!override.size) return
  if(override.size.x !== undefined) {
    if(finite(override.size.x, Number.MIN_VALUE, 1e7) && override.size.x > 0) fields.width = override.size.x
    else warnings?.add('FIG 实例覆盖 size.x 暂不能执行，其余覆盖已保留')
  }
  if(override.size.y !== undefined) {
    if(finite(override.size.y, Number.MIN_VALUE, 1e7) && override.size.y > 0) fields.height = override.size.y
    else warnings?.add('FIG 实例覆盖 size.y 暂不能执行，其余覆盖已保留')
  }
}

function applyCorners(fields: Record<string, unknown>, override: any, target: { kind?: string; radii?: number[] } | undefined, warnings?: { add(message: string): unknown }) {
  const polygon = target?.kind === 'polygon' || target?.kind === 'star'
  const radius = override.cornerRadius
  if(radius !== undefined && !finite(radius, 0, 1e7)) warnings?.add('FIG 实例覆盖 cornerRadius 暂不能执行，其余覆盖已保留')
  if(polygon && finite(radius, 0, 1e7)) fields.cornerRadius = radius
  if(polygon) return
  const radii = [...(target?.radii ?? [0, 0, 0, 0])]
  let touched = false
  if(finite(radius, 0, 1e7)) { radii.fill(radius); touched = true }
  const corners = ['rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomRightCornerRadius','rectangleBottomLeftCornerRadius']
  corners.forEach((key, index) => {
    if(override[key] === undefined) return
    if(finite(override[key], 0, 1e7)) { radii[index] = override[key]; touched = true }
    else warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
  })
  if(touched) fields.radii = radii
  if(override.cornerSmoothing !== undefined) {
    if(finite(override.cornerSmoothing, 0, 1)) fields.smoothing = override.cornerSmoothing
    else warnings?.add('FIG 实例覆盖 cornerSmoothing 暂不能执行，其余覆盖已保留')
  }
}

function applyStrokeAttrs(fields: Record<string, unknown>, override: any, target: { strokes?: Stroke[] } | undefined, warnings?: { add(message: string): unknown }) {
  const strokes = target?.strokes?.map(stroke => ({ ...stroke }))
  if(!strokes?.length) {
    warnings?.add('FIG 实例覆盖 strokeWeight 暂不能执行，其余覆盖已保留')
    return
  }
  const align = override.strokeAlign === 'INSIDE' ? 'inside' : override.strokeAlign === 'OUTSIDE' ? 'outside' : override.strokeAlign === undefined || override.strokeAlign === 'CENTER' ? 'center' : undefined
  if(override.strokeAlign !== undefined && !align) warnings?.add('FIG 实例覆盖 strokeAlign 暂不能执行，其余覆盖已保留')
  const weight = finite(override.strokeWeight, 0, 10000) ? override.strokeWeight : undefined
  if(override.strokeWeight !== undefined && weight === undefined) warnings?.add('FIG 实例覆盖 strokeWeight 暂不能执行，其余覆盖已保留')
  if(override.borderStrokeWeightsIndependent === true) {
    const borders = [override.borderTopWeight, override.borderRightWeight, override.borderBottomWeight, override.borderLeftWeight]
    if(!borders.every(value => value === borders[0])) warnings?.add('FIG 实例覆盖 borderStrokeWeightsIndependent 暂不能执行，其余覆盖已保留')
  }
  fields.strokes = strokes.map(stroke => ({
    ...stroke,
    ...(weight !== undefined ? { width: weight } : {}),
    ...(align ? { align } : {}),
  }))
}

function metricSize(fields: Record<string, unknown>, target: { fontSize?: number } | undefined) {
  const size = typeof fields.fontSize === 'number' ? fields.fontSize : target?.fontSize
  return typeof size === 'number' && size >= 1 ? size : 16
}

function lineHeightMultiplier(value: any, size: number) {
  if (!value || typeof value !== 'object' || typeof value.value !== 'number' || !Number.isFinite(value.value) || !(size >= 1)) return
  if (value.units === 'PIXELS') return value.value / size
  if (value.units === 'PERCENT') return value.value / 100
  if (value.units === 'RAW') return value.value
}

function letterSpacingPixels(value: any, size: number) {
  if (!value || typeof value !== 'object' || typeof value.value !== 'number' || !Number.isFinite(value.value)) return
  if (value.units === 'PIXELS') return value.value
  if (value.units === 'PERCENT' && size >= 1) return size * value.value / 100
}

function styleWeight(style: string) {
  const name = style.toLowerCase().replace(/[\s_-]/g, '').replace(/italic$/, '')
  const table: Record<string, number> = {
    thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
    medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, heavy: 800, black: 900,
  }
  return table[name]
}

function applyText(fields: Record<string, unknown>, override: any, target: { text?: string; textStyle?: ReturnType<typeof defaultTextStyle>; fontSize?: number } | undefined, warnings?: { add(message: string): unknown }) {
  if(override.textData) {
    if(typeof override.textData.characters === 'string') fields.text = override.textData.characters
    if(override.textData.layoutVersion !== undefined) warnings?.add('FIG 实例覆盖 textData.layoutVersion 暂不能执行，其余覆盖已保留')
  }
  const style = { ...(target?.textStyle ?? defaultTextStyle()) }
  let changed = false
  const size = metricSize(fields, target)
  if(override.lineHeight !== undefined) {
    const multiplier = lineHeightMultiplier(override.lineHeight, size)
    if(multiplier !== undefined && multiplier >= 0.1 && multiplier <= 10) { style.lineHeight = multiplier; changed = true }
    else warnings?.add('FIG 实例覆盖 lineHeight 暂不能执行，其余覆盖已保留')
  }
  if(override.letterSpacing !== undefined) {
    const pixels = letterSpacingPixels(override.letterSpacing, size)
    if(pixels !== undefined && Number.isFinite(pixels) && Math.abs(pixels) <= 1000) { style.letterSpacing = pixels; changed = true }
    else warnings?.add('FIG 实例覆盖 letterSpacing 暂不能执行，其余覆盖已保留')
  } else if(override.textTracking !== undefined) {
    if(typeof override.textTracking === 'number' && Number.isFinite(override.textTracking) && Math.abs(override.textTracking) <= 1000) {
      style.letterSpacing = override.textTracking
      changed = true
    } else warnings?.add('FIG 实例覆盖 textTracking 暂不能执行，其余覆盖已保留')
  }
  if(override.paragraphSpacing !== undefined) {
    if(typeof override.paragraphSpacing === 'number' && Number.isFinite(override.paragraphSpacing) && override.paragraphSpacing >= 0 && override.paragraphSpacing <= 10000) {
      style.paragraphSpacing = override.paragraphSpacing
      changed = true
    } else warnings?.add('FIG 实例覆盖 paragraphSpacing 暂不能执行，其余覆盖已保留')
  }
  if(override.paragraphIndent !== undefined) {
    if(typeof override.paragraphIndent === 'number' && Number.isFinite(override.paragraphIndent) && Math.abs(override.paragraphIndent) <= 10000) {
      style.paragraphIndent = override.paragraphIndent
      changed = true
    } else warnings?.add('FIG 实例覆盖 paragraphIndent 暂不能执行，其余覆盖已保留')
  }
  if(override.textCase !== undefined) {
    const mapped: Record<string, 'original' | 'upper' | 'lower'> = { ORIGINAL: 'original', UPPER: 'upper', LOWER: 'lower' }
    if(mapped[override.textCase]) { style.textCase = mapped[override.textCase]; changed = true }
    else warnings?.add(`FIG 实例覆盖 textCase=${override.textCase} 暂不能执行，其余覆盖已保留`)
  }
  if(override.fontName) {
    if(typeof override.fontName.style === 'string') {
      const weight = styleWeight(override.fontName.style)
      if(weight !== undefined) { style.weight = weight; changed = true }
      else warnings?.add('FIG 实例覆盖 fontName.style 暂不能执行，其余覆盖已保留')
    }
    if(typeof override.fontName.family === 'string' && override.fontName.family) {
      warnings?.add(`FIG 实例覆盖 fontName.family=${override.fontName.family} 暂不能执行，其余覆盖已保留`)
    }
  }
  if(override.textAlignHorizontal !== undefined) {
    const align = { LEFT: 'start', CENTER: 'center', RIGHT: 'end', JUSTIFIED: 'justify' } as Record<string, string>
    if(align[override.textAlignHorizontal]) { style.align = align[override.textAlignHorizontal] as typeof style.align; changed = true }
    else warnings?.add('FIG 实例覆盖 textAlignHorizontal 暂不能执行，其余覆盖已保留')
  }
  if(override.textAlignVertical !== undefined) {
    const align = { TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' } as Record<string, string>
    if(align[override.textAlignVertical]) { style.verticalAlign = align[override.textAlignVertical] as typeof style.verticalAlign; changed = true }
    else warnings?.add('FIG 实例覆盖 textAlignVertical 暂不能执行，其余覆盖已保留')
  }
  if(override.textAutoResize !== undefined) {
    if(override.textAutoResize === 'WIDTH_AND_HEIGHT') { style.wrap = false; changed = true }
    else if(override.textAutoResize === 'HEIGHT' || override.textAutoResize === 'NONE' || override.textAutoResize === 'TRUNCATE') { style.wrap = true; changed = true }
    else warnings?.add('FIG 实例覆盖 textAutoResize 暂不能执行，其余覆盖已保留')
  }
  if(applyOpenType(style, override, warnings)) changed = true
  if(changed) fields.textStyle = style
}

function applyEffects(fields: Record<string, unknown>, override: any, effectsOf: ((record: any) => Effect[]) | undefined, warnings?: { add(message: string): unknown }) {
  if(override.effects === undefined) return
  if(!Array.isArray(override.effects) || !effectsOf) {
    warnings?.add('FIG 实例覆盖 effects 暂不能执行，其余覆盖已保留')
    return
  }
  try {
    fields.effects = effectsOf({ effects: override.effects })
  } catch {
    warnings?.add('FIG 实例覆盖 effects 暂不能执行，其余覆盖已保留')
  }
}

function setFeature(features: string[], tag: string, enabled: boolean) {
  const disabled = `-${tag}`
  const next = features.filter(feature => feature !== tag && feature !== disabled)
  next.push(enabled ? tag : disabled)
  features.splice(0, features.length, ...next)
}

function clearFeatures(features: string[], tags: string[]) {
  const next = features.filter(feature => !tags.some(tag => feature === tag || feature === `-${tag}`))
  features.splice(0, features.length, ...next)
}

function chooseFeature(features: string[], tags: string[], selected?: string) {
  clearFeatures(features, tags)
  if(selected) setFeature(features, selected, true)
}

function applyOpenType(style: ReturnType<typeof defaultTextStyle>, override: any, warnings?: { add(message: string): unknown }) {
  const features = [...(style.features ?? [])]
  const variations = [...(style.variations ?? [])]
  let changed = false
  const flag = (key: string, tags: string[]) => {
    if(override[key] === undefined) return
    if(typeof override[key] !== 'boolean') { warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`); return }
    for(const tag of tags) setFeature(features, tag, override[key])
    changed = true
  }
  flag('fontVariantCommonLigatures', ['liga', 'clig'])
  flag('fontVariantContextualLigatures', ['calt'])
  flag('fontVariantDiscretionaryLigatures', ['dlig'])
  flag('fontVariantHistoricalLigatures', ['hlig'])
  flag('fontVariantOrdinal', ['ordn'])
  flag('fontVariantSlashedZero', ['zero'])
  const choice = (key: string, tags: string[], selected: Record<string, string | undefined>) => {
    if(override[key] === undefined) return
    if(!Object.hasOwn(selected, override[key])) { warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`); return }
    chooseFeature(features, tags, selected[override[key]])
    changed = true
  }
  choice('fontVariantNumericFigure', ['lnum', 'onum'], { NORMAL: undefined, LINING: 'lnum', OLDSTYLE: 'onum' })
  choice('fontVariantNumericSpacing', ['pnum', 'tnum'], { NORMAL: undefined, PROPORTIONAL: 'pnum', TABULAR: 'tnum' })
  choice('fontVariantNumericFraction', ['frac', 'afrc'], { NORMAL: undefined, DIAGONAL: 'frac', STACKED: 'afrc' })
  if(override.fontVariantCaps !== undefined) {
    const caps = ['smcp', 'c2sc', 'pcap', 'c2pc', 'unic', 'titl']
    const selected: Record<string, string[]> = {
      NORMAL: [], SMALL: ['smcp'], ALL_SMALL: ['smcp', 'c2sc'], PETITE: ['pcap'], ALL_PETITE: ['pcap', 'c2pc'], UNICASE: ['unic'], TITLING: ['titl'],
    }
    const tags = selected[override.fontVariantCaps]
    if(!tags) warnings?.add('FIG 实例覆盖 fontVariantCaps 暂不能执行，其余覆盖已保留')
    else { clearFeatures(features, caps); for(const tag of tags) setFeature(features, tag, true); changed = true }
  }
  choice('fontVariantPosition', ['subs', 'sups'], { NORMAL: undefined, SUB: 'subs', SUPER: 'sups' })
  for(const [key, enabled] of [['toggledOnOTFeatures', true], ['toggledOffOTFeatures', false]] as const) {
    if(override[key] === undefined) continue
    if(!Array.isArray(override[key])) { warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`); continue }
    for(const tag of override[key]) {
      const name = typeof tag === 'string' ? tag.toLowerCase() : ''
      if(name.length === 4 && /^[a-z0-9]+$/.test(name)) { setFeature(features, name, enabled); changed = true }
      else warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
    }
  }
  if(override.fontVariations !== undefined) {
    if(!Array.isArray(override.fontVariations)) warnings?.add('FIG 实例覆盖 fontVariations 暂不能执行，其余覆盖已保留')
    else for(const variation of override.fontVariations) {
      const value = variation?.value
      const tag = typeof variation?.axisTag === 'number'
        ? String.fromCharCode((variation.axisTag >>> 24) & 255, (variation.axisTag >>> 16) & 255, (variation.axisTag >>> 8) & 255, variation.axisTag & 255)
        : variation?.axisName
      if(typeof value !== 'number' || !Number.isFinite(value) || typeof tag !== 'string' || !/^[A-Za-z0-9]{4}$/.test(tag)) {
        warnings?.add('FIG 实例覆盖 fontVariations 暂不能执行，其余覆盖已保留')
        continue
      }
      if(tag.toLowerCase() === 'wght') {
        if(value >= 1 && value <= 1000) { style.weight = value; changed = true }
        else warnings?.add('FIG 实例覆盖 fontVariations 暂不能执行，其余覆盖已保留')
        continue
      }
      if(Math.abs(value) > 10000) { warnings?.add('FIG 实例覆盖 fontVariations 暂不能执行，其余覆盖已保留'); continue }
      const index = variations.findIndex(axis => axis.tag === tag)
      if(index >= 0) variations.splice(index, 1)
      variations.push({ tag, value })
      changed = true
    }
  }
  if(features.length > 16 || variations.length > 16) {
    for(const key of FONT_KEYS) if(override[key] !== undefined) warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
    return false
  }
  if(changed) {
    style.features = features
    style.variations = variations
  }
  return changed
}

function distance(record: any, field: string, fallback = 0) {
  const value = record[field] ?? fallback
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e5) return undefined
  return value
}

function applyExport(fields: Record<string, unknown>, override: any, warnings?: { add(message: string): unknown }) {
  if(override.exportSettings === undefined) return
  if(!Array.isArray(override.exportSettings)) {
    warnings?.add('FIG 实例覆盖 exportSettings 暂不能执行，其余覆盖已保留')
    return
  }
  const formats: Record<string, string> = { PNG: 'png', JPG: 'jpeg', JPEG: 'jpeg', SVG: 'svg', SVG_STRING: 'svg', PDF: 'pdf', WEBP: 'webp', TIFF: 'tiff' }
  const exported: { id: string; format: string; scale: number; suffix: string }[] = []
  let failed = false
  override.exportSettings.forEach((setting: any, index: number) => {
    const format = formats[setting?.imageType]
    const constraint = setting?.constraint
    const scale = constraint?.type === 'SCALE' || constraint?.type === 'CONTENT_SCALE' ? constraint.value : constraint ? undefined : 1
    const suffix = typeof setting?.suffix === 'string' ? setting.suffix : ''
    if(!format || typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0 || scale > 128 || suffix.length > 80) {
      failed = true
      return
    }
    exported.push({ id: `fig-export-${index}`, format, scale, suffix })
  })
  if(failed || (!exported.length && override.exportSettings.length)) warnings?.add('FIG 实例覆盖 exportSettings 暂不能执行，其余覆盖已保留')
  if(exported.length) fields.exportSettings = exported
}

function applyLayout(fields: Record<string, unknown>, override: any, target: any, source: any, records: Map<string, any>, warnings?: { add(message: string): unknown }) {
  if(override.stackReverseZIndex === true) warnings?.add('FIG 实例覆盖 stackReverseZIndex 暂不能执行，其余覆盖已保留')
  const present = LAYOUT_KEYS.filter(key => override[key] !== undefined)
  if(!present.length) return
  if(!target || !source) {
    for(const key of present) warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
    return
  }
  const record = { ...source, ...Object.fromEntries(present.map(key => [key, override[key]])) }
  const mode = record.stackMode === 'HORIZONTAL' ? 'horizontal' : record.stackMode === 'VERTICAL' ? 'vertical' : record.stackMode === 'NONE' || record.stackMode === undefined ? 'none' : undefined
  if(!mode) { for(const key of present) warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`); return }
  if(mode !== 'none') {
    if(!['frame','group','section'].includes(target.kind)) { for(const key of present) warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`); return }
    const horizontal = distance(record, 'stackHorizontalPadding')
    const vertical = distance(record, 'stackVerticalPadding')
    const gap = distance(record, 'stackSpacing')
    const right = distance(record, 'stackPaddingRight', horizontal)
    const bottom = distance(record, 'stackPaddingBottom', vertical)
    if([horizontal, vertical, gap, right, bottom].some(value => value === undefined)) {
      for(const key of present) warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
      return
    }
    const justify = { MIN: 'start', CENTER: 'unsafe-center', MAX: 'unsafe-end', SPACE_BETWEEN: 'space-between', SPACE_EVENLY: 'space-evenly', SPACE_AROUND: 'space-around' } as Record<string, string>
    const counterAlign = { MIN: 'start', CENTER: 'unsafe-center', MAX: 'unsafe-end' } as Record<string, string>
    const layout = {
      ...defaultLayout(),
      ...(target.layout ?? {}),
      mode,
      gap,
      lineGap: distance(record, 'stackCounterSpacing', gap ?? 0) ?? gap,
      padding: [vertical, right, bottom, horizontal],
      wrap: record.stackWrap === 'WRAP',
      justify: justify[record.stackPrimaryAlignItems] ?? 'start',
      align: counterAlign[record.stackCounterAlignItems] ?? 'start',
    }
    if(record.stackPrimaryAlignItems !== undefined && !justify[record.stackPrimaryAlignItems]) warnings?.add('FIG 实例覆盖 stackPrimaryAlignItems 暂不能执行，其余覆盖已保留')
    if(record.stackCounterAlignItems !== undefined && !counterAlign[record.stackCounterAlignItems]) warnings?.add('FIG 实例覆盖 stackCounterAlignItems 暂不能执行，其余覆盖已保留')
    if(record.stackWrap !== undefined && record.stackWrap !== 'WRAP' && record.stackWrap !== 'NO_WRAP') warnings?.add('FIG 实例覆盖 stackWrap 暂不能执行，其余覆盖已保留')
    fields.layout = layout
    const sizing = { ...(target.sizing ?? defaultSizing()) }
    const primary = record.stackPrimarySizing === 'FIXED' ? 'fixed' : record.stackPrimarySizing === 'RESIZE_TO_FIT' || record.stackPrimarySizing === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' || record.stackPrimarySizing === undefined ? 'hug' : undefined
    const counter = record.stackCounterSizing === 'RESIZE_TO_FIT' || record.stackCounterSizing === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' ? 'hug' : record.stackCounterSizing === 'FIXED' || record.stackCounterSizing === undefined ? 'fixed' : undefined
    if(!primary || !counter) { warnings?.add('FIG 实例覆盖自动布局尺寸暂不能执行，其余覆盖已保留'); return }
    sizing.width = mode === 'horizontal' ? primary : counter
    sizing.height = mode === 'horizontal' ? counter : primary
    fields.sizing = sizing
  }
  const parent = records.get(guid(source.parentIndex?.guid))
  const parentMode = parent?.stackMode
  const parentLayout = parentMode === 'HORIZONTAL' || parentMode === 'VERTICAL'
  const sizing = { ...((fields.sizing as object | undefined) ?? target.sizing ?? defaultSizing()) } as Record<string, unknown>
  let sized = fields.sizing !== undefined
  if(parentLayout && record.stackPositioning !== undefined) {
    if(record.stackPositioning === 'AUTO' || record.stackPositioning === 'ABSOLUTE') {
      sizing.absolute = record.stackPositioning === 'ABSOLUTE'
      sized = true
    } else warnings?.add('FIG 实例覆盖 stackPositioning 暂不能执行，其余覆盖已保留')
  }
  if(parentLayout && sizing.absolute !== true) {
    const grow = record.stackChildPrimaryGrow
    const selfAlign = { MIN: 'start', CENTER: 'center', MAX: 'end', STRETCH: 'stretch' } as Record<string, string>
    if(record.stackChildAlignSelf !== undefined && record.stackChildAlignSelf !== 'AUTO' && !selfAlign[record.stackChildAlignSelf]) {
      warnings?.add('FIG 实例覆盖 stackChildAlignSelf 暂不能执行，其余覆盖已保留')
    }
    if(typeof grow === 'number' && grow !== 0 && grow !== 1) warnings?.add('FIG 实例覆盖 stackChildPrimaryGrow 暂不能执行，其余覆盖已保留')
    else if(grow === 1 || selfAlign[record.stackChildAlignSelf]) {
      if(grow === 1) sizing[parentMode === 'HORIZONTAL' ? 'width' : 'height'] = 'fill'
      if(selfAlign[record.stackChildAlignSelf] === 'stretch') sizing[parentMode === 'HORIZONTAL' ? 'height' : 'width'] = 'fill'
      if(selfAlign[record.stackChildAlignSelf]) sizing.alignSelf = selfAlign[record.stackChildAlignSelf]
      sized = true
    }
  }
  for(const [field, prefix] of [['minSize', 'min'], ['maxSize', 'max']] as const) {
    const value = record[field]?.value
    if(!value) continue
    if(![value.x, value.y].every((item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0.01 && item <= 1e7)) {
      warnings?.add(`FIG 实例覆盖 ${field} 暂不能执行，其余覆盖已保留`)
      continue
    }
    sizing[`${prefix}Width`] = value.x
    sizing[`${prefix}Height`] = value.y
    sized = true
  }
  if(sized) fields.sizing = sizing
  if(override.horizontalConstraint !== undefined || override.verticalConstraint !== undefined) {
    const anchors: Record<string, string> = { MIN: 'start', CENTER: 'center', MAX: 'end', STRETCH: 'stretch', SCALE: 'scale' }
    const horizontal = anchors[record.horizontalConstraint] ?? (record.horizontalConstraint === undefined ? 'start' : undefined)
    const vertical = anchors[record.verticalConstraint] ?? (record.verticalConstraint === undefined ? 'start' : undefined)
    if(!horizontal || !vertical) warnings?.add('FIG 实例覆盖约束字段暂不能执行，其余覆盖已保留')
    else fields.constraints = { horizontal, vertical }
  }
}

function applyStyles(fields: Record<string, unknown>, override: any, target: { styleRefs?: Record<string, string> } | undefined, source: any, records: Map<string, any>, ids: Map<string, string>, warnings?: { add(message: string): unknown }) {
  const refs = { ...(target?.styleRefs ?? {}) }
  let touched = false
  for(const [key, spec] of Object.entries(STYLE_FIELDS)) {
    if(override[key] === undefined) continue
    const id = guid(override[key]?.guid ?? override[key])
    if(NULL_STYLE.has(id)) { delete refs[spec.field]; touched = true; continue }
    const resolved = ids.get(id)
    if(resolved && records.get(id)?.styleType === spec.type) { refs[spec.field] = resolved; touched = true }
    else warnings?.add(`FIG 实例覆盖 ${key} 未能对应到已导入样式`)
  }
  if(touched) fields.styleRefs = refs
  void source
}

function variableCatalog(records: Map<string, any>) {
  const idByKey = new Map<string, string>()
  const kindById = new Map<string, string>()
  for(const [id, record] of records) {
    if(record.type !== 'VARIABLE') continue
    const resolved = String(record.variableResolvedType || '')
    kindById.set(id, resolved === 'COLOR' ? 'color' : resolved === 'BOOLEAN' ? 'boolean' : resolved === 'STRING' ? 'string' : 'number')
    idByKey.set(id, id)
    if(typeof record.key === 'string' && record.key) idByKey.set(record.key, id)
  }
  return { idByKey, kindById }
}

function bindingKind(path: string) {
  if(path === 'text') return 'string'
  if(path === 'visible') return 'boolean'
  return 'number'
}

function aliasId(value: any, variables: ReturnType<typeof variableCatalog>) {
  const alias = value?.alias ?? value?.variableAlias
  const key = alias?.assetRef?.key
  if(typeof key === 'string' && variables.idByKey.has(key)) return variables.idByKey.get(key)
  const id = guid(alias?.guid ?? alias)
  return id && id !== '0:0' && variables.kindById.has(id) ? id : undefined
}

function applyConsumption(fields: Record<string, unknown>, override: any, variables: ReturnType<typeof variableCatalog>, warnings?: { add(message: string): unknown }) {
  const kept: Record<string, unknown> = {}
  const map = override.variableConsumptionMap
  if(Array.isArray(map?.entries) && map.entries.length) {
    kept.variableConsumptionMap = map
    const bindings: Record<string, string> = {}
    for(const entry of map.entries) {
      const field = String(entry?.variableField || '')
      const path = BINDING_FIELDS[field]
      if(!path) { if(field && field !== 'MISSING') warnings?.add(`FIG 实例覆盖 variableConsumptionMap.${field} 暂不能执行，消费表已保留`); continue }
      const target = aliasId(entry?.variableData?.value, variables)
      if(!target || variables.kindById.get(target) !== bindingKind(path) || bindings[path]) {
        warnings?.add(`FIG 实例覆盖 variableConsumptionMap.${field} 暂不能执行，消费表已保留`)
        continue
      }
      bindings[path] = target
    }
    if(Object.keys(bindings).length) fields.bindings = bindings
  }
  if(Array.isArray(override.parameterConsumptionMap?.entries) && override.parameterConsumptionMap.entries.length) {
    kept.parameterConsumptionMap = override.parameterConsumptionMap
    warnings?.add('FIG 实例覆盖 parameterConsumptionMap 暂不能执行，消费表已保留')
  }
  return kept
}
