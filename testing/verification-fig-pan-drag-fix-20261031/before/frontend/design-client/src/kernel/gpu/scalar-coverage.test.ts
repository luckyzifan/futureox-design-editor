import { expect, test } from 'vitest'
import { scalarCoverageSource, SCALAR_COVERAGE_UNIFORM } from './scalar-coverage'

test('each input sampler retains bounds handling and expands its own channel flag',()=>{
  const source=`fn at(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{let q=vec2<i32>(p);if(any(q<vec2<i32>(0))){return vec4<f32>(0);}return textureLoad(tex,q,0);}
fn smp(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{return at(tex,p,r);}
fn use()->vec4<f32>{return smp(sourceA,p,r)+at(sourceC,p,r);}`
  const result=scalarCoverageSource(source)
  expect(SCALAR_COVERAGE_UNIFORM).toBe(251)
  expect(result).toContain('u(62).w')
  expect(result).not.toContain('u(61).y')
  expect(result).toContain('return coverage_smp_A(p,r)+coverage_at_C(p,r)')
  for(const [i,slot] of ['A','B','C','D'].entries()){
    expect(result).toContain(`fn coverage_at_${slot}`)
    expect(result).toContain(`&${1<<i}u`)
    expect(result).toContain(`if((u32(u(62).w)&${1<<(i+4)}u)!=0u){return vec4<f32>(0);}`)
    expect(result).toContain(`return coverage_at_${slot}(p,r)`)
  }
  expect(result).toContain('return vec4<f32>(0)')
  expect(()=>scalarCoverageSource('fn unrelated() {}')).toThrow('Missing coverage sampler')
})
