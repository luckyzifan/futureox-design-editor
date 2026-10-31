import {afterEach,expect,test,vi} from 'vitest'
import {displayRasterBackpressure} from './display-raster-scheduling'
afterEach(()=>vi.unstubAllEnvs())
const request={channel:'canvas',hdr:false}
test('display preparation uses the existing queue progress fence by default',()=>{
 expect(displayRasterBackpressure({renderIntent:'canvas'},request)).toBe(true)
 expect(displayRasterBackpressure({renderIntent:'preview'},request)).toBe(true)
 vi.stubEnv('VITE_DESIGN_RASTER_BACKPRESSURE','0')
 expect(displayRasterBackpressure({renderIntent:'canvas'},request)).toBe(false)
})
test.each([{png:true},{readback:true},{hdr:true},{channel:'interaction'}])('independent output/pose owner is excluded: %j',scope=>{
 expect(displayRasterBackpressure({renderIntent:'canvas'},{...request,...scope})).toBe(false)
})
test.each([{renderIntent:'settled'},{exportFormat:'png'},{exportRegion:{}},{pixelPreview:1},{rasterProfile:'figmaSoftware'},{retainInteractionGraph:true},{interactionChannel:true}])('request boundary is excluded: %j',options=>{
 expect(displayRasterBackpressure({renderIntent:'canvas',...options},request)).toBe(false)
})
