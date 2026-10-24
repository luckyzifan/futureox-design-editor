import { afterEach, expect, test, vi } from 'vitest'
import { bindScenePlan, sceneIndex } from './scene-index'
import { referenceSceneIndex } from './scene-index-reference.test-helper'
import { compiled_scene_plan_json } from '../../generated/design-kernel/design_kernel'
import type { GpuScene } from './types'
const shape=(id:string,children:string[]=[],effects:any[]=[],matrix=[1,0,0,1,0,0])=>({id,children,effects,matrix,fills:[],strokes:[]})
afterEach(()=>vi.unstubAllEnvs())
test.each(['0','1'])('Rust topology, material references and filter capabilities match the independent prior oracle (clamp %s)', flag=>{
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX',flag)
  for(const radius of [0,1,31.999999999,32,32.000000001,2048,2048.000000001]) {
    const nodes:any={ root:shape('root',['group','sibling','absent']), group:shape('group',['blur','future']), sibling:shape('sibling'),
      blur:shape('blur',[],[{kind:'blur',radius,visible:true}]),
      future:shape('future',[],[{kind:'future-effect',visible:true}]),
      backdrop:shape('backdrop',[],[{kind:'background-blur',radius,visible:true}]),
      glass:shape('glass',[],[{kind:'glass',radius,visible:true,glass:{}}]),
      hidden:shape('hidden',[],[{kind:'unknown',visible:false}]),
      '2':shape('2'), '10':shape('10') }
    nodes.blur.fills=[{kind:'image',image:'same'}, {kind:'image',image:'same'}]
    nodes.sibling.strokes=[{paint:{kind:'image',image:'different'}}]
    nodes.sibling.textureReplay={paint:{kind:'image',image:'replay-owned-separately'}}
    const scene={roots:['root','backdrop','glass','missing-root'],nodes} as unknown as GpuScene
    const expected=referenceSceneIndex(scene), actual=sceneIndex(scene)
    expect(actual).toEqual(expected)
    expect(sceneIndex(scene)).toBe(actual)
  }
})
test('compiled plan is bound only to its exact node table and roots',()=>{
  const scene={roots:['a'],nodes:{a:shape('a')}} as unknown as GpuScene
  const plan=JSON.parse(compiled_scene_plan_json(JSON.stringify(scene)))
  expect(bindScenePlan(scene,plan)).toEqual(referenceSceneIndex(scene))
  expect(()=>bindScenePlan({...scene,roots:['other']},plan)).toThrow('identity')
  expect(()=>bindScenePlan({...scene,nodes:{}},plan)).toThrow('identity')
})
