import type {Driver,GpuNode,GpuScene} from './types'
import {sourceLayer,SOURCE_LAYER_FLOATS,type SourceLayerProgram} from './source-layer'

/** One bounded native source tile; this does not admit the other source-detail
 * shortcuts, transient captures, HDR or exact outputs. */
export function sourceSolidLayerDisplay(scene:GpuScene,driver:Pick<Driver,'name'|'managed'|'hdr'|'displayMath'>,displayOnly:boolean) {
  const output=scene.output,zoom=scene.view?.zoom
  return import.meta.env.VITE_DESIGN_SOURCE_SOLID_LAYERS!=='0'&&displayOnly&&driver.name==='webgpu'&&
    driver.managed===true&&!driver.hdr&&!driver.displayMath&&scene.sourceImageDisplay===true&&
    scene.coherentSamples===true&&scene.colorManagement?.documentSpace==='srgb'&&
    !scene.softwareRaster&&!scene.interactionRetained&&!scene.resolve&&!scene.presentation&&
    Number.isFinite(zoom)&&zoom>0&&zoom<=.5&&!!output&&output.w>0&&output.h>0&&output.w<=514&&output.h<=514
}

/** Opaque normal leaves preserve both the original binary sample coverage and
 * the destination texel outside it. No alpha or gradient arithmetic is fused. */
export function sourceSolidLayer(node:GpuNode,programOffset:Parameters<typeof sourceLayer>[1],
  colour:Parameters<typeof sourceLayer>[2],availableFloats=SOURCE_LAYER_FLOATS):SourceLayerProgram|undefined {
  if(node.opacity!==1||node.effects.some(e=>e.visible)||node.opticalPrefixNext)return
  let brushes=0
  for(const paint of [...node.fills,...node.strokes.map(stroke=>stroke.paint)]){
    if(!paint)return
    if(!paint.visible||paint.opacity===0)continue
    if(paint.opacity!==1||paint.kind!=='solid'||paint.blend!=='normal')return
    const channels=colour(paint.color)
    if(channels.length!==4||channels[3]!==1)return
    brushes++
  }
  if(!brushes)return
  return sourceLayer(node,programOffset,colour,availableFloats)
}
