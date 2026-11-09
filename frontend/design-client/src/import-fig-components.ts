import type { ComponentProperty, DesignDocument, Paint, Stroke } from './model'
import { defaultLayout, defaultSizing, defaultTextStyle } from './model'
import type { FigReceipts } from './import-fig-nodes'
const guid = (g: any): string => typeof g === 'string' ? g : g ? `${g.sessionID}:${g.localID}` : ''
function literal(kind: ComponentProperty['kind'], value: any, ids: Map<string,string>): string | boolean {
  if (kind === 'boolean' && typeof value?.boolValue === 'boolean') return value.boolValue
  if (kind === 'text' && typeof value?.textValue?.characters === 'string') return value.textValue.characters
  if (kind === 'instance-swap' && ids.has(guid(value?.guidValue))) return ids.get(guid(value.guidValue))!
  throw new Error('FIG 组件属性缺少可执行的常量值；原文件未修改')
}
/** Resolve after assembly so property references name actual template layers. */
const NULL_STYLE = new Set(['4294967295:4294967295', '0:0'])
const STROKE_INPUTS = ['strokeWeight','strokeAlign','strokeCap','strokeJoin','dashPattern','borderStrokeWeightsIndependent','borderTopWeight','borderRightWeight','borderBottomWeight','borderLeftWeight']
const LAYOUT_KEYS = ['stackMode','stackSpacing','stackCounterSpacing','stackHorizontalPadding','stackVerticalPadding','stackPaddingRight','stackPaddingBottom','stackPadding','stackWrap','stackPrimaryAlignItems','stackCounterAlignItems','stackPrimarySizing','stackCounterSizing','stackPositioning','stackChildPrimaryGrow','stackChildAlignSelf','minSize','maxSize','horizontalConstraint','verticalConstraint']
const BINDING_FIELDS: Record<string, string> = {
  WIDTH: 'width', HEIGHT: 'height', OPACITY: 'opacity', VISIBLE: 'visible', TEXT_DATA: 'text',
  FONT_SIZE: 'fontSize', STACK_SPACING: 'layout.gap', STACK_COUNTER_SPACING: 'layout.lineGap',
  LETTER_SPACING: 'textStyle.letterSpacing', LINE_HEIGHT: 'textStyle.lineHeight',
}
const STYLE_FIELDS: Record<string, { field: string; type: string }> = {
  styleIdForFill: { field: 'fills', type: 'FILL' },
  styleIdForStrokeFill: { field: 'strokes', type: 'STROKE' },
  styleIdForEffect: { field: 'effects', type: 'EFFECT' },
  styleIdForText: { field: 'textStyle', type: 'TEXT' },
}

export function importFigComponents(doc: DesignDocument, records: Map<string,any>, ids: Map<string,string>, toPaint: (p:any)=>Paint, strokesOf: (record:any)=>Stroke[], warnings?: { add(message: string): unknown }, receipts?: FigReceipts) {
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
      try{n.instance.propertyValues[key]=literal(property.kind,assignment.value,ids)}
      catch(error){warnings?.add(error instanceof Error?error.message:String(error))}
    }
    const retained: unknown[] = []
    for(const override of r.symbolData?.symbolOverrides||[]) {
      const sourcePath=override.guidPath?.guids || (override.overrideKey?[override.overrideKey]:[])
      const path=sourcePath.map((g:any)=>ids.get(guid(g))||guid(g)).join('/')||'$root'
      const targetId = path === '$root' ? componentId : path.split('/').at(-1)!
      const target = doc.nodes[targetId]
      const sourceKey = [...ids].find(([, id]) => id === targetId)?.[0]
      const source = sourceKey ? records.get(sourceKey) : undefined
      const fields:Record<string,unknown>={}
      const skip = new Set(['guidPath','overrideKey','styleID','guid','phase','parentIndex','type','cornerRadius','cornerSmoothing','size','textData','effects','pluginData','derivedTextData','variableConsumptionMap','parameterConsumptionMap','variableModeBySetMap','stackReverseZIndex','styleIdForGrid',...STROKE_INPUTS,...LAYOUT_KEYS,...Object.keys(STYLE_FIELDS),'textAlignHorizontal','textAlignVertical','textAutoResize','lineHeight','letterSpacing','paragraphSpacing','paragraphIndent','textCase','fontName','textDecoration','rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomRightCornerRadius','rectangleBottomLeftCornerRadius'])
      for(const [key,value] of Object.entries(override)) {
        if(Array.isArray(override.strokePaints) && STROKE_INPUTS.includes(key)) continue
        if(skip.has(key)) continue
        if(['name','visible','opacity','fontSize'].includes(key)) fields[key]=value
        else if(key==='textData') fields.text=(value as any)?.characters??''
        else if(key==='fillPaints') fields.fills=(value as any[]).map(toPaint)
        else if(key==='strokePaints') fields.strokes=strokesOf(override)
        else if(key==='symbolID') fields.swapComponent=ids.get(guid(value))
        else warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
      }
      if(override.pluginData !== undefined) warnings?.add('FIG 实例覆盖 pluginData 暂不能执行，其余覆盖已保留')
      if(override.derivedTextData !== undefined) warnings?.add('FIG 实例覆盖 derivedTextData 暂不能执行，其余覆盖已保留')
      if(override.styleIdForGrid !== undefined) warnings?.add('FIG 实例覆盖 styleIdForGrid 暂不能执行，其余覆盖已保留')
      applySize(fields, override, warnings)
      applyCorners(fields, override, target, warnings)
      applyText(fields, override, target, warnings)
      applyLayout(fields, override, target, source, records, warnings)
      applyStyles(fields, override, target, source, records, ids, warnings)
      if(Array.isArray(override.strokePaints)) fields.strokes = strokesOf(override)
      else if(STROKE_INPUTS.some(key => override[key] !== undefined)) applyStrokeAttrs(fields, override, target, warnings)
      const kept = applyConsumption(fields, override, variables, warnings)
      if(Object.keys(kept).length) retained.push({ path, ...kept })
      n.instance.overrides[path]=fields
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

function applyText(fields: Record<string, unknown>, override: any, target: { text?: string; textStyle?: ReturnType<typeof defaultTextStyle>; fontSize?: number } | undefined, warnings?: { add(message: string): unknown }) {
  if(override.textData) {
    if(typeof override.textData.characters === 'string') fields.text = override.textData.characters
    if(override.textData.layoutVersion !== undefined) warnings?.add('FIG 实例覆盖 textData.layoutVersion 暂不能执行，其余覆盖已保留')
  }
  const style = { ...(target?.textStyle ?? defaultTextStyle()) }
  let changed = false
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
  if(changed) fields.textStyle = style
}

function distance(record: any, field: string, fallback = 0) {
  const value = record[field] ?? fallback
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e5) return undefined
  return value
}

function applyLayout(fields: Record<string, unknown>, override: any, target: any, source: any, _records: Map<string, any>, warnings?: { add(message: string): unknown }) {
  if(override.stackReverseZIndex === true) warnings?.add('FIG 实例覆盖 stackReverseZIndex 暂不能执行，其余覆盖已保留')
  if(!LAYOUT_KEYS.some(key => override[key] !== undefined) || !target || !source) return
  const record = { ...source, ...Object.fromEntries(LAYOUT_KEYS.filter(key => override[key] !== undefined).map(key => [key, override[key]])) }
  const mode = record.stackMode === 'HORIZONTAL' ? 'horizontal' : record.stackMode === 'VERTICAL' ? 'vertical' : record.stackMode === 'NONE' || record.stackMode === undefined ? 'none' : undefined
  if(!mode) { warnings?.add('FIG 实例覆盖自动布局字段暂不能执行，其余覆盖已保留'); return }
  if(mode !== 'none') {
    if(!['frame','group','section'].includes(target.kind)) { warnings?.add('FIG 实例覆盖自动布局字段暂不能执行，其余覆盖已保留'); return }
    const horizontal = distance(record, 'stackHorizontalPadding')
    const vertical = distance(record, 'stackVerticalPadding')
    const gap = distance(record, 'stackSpacing')
    const right = distance(record, 'stackPaddingRight', horizontal)
    const bottom = distance(record, 'stackPaddingBottom', vertical)
    if([horizontal, vertical, gap, right, bottom].some(value => value === undefined)) {
      warnings?.add('FIG 实例覆盖自动布局字段暂不能执行，其余覆盖已保留')
      return
    }
    const layout = {
      ...defaultLayout(),
      ...(target.layout ?? {}),
      mode,
      gap,
      padding: [vertical, right, bottom, horizontal],
    }
    fields.layout = layout
    const sizing = { ...(target.sizing ?? defaultSizing()) }
    const primary = record.stackPrimarySizing === 'FIXED' ? 'fixed' : 'hug'
    const counter = record.stackCounterSizing === 'RESIZE_TO_FIT' || record.stackCounterSizing === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' ? 'hug' : 'fixed'
    sizing.width = mode === 'horizontal' ? primary : counter
    sizing.height = mode === 'horizontal' ? counter : primary
    fields.sizing = sizing
  }
  const sizing = { ...((fields.sizing as object | undefined) ?? target.sizing ?? defaultSizing()) } as Record<string, unknown>
  let sized = fields.sizing !== undefined
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
