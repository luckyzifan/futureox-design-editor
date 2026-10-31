import {expect,test} from 'vitest'
import {blank,node,paint,defaultTextStyle,type DesignDocument} from './model'
import {createClip} from './animation'
import {componentFixture} from './component-fixtures'
import {emptySystem} from './design-system'
import {guardPurePlanner,freezeSnapshot} from './clipboard-invariants'
import {captureNodeGraph,serializeNodePacket,parsePortablePacket,planNodePaste,serializePropertyPacket,parsePropertyPacket,planPropertyPaste} from './clipboard-core'
guardPurePlanner()
function roundtrip(source:DesignDocument,ids:string[]){
 const target=blank(),sourceJson=JSON.stringify(source),targetJson=JSON.stringify(target);freezeSnapshot(source);freezeSnapshot(target)
 const graph=captureNodeGraph(source,ids),encoded=serializeNodePacket(source,ids),parsed=parsePortablePacket(encoded)
 const plan=planNodePaste(target,encoded,{pageId:target.pages[0].id,mode:'inPlace'})
 expect(plan.nativeAdmissionRequired).toBe(true);expect(JSON.stringify(source)).toBe(sourceJson);expect(JSON.stringify(target)).toBe(targetJson)
 expect(parsed.roots.length).toBe(graph.roots.length);expect(plan.createdRoots.every(id=>!!plan.candidate.nodes[id])).toBe(true)
 return {parsed,plan,encoded}
}
test('own node export parses and plans a basic detached carrier',()=>{
 const source=blank(),a=node('rectangle',10,20,30,40);source.nodes[a.id]=a;source.pages[0].children=[a.id];roundtrip(source,[a.id])
})
test('own nested animation export roundtrips wrapper placement without changing keyframes',()=>{
 const source=blank(),parent=node('frame',100,200,400,400),child=node('rectangle',10,20,30,40);source.schemaVersion=5
 parent.transform=[2,.4,.3,1.5,100,200];parent.children=[child.id];source.nodes={[parent.id]:parent,[child.id]:child};source.pages[0].children=[parent.id]
 const clip=createClip(source,source.pages[0].id,[child.id]);clip.tracks[0].keyframes[1].value.transform=[1,0,0,1,80,50];source.animations=[clip]
 const {parsed,plan}=roundtrip(source,[child.id]);expect(parsed.document.animations![0].tracks[0].keyframes).toEqual(clip.tracks[0].keyframes)
 expect(plan.candidate.animations![0].tracks[0].keyframes).toEqual(clip.tracks[0].keyframes);expect(parsed.roots[0]).not.toBe(child.id)
})
test('own component instance export roundtrips definitions, keys and nested references',()=>{
 const {doc,ids}=componentFixture();const {parsed,plan}=roundtrip(doc,[ids.a])
 const sourceRoot=parsed.nodes[parsed.roots[0]];expect(sourceRoot.instance).toBeTruthy()
 expect(parsed.document.nodes[sourceRoot.instance!.componentId].component).toBeTruthy()
 const pasted=plan.candidate.nodes[plan.createdRoots[0]];expect(plan.candidate.nodes[pasted.instance!.componentId].component).toBeTruthy()
})
test('own style/variable export roundtrips only reachable dependencies',()=>{
 const source=blank(),a=node('rectangle',0,0,30,40);source.schemaVersion=6;source.nodes[a.id]=a;source.pages[0].children=[a.id];source.designSystem=emptySystem()
 source.designSystem.collections.theme={name:'Theme',modes:['Light','Dark'],defaultMode:'Light'};source.designSystem.activeModes.theme='Dark'
 source.designSystem.variables.color={name:'Color',collection:'theme',kind:'color',values:{Light:'#aabbcc',Dark:'#ddeeff'}}
 source.designSystem.variables.secret={name:'Unrelated',collection:'theme',kind:'color',values:{Light:'#000000',Dark:'#000000'}}
 source.designSystem.styles.brand={name:'Brand',kind:'paint',value:[paint('#aabbcc')]}
 source.designSystem.styles.unrelated={name:'Unrelated style',kind:'paint',value:[paint('#000000')]}
 a.bindings={'fills.0.color':'color'};a.styleRefs={fills:'brand'};a.variableModes={theme:'Dark'}
 const {parsed,encoded}=roundtrip(source,[a.id]);expect(Object.keys(parsed.document.designSystem!.variables)).toEqual(['color']);expect(Object.keys(parsed.document.designSystem!.styles)).toEqual(['brand']);expect(encoded).not.toContain('Unrelated')
})
test('all property helpers and failure paths preserve frozen snapshots and global font state',()=>{
 const source=blank(),a=node('text',0,0,100,20);a.text='SOURCE PRIVATE';a.textStyle=defaultTextStyle();source.nodes[a.id]=a;source.pages[0].children=[a.id]
 const target=blank(),b=node('text',10,20,50,20),locked=node('rectangle',30,40,10,10);b.text='TARGET';locked.locked=true;target.nodes={[b.id]:b,[locked.id]:locked};target.pages[0].children=[b.id,locked.id]
 const before=[JSON.stringify(source),JSON.stringify(target)];freezeSnapshot(source);freezeSnapshot(target)
 const packet=serializePropertyPacket(source,[a.id]),parsed=parsePropertyPacket(packet),plan=planPropertyPaste(target,packet,[b.id]);expect(parsed.node.text).toBe('X');expect(plan.candidate.nodes[b.id].text).toBe('TARGET')
 expect(()=>planPropertyPaste(target,packet,[b.id,locked.id])).toThrow(/Locked/);expect(()=>parsePortablePacket('{')).toThrow()
 expect(()=>planNodePaste(target,serializeNodePacket(source,[a.id]),{pageId:'missing',mode:'inPlace'})).toThrow()
 expect([JSON.stringify(source),JSON.stringify(target)]).toEqual(before)
})
