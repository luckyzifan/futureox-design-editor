import { expect, test, vi } from 'vitest'
import { rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { prefixRationalUnsupported } from './prefix-preflight'
import { WebGpuDriver } from './webgpu'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

function metadata(count: number, high = 0) {
  const bytes = new Uint8Array(16 + count * 4)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, count, true)
  if (count) view.setUint32(16 + (count - 1) * 4, high, true)
  return bytes
}
test('matches shader reason4 across coefficient widths and the exact 95-bit boundary', () => {
  for (let count = 1; count <= 44; count++) for (const high of [0, 1, 0x80000000, 0xffffffff]) {
    const bytes = metadata(count, high)
    expect(prefixRationalUnsupported(bytes)).toBe(count > 4 || count === 4 && high !== 0)
  }
  expect(prefixRationalUnsupported(metadata(3, 0x80000000))).toBe(false) // highest bit95
  expect(prefixRationalUnsupported(metadata(4, 1))).toBe(true) // highest bit96
})
test('handles subarray offsets without alignment assumptions and never reads malformed bounds', () => {
  const input = metadata(4, 1), backing = new Uint8Array(input.length + 3)
  backing.set(input, 1)
  expect(prefixRationalUnsupported(backing.subarray(1, 1 + input.length))).toBe(true)
  for (let size = 0; size < 32; size++) expect(prefixRationalUnsupported(input.subarray(0, size))).toBe(false)
  expect(prefixRationalUnsupported(metadata(0))).toBe(false)
  for (const count of [0xffffffff, 0x40000000, 5]) {
    const invalid = new Uint8Array(20); new DataView(invalid.buffer).setUint32(0, count, true)
    expect(prefixRationalUnsupported(invalid)).toBe(false)
  }
})
test('current real WASM preserves eligible integer/binary fractions and detects futile fractional trials', () => {
  for (const radius of [32, 38.25948715209961, 48, 48.25, 48.5, 96, 128, 512, 513])
    expect(prefixRationalUnsupported(rational_tent_kernel_rgba(radius))).toBe(false)
  for (const radius of [48.1, 96.1, 96 * Math.SQRT2, 60.00000000000001])
    expect(prefixRationalUnsupported(rational_tent_kernel_rgba(radius))).toBe(true)
})
const policy = WebGpuDriver.prototype as unknown as {
  prefixPolicy: (u: Float32Array, channels: number, filter: {kind:'tent';radius:number}, kernel?: Texture) => boolean
}
test('preflight only narrows the rational path; unknown metadata and integer <=512 stay unchanged', () => {
  const driver = { prefix: {}, displayFilters: false }, u = new Float32Array(256); u[16] = 22
  const kernel = { prefixRationalUnsupported: true } as Texture
  for (const radius of [48, 96, 512]) expect(policy.prefixPolicy.call(driver, u, 15, {kind:'tent',radius}, kernel)).toBe(true)
  for (const radius of [48.1, 513]) expect(policy.prefixPolicy.call(driver, u, 15, {kind:'tent',radius}, kernel)).toBe(false)
  expect(policy.prefixPolicy.call(driver, u, 15, {kind:'tent',radius:48.1})).toBe(true)
  expect(policy.prefixPolicy.call(driver, u, 15, {kind:'tent',radius:48.1}, {prefixRationalUnsupported:false} as Texture)).toBe(true)
})
test('measured drag radius retains the same exactness, alpha and display guards', () => {
  const driver = { prefix: {}, displayFilters: false }, u = new Float32Array(256); u[16] = 22
  for (const radius of [32, 38.25948715209961]) {
    const filter = {kind:'tent' as const,radius}
    expect(policy.prefixPolicy.call(driver,u,15,filter,{prefixRationalUnsupported:false} as Texture)).toBe(true)
    expect(policy.prefixPolicy.call(driver,u,8,filter)).toBe(false)
    expect(policy.prefixPolicy.call({...driver,displayFilters:true},u,15,filter)).toBe(false)
  }
  for (const radius of [0,31.999999,NaN])
    expect(policy.prefixPolicy.call(driver,u,15,{kind:'tent',radius})).toBe(false)
  expect(policy.prefixPolicy.call(driver,u,15,{kind:'tent',radius:38.25948715209961},
    {prefixRationalUnsupported:true} as Texture)).toBe(false)
})
test('deterministic rejection occurs before scratch reservation even if scratch already exists', () => {
  const driver = Object.create(WebGpuDriver.prototype) as WebGpuDriver
  const internal = driver as unknown as {prefix: object}
  for (const scratchBytes of [0, 4194304]) {
    const reserveScratch=vi.fn(), canEncode=vi.fn()
    internal.prefix={scratchBytes,reserveScratch,canEncode}
    const u=new Float32Array(256);u[16]=22
    driver.prepareFilterPass({} as Texture,u,[{} as Texture,{prefixRationalUnsupported:true} as Texture],15,{kind:'tent',radius:48.1},Infinity)
    expect(reserveScratch).not.toHaveBeenCalled();expect(canEncode).not.toHaveBeenCalled()
  }
})
test('rejected pass reaches existing exact fallback without prefix dispatch', () => {
  const driver = Object.create(WebGpuDriver.prototype) as WebGpuDriver, encode=vi.fn(), fallback=new Error('existing bind path')
  Object.assign(driver,{prefix:{encode},closeOver(){},bind(){throw fallback}})
  const u=new Float32Array(256);u[16]=22
  expect(()=>driver.pass({} as Texture,u,[{} as Texture,{prefixRationalUnsupported:true} as Texture],undefined,15,{kind:'tent',radius:48.1})).toThrow(fallback)
  expect(encode).not.toHaveBeenCalled()
})
test('immutable coefficient texture carries proof through per-frame reuse without affecting other kernels', () => {
  const upload=vi.fn((_bytes:Uint8Array,width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}} as Texture))
  const driver={managed:true,uploadRgba8:upload} as unknown as Driver
  const renderer=new GpuRenderer(driver) as unknown as {filterKernel:(operator:string,radius:number,build:()=>Uint8Array)=>{texture:Texture}}
  const build=vi.fn(()=>rational_tent_kernel_rgba(48.1))
  const first=renderer.filterKernel('rational-tent',48.1,build)
  expect(first.texture.prefixRationalUnsupported).toBe(true)
  expect(renderer.filterKernel('rational-tent',48.1,build)).toBe(first)
  expect(build).toHaveBeenCalledTimes(1)
  expect(renderer.filterKernel('other',48.1,build).texture.prefixRationalUnsupported).toBeUndefined()
})
test('real kernel corpus agrees with independent little-endian BigInt denominator oracle', () => {
  for (let i=0;i<256;i++) {
    const radius=48+i*1.875+(i%3===0?0.1:0), bytes=rational_tent_kernel_rgba(radius)
    const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), count=d.getUint32(0,true)
    let denominator=0n
    for(let word=Math.min(count,4)-1;word>=0;word--) denominator=(denominator<<32n)|BigInt(d.getUint32((4+word)*4,true))
    expect(prefixRationalUnsupported(bytes)).toBe(count>4||denominator>=(1n<<96n))
  }
})
test('proof survives completed-frame immutable kernel cache reuse', () => {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE','1')
  try {
    const upload=vi.fn((_bytes:Uint8Array,width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}} as Texture))
    const driver={managed:true,uploadRgba8:upload,resourceEpoch:1,completedResourceEpoch:1} as unknown as Driver
    const renderer=new GpuRenderer(driver) as unknown as {
      filterKernel:(operator:string,radius:number,build:()=>Uint8Array)=>{texture:Texture};beginKernelFrame:()=>void
    }
    const build=vi.fn(()=>rational_tent_kernel_rgba(48.1))
    const first=renderer.filterKernel('rational-tent',48.1,build)
    renderer.beginKernelFrame()
    const next=renderer.filterKernel('rational-tent',48.1,build)
    expect(next.texture).toBe(first.texture);expect(next.texture.prefixRationalUnsupported).toBe(true)
    expect(build).toHaveBeenCalledTimes(1);expect(upload).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllEnvs() }
})
