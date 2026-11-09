import { afterEach, expect, test, vi } from 'vitest'
import { tilePrepareViewport, tileBatchPrepareViewport, localDisplayPrepareScope, tileLocalPrepareViewport } from './tile-prepare-viewport'
import type { RasterTile } from './tile-cache'
afterEach(()=>vi.unstubAllEnvs())
test('bounded chunks keep the whole plan guard with the exact camera phase', () => {
  const tiles = [0, 512, 1024].map(x => ({ key: String(x), x, y: -1, width: 514, height: 514, zoom: 2 }) as RasterTile)
  const view = { x: -3.25, y: 5.75 }, guard = tilePrepareViewport(tiles, view)!
  expect(guard).toEqual({ x: -4, y: 4, w: 1538, h: 514 })
  for (const tile of tiles) expect(tilePrepareViewport([tile], view, guard)).toBe(guard)
  expect(() => tilePrepareViewport(tiles, view, tilePrepareViewport([tiles[0]], view))).toThrow('cover every')
  expect(() => tilePrepareViewport(tiles, view, { ...guard, w: Infinity })).toThrow()
})

test('large minified display prepares the actual crop unless the union is explicitly requested',()=>{
 const tile={key:'phase',x:511,y:-513,width:514,height:514,zoom:.125,phaseX:.375,phaseY:.125} as RasterTile
 const view={x:-3.25,y:5.75},shared={x:-1028,y:-1020,w:4096,h:4096}
 expect(localDisplayPrepareScope(9403,.125,true)).toBe(true)
 expect(localDisplayPrepareScope(20082,.125,true)).toBe(true)
 expect(localDisplayPrepareScope(124447,.125,true)).toBe(true)
 expect(localDisplayPrepareScope(9403,2,true)).toBe(false)
 expect(localDisplayPrepareScope(2999,.125,true)).toBe(false)
 expect(localDisplayPrepareScope(9403,.125,false)).toBe(false)
 vi.stubEnv('VITE_DESIGN_LOCAL_PREPARE_SCOPE','1')
 expect(localDisplayPrepareScope(9403,32,true)).toBe(true)
 expect(localDisplayPrepareScope(2999,.125,true)).toBe(false)
 vi.stubEnv('VITE_DESIGN_LOCAL_PREPARE_SCOPE','0')
 expect(localDisplayPrepareScope(124447,.125,true)).toBe(false)
 expect(tileLocalPrepareViewport(tile,view,shared,true)).toEqual({x:507,y:-508,w:514,h:514})
 expect(tileLocalPrepareViewport(tile,view,shared,false)).toBe(shared)
 expect(tileLocalPrepareViewport(tile,view,undefined,true)).toBeUndefined()
 expect(()=>tileLocalPrepareViewport(tile,view,{x:0,y:0,w:1,h:1},true)).toThrow('cover every')
 expect([tile.zoom,tile.phaseX,tile.phaseY]).toEqual([.125,.375,.125])
})

test('visible preparation excludes idle rim, while every dispatched crop remains covered', () => {
  const tile = (x: number, prefetch = false) => ({ key: String(x), x, y: 0, width: 514, height: 514, zoom: 2, prefetch }) as RasterTile
  const visible = [tile(0), tile(512)], rim = [tile(-1024, true), tile(1536, true)]
  const view = { x: .25, y: -.25 }
  const first = tileBatchPrepareViewport(visible, rim, [visible[0]], view)!
  expect(first).toEqual({ x: 0, y: -1, w: 1026, h: 514 })
  const later = tileBatchPrepareViewport(visible, rim, [rim[0]], view)!
  expect(later).toEqual({ x: -1024, y: -1, w: 3074, h: 514 })
  for (const batch of [[visible[0]], [rim[0]], [visible[1], rim[1]]]) {
    const guard = tileBatchPrepareViewport(visible, rim, batch, view)!
    expect(tilePrepareViewport(batch, view, guard)).toBe(guard)
  }
})
