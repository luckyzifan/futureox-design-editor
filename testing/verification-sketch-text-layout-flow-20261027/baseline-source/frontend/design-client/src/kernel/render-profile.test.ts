import { afterEach, expect, test } from 'vitest'
import { profileBars, recordRenderProfile, renderProfile } from './render-profile'
afterEach(() => renderProfile.pause())
test('recording is opt-in and bounded; GPU waits are included, not double counted', () => {
  renderProfile.start()
  for (let i=0;i<600;i++) recordRenderProfile('pose', {total:25,compileMs:4,graphMs:18,checkpointMs:10,fieldMs:3,finishMs:3})
  expect(renderProfile.snapshot()).toHaveLength(512)
  const bars=profileBars(renderProfile.snapshot()[0])
  expect(bars.reduce((sum,b)=>sum+b.ms,0)).toBe(25)
  expect(bars.find(b=>b.children)?.children?.map(b=>b.ms)).toEqual([3,10,5])
  renderProfile.pause(); recordRenderProfile('late', {total:1})
  expect(renderProfile.snapshot().at(-1)?.kind).toBe('pose')
})
test('malformed diagnostics cannot produce negative or NaN widths', () => {
  renderProfile.start();recordRenderProfile('pose',{total:NaN,compileMs:-1,graphMs:5,checkpointMs:20,fieldMs:50})
  const bars=profileBars(renderProfile.snapshot()[0])
  expect(bars[0].children?.map(b=>b.ms)).toEqual([0,5,0])
})
test('parameter uploads survive tile and live-pose reporting without inventing unavailable geometry bytes',()=>{
  renderProfile.start();recordRenderProfile('tile',{materialFieldUploadBytes:4096})
  recordRenderProfile('pose',{fieldUploadBytes:8192,geometryUploadBytes:128})
  expect(renderProfile.snapshot().map(s=>[s.fieldUploadBytes,s.geometryUploadBytes])).toEqual([[4096,undefined],[8192,128]])
})
