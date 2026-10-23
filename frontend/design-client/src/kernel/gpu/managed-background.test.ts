import { expect, test } from 'vitest'
import vector from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import driverSource from './webgpu.ts?raw'
import { managedBackgroundEntryPoint, managedBackgroundWgsl } from './managed-background'
import { imageCoordinateSource } from './image-coordinate-source'
import { scalarCoverageSource } from './scalar-coverage'

// Textual provenance tests only. These do not compile WGSL, initialize a GPU,
// evaluate floating-point pixels, or establish portable NaN payload behavior.
function bodyAfter(source: string, marker: string) {
  const start = source.indexOf(marker)
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw Error(`Nonunique source marker ${marker}`)
  const begin = start + marker.length
  let depth = 1, end = begin
  while (end < source.length && depth) {
    if (source[end] === '{') depth++
    else if (source[end] === '}') depth--
    end++
  }
  if (depth) throw Error(`Incomplete source block ${marker}`)
  return source.slice(begin, end - 1)
}
function fn(source: string, name: string) {
  const marker = `fn ${name}(`, start = source.indexOf(marker)
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw Error(`Nonunique function ${name}`)
  const begin = source.indexOf('{', start)
  return source.slice(start, begin + 1) + bodyAfter(source, source.slice(start, begin + 1)) + '}'
}
const shade = fn(vector, 'shade'), originalOver = fn(vector, 'over')
const modeSelector = shade.slice(shade.indexOf('{') + 1, shade.indexOf(';') + 1)
const sample = 'let a=smp(sourceA,p,u(1));'
const normalEarlyOuts = originalOver.slice(originalOver.indexOf('{') + 1, originalOver.indexOf('if(mode==0){'))
const normalArm = bodyAfter(originalOver, 'if(mode==0){')
const originalBackground = bodyAfter(shade, 'if(mode==12){')
const originalNormalCall = 'over(bg,vec4<f32>(vec3<f32>(0.65,0.67,0.73)*alpha,alpha),0)'
const dedicatedNormalCall = 'managedBackgroundOverNormal(bg,vec4<f32>(vec3<f32>(0.65,0.67,0.73)*alpha,alpha))'

test.each([
  [true, false, undefined], [true, false, '0'], [true, false, 'true'],
  [false, false, '1'], [false, true, '1'], [true, true, '1'],
] as const)('mode12 entry remains original for managed=%s displayMath=%s flag=%s', (managed, displayMath, flag) => {
  expect(managedBackgroundEntryPoint(managed, displayMath, flag)).toBe('fragment')
})
test('only explicit managed exact opt-in selects the dedicated entry', () => {
  expect(managedBackgroundEntryPoint(true, false, '1')).toBe('managedBackgroundFragment')
  expect(managedBackgroundEntryPoint(true, false)).toBe('fragment')
})
test('normal helper contains the original alpha early-outs and complete mode0 arm verbatim', () => {
  expect(normalEarlyOuts).toBe('if(s.a<=0.){return b;}if(b.a<=0.){return s;}')
  expect(bodyAfter(managedBackgroundWgsl, 'fn managedBackgroundOverNormal(b:vec4<f32>,s:vec4<f32>)->vec4<f32>{'))
    .toBe(normalEarlyOuts + normalArm)
  expect(normalArm).toContain('if(u(60).x>0.5)')
  expect(normalArm).toContain('return s+b*(1.-s.a);')
})
test('dedicated shade retains mode select, original predispatch sampling and exact background ordering', () => {
  expect(shade).toContain(sample)
  expect(modeSelector).toBe('let mode=select(i32(u(4).x),COMPOSITOR_MODE,COMPOSITOR_MODE>=0);')
  expect(originalBackground.split(originalNormalCall)).toHaveLength(2)
  const expectedBody = modeSelector + sample + '\n if(mode==12){' +
    originalBackground.replace(originalNormalCall, dedicatedNormalCall) + '}\n return vec4<f32>(0);\n'
  expect(bodyAfter(managedBackgroundWgsl, 'fn managedBackgroundShade(p:vec2<f32>)->vec4<f32>{')).toBe(expectedBody)
})
test('fragment wrapper is byte-identical except for its entry and shade callee names', () => {
  expect(fn(managedBackgroundWgsl, 'managedBackgroundFragment')).toBe(fn(vector, 'fragment')
    .replace('fn fragment(', 'fn managedBackgroundFragment(')
    .replace('value=shade(', 'value=managedBackgroundShade('))
  const wrapper = fn(managedBackgroundWgsl, 'managedBackgroundFragment')
  expect(wrapper).toContain('let mode=i32(u(4).x);')
  expect(wrapper).toContain('mode!=15&&mode!=16&&mode!=44')
  expect(wrapper).toContain('if(u(60).z>0.5){return displayColor(value);}')
})
test('candidate entry has no giant shade or non-normal blend call dependency', () => {
  expect(managedBackgroundWgsl).not.toMatch(/\b(?:shade|over|blendRN|channel|setLum|setSat)\(/)
  expect(managedBackgroundWgsl).toContain('COMPOSITOR_MODE')
  expect(managedBackgroundWgsl).toContain('addRN4(s,mulRN4(b,vec4<f32>(addRN(1.,-s.a))))')
  expect(managedBackgroundWgsl).toContain(sample)
})
test('original image/scalar transforms retain the candidate sourceA sample and its shared sampler', () => {
  const transformed = scalarCoverageSource(imageCoordinateSource(vector + managedBackgroundWgsl))
  const dedicated = fn(transformed, 'managedBackgroundShade')
  expect(dedicated).toContain('let a=coverage_smp_A(p,u(1));')
  expect(dedicated.indexOf('let a=coverage_smp_A(p,u(1));')).toBeLessThan(dedicated.indexOf('if(mode==12){'))
  expect(fn(transformed, 'managedBackgroundFragment')).toBe(fn(managedBackgroundWgsl, 'managedBackgroundFragment'))
  expect(fn(transformed, 'managedBackgroundOverNormal')).toBe(fn(managedBackgroundWgsl, 'managedBackgroundOverNormal'))
  expect(transformed).toContain('fn coverage_smp_A(')
})
test('driver appends only under the same entry gate and changes only paint registry entry selection', () => {
  expect(driverSource).toContain("const paintEntryPoint = managedBackgroundEntryPoint(this.managed, this.displayMath, import.meta.env.VITE_DESIGN_MANAGED_MODE12_ENTRY)")
  expect(driverSource).toContain("vectorShader + (paintEntryPoint === 'managedBackgroundFragment' ? managedBackgroundWgsl : '')")
  expect(driverSource.match(/entryPoint: paintEntryPoint/g)).toHaveLength(1)
  expect(driverSource).toContain("fragment: { module, entryPoint: paintEntryPoint, ...(this.managed ? { constants: { COMPOSITOR_MODE: 12 } } : {}), targets: [{ format: this.layerFormat }] }")
  expect(driverSource).toContain('if (this.managed) this.modePipelines.set(12, this.paintPipeline)')
  expect(driverSource).toContain("fragment:{module,entryPoint:'fragment',constants:{COMPOSITOR_MODE:mode},targets:[{format:'r32float'}]}")
})
