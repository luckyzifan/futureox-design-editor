/** Authored interaction data only. Uses the editor's atomic commit/validation boundary. */
import { createClip, recordKeyframe, type AnimationClip, type Easing } from '../animation'
import { uid, type DesignDocument, type LocalReview } from '../model'
import { type Prototype, isPrototypeEasing, hasSchemaExtras } from '../prototype'
import type { AutomationExtension } from './types'

const str = (v: unknown, name: string, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Invalid ${name}`)
  return v
}
const num = (v: unknown, name: string, lo: number, hi: number) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`Invalid ${name}`)
  return v
}
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object')
  return v as Record<string, unknown>
}
const copy = <T>(v: T): T => structuredClone(v)
const page = (d: DesignDocument, id: unknown) => {
  const p = d.pages.find(p => p.id === id)
  if (!p) throw new Error('Page not found')
  return p
}
function members(d: DesignDocument, pageId: string) {
  const seen = new Set<string>(), pending = [...page(d, pageId).children]
  while (pending.length) { const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id); pending.push(...(d.nodes[id]?.children ?? [])) }
  return seen
}
function ids(d: DesignDocument, value: unknown, pageId: string) {
  if (!Array.isArray(value) || !value.length || value.length > 1024) throw new Error('Expected 1–1024 node IDs')
  const owned = members(d, pageId)
  return [...new Set(value.map(v => { const id = str(v, 'node ID', 128); if (!owned.has(id)) throw new Error('Node outside page'); return id }))]
}
function clip(d: DesignDocument, value: unknown): AnimationClip {
  const c = d.animations?.find(c => c.id === str(value, 'clip ID', 128))
  if (!c) throw new Error('Animation not found')
  return c
}
function easing(v: unknown): Easing {
  if (v === undefined) return { kind: 'linear' }
  const e = obj(v)
  if (e.kind === 'linear' || e.kind === 'hold') return { kind: e.kind }
  if (e.kind === 'named' && typeof e.name === 'string' && /^ease-(in|out|in-out)-(sine|quad|cubic|quart|quint|expo|circ)$/.test(e.name)) return { kind: 'named', name: e.name as Extract<Easing,{kind:'named'}>['name'] }
  if (e.kind === 'cubic') return { kind: 'cubic', x1:num(e.x1,'x1',0,1), y1:num(e.y1,'y1',-10,10), x2:num(e.x2,'x2',0,1), y2:num(e.y2,'y2',-10,10) }
  if (e.kind === 'spring') return { kind:'spring',mass:num(e.mass,'mass',0.0001,1e6),stiffness:num(e.stiffness,'stiffness',0.0001,1e6),damping:num(e.damping,'damping',0,1e6),velocity:num(e.velocity,'velocity',-1e6,1e6) }
  throw new Error('Unsupported easing')
}
const S = { type:'string', minLength:1, maxLength:128 }
const text = { type:'string', minLength:1, maxLength:10000 }
const nodes = { type:'array',items:S,minItems:1,maxItems:1024 }
function tool(name:string, description:string, mutates:boolean, properties:Record<string,unknown>, required:string[], execute:AutomationExtension['execute']):AutomationExtension {
  return {name,description,mutates,inputSchema:{type:'object',properties,required,additionalProperties:false},execute}
}
function reviews(d:DesignDocument,id:unknown) {
  const r=d.reviews?.find(r=>r.id===str(id,'review ID',128));if(!r)throw new Error('Review not found');return r
}
function validatePrototype(d:DesignDocument, value:unknown): Prototype {
  const p=obj(value)
  if(Object.keys(p).some(k=>!['startNode','interactions'].includes(k)))throw new Error('Unknown prototype field')
  if(p.startNode!==undefined && !d.nodes[str(p.startNode,'start node',128)])throw new Error('Start node not found')
  const interactions=obj(p.interactions)
  if(Object.keys(interactions).length>10000)throw new Error('Too many interaction owners')
  for(const [id,raw] of Object.entries(interactions)){
    if(!d.nodes[id]||!Array.isArray(raw)||raw.length>100)throw new Error('Invalid interaction owner/list')
    for(const value of raw){
      const event=obj(value)
      if(Object.keys(event).some(k=>!['trigger','actions','delayMs','condition'].includes(k)))throw new Error('Unknown interaction field')
      if(!['click','hover','leave','after-delay'].includes(String(event.trigger))||!Array.isArray(event.actions)||!event.actions.length||event.actions.length>100)throw new Error('Invalid interaction')
      if(event.delayMs!==undefined)num(event.delayMs,'delayMs',0,1e6)
      if(event.condition!==undefined){const c=obj(event.condition);if(Object.keys(c).some(k=>!['variable','equals'].includes(k)))throw new Error('Unknown condition field');if(!d.designSystem?.variables?.[String(c.variable)])throw new Error('Condition variable not found')}
      for(const rawAction of event.actions){
        const a=obj(rawAction)
        const keys=['kind','target','value','durationMs','easingCurve','overlayPosition','targetVariable','targetVariableModeId','targetVariableSetId','targetVariableSetKey','targetVariableData','mediaAction','mediaSkipByAmount','mediaSkipToTime','transitionShouldSmartAnimate','transitionOverridesEnabled','transitionPreserveScroll','transitionResetScrollPosition','transitionResetInteractiveComponents','transitionDurationVar','transitionEasingVar']
        if(Object.keys(a).some(k=>!keys.includes(k)))throw new Error('Unknown prototype action field')
        if(!['navigate','overlay','back','close-overlay','scroll-to','set-variable'].includes(String(a.kind)))throw new Error('Unsupported prototype action')
        if(['navigate','overlay','scroll-to'].includes(String(a.kind))&&!d.nodes[String(a.target)])throw new Error('Action target not found')
        if(a.kind==='set-variable'&&!d.designSystem?.variables?.[String(a.target)])throw new Error('Action variable not found')
        if(a.durationMs!==undefined)num(a.durationMs,'durationMs',0,1e6)
        if(a.easingCurve!==undefined&&!isPrototypeEasing(a.easingCurve))throw new Error('Invalid prototype easing')
      }
    }
  }
  return copy(p as unknown as Prototype)
}
export const interactionExtensions: AutomationExtension[] = [
  tool('prototype.get','Read authored prototype actions; does not execute navigation.',false,{},[],d=>copy(d.prototype??{interactions:{}})),
  tool('prototype.set','Replace authored prototype graph atomically; validates targets. Does not launch URLs or execute actions.',true,{prototype:{type:'object'}},['prototype'],(d,p)=>{d.prototype=validatePrototype(d,p.prototype);const extended=Object.values(d.prototype.interactions).some(events=>events.some(e=>e.actions.some(a=>a.easingCurve!==undefined||a.overlayPosition!==undefined||hasSchemaExtras(a))));d.schemaVersion=Math.max(d.schemaVersion,extended?12:4) as DesignDocument['schemaVersion'];return copy(d.prototype)}),
  tool('animation.list','List authored animation clips and track counts.',false,{pageId:S},[],(d,p)=>({clips:(d.animations??[]).filter(c=>p.pageId===undefined||c.pageId===p.pageId).map(({tracks,...c})=>({...c,trackCount:tracks.length}))})),
  tool('animation.get','Read one authored animation clip.',false,{id:S},['id'],(d,p)=>copy(clip(d,p.id))),
  tool('animation.create','Create a clip from current authored node poses; no rendering or playback.',true,{pageId:S,nodeIds:nodes,descendants:{type:'boolean'},name:{type:'string',minLength:1,maxLength:200}},['pageId','nodeIds'],(d,p)=>{
    const pageId=page(d,p.pageId).id
    if(p.descendants!==undefined&&typeof p.descendants!=='boolean')throw new Error('Invalid descendants')
    if((d.animations?.length??0)>=256)throw new Error('Animation limit reached')
    const c=createClip(d,pageId,ids(d,p.nodeIds,pageId),p.descendants!==false)
    if(p.name!==undefined)c.name=str(p.name,'name')
    ;(d.animations??=[]).push(c);d.schemaVersion=Math.max(d.schemaVersion,5) as DesignDocument['schemaVersion'];return copy(c)
  }),
  tool('animation.update','Update clip timing/name without silently dropping keyframes.',true,{id:S,name:{type:'string',minLength:1,maxLength:200},durationMs:{type:'number',minimum:1,maximum:1e6},delayMs:{type:'number',minimum:0,maximum:1e6},repeat:{enum:['once','loop','alternate']}},['id'],(d,p)=>{
    const c=clip(d,p.id)
    if(p.name!==undefined)c.name=str(p.name,'name')
    if(p.durationMs!==undefined){const n=num(p.durationMs,'durationMs',1,1e6);if(c.tracks.some(t=>t.keyframes.some(k=>k.timeMs>n)))throw new Error('Duration would discard keyframes');c.durationMs=n}
    if(p.delayMs!==undefined)c.delayMs=num(p.delayMs,'delayMs',0,1e6)
    if(p.repeat!==undefined){if(!['once','loop','alternate'].includes(String(p.repeat)))throw new Error('Invalid repeat');c.repeat=p.repeat as AnimationClip['repeat']}
    return copy(c)
  }),
  tool('animation.delete','Delete one authored animation clip.',true,{id:S},['id'],(d,p)=>{const c=clip(d,p.id);d.animations=d.animations!.filter(x=>x.id!==c.id);return {id:c.id}}),
  tool('animation.keyframe.record','Record current authored node poses into a clip at a time; replaces same-time keys.',true,{id:S,nodeIds:nodes,timeMs:{type:'number',minimum:0,maximum:1e6},easing:{type:'object'},descendants:{type:'boolean'}},['id','nodeIds','timeMs'],(d,p)=>{
    const c=clip(d,p.id);if(p.descendants!==undefined&&typeof p.descendants!=='boolean')throw new Error('Invalid descendants')
    recordKeyframe(d,c,ids(d,p.nodeIds,c.pageId),num(p.timeMs,'timeMs',0,c.durationMs),easing(p.easing),p.descendants!==false);return copy(c)
  }),
  tool('animation.keyframe.remove','Remove an exact-time keyframe; refuses to leave a track empty.',true,{id:S,nodeId:S,timeMs:{type:'number',minimum:0,maximum:1e6}},['id','nodeId','timeMs'],(d,p)=>{
    const c=clip(d,p.id),t=c.tracks.find(t=>t.nodeId===p.nodeId);if(!t)throw new Error('Track not found')
    const at=t.keyframes.findIndex(k=>k.timeMs===num(p.timeMs,'timeMs',0,c.durationMs));if(at<0)throw new Error('Keyframe not found');if(t.keyframes.length===1)throw new Error('Cannot empty a track');t.keyframes.splice(at,1);return copy(c)
  }),
  tool('review.list','Read local comments/annotations; no remote publishing.',false,{pageId:S,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},[],(d,p)=>{
    const offset=num(p.offset??0,'offset',0,1e6),limit=num(p.limit??50,'limit',1,100);if(!Number.isInteger(offset)||!Number.isInteger(limit))throw new Error('Invalid pagination')
    const rows=(d.reviews??[]).filter(r=>p.pageId===undefined||r.pageId===p.pageId);return{items:copy(rows.slice(offset,offset+limit)),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null}
  }),
  tool('review.create','Create a local automation-authored comment or annotation. Never impersonates a human author.',true,{pageId:S,nodeId:S,x:{type:'number'},y:{type:'number'},text,kind:{enum:['comment','annotation']}},['pageId','x','y','text'],(d,p)=>{
    const pageId=page(d,p.pageId).id;if(p.nodeId!==undefined)ids(d,[p.nodeId],pageId)
    const kind=p.kind??'comment';if(kind!=='comment'&&kind!=='annotation')throw new Error('Invalid review kind')
    if((d.reviews?.length??0)>=2000)throw new Error('Review limit reached')
    const r:LocalReview={id:uid(),pageId,...(p.nodeId?{nodeId:String(p.nodeId)}:{}),position:{x:num(p.x,'x',-1e7,1e7),y:num(p.y,'y',-1e7,1e7)},kind,resolved:false,messages:[{id:uid(),author:'Automation',text:str(p.text,'text',10000),createdAt:Date.now()}]}
    ;(d.reviews??=[]).push(r);d.schemaVersion=Math.max(d.schemaVersion,10) as DesignDocument['schemaVersion'];return copy(r)
  }),
  tool('review.reply','Append an automation-authored message to a local review.',true,{id:S,text},['id','text'],(d,p)=>{const r=reviews(d,p.id);if(r.messages.length>=1000)throw new Error('Message limit reached');const m={id:uid(),author:'Automation',text:str(p.text,'text',10000),createdAt:Date.now()};r.messages.push(m);return copy(m)}),
  tool('review.resolve','Set the resolved state of a local review.',true,{id:S,resolved:{type:'boolean'}},['id','resolved'],(d,p)=>{const r=reviews(d,p.id);if(typeof p.resolved!=='boolean')throw new Error('Invalid resolved');r.resolved=p.resolved;return copy(r)}),
  tool('review.delete','Delete a local review through undoable document transaction.',true,{id:S},['id'],(d,p)=>{const r=reviews(d,p.id);d.reviews=d.reviews!.filter(x=>x.id!==r.id);return{id:r.id}}),
]
