/** SOURCE-ONLY CANDIDATE. Install beside engine.ts; no endpoint imports this file.
 * Plans are NOT native-admitted documents or authorization capabilities.
 * Only the existing automation staging/fenced Editor commit may adopt a plan.
 */
import {blank,uid,validateDocument,type DesignDocument,type DesignNode,type Point} from './model'
import {cloneValue} from './draft'
import {allParents,worldMatrix,bounds,boxPoints,apply,unionBounds,multiply,translate,inverse} from './geometry'
import * as Components from './components'
import {remapDesignDependencies} from './design-system'
import {captureClipboardSemantics,clipboardDependencyNodes,applyClipboardSemantics,hasClipboardSemantics} from './clipboard-semantics'
import {copyProperties,readProperties,pasteProperties,PROPERTY_PREFIX,type PropertyKind} from './property-clipboard'

export const MAX_PACKET_BYTES=32*1024*1024
export const MAX_PROPERTY_TARGETS=64
export const MAX_NODE_ROOTS=64
const encodedBytes=(s:string)=>new TextEncoder().encode(s).byteLength
function bounded(s:string){if(typeof s!=='string'||s.length>MAX_PACKET_BYTES||encodedBytes(s)>MAX_PACKET_BYTES)throw Error('Clipboard packet exceeds 32 MiB');return s}
function keys(value:unknown,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unsupported clipboard fields')}
function ids(value:unknown):asserts value is string[]{if(!Array.isArray(value)||!value.length||value.length>20000||value.some(v=>typeof v!=='string'||!v))throw Error('Explicit nonempty node IDs required')}
/** Bound arbitrary JSON nesting before schema recursion, including unknown fields. */
function json(source:string){const value=JSON.parse(bounded(source));const pending:[unknown,number][]=[[value,0]];while(pending.length){const [v,depth]=pending.pop()!;if(depth>256)throw Error('Clipboard JSON too deep');if(typeof v==='number'&&!Number.isFinite(v))throw Error('Nonfinite clipboard number');if(v&&typeof v==='object')for(const child of Object.values(v))pending.push([child,depth+1])}return value}

export function captureNodeGraph(source:DesignDocument,nodeIds:string[]){
  validateDocument(source);ids(nodeIds);source=cloneValue(source)
  const parents=allParents(source),selected=new Set(nodeIds)
  for(const id of selected)if(!source.nodes[id])throw Error('Source node missing')
  const sceneOrder:string[]=[];const order=(id:string)=>{sceneOrder.push(id);source.nodes[id].children.forEach(order)};source.pages.forEach(page=>page.children.forEach(order))
  const roots=sceneOrder.filter(id=>selected.has(id)).filter(id=>{let parent=parents.get(id);while(parent&&source.nodes[parent]){if(selected.has(parent))return false;parent=parents.get(parent)}return true})
    const nodes: Record<string, DesignNode> = {}
    const visit = (id: string) => {
      nodes[id] = cloneValue(source.nodes[id])
      nodes[id].children.forEach(visit)
    }
    roots.forEach(visit)
    roots.forEach((id) => {
      nodes[id].transform = worldMatrix(source, id)
    })
    for (const root of roots) {
      const original = nodes[root],
        origin = original.instanceOrigin
      if (!origin) continue
      if (original.instance) {
        // A generated nested root includes template/override modes. On lifting
        // it to an authored root retain only its source placement selections;
        // the instance specification and lifted overrides supply the defaults.
        original.variableModes = cloneValue(source.nodes[origin.source]?.variableModes)
        if (!original.variableModes) delete original.variableModes
        const outer = source.nodes[origin.owner].instance!
        for (const [k, v] of Object.entries(outer.overrides))
          if (k === origin.key || k.startsWith(origin.key + '/'))
            original.instance.overrides[
              k === origin.key ? '$root' : k.slice(origin.key.length + 1)
            ] = {
              ...original.instance.overrides[
                k === origin.key ? '$root' : k.slice(origin.key.length + 1)
              ],
              ...cloneValue(v),
            }
        delete original.instanceOrigin
        for (const n of Object.values(nodes))
          if (
            n.instanceOrigin?.owner === origin.owner &&
            n.instanceOrigin.key.startsWith(origin.key + '/')
          )
            n.instanceOrigin = {
              ...n.instanceOrigin,
              owner: root,
              key: n.instanceOrigin.key.slice(origin.key.length + 1),
            }
      } else {
        const clear = (id: string) => {
          const n = nodes[id]
          delete n.instanceOrigin
          delete n.instance
          delete n.componentKey
          n.children.forEach(clear)
        }
        clear(root)
      }
    }
    return { nodes, roots, document: source }
}

export function selectedDocument(source:DesignDocument,nodeIds:string[],name:string,rootLimit=1000){
  const content=captureNodeGraph(source,nodeIds)
  if(content.roots.length>rootLimit)throw Error(`Selection exceeds ${rootLimit} roots`)
  const semantics=captureClipboardSemantics(content.document,Object.values(content.nodes),content.roots,{external:true})
  const document=blank(name);document.schemaVersion=source.schemaVersion
  document.colorManagement=cloneValue(source.colorManagement);document.rasterProfile=source.rasterProfile
  const mapping=new Map(Object.keys(content.nodes).map(id=>[id,id]))
  const dependencies=Components.importClipboardDependencies(document,content.document,clipboardDependencyNodes(Object.values(content.nodes),semantics),mapping)
  for(const [id,original]of Object.entries(content.nodes)){
    const n=cloneValue(original);Components.remapReferences(n,dependencies.nodeIds,content.document);remapDesignDependencies(n,dependencies.designSystem);document.nodes[id]=n
  }
  document.pages[0].children=[...content.roots]
  const remapped=applyClipboardSemantics(document,content.document,content.roots,dependencies.nodeIds,dependencies.designSystem,semantics,document.pages[0].id,0)
  validateDocument(document)
  return {document,roots:content.roots.map(id=>remapped.get(id)!),selection:content.roots}
}
export function serializeNodePacket(source:DesignDocument,nodeIds:string[]):string{
  const selection=selectedDocument(source,nodeIds,'剪贴板',MAX_NODE_ROOTS)
  return bounded(JSON.stringify({format:'forma-nodes',version:1,...selection}))
}

/** Only a private schema-checked graph; deliberately NOT native admission. */
export function parsePortablePacket(source:string){
  const packet=json(source);keys(packet,['format','version','document','roots','selection','placements'])
  if(packet.format!=='forma-nodes'||packet.version!==1)throw Error('Unsupported node packet')
  ids(packet.roots);if(packet.roots.length>MAX_NODE_ROOTS)throw Error('Clipboard supports at most 64 roots')
  if(new Set(packet.roots).size!==packet.roots.length)throw Error('Duplicate packet roots')
  const document=validateDocument(packet.document),roots=packet.roots as string[]
  for(const key of ['sourceSession','grant','owner'])if(Object.hasOwn(document,key))throw Error('Portable packet cannot carry capabilities')
  if(roots.some(id=>!document.pages.some(page=>page.children.includes(id))))throw Error('Invalid page-root clipboard')
  const nodes:Record<string,DesignNode>={};const visit=(id:string)=>{nodes[id]=document.nodes[id];nodes[id].children.forEach(visit)};roots.forEach(visit)
  if(packet.selection!==undefined){ids(packet.selection);if(packet.selection.some((id:string)=>!nodes[id]))throw Error('Selection outside copied graph')}
  if(packet.placements!==undefined){keys(packet.placements,roots);for(const placement of Object.values(packet.placements) as any[]){keys(placement,['transform','outsideX','outsideY']);if(!Array.isArray(placement.transform)||placement.transform.length!==6||placement.transform.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e7)||typeof placement.outsideX!=='boolean'||typeof placement.outsideY!=='boolean')throw Error('Invalid placement');inverse(placement.transform)}}
  captureClipboardSemantics(document,Object.values(nodes),roots,{external:true})
  // Closed-carrier proof: regenerate ONLY selected + reachable dependencies and
  // reject any additional document data. Generated resource identities alone
  // are reconciled; caller-chosen dictionary/node IDs are never rewritten.
  const projected=JSON.parse(serializeNodePacket(document,roots)).document as DesignDocument
  projected.id=document.id
  if(projected.pages.length!==document.pages.length)throw Error('Clipboard contains unrelated pages')
  const pageIds=new Map(projected.pages.map((page,index)=>[page.id,document.pages[index].id]))
  projected.pages.forEach((page,index)=>{page.id=document.pages[index].id})
  if((projected.animations?.length||0)!==(document.animations?.length||0))throw Error('Clipboard contains unrelated animations')
  projected.animations?.forEach((clip,index)=>{clip.id=document.animations![index].id;clip.pageId=pageIds.get(clip.pageId)||clip.pageId})
  if(canonical(projected)!==canonical(document))throw Error('Clipboard is not a minimal selected dependency carrier')
  return {document,nodes,roots,selection:(packet.selection||roots) as string[]}
}
export type PageRootPaste={pageId:string;mode:'inPlace';position?:never}|{pageId:string;mode:'here';position:Point}
export type ClipboardPlan={candidate:DesignDocument;createdRoots:string[];selection:string[];nativeAdmissionRequired:true}
export function planNodePaste(snapshot:DesignDocument,serialized:string,options:PageRootPaste):ClipboardPlan{
  keys(options,['pageId','mode','position']);validateDocument(snapshot)
  if(!snapshot.pages.some(p=>p.id===options.pageId))throw Error('Destination page missing')
  if(options.mode!=='inPlace'&&options.mode!=='here')throw Error('Unsupported paste mode')
  if(options.mode==='inPlace'&&Object.hasOwn(options,'position'))throw Error('inPlace forbids position')
  const content=parsePortablePacket(serialized),candidate=cloneValue(snapshot)
  // A caller-chosen document UUID is never same-session authority. Disable the
  // existing same-document dependency fast paths for every portable import.
  do{content.document.id=uid()}while(content.document.id===candidate.id)
  candidate.schemaVersion=Math.max(candidate.schemaVersion,content.document.schemaVersion) as DesignDocument['schemaVersion']
  let delta={x:0,y:0}
  if(options.mode==='here'){
    keys(options.position,['x','y']);const position=options.position
    if(!Number.isFinite(position.x)||!Number.isFinite(position.y))throw Error('Finite world position required')
    // A vector network requires native geometry. Never silently use its box.
    if(content.roots.some(id=>{const n=content.nodes[id];return !['rectangle','ellipse'].includes(n.kind)||n.children.length||n.network||n.booleanOperation||n.pathOffset}))throw Error('Unsupported: here requires proven native-free leaf bounds')
    const box=unionBounds(content.roots.map(id=>{const n=content.nodes[id];return bounds(boxPoints({x:0,y:0,width:n.width,height:n.height}).map(p=>apply(n.transform,p)))}))
    delta={x:position.x-box.x,y:position.y-box.y}
  }
  const semantics=captureClipboardSemantics(content.document,Object.values(content.nodes),content.roots,{external:true})
  if(content.roots.length===1&&content.nodes[content.roots[0]].component&&!hasClipboardSemantics(semantics)){
    const source=content.nodes[content.roots[0]],componentId=Components.importDefinitions(candidate,content.document,source.id)
    const created=Components.insertInstance(candidate,componentId,options.pageId,{x:source.transform[4]+delta.x,y:source.transform[5]+delta.y})
    // Explicit page-root coordinate semantics retain rotation/scale, unlike UI smart paste.
    candidate.nodes[created].transform=multiply(translate(delta.x,delta.y),source.transform)
    validateDocument(candidate);bounded(JSON.stringify(candidate));return {candidate,createdRoots:[created],selection:[created],nativeAdmissionRequired:true}
  }
  const mapping=new Map(Object.keys(content.nodes).map(id=>[id,uid()]))
  const dependencies=Components.importClipboardDependencies(candidate,content.document,clipboardDependencyNodes(Object.values(content.nodes),semantics),mapping)
  for(const [id,source]of Object.entries(content.nodes)){
    const n=cloneValue(source);Components.remapReferences(n,dependencies.nodeIds,content.document);remapDesignDependencies(n,dependencies.designSystem)
    if(n.instanceOrigin&&source.instanceOrigin)n.instanceOrigin.owner=mapping.get(source.instanceOrigin.owner)||n.instanceOrigin.owner
    n.id=mapping.get(id)!;n.children=n.children.map(child=>mapping.get(child)!)
    if(content.roots.includes(id))n.transform=multiply(translate(delta.x,delta.y),n.transform)
    candidate.nodes[n.id]=n
  }
  candidate.pages.find(p=>p.id===options.pageId)!.children.push(...content.roots.map(id=>mapping.get(id)!))
  const finalRoots=applyClipboardSemantics(candidate,content.document,content.roots,dependencies.nodeIds,dependencies.designSystem,semantics,options.pageId,delta,{internal:false})
  validateDocument(candidate);bounded(JSON.stringify(candidate))
  return {candidate,createdRoots:content.roots.map(id=>finalRoots.get(id)!),selection:content.selection.map(id=>mapping.get(id)!),nativeAdmissionRequired:true}
}

function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)}
/** Reprojection whitelist: reject hidden text, interactions, animations, unknown
 * carrier fields and unreferenced dictionaries instead of merely ignoring them. */
export function parsePropertyPacket(serialized:string){
  bounded(serialized);if(!serialized.startsWith(PROPERTY_PREFIX))throw Error('Expected property packet')
  const value=json(serialized.slice(PROPERTY_PREFIX.length));keys(value,['format','version','kind','document'])
  const packet=readProperties(serialized),reprojected=readProperties(copyProperties(packet.document,packet.node.id,packet.kind))
  const normalized=cloneValue(reprojected.document),original=packet.document,root=packet.node.id
  const projectedId=reprojected.node.id;normalized.id=original.id;normalized.pages[0].id=original.pages[0].id
  normalized.nodes[root]=normalized.nodes[projectedId];delete normalized.nodes[projectedId];normalized.nodes[root].id=root;normalized.pages[0].children=[root]
  if(canonical(normalized)!==canonical(original))throw Error('Property packet is not a minimal style-only carrier')
  return packet
}
export function serializePropertyPacket(source:DesignDocument,nodeIds:string[],kind:PropertyKind='all'){
  validateDocument(source);ids(nodeIds);if(nodeIds.length!==1||!['all','fills','strokes','effects'].includes(kind))throw Error('Exactly one property source required')
  return bounded(copyProperties(cloneValue(source),nodeIds[0],kind))
}
export function planPropertyPaste(snapshot:DesignDocument,serialized:string,targetIds:string[]){
  validateDocument(snapshot);ids(targetIds);if(targetIds.length>MAX_PROPERTY_TARGETS||new Set(targetIds).size!==targetIds.length)throw Error('Invalid property targets')
  const parents=allParents(snapshot)
  for(const id of targetIds){if(!snapshot.nodes[id])throw Error('Property target missing');let current:string|undefined=id;while(current&&snapshot.nodes[current]){if(snapshot.nodes[current].locked)throw Error('Locked property target');current=parents.get(current)}}
  const packet=parsePropertyPacket(serialized)
  // Prevent a small packet expanding into an oversized candidate through N targets.
  const styleBytes=encodedBytes(JSON.stringify(packet.node));if(styleBytes*targetIds.length>MAX_PACKET_BYTES)throw Error('Property expansion exceeds budget')
  const candidate=cloneValue(snapshot)
  do{packet.document.id=uid()}while(packet.document.id===candidate.id)
  candidate.schemaVersion=Math.max(candidate.schemaVersion,packet.document.schemaVersion) as DesignDocument['schemaVersion']
  pasteProperties(candidate,targetIds,packet);validateDocument(candidate)
  if(encodedBytes(JSON.stringify(candidate))>MAX_PACKET_BYTES)throw Error('Candidate exceeds document budget')
  return {candidate,nativeAdmissionRequired:true as const}
}
