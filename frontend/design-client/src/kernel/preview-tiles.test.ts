import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewAdmission, prepareWindowRetriable, renderPreviewRegions, renderPreviewTiles, renderBitmapPreviewTiles, type PreviewTile } from './preview-tiles'

afterEach(() => vi.unstubAllGlobals())

const pixels = (tile: PreviewTile, float = false) => {
  const data = float
    ? new Float32Array(tile.width * tile.height * 4)
    : new Uint8Array(tile.width * tile.height * 4)
  for (let y = 0; y < tile.height; y++)
    for (let x = 0; x < tile.width; x++)
      data.set(
        [
          ((tile.x + x) % 251) / (float ? 100 : 1),
          ((tile.y + y) % 251) / (float ? 100 : 1),
          float ? 4 : 200,
          1,
        ],
        (y * tile.width + x) * 4,
      )
  return data
}
describe('prepare window admission', () => {
  it('retries a wide guard only for aggregate program or path budgets', () => {
    expect(prepareWindowRetriable(Error('Scene path budget exceeded'))).toBe(true)
    expect(prepareWindowRetriable(Error('GPU analytic interval program budget exceeded'))).toBe(true)
    expect(prepareWindowRetriable(Error('Flattened path budget exceeded'))).toBe(false)
    expect(prepareWindowRetriable(Error('GPU 设备已丢失'))).toBe(false)
  })
})
describe('bounded preview tile assembly', () => {
  it('learns failed dimensions before repeating expensive work, preserving every float pixel', async () => {
    const admission=new PreviewAdmission(), failures:number[]=[]
    for(let run=0;run<2;run++){
      let failed=0
      const result=await renderPreviewTiles(256,256,async tile=>{
        if(tile.width>64||tile.height>64){failed++;throw Error('GPU 表面内存预算超限')}
        return pixels(tile,true)
      },256,admission)
      expect(result.tiles).toBe(16)
      expect(result.pixels).toEqual(pixels({x:0,y:0,width:256,height:256},true))
      failures.push(failed)
    }
    expect(failures).toEqual([4,0])
    const fresh=new PreviewAdmission()
    expect(fresh.shouldSplit({x:0,y:0,width:256,height:256})).toBe(false)
    fresh.observe(Error('GPU surface budget exceeded; device lost'),{x:0,y:0,width:256,height:256})
    expect(fresh.shouldSplit({x:0,y:0,width:256,height:256})).toBe(false)
  })
  for (const float of [false, true])
    it(`preserves global pixel positions and partial edge tiles (${float ? 'float HDR' : 'SDR'})`, async () => {
      const result = await renderPreviewTiles(513, 389, async (tile) => pixels(tile, float))
      expect(result.tiles).toBe(6)
      const expected = pixels({ x: 0, y: 0, width: 513, height: 389 }, float)
      expect(result.pixels.every((v, i) => v === expected[i])).toBe(true)
    })
  it('subdivides only admission failures and never drops pixels', async () => {
    const result = await renderPreviewTiles(129, 97, async (tile) => {
      if (tile.width > 64 || tile.height > 64) throw new Error('GPU 表面内存预算超限')
      return pixels(tile)
    })
    expect(result.tiles).toBeGreaterThan(1)
    expect(result.pixels).toEqual(pixels({ x: 0, y: 0, width: 129, height: 97 }))
  })
  it('propagates rendering failures instead of presenting a partial frame', async () => {
    await expect(
      renderPreviewTiles(300, 100, async (tile) => {
        if (tile.x) throw new Error('Device lost')
        return pixels(tile)
      }),
    ).rejects.toThrow('Device lost')
    await expect(
      renderPreviewTiles(64, 64, async () => {
        throw new Error('GPU 表面内存预算超限')
      }),
    ).rejects.toThrow('预算超限')
  })
  it('rejects malformed readbacks and excessive allocations', async () => {
    await expect(renderPreviewTiles(64, 64, async () => new Uint8Array(1))).rejects.toThrow(
      'readback',
    )
    await expect(renderPreviewTiles(4096, 4096, async (tile) => pixels(tile))).rejects.toThrow(
      'dimensions',
    )
  })
})

it('GPU display subdivision blits integer regions and closes every leaf without reading pixels', async () => {
  const blits: number[][] = [], closed: string[] = []
  const output = { width: 129, height: 97 }
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { imageSmoothingEnabled: true, drawImage(bitmap: ImageBitmap, x: number, y: number) {
      blits.push([x, y, bitmap.width, bitmap.height])
    } } }
    transferToImageBitmap() { return output }
  })
  const result = await renderBitmapPreviewTiles(129, 97, async tile => {
    if (tile.width > 64 || tile.height > 64) throw new Error('GPU 表面内存预算超限')
    return { width: tile.width, height: tile.height, close: () => closed.push(`${tile.x}:${tile.y}`) } as ImageBitmap
  })
  expect(result.bitmap).toBe(output)
  expect(closed).toHaveLength(result.tiles)
  expect(new Set(closed).size).toBe(result.tiles)
  const coverage = new Uint8Array(129 * 97)
  for (const [x, y, w, h] of blits) for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) coverage[row * 129 + col]++
  expect(coverage.every(count => count === 1)).toBe(true)
})

it('display assembly closes malformed leaves and never publishes a partial failed frame', async () => {
  const publish = vi.fn(), close = vi.fn()
  vi.stubGlobal('OffscreenCanvas', class {
    width = 0; height = 0
    getContext() { return { drawImage() {}, imageSmoothingEnabled: false } }
    transferToImageBitmap = publish
  })
  await expect(renderBitmapPreviewTiles(128, 64, async () => ({ width: 1, height: 1, close }) as ImageBitmap))
    .rejects.toThrow('bitmap')
  expect(close).toHaveBeenCalledOnce()
  await expect(renderBitmapPreviewTiles(128, 64, async tile => {
    if (tile.x) throw new Error('Device lost')
    return { width: tile.width, height: tile.height, close } as ImageBitmap
  }, 64)).rejects.toThrow('Device lost')
  expect(publish).not.toHaveBeenCalled()
})


it('canceled expensive subdivision stops before compiling its first child region', async () => {
  let current = true
  const attempted: PreviewTile[] = []
  const checkpoint = async () => {
    await Promise.resolve()
    if (!current) throw new Error('PREVIEW_CANCELLED')
  }
  await expect(renderPreviewRegions(512, 512, async tile => {
    attempted.push(tile)
    current = false
    throw new Error('GPU 表面内存预算超限')
  }, 512, new PreviewAdmission(), checkpoint)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(attempted).toEqual([{ x: 0, y: 0, width: 512, height: 512 }])
})

it('cancellation is observed while traversing learned budget subdivisions', async () => {
  const admission = new PreviewAdmission(), rasterize = vi.fn(async () => {})
  admission.observe(Error('GPU surface budget exceeded'), { x: 0, y: 0, width: 128, height: 128 })
  let checkpoints = 0
  const checkpoint = async () => {
    if (++checkpoints === 2) throw new Error('PREVIEW_CANCELLED')
  }
  await expect(renderPreviewRegions(512, 512, rasterize, 512, admission, checkpoint)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(rasterize).not.toHaveBeenCalled()
  expect(checkpoints).toBe(2)
})

it('canceling a partial byte assembly never publishes it or starts the next region', async () => {
  let current = true, rasterized = 0
  await expect(renderPreviewTiles(512, 256, async tile => {
    rasterized++
    current = false
    return pixels(tile)
  }, 256, undefined, async () => {
    if (!current) throw new Error('PREVIEW_CANCELLED')
  })).rejects.toThrow('PREVIEW_CANCELLED')
  expect(rasterized).toBe(1)
})

it('canceling a partial display assembly keeps every unfinished region private', async () => {
  const publish = vi.fn(), close = vi.fn(), draw = vi.fn()
  let current = true, attempted = 0
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: draw, imageSmoothingEnabled: false } }
    transferToImageBitmap = publish
  })
  await expect(renderBitmapPreviewTiles(1710, 1776, async tile => {
    attempted++; current = false
    return { width: tile.width, height: tile.height, close } as ImageBitmap
  }, 256, undefined, async () => {
    if (!current) throw Error('PREVIEW_CANCELLED')
  })).rejects.toThrow('PREVIEW_CANCELLED')
  expect(attempted).toBe(1); expect(draw).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  expect(publish).not.toHaveBeenCalled()
})

it('current subdivided work still assembles every exact pixel with checkpoints', async () => {
  let checkpoints = 0
  const result = await renderPreviewTiles(256, 128, async tile => {
    if (tile.width > 128) throw new Error('GPU surface budget exceeded')
    return pixels(tile, true)
  }, 256, undefined, async () => { checkpoints++ })
  expect(result.tiles).toBe(2)
  expect(checkpoints).toBe(3)
  expect(result.pixels).toEqual(pixels({ x: 0, y: 0, width: 256, height: 128 }, true))
})

it('spatial scene geometry admission splits exactly but per-path failures do not retry', async () => {
  const result=await renderPreviewTiles(256,128,async tile=>{
    if(tile.width>64)throw Error('Scene path budget exceeded')
    return pixels(tile,true)
  },256)
  expect(result.pixels).toEqual(pixels({x:0,y:0,width:256,height:128},true))
  for(const message of ['Flattened path budget exceeded','Curve Boolean output budget exceeded','Scene path budget exceeded; device lost']) {
    const render=vi.fn(async()=>{throw Error(message)})
    await expect(renderPreviewTiles(256,128,render)).rejects.toThrow(message)
    expect(render).toHaveBeenCalledOnce()
  }
})
