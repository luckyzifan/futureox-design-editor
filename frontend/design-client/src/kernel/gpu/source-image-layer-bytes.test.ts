import { expect, test, vi } from 'vitest'
import { sourceImageLayerWgsl, sourceLayerWgsl } from './source-layer-shader'
import { SOURCE_IMAGE_LAYER_MODE, noteHostedSourceImageLayer } from './source-layer'
import type { Texture } from './types'
import { WebGpuDriver } from './webgpu'

function body(source: string, name: string) {
  const marker = `fn ${name}(`
  const start = source.indexOf(marker)
  expect(start, name).toBeGreaterThanOrEqual(0)
  expect(source.indexOf(marker, start + marker.length), name).toBe(-1)
  const open = source.indexOf('{', start)
  let end = open + 1
  let depth = 1
  while (end < source.length && depth) {
    if (source[end] === '{') depth++
    else if (source[end] === '}') depth--
    end++
  }
  expect(depth, name).toBe(0)
  return source.slice(open + 1, end - 1)
}

test('the source image layer samples straight RGBA8 from rgba8uint', () => {
  expect(sourceLayerWgsl).not.toContain('sourceBytes')
  expect(sourceImageLayerWgsl.match(/@group\(0\) @binding\(6\) var sourceBytes:texture_2d<u32>;/g)).toEqual([
    '@group(0) @binding(6) var sourceBytes:texture_2d<u32>;',
  ])
  const texel = body(sourceImageLayerWgsl, 'texel')
  const word = body(sourceImageLayerWgsl, 'hostedByteWord')
  const fragment = body(sourceImageLayerWgsl, 'imageLayer')
  expect(texel).toContain('if(u(4).z==0.){return textureLoad(soft1,local,0);}')
  expect(texel).toContain('textureLoad(sourceBytes,local,0)')
  expect(texel).toContain('hostedByteWord(stored.a,row+1)')
  expect(texel).not.toContain('round(')
  expect(texel).not.toContain('*255')
  expect(word).toContain('textureLoad(sourceBytes,vec2<i32>(i32(channel),row),0)')
  expect(word).toContain('bitcast<f32>(bits.r|(bits.g<<8u)|(bits.b<<16u)|(bits.a<<24u))')
  expect(fragment).toContain('mix(mix(texel(q),texel(q+vec2<i32>(1,0)),ax.y)')
  expect(fragment).not.toContain('smpBytesIndex')
  expect(fragment).not.toContain('byteImageAddress')
  expect(sourceImageLayerWgsl.slice(sourceImageLayerWgsl.indexOf('fn texel('))).not.toContain('round(')
})

test('a source image layer pass routes only an agreed straight upload', () => {
  const image = { resource: {} } as Texture
  const other = { resource: {} } as Texture
  const host = { straightSources: new WeakSet([image]), encodePass: vi.fn() }
  const straight = new Float32Array(256)
  straight[16] = SOURCE_IMAGE_LAYER_MODE
  straight[18] = 1
  straight[187] = 0
  WebGpuDriver.prototype.pass.call(host, {} as Texture, straight, [undefined as unknown as Texture, image])
  expect([straight[187], straight[206], straight[207]]).toEqual([0, 0, 1])
  expect(host.encodePass).toHaveBeenCalledOnce()

  const floated = new Float32Array(256)
  floated[16] = SOURCE_IMAGE_LAYER_MODE
  floated[18] = 0
  floated[207] = 4
  WebGpuDriver.prototype.pass.call(host, {} as Texture, floated, [undefined as unknown as Texture, other])
  expect(floated[207]).toBe(0)
  expect(host.encodePass).toHaveBeenCalledTimes(2)

  const mismatched = new Float32Array(256)
  mismatched[16] = SOURCE_IMAGE_LAYER_MODE
  mismatched[18] = 0
  expect(() => WebGpuDriver.prototype.pass.call(host, {} as Texture, mismatched, [undefined as unknown as Texture, image]))
    .toThrow('Source image layer straight RGBA flag does not match the upload')
  expect(host.encodePass).toHaveBeenCalledTimes(2)

  const missing = new Float32Array(256)
  missing[16] = SOURCE_IMAGE_LAYER_MODE
  missing[18] = 1
  expect(() => WebGpuDriver.prototype.pass.call(host, {} as Texture, missing, [undefined as unknown as Texture, other]))
    .toThrow('does not match the upload')

  const short = new Float32Array(32)
  short[16] = SOURCE_IMAGE_LAYER_MODE
  expect(() => noteHostedSourceImageLayer(short, false)).toThrow('uniforms are incomplete')

  const paint = new Float32Array(256)
  paint[16] = 2
  paint[18] = 0
  paint[207] = 3
  noteHostedSourceImageLayer(paint, true)
  expect(paint[207]).toBe(3)
})
