import {afterEach,expect,test,vi} from 'vitest'
import {blank,node,paint,defaultLayout,type DesignDocument,type Matrix} from '../model'
import {VectorEngine} from '../generated/design-kernel/design_kernel'
import {kernelLayout} from './picking'

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
function fixture(){
 const doc=blank('native mask pose'),frame=node('frame',0,0,240,180),mask=node('rectangle',20,30,60,40),content=node('rectangle',0,0,200,160),master=node('frame',300,0,40,40)
 doc.schemaVersion=21
 frame.children=[mask.id,content.id];mask.mask=true;mask.maskType='alpha';mask.fills=[paint('#ffffff')];content.fills=[paint('#13895b')]
 mask.constraints={horizontal:'scale',vertical:'center',referenceWidth:240,referenceHeight:180};master.component={variants:{},properties:{}}
 doc.nodes=Object.fromEntries([frame,mask,content,master].map(n=>[n.id,n]));doc.pages[0].children=[frame.id,master.id]
 return{doc,frame,mask}
}
function raster(document:DesignDocument){
 const engine=new VectorEngine()
 try{engine.load_document(JSON.stringify(document));return engine.render_rgba(JSON.stringify({pageId:document.pages[0].id,width:240,height:180,view:{x:.125,y:.375,zoom:1},transparent:false,rasterProfile:'analytic'}))}
 finally{engine.free()}
}
test('native mask pose preserves authored shape and matches complete layout and CPU rendering',()=>{
 const f=fixture(),before=kernelLayout(f.doc),angle=.63,c=Math.cos(angle),s=Math.sin(angle),transform:Matrix=[c,s,-s,c,42,35]
 const input={...before,nodes:{...before.nodes,[f.mask.id]:{...before.nodes[f.mask.id],transform}}}
 const pose=vi.spyOn(VectorEngine.prototype,'resolve_components_pose_patch'),full=vi.spyOn(VectorEngine.prototype,'resolve_components_full'),regular=vi.spyOn(VectorEngine.prototype,'resolve_components_patch')
 const result=kernelLayout(input,before,true)
 expect(pose).toHaveBeenCalledOnce();expect(full).not.toHaveBeenCalled();expect(regular).not.toHaveBeenCalled();expect(result).toBe(input)
 vi.stubEnv('VITE_DESIGN_COMPONENT_POSE','0');const oracle=kernelLayout(structuredClone(input))
 expect(pose).toHaveBeenCalledOnce();expect(result).toEqual(oracle);expect(raster(result)).toEqual(raster(oracle));expect(raster(result)).not.toEqual(raster(before))
})
test('changed JavaScript node shape retains the normal defaulting and resolution path',()=>{
 const f=fixture(),before=kernelLayout(f.doc)
 const input={...before,nodes:{...before.nodes,[f.frame.id]:{...before.nodes[f.frame.id],layout:{mode:'horizontal'} as ReturnType<typeof defaultLayout>}}}
 const pose=vi.spyOn(VectorEngine.prototype,'resolve_components_pose_patch');vi.stubEnv('VITE_DESIGN_COMPONENT_POSE','1')
 const result=kernelLayout(input,before,true)
 expect(pose).not.toHaveBeenCalled();expect(result.nodes[f.frame.id].layout?.gap).toBe(defaultLayout().gap)
 vi.stubEnv('VITE_DESIGN_COMPONENT_POSE','0');expect(result).toEqual(kernelLayout(structuredClone(input)))
})
test('a stale native pose receipt falls back and a malformed response cannot certify an edit',()=>{
 const f=fixture(),before=kernelLayout(f.doc),input={...before,nodes:{...before.nodes,[f.mask.id]:{...before.nodes[f.mask.id],transform:[0,1,-1,0,80,30] as Matrix}}}
 vi.stubEnv('VITE_DESIGN_COMPONENT_POSE','1')
 const pose=vi.spyOn(VectorEngine.prototype,'resolve_components_pose_patch').mockImplementationOnce(()=>{throw 'DERIVED_STATE_STALE'})
 const result=kernelLayout(input,before,true);expect(result.nodes[f.mask.id].transform).toEqual(input.nodes[f.mask.id].transform)
 const ready=kernelLayout(result)
 const next={...ready,nodes:{...ready.nodes,[f.mask.id]:{...ready.nodes[f.mask.id],transform:[0,1,-1,0,81,30] as Matrix}}}
 pose.mockImplementationOnce(()=>JSON.stringify({receipt:1,stats:{pose:true},nodes:{unexpected:{}},removed:[]}))
 expect(()=>kernelLayout(next,ready,true)).toThrow('无效的变换派生回执')
})
