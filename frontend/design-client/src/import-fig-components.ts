import type { ComponentProperty, DesignDocument, Paint, Stroke } from './model'
const guid = (g: any): string => typeof g === 'string' ? g : g ? `${g.sessionID}:${g.localID}` : ''
function literal(kind: ComponentProperty['kind'], value: any, ids: Map<string,string>): string | boolean {
  if (kind === 'boolean' && typeof value?.boolValue === 'boolean') return value.boolValue
  if (kind === 'text' && typeof value?.textValue?.characters === 'string') return value.textValue.characters
  if (kind === 'instance-swap' && ids.has(guid(value?.guidValue))) return ids.get(guid(value.guidValue))!
  throw new Error('FIG 组件属性缺少可执行的常量值；原文件未修改')
}
/** Resolve after assembly so property references name actual template layers. */
const NULL_STYLE = '4294967295:4294967295'
export function importFigComponents(doc: DesignDocument, records: Map<string,any>, ids: Map<string,string>, toPaint: (p:any)=>Paint, strokesOf: (record:any)=>Stroke[], warnings?: { add(message: string): unknown }) {
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
    for(const override of r.symbolData?.symbolOverrides||[]) {
      const sourcePath=override.guidPath?.guids || (override.overrideKey?[override.overrideKey]:[])
      const path=sourcePath.map((g:any)=>ids.get(guid(g))||guid(g)).join('/')||'$root',fields:Record<string,unknown>={}
      const strokeInputs=new Set(['strokeWeight','strokeAlign','strokeCap','strokeJoin','dashPattern','borderStrokeWeightsIndependent','borderTopWeight','borderRightWeight','borderBottomWeight','borderLeftWeight'])
      for(const [key,value] of Object.entries(override)) {
        if(Array.isArray(override.strokePaints) && strokeInputs.has(key)) continue
        if(['guidPath','overrideKey','styleID'].includes(key))continue
        if(['name','visible','opacity','fontSize'].includes(key))fields[key]=value
        else if(key==='textData')fields.text=(value as any)?.characters??''
        else if(key==='fillPaints')fields.fills=(value as any[]).map(toPaint)
        else if(key==='strokePaints')fields.strokes=strokesOf(override)
        else if(key==='styleIdForFill' || key==='styleIdForStrokeFill'){
          if(key==='styleIdForFill'){
            const id=guid((value as any)?.guid ?? value)
            if(id && id!==NULL_STYLE && id!=='0:0'){
              const resolved=ids.get(id)
              const style=resolved ? doc.designSystem?.styles?.[resolved] : undefined
              if(style?.kind==='paint' && resolved) fields.styleRefs={...(fields.styleRefs as Record<string,string>||{}), fills: resolved}
              else warnings?.add(`FIG 实例覆盖 styleIdForFill 未能对应到已导入填充样式`)
            }
          }
        }
        else if(key==='symbolID')fields.swapComponent=ids.get(guid(value))
        else warnings?.add(`FIG 实例覆盖 ${key} 暂不能执行，其余覆盖已保留`)
      }
      n.instance.overrides[path]=fields
    }
  }
}
