import type { DesignDocument } from '../model'
import { SVG_OPTION_SCHEMA, validateSvgOptions, type SvgExportOptions } from '../export-options'
import { createSvgArtifact } from '../svg-artifact'
import { kernelLayout } from '../kernel/picking'
import { assetReference, boundedInteger, contextOptions, contextEntries } from './context'
import { AutomationError, type AutomationMethod } from './types'
import { RASTER_LIMITS } from './raster'
const id={type:'string',minLength:1,maxLength:512}
export const vectorArtifactMethods: AutomationMethod[] = [
 {name:'svg.importArtifact',mutates:true,description:'Validate and atomically append an owned SVG artifact. Requires write scope and current expectedRevision; preserves destination fonts and existing text. 48 MiB expanded XML, 24 MiB fonts, 200:1 expansion limit; arbitrary styles and external URLs rejected.',inputSchema:{type:'object',additionalProperties:false,required:['artifactId'],properties:{artifactId:id,pageId:id,name:{type:'string',maxLength:200}}}},
 {name:'vector.exportArtifact',mutates:false,description:'Export SVG/SVGZ to an immutable session-owned artifact. Editable font embedding includes the whole bundled default font and local fonts up to 24 MiB total; explicit redistribution rights required. Read with vector.read (64 KiB) then vector.release. Host font support varies; no pixel equivalence claim. Large artifacts can be appended with svg.importArtifact.',inputSchema:{type:'object',additionalProperties:false,properties:{...SVG_OPTION_SCHEMA,fontMode:{...SVG_OPTION_SCHEMA.fontMode,description:'Artifact embedding includes whole local TTF/OTF and bundled default; 24 MiB total with explicit redistribution permission.'},pageId:id,nodeIds:{type:'array',items:id,maxItems:500},maxNodes:{type:'integer',minimum:1,maximum:500}}}},
 {name:'vector.read',mutates:false,description:'Read bounded bytes of a session-owned SVG artifact; expires in five minutes.',inputSchema:{type:'object',additionalProperties:false,required:['artifactId'],properties:{artifactId:id,offset:{type:'integer',minimum:0},length:{type:'integer',minimum:1,maximum:RASTER_LIMITS.chunkBytes}}}},
 {name:'vector.release',mutates:false,description:'Release a session-owned SVG artifact.',inputSchema:{type:'object',additionalProperties:false,required:['artifactId'],properties:{artifactId:id}}},
]
export function vectorArtifactParams(input: Record<string,unknown>) {
 if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['pageId','nodeIds','maxNodes',...Object.keys(SVG_OPTION_SCHEMA)].includes(k))) throw new AutomationError('invalid_params','Unknown SVG artifact option')
 const {pageId,nodeIds}=contextOptions({pageId:input.pageId,nodeIds:input.nodeIds})
 const {scale,precision,compression,textMode,fontMode,fontEmbeddingAllowed}=input as SvgExportOptions
 return {pageId,nodeIds,maxNodes:boundedInteger(input.maxNodes,200,1,500,'maxNodes'),options:validateSvgOptions({scale,precision,compression,textMode,fontMode,fontEmbeddingAllowed})}
}
export async function captureSvgArtifact(document: DesignDocument,input:Record<string,unknown>,signal:AbortSignal) {
 const options=vectorArtifactParams(input),doc=kernelLayout(document)
 const selected=contextEntries(doc,{pageId:options.pageId,nodeIds:options.nodeIds,maxDepth:64,limit:500})
 if(selected.entries.length>options.maxNodes || selected.omittedByDepth) throw new AutomationError('response_limit','SVG artifact exceeds node/depth limits')
 for(const {node} of selected.entries) for(const paint of [...node.fills,...node.strokes.map(s=>s.paint)]) if(paint.image){const asset=assetReference(paint.image,node.id,paint.id);if(asset.source==='unsafe'||asset.source==='local')throw new AutomationError('unsafe_asset_url','SVG artifact contains an unsafe image URL')}
 const target=options.nodeIds?{kind:'selection' as const,nodeIds:selected.roots}:{kind:'page' as const,padding:0}
 return {...await createSvgArtifact(doc,selected.page.id,target,options.options,signal),pageId:selected.page.id,sourceNodeIds:selected.roots}
}
