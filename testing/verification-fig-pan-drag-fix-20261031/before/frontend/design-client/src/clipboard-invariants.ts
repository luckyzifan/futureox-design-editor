import {beforeEach,afterEach,expect,vi} from 'vitest'
import {node} from './model'
import {pickingGeometryEpoch,kernelTextLayout} from './kernel/picking'
import {VectorEngine} from './generated/design-kernel/design_kernel'
/** Setup initializes the real existing kernel once. During every candidate test,
 * fail BEFORE any font/scene installation, and independently compare resident
 * font shaping and the opaque geometry epoch before/after. No engine edits. */
export function guardPurePlanner(){
 let epoch:object,shape:string,probe:ReturnType<typeof node>
 let restore:Array<()=>void>=[],called:Array<()=>number>=[]
 beforeEach(()=>{
  probe=node('text',0,0,240,30);probe.text='Font probe Aa 中文';epoch=pickingGeometryEpoch();shape=JSON.stringify(kernelTextLayout(probe))
  for(const method of ['load_document_fonts','load_font','load_document'] as const){
   const spy=vi.spyOn(VectorEngine.prototype,method).mockImplementation(()=>{throw Error('Pure planner attempted global font/scene mutation')})
   restore.push(()=>spy.mockRestore());called.push(()=>spy.mock.calls.length)
  }
 })
 afterEach(()=>{try{expect(called.map(count=>count())).toEqual([0,0,0]);expect(pickingGeometryEpoch()).toBe(epoch);expect(JSON.stringify(kernelTextLayout(probe))).toBe(shape)}finally{restore.forEach(fn=>fn());restore=[];called=[]}})
}
export function freezeSnapshot<T>(value:T):T {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freezeSnapshot(child)}return value}
