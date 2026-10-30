import { applyShapeBuilder, previewShapeBuilder } from '../shape-builder'
import type { AutomationExtension } from './types'
const ids = { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } }
export const shapeBuilderExtensions: AutomationExtension[] = [
  { name: 'vector.shapeBuilder.preview', description: 'Find connected cubic regions in selected closed fill-only shapes. Read-only; region IDs refer to this exact geometry.', mutates: false,
    inputSchema: { type: 'object', properties: { ids }, required: ['ids'], additionalProperties: false },
    execute(doc,params) { const p = previewShapeBuilder(doc,params.ids as string[]); return { regions:p.regions, fingerprint:p.fingerprint } } },
  { name: 'vector.shapeBuilder.apply', description: 'Atomically merge or erase selected connected regions, preserving all other regions. New vector IDs; topmost source supplies paint. Supports typed batch/undo/FD.', mutates: true,
    inputSchema: { type: 'object', properties: { ids, regionIds: { ...ids, maxItems:256 }, mode: { enum: ['merge','erase'] }, fingerprint: { type:'string',minLength:1,maxLength:2000000 } }, required:['ids','regionIds','mode','fingerprint'],additionalProperties:false },
    execute(doc,params,context) { const p=previewShapeBuilder(doc,params.ids as string[]); if(p.fingerprint!==params.fingerprint) throw new Error('Shape Builder preview is stale'); const created=applyShapeBuilder(doc,p,params.regionIds as string[],params.mode as 'merge'|'erase'); context.selection=created; context.createdIds.push(...created); return {ids:created} } },
]
