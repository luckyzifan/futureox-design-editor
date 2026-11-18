import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
const source=readFileSync(new URL('./render-worker.ts',import.meta.url),'utf8')
test('worker switches partition and preserves lane-local document/resource generations',()=>{
  const select=source.slice(source.indexOf('function selectLane('),source.indexOf('async function engine('))
  expect(select).toMatch(/tileCache\s*=\s*tileCaches\.owner\(name\)/)
  expect(select).not.toContain('invalidateTileCache()')
  expect(select).toMatch(/laneState\s*=\s*lanes\.get\(name\)/)
  expect(select).not.toContain('invalidateOwnerTileCache()')
  expect(source).toMatch(/laneState\.documentGeneration\+\+/)
  expect(source).toMatch(/laneState\.resourceGeneration\+\+/)
})
test('worker full load/fonts invalidate owner while driver resets invalidate aggregate cache',()=>{
  expect(source).toMatch(/laneState\.documentGeneration\+\+\s+laneState\.decodedImageOwner = createDecodedImageOwner\(\)\s+invalidateOwnerTileCache\(\)/)
  expect(source).toMatch(/resourceGeneration\+\+\s+invalidateOwnerTileCache\(\)/)
  expect(source).toMatch(/settingsJson !== colorKey[\s\S]*?invalidateTileCache\(\)\s+gpu\?\.dispose\(\)/)
  expect(source).toMatch(/if \(gpu\?\.driver\.lost\)[\s\S]*?invalidateTileCache\(\)/)
})
test('worker cache commits require owned bytes, uncanceled request, and captured lifetime',()=>{
  expect(source).toContain('ownsExactTileBytes(result) && cacheOwner.current(cacheTicket)')
  expect(source).toContain('cacheTicket = cacheOwner.capture()')
  expect(source).toContain('exactTilePayloadBytes(result), cacheTicket)')
  const commitStart = source.indexOf('undelivered = result', source.indexOf('cacheTicket = cacheOwner.capture()'))
  const commitEnd = source.indexOf('exactTilePayloadBytes(result), cacheTicket)', commitStart)
  expect(commitStart).toBeGreaterThanOrEqual(0)
  expect(commitEnd).toBeGreaterThan(commitStart)
  expect(source.slice(commitStart, commitEnd)).toMatch(
    /tileFence\(false\) === 'cancel'\) throw new Error\('PREVIEW_CANCELLED'\)[\s\S]*ownsExactTileBytes\(result\) && cacheOwner\.current\(cacheTicket\)[\s\S]*cacheOwner\.set\(/,
  )
})
