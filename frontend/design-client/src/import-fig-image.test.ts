import { expect,test } from 'vitest'
import { figImageAdjust } from './import-fig-image'
import { applyImageAdjust } from './kernel/gpu/image-adjust'
// Values independently read from a Figma export at source-texel centers.
test.each([
  ['exposure',.23000000417232513,[137,122,240]],['contrast',-.09300000220537186,[94,82,182]],
  ['vibrance',.4699999988079071,[90,68,219]],['temperature',-.28999999165534973,[73,82,195]],
  ['tint',.1899999976158142,[104,75,180]],['highlights',.3700000047683716,[92,80,180]],
  ['shadows',-.4300000071525574,[86,75,171]],
] as const)('native FIG %s retains shader-domain values and matches Figma center pixels',(key,value,expected)=>{
  const a=figImageAdjust({paintFilter:{[key]:value}})!
  expect(applyImageAdjust([92/255,80/255,180/255],a,false).map(v=>Math.round(v*255))).toEqual(expected)
  if(key==='contrast')expect(a.contrast).toBe(value)
})
test('legacy known fields, identity, malformed values and unsupported filters stay explicit',()=>{
  expect(figImageAdjust({filterColorAdjust:{exposure:.5,detail:0}})?.exposure).toBe(.5)
  expect(figImageAdjust({paintFilter:{exposure:0}})).toBeUndefined()
  expect(()=>figImageAdjust({paintFilter:{detail:.2}})).toThrow(/无损/)
  expect(()=>figImageAdjust({paintFilter:{exposure:NaN}})).toThrow(/无效/)
})
