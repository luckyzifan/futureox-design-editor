import {blank,node,validateDocument,type DesignDocument,type DesignNode} from './model'
import {cloneValue} from './draft'
import {importDesignDependencies,remapDesignDependencies} from './design-system'
import {importFonts} from './text'
import {allParents} from './geometry'

export const PROPERTY_PREFIX='FUTUREOX-DESGIN-PROPERTIES-V1\n'
export type PropertyKind='all'|'fills'|'strokes'|'effects'
const appearance=['opacity','blend','fills','strokes','effects','radii','smoothing','cornerRadius'] as const
const typography=['fontSize','textStyle'] as const
function fields(kind:PropertyKind,text:boolean):string[]{return kind==='all'?[...appearance,...(text?typography:[])]:[kind]}
function keepReferences(n:DesignNode,allowed:string[]){
  n.bindings=Object.fromEntries(Object.entries(n.bindings||{}).filter(([key])=>allowed.includes(key.split('.')[0])))
  n.styleRefs=Object.fromEntries(Object.entries(n.styleRefs||{}).filter(([key])=>allowed.includes(key)))
}
/** A style-only carrier never places source text, children, prototypes or other
 * document content on the system clipboard. Dependencies are reachable only. */
export function copyProperties(source:DesignDocument,id:string,kind:PropertyKind='all'):string {
  const original=source.nodes[id];if(!original)throw Error('请选择一个来源图层')
  const text=kind==='all'&&original.kind==='text',carrier=node(text?'text':kind==='all'&&['polygon','star'].includes(original.kind)?original.kind:'rectangle',0,0,100,100)
  carrier.name='属性';carrier.text=text?'X':''
  const allowed=fields(kind,text)
  for(const key of allowed)(carrier as any)[key]=cloneValue((original as any)[key])
  carrier.bindings=cloneValue(original.bindings);carrier.styleRefs=cloneValue(original.styleRefs)
  // Preserve the effective variable mode at the copy site, including ancestors.
  const parents=allParents(source),chain:string[]=[];let current:string|undefined=id
  while(current&&source.nodes[current]){chain.unshift(current);current=parents.get(current)}
  const modes=Object.assign({},...chain.map(id=>source.nodes[id].variableModes||{}))
  if(Object.keys(modes).length)carrier.variableModes=modes
  keepReferences(carrier,allowed)
  const document=blank('属性');document.schemaVersion=source.schemaVersion
  document.colorManagement=cloneValue(source.colorManagement);document.rasterProfile=source.rasterProfile
  const deps=importDesignDependencies(document,source,[carrier]);importFonts(document,source,[carrier]);remapDesignDependencies(carrier,deps)
  document.nodes[carrier.id]=carrier;document.pages[0].children=[carrier.id]
  validateDocument(document)
  return PROPERTY_PREFIX+JSON.stringify({format:'futureox-desgin-properties',version:1,kind,document})
}
export function readProperties(source:string):{kind:PropertyKind;document:DesignDocument;node:DesignNode}{
  if(!source.startsWith(PROPERTY_PREFIX)||new TextEncoder().encode(source).byteLength>32*1024*1024)throw Error('无效的属性剪贴板')
  const packet=JSON.parse(source.slice(PROPERTY_PREFIX.length))
  if(packet.format!=='futureox-desgin-properties'||packet.version!==1||!['all','fills','strokes','effects'].includes(packet.kind))throw Error('无效的属性剪贴板')
  validateDocument(packet.document)
  const doc=packet.document as DesignDocument,roots=doc.pages[0]?.children
  if(doc.pages.length!==1||roots.length!==1||Object.keys(doc.nodes).length!==1)throw Error('属性剪贴板只能包含一个样式来源')
  const n=doc.nodes[roots[0]]
  if(n.children.length||n.instance||n.instanceOrigin||n.component)throw Error('属性剪贴板不能包含组件结构')
  return {kind:packet.kind,document:doc,node:n}
}
/** Called inside Editor.change so dependencies, overrides and all targets share
 * a single validated undo entry. Geometry and textual content remain authored. */
export function pasteProperties(target:DesignDocument,ids:string[],packet:ReturnType<typeof readProperties>){
  const source=cloneValue(packet.node),allowed=fields(packet.kind,source.kind==='text')
  keepReferences(source,allowed)
  const deps=importDesignDependencies(target,packet.document,[source]);importFonts(target,packet.document,[source]);remapDesignDependencies(source,deps)
  for(const id of ids){
    const n=target.nodes[id];if(!n)throw Error('粘贴目标已移除')
    const keys=allowed.filter(key=>(!typography.includes(key as any)||n.kind==='text')&&(key!=='cornerRadius'||(['polygon','star'].includes(n.kind)&&!n.network)))
    for(const key of keys){if((source as any)[key]===undefined)delete (n as any)[key];else (n as any)[key]=cloneValue((source as any)[key])}
    // Applying one text style intentionally clears mixed run formatting without
    // copying character ranges from text with a different length.
    if(packet.kind==='all'&&source.kind==='text'&&n.kind==='text')delete n.textRuns
    n.bindings={...Object.fromEntries(Object.entries(n.bindings||{}).filter(([key])=>!keys.includes(key.split('.')[0]))),...Object.fromEntries(Object.entries(source.bindings||{}).filter(([key])=>keys.includes(key.split('.')[0])))}
    n.styleRefs={...Object.fromEntries(Object.entries(n.styleRefs||{}).filter(([key])=>!keys.includes(key))),...Object.fromEntries(Object.entries(source.styleRefs||{}).filter(([key])=>keys.includes(key)))}
    if(source.variableModes)n.variableModes={...n.variableModes,...cloneValue(source.variableModes)}
  }
}
