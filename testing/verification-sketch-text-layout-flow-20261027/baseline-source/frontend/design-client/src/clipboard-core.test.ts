/** Source-only fixtures. Not run in this candidate. Install alongside core. */
import {test,expect,vi,afterEach} from 'vitest'
import {blank,node,paint,defaultTextStyle} from './model'
import {guardPurePlanner} from './clipboard-invariants'
import {emptySystem} from './design-system'
guardPurePlanner()
import {PROPERTY_PREFIX} from './property-clipboard'
import {captureNodeGraph,serializeNodePacket,parsePortablePacket,planNodePaste,serializePropertyPacket,parsePropertyPacket,planPropertyPaste,MAX_PACKET_BYTES} from './clipboard-core'
function fixture(){const document=blank(),a=node('rectangle',10,20,30,40);document.nodes[a.id]=a;document.pages[0].children=[a.id];return {document,a}}
afterEach(()=>vi.unstubAllGlobals())
test('export closure excludes unrelated text, page and font; capture is detached',()=>{
 const {document,a}=fixture(),secret=node('text',0,0,5,5);secret.text='PRIVATE_NOT_SELECTED';document.nodes[secret.id]=secret;document.pages[0].children.push(secret.id)
 const encoded=serializeNodePacket(document,[a.id,a.id]);expect(encoded).not.toContain(secret.text);expect(encoded).not.toContain(secret.id)
 const graph=captureNodeGraph(document,[a.id]);graph.nodes[a.id].name='changed';graph.document.name='changed';expect(document.nodes[a.id].name).not.toBe('changed');expect(document.name).not.toBe('changed')
})
test('ancestor normalization and explicit page-root here/inPlace preserve input',()=>{
 const {document,a}=fixture(),child=node('rectangle',1,2,3,4);a.children=[child.id];a.kind='group';document.nodes[child.id]=child
 expect(captureNodeGraph(document,[child.id,a.id,a.id]).roots).toEqual([a.id])
 a.children=[];delete document.nodes[child.id];a.kind='rectangle'
 const packet=serializeNodePacket(document,[a.id]),target=blank(),before=JSON.stringify(target)
 const plan=planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'here',position:{x:100,y:200}})
 expect(plan.candidate.nodes[plan.createdRoots[0]].transform.slice(4)).toEqual([100,200]);expect(JSON.stringify(target)).toBe(before);expect(plan.nativeAdmissionRequired).toBe(true)
 expect(()=>planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'inPlace',position:{x:1,y:2}} as any)).toThrow()
 expect(()=>planNodePaste(target,packet,{pageId:'missing',mode:'inPlace'})).toThrow()
})
test.each(['sourceSession','owner','grant','url','handle'])('portable envelope rejects %s capability/indirection',key=>{
 const {document,a}=fixture(),packet=JSON.parse(serializeNodePacket(document,[a.id]));packet[key]='forged';expect(()=>parsePortablePacket(JSON.stringify(packet))).toThrow()
})
test('reject cyclic ownership, duplicate roots, deep unknown fields and bytes before native admission',()=>{
 const {document,a}=fixture(),packet=JSON.parse(serializeNodePacket(document,[a.id]))
 packet.roots.push(a.id);expect(()=>parsePortablePacket(JSON.stringify(packet))).toThrow();packet.roots.pop()
 packet.document.nodes[a.id].children=[a.id];expect(()=>parsePortablePacket(JSON.stringify(packet))).toThrow()
 expect(()=>parsePortablePacket(' '.repeat(MAX_PACKET_BYTES+1))).toThrow(/32 MiB/)
 expect(()=>parsePortablePacket('{"extra":'+ '['.repeat(257)+'0'+']'.repeat(257)+'}')).toThrow(/deep/)
})
test('property carrier rejects hidden text, prototypes, animation and extra dictionaries',()=>{
 const {document,a}=fixture();a.kind='text';a.text='PRIVATE SOURCE';const encoded=serializePropertyPacket(document,[a.id]);expect(encoded).not.toContain(a.text);expect(()=>parsePropertyPacket(encoded)).not.toThrow()
 for(const mutate of [(v:any)=>v.document.nodes[Object.keys(v.document.nodes)[0]].text='hidden', (v:any)=>v.document.prototype={interactions:{}}, (v:any)=>v.document.animations=[]]){
  const value=JSON.parse(encoded.slice(PROPERTY_PREFIX.length));mutate(value);expect(()=>parsePropertyPacket(PROPERTY_PREFIX+JSON.stringify(value))).toThrow()
 }
})
test('properties preserve target text/geometry and reject second locked target atomically',()=>{
 const source=fixture();source.a.fills=[paint('#abcdef')];const packet=serializePropertyPacket(source.document,[source.a.id]);const target=fixture(),b=node('text',1,2,30,40);b.text='KEEP';target.document.nodes[b.id]=b;target.document.pages[0].children.push(b.id)
 const planned=planPropertyPaste(target.document,packet,[b.id]);expect(planned.candidate.nodes[b.id].text).toBe('KEEP');expect(planned.candidate.nodes[b.id].transform).toEqual(b.transform)
 b.locked=true;const before=JSON.stringify(target.document);expect(()=>planPropertyPaste(target.document,packet,[target.a.id,b.id])).toThrow(/Locked/);expect(JSON.stringify(target.document)).toBe(before)
})
test('property target multiplication is bounded without partial dependency insertion',()=>{
 const source=fixture();source.a.fills=[paint('#abcdef')];const packet=serializePropertyPacket(source.document,[source.a.id]),target=fixture()
 expect(()=>planPropertyPaste(target.document,packet,Array(65).fill(target.a.id))).toThrow()
 expect(()=>planPropertyPaste(target.document,packet,[target.a.id,target.a.id])).toThrow()
})
test('planning never reads OS clipboard or fetches a URL',()=>{
 const fail=vi.fn(()=>{throw Error('Forbidden IO')});vi.stubGlobal('fetch',fail);vi.stubGlobal('navigator',{clipboard:{readText:fail,writeText:fail}})
 const {document,a}=fixture(),target=blank(),packet=serializeNodePacket(document,[a.id]);planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'inPlace'});expect(fail).not.toHaveBeenCalled()
})
test('forged matching document ID cannot reuse a different target component',()=>{
 const source=fixture();source.a.kind='frame';source.a.component={variants:{},properties:{}};source.a.fills=[paint('#abcdef')]
 const target=structuredClone(source.document);target.nodes[source.a.id].fills=[paint('#000000')]
 const value=JSON.parse(serializeNodePacket(source.document,[source.a.id]));value.document.id=target.id;const packet=JSON.stringify(value),before=JSON.stringify(target)
 const plan=planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'inPlace'}),created=plan.candidate.nodes[plan.createdRoots[0]]
 expect(created.instance!.componentId).not.toBe(source.a.id);expect(plan.candidate.nodes[created.instance!.componentId].fills).toEqual(source.a.fills)
 expect(JSON.stringify(target)).toBe(before);expect(JSON.stringify(value)).toBe(packet)
})
test('matching document ID still rejects same font ID with different bytes without changing target',()=>{
 const source=fixture();source.a.kind='text';source.a.text='Font';source.a.textStyle={...defaultTextStyle(),fontId:'test-font'}
 source.document.fonts={'test-font':{family:'Test',data:'AA=='}}
 const value=JSON.parse(serializeNodePacket(source.document,[source.a.id])),target=blank();target.fonts={'test-font':{family:'Test',data:'AQ=='}};value.document.id=target.id
 const before=JSON.stringify(target);expect(()=>planNodePaste(target,JSON.stringify(value),{pageId:target.pages[0].id,mode:'inPlace'})).toThrow(/字体标识冲突/);expect(JSON.stringify(target)).toBe(before)
})
test('matching document ID does not resolve a source variable to target contents',()=>{
 const source=fixture();source.document.schemaVersion=6;source.document.designSystem={...emptySystem(),collections:{colors:{name:'Colors',modes:['Light'],defaultMode:'Light'}},variables:{brand:{name:'Brand',kind:'color',collection:'colors',values:{Light:'#abcdef'}}},styles:{},activeModes:{colors:'Light'}}
 source.a.bindings={'fills.0.color':'brand'};const target=structuredClone(source.document);target.designSystem!.variables.brand.values.Light='#000000'
 const value=JSON.parse(serializeNodePacket(source.document,[source.a.id]));value.document.id=target.id
 const plan=planNodePaste(target,JSON.stringify(value),{pageId:target.pages[0].id,mode:'inPlace'}),created=plan.candidate.nodes[plan.createdRoots[0]],binding=created.bindings!['fills.0.color']
 expect(binding).not.toBe('brand');expect(plan.candidate.designSystem!.variables[binding].values.Light).toBe('#abcdef');expect(target.designSystem!.variables.brand.values.Light).toBe('#000000')
})
test('actual style payload multiplied across distinct targets fails before applying',()=>{
 const source=fixture();source.a.fills=[{...paint('#ffffff'),kind:'image',image:'data:image/png;base64,'+'A'.repeat(1024*1024)}]
 const packet=serializePropertyPacket(source.document,[source.a.id]),target=blank(),targets:string[]=[]
 for(let i=0;i<33;i++){const n=node('rectangle',i,0,1,1);target.nodes[n.id]=n;target.pages[0].children.push(n.id);targets.push(n.id)}
 const before=JSON.stringify(target);expect(()=>planPropertyPaste(target,packet,targets)).toThrow(/expansion/);expect(JSON.stringify(target)).toBe(before)
})
test('packet byte budget counts UTF-8 rather than UTF-16 character length',()=>{
 expect(()=>parsePortablePacket('中'.repeat(Math.floor(MAX_PACKET_BYTES/3)+1))).toThrow(/32 MiB/)
})

test('scene order wins over caller ID order; unrelated document metadata is rejected',()=>{
 const {document,a}=fixture(),b=node('rectangle',30,0,10,10);document.nodes[b.id]=b;document.pages[0].children.push(b.id)
 expect(captureNodeGraph(document,[b.id,a.id]).roots).toEqual([a.id,b.id])
 const value=JSON.parse(serializeNodePacket(document,[a.id]));value.document.nodes[b.id]=b;value.document.pages[0].children.push(b.id)
 expect(()=>parsePortablePacket(JSON.stringify(value))).toThrow(/minimal/)
})
test('here rejects groups rather than trusting stale nominal bounds',()=>{
 const {document,a}=fixture();a.kind='group';const packet=serializeNodePacket(document,[a.id]),target=blank()
 expect(()=>planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'here',position:{x:0,y:0}})).toThrow(/Unsupported/)
})
test('matching document ID cannot bind an imported style to different target style contents',()=>{
 const source=fixture();source.document.schemaVersion=6;source.document.designSystem=emptySystem();source.document.designSystem.styles.brand={name:'Brand',kind:'paint',value:[paint('#abcdef')]};source.a.styleRefs={fills:'brand'}
 const target=structuredClone(source.document);target.designSystem!.styles.brand.value=[paint('#000000')]
 const value=JSON.parse(serializeNodePacket(source.document,[source.a.id]));value.document.id=target.id
 const before=JSON.stringify(target),packet=JSON.stringify(value),plan=planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'inPlace'}),style=plan.candidate.nodes[plan.createdRoots[0]].styleRefs!.fills
 expect(style).not.toBe('brand');expect(plan.candidate.designSystem!.styles[style].value).toEqual(source.document.designSystem!.styles.brand.value);expect(JSON.stringify(target)).toBe(before);expect(JSON.stringify(value)).toBe(packet)
})

test('portable root budget rejects before document/dependency validation or planning',()=>{
 const packet=JSON.stringify({format:'forma-nodes',version:1,roots:Array.from({length:65},()=>crypto.randomUUID()),document:{fonts:{untrusted:'not admitted'}}})
 expect(()=>parsePortablePacket(packet)).toThrow(/at most 64 roots/)
 const target=blank(),before=JSON.stringify(target);expect(()=>planNodePaste(target,packet,{pageId:target.pages[0].id,mode:'inPlace'})).toThrow(/at most 64 roots/);expect(JSON.stringify(target)).toBe(before)
})
