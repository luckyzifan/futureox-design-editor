import { expect, test } from 'vitest'
import { regionalGaussianDisplay, regionalGaussianAllocationFailure } from './regional-gaussian-display'
const request={backend:'webgpu',channel:'canvas',profile:'figmaSubpixel',colorSpace:'srgb',displayOnly:true}
test('ordinary tiles and display preview crops share the same full-density allocation retry',()=>{
  expect(regionalGaussianDisplay(request,{})).toBe(true)
  for(const change of [{channel:'interaction'},{backend:'webgl2'},{profile:'figmaSoftware'},{colorSpace:'display-p3'},
    {displayOnly:false},{regional:true},{hdr:true},{pixelPreview:1},{animation:{}},{exportRegion:{}}])
    expect(regionalGaussianDisplay({...request,...change},{})).toBe(false)
  for(const name of ['auto','prefix','regions'])expect(regionalGaussianDisplay(request,{[name]:'0'})).toBe(false)
})
test('cancellation, device loss and unrelated failures cannot enter the allocation retry',()=>{
  expect(regionalGaussianAllocationFailure(Error('GPU surface budget exceeded'))).toBe(true)
  for(const error of ['PREVIEW_CANCELLED','device lost','GPU surface budget exceeded; device lost','Invalid GPU viewport','unknown GPU surface budget exceeded'])
    expect(regionalGaussianAllocationFailure(Error(error))).toBe(false)
})
