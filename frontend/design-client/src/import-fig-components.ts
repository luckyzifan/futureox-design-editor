import type { ComponentProperty, DesignDocument, Paint } from './model'
const guid = (g: any): string => typeof g === 'string' ? g : g ? `${g.sessionID}:${g.localID}` : ''
function literal(kind: ComponentProperty['kind'], value: any, ids: Map<string,string>): string | boolean {
  if (kind === 'boolean' && typeof value?.boolValue === 'boolean') return value.boolValue
  if (kind === 'text' && typeof value?.textValue?.characters === 'string') return value.textValue.characters
  if (kind === 'instance-swap' && ids.has(guid(value?.guidValue))) return ids.get(guid(value.guidValue))!
  throw new Error('FIG 组件属性缺少可执行的常量值；原文件未修改')
}
/** Resolve after assembly so property references name actual template layers. */
export function importFigComponents(doc: DesignDocument, records: Map<string,any>, ids: Map<string,string>, toPaint: (p:any)=>Paint) {
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
      const kinds={BOOL:'boolean',TEXT:'text',INSTANCE_SWAP:'instance-swap'} as const
      const kind=kinds[def.type as keyof typeof kinds]
      if(!kind)throw new Error(`FIG 组件属性 ${def.type} 暂不支持；原文件未修改`)
      const field={boolean:'VISIBLE',text:'TEXT_DATA','instance-swap':'OVERRIDDEN_SYMBOL_ID'}[kind],key=guid(def.id)
      const targets=[...records].filter(([source,record])=>descendants.has(ids.get(source)!) &&
        record.componentPropRefs?.some((ref:any)=>!ref.isDeleted && guid(ref.defID)===key && ref.componentPropNodeField===field))
      if(targets.length!==1)throw new Error(`FIG 组件属性 ${def.name} 需要一个明确目标，当前为 ${targets.length}；原文件未修改`)
      const target=doc.nodes[ids.get(targets[0][0])!]
      n.component.properties[key]={name:def.name||key,kind,targetKey:target.componentKey||target.id,defaultValue:literal(kind,def.initialValue,ids)}
    }
  }
  for(const [sourceId,r] of records) {
    const n=doc.nodes[ids.get(sourceId)!]
    if(!n || r.type!=='INSTANCE')continue
    const componentId=ids.get(guid(r.symbolData?.symbolID)),component=componentId && doc.nodes[componentId]?.component
    if(!componentId || !component)throw new Error('FIG 实例缺少嵌入的主组件；原文件未修改')
    n.instance={componentId,overrides:{},propertyValues:{}}
    for(const assignment of r.componentPropAssignments||r.symbolData?.componentPropAssignments||[]) {
      const key=guid(assignment.defID),property=component.properties[key]
      if(!property)throw new Error(`FIG 组件属性赋值 ${key} 缺少定义；原文件未修改`)
      n.instance.propertyValues[key]=literal(property.kind,assignment.value,ids)
    }
    for(const override of r.symbolData?.symbolOverrides||[]) {
      const sourcePath=override.guidPath?.guids || (override.overrideKey?[override.overrideKey]:[])
      const path=sourcePath.map((g:any)=>ids.get(guid(g))||guid(g)).join('/')||'$root',fields:Record<string,unknown>={}
      for(const [key,value] of Object.entries(override)) {
        if(['guidPath','overrideKey','styleID'].includes(key))continue
        if(['name','visible','opacity','fontSize'].includes(key))fields[key]=value
        else if(key==='textData')fields.text=(value as any)?.characters??''
        else if(key==='fillPaints')fields.fills=(value as any[]).map(toPaint)
        else if(key==='symbolID')fields.swapComponent=ids.get(guid(value))
        else throw new Error(`FIG 实例覆盖 ${key} 暂不支持；原文件未修改`)
      }
      n.instance.overrides[path]=fields
    }
  }
}
