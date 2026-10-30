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
    const {sampleIndependentNodes,...priorFields}=actual
    expect(priorFields).toEqual(expected)
    expect(sceneIndex(scene)).toBe(actual)
  }
})
test('compiled plan is bound only to its exact node table and roots',()=>{
  const scene={roots:['a'],nodes:{a:shape('a')}} as unknown as GpuScene
  const plan=JSON.parse(compiled_scene_plan_json(JSON.stringify(scene)))
  const {sampleIndependentNodes,...priorFields}=bindScenePlan(scene,plan)
  expect(priorFields).toEqual(referenceSceneIndex(scene))
  expect(sampleIndependentNodes).toEqual(new Set(['a']))
  expect(()=>bindScenePlan({...scene,roots:['other']},plan)).toThrow('identity')
  expect(()=>bindScenePlan({...scene,nodes:{}},plan)).toThrow('identity')
})

test('Rust owns sample independence across masks, hidden effects, missing children and nested dependencies',()=>{
  const nodes:any={root:shape('root',['plain','nested','missing']),plain:shape('plain'),nested:shape('nested',['effect']),
    effect:shape('effect',[],[{kind:'blur',visible:false}]),detached:shape('detached')}
  const scene=()=>({roots:['root'],nodes:structuredClone(nodes)}) as unknown as GpuScene
  expect(sceneIndex(scene()).sampleIndependentNodes).toEqual(new Set(Object.keys(nodes)))
  for(const patch of [{clip:true},{mask:true},{maskId:'mask-owner'},{passthrough:true},{effects:[{kind:'blur',visible:true}]}]) {
    const changed=scene();Object.assign(changed.nodes.effect,patch)
    expect(sceneIndex(changed).sampleIndependentNodes).toEqual(new Set(['plain','detached']))
  }
})

test('immutable native plans reuse logical topology while each frame binds its own sources',()=>{
  const a={roots:['a'],nodes:{a:shape('a')}} as unknown as GpuScene
  const plan=JSON.parse(compiled_scene_plan_json(JSON.stringify(a)))
  const freeze=(v:any)=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v)}}
  freeze(plan)
  const b={roots:['a'],nodes:{a:shape('a')}} as unknown as GpuScene
  const x=bindScenePlan(a,plan),y=bindScenePlan(b,plan)
  expect(x.parents).toBe(y.parents);expect(x.rootFor).toBe(y.rootFor)
  expect(x.sources).not.toBe(y.sources)
  expect(y.sources.has(b.nodes.a)).toBe(true);expect(y.sources.has(a.nodes.a)).toBe(false)
})
