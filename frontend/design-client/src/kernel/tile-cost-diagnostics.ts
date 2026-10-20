import type { GpuScene } from './gpu/types'
// Numeric group flags: 1=rectangles, 2=pass accounting, 4=field elapsed,
// 8=packet scene/effects, 16=geometry build elapsed, 32=pure encode CPU time.
// Bits16/32 remain unavailable; neither is inferred from graph elapsed.
export const tileCostLimits: Record<string,number> = {
  tileCostSamples:2048,costSamplesOmitted:1e9,tileCostUnavailable:63,tileCostCapped:1,
  outputPixelVisits:1e12,sourcePixelVisits:1e12,sourcePixelAreaMax:1e9,supportRectExpansionMax:1e7,
  packetNodeVisits:1e9,sampledPacketNodeVisits:1e9,effectBlurVisits:1e9,effectBackdropVisits:1e9,effectShadowVisits:1e9,effectOtherVisits:1e9,
  costScanOmittedNodes:1e9,costScanOmittedEffects:1e9,
  encodedPassPixels:1e15,fieldBuildElapsedMs:120000,graphNonCheckpointElapsedMs:120000,
  materialFieldBuilds:1e9,materialFieldHits:1e9,materialFieldUploadBytes:1e12,
  tileDrawCalls:1e9,tileCommandSubmissions:1e9,
}
const scanLimit=4096
export function createTileCostDiagnostics(enabled:boolean) {
  if(!enabled)return undefined
  const totals:Record<string,number>={tileCostSamples:0,tileCostUnavailable:48,tileCostCapped:0,
    costScanOmittedNodes:0,costScanOmittedEffects:0,costSamplesOmitted:0,effectBlurVisits:0,effectBackdropVisits:0,effectShadowVisits:0,effectOtherVisits:0}
  const invalid=new Set<string>()
  const add=(key:string,value:unknown,flag:number,max=false)=>{
    if(typeof value!=='number'||!Number.isFinite(value)||value<0){invalid.add(key);totals.tileCostUnavailable|=flag;return}
    const next=max?Math.max(totals[key]||0,value):(totals[key]||0)+value
    if(next>tileCostLimits[key]){invalid.add(key);totals.tileCostCapped=1;totals.tileCostUnavailable|=flag;return}
    totals[key]=next
  }
  return {
    observe(scene:GpuScene,result:{passPixels?:number;materialFieldBuildMs?:number;graphMs?:number;checkpointMs?:number;materialFieldBuilds?:number;materialFieldHits?:number;materialFieldUploadBytes?:number;drawCalls?:number;commandSubmissions?:number}) {
      if(totals.tileCostSamples>=2048){totals.tileCostCapped=1;totals.tileCostUnavailable=63;totals.costSamplesOmitted=Math.min(1e9,totals.costSamplesOmitted+1);return}
      totals.tileCostSamples++
      const output=scene.output,source=scene.extent
      if(output&&source&&[output.x,output.y,output.w,output.h,source.x,source.y,source.w,source.h].every(Number.isFinite)&&output.w>0&&output.h>0&&source.w>0&&source.h>0){
        add('outputPixelVisits',output.w*output.h,1);add('sourcePixelVisits',source.w*source.h,1)
        add('sourcePixelAreaMax',source.w*source.h,1,true)
        add('supportRectExpansionMax',Math.max(0,output.x-source.x,output.y-source.y,source.x+source.w-output.x-output.w,source.y+source.h-output.y-output.h),1,true)
      }else{totals.tileCostUnavailable|=1;for(const key of ['outputPixelVisits','sourcePixelVisits','sourcePixelAreaMax','supportRectExpansionMax'])invalid.add(key)}
      add('encodedPassPixels',result.passPixels,2);add('tileDrawCalls',result.drawCalls,2);add('tileCommandSubmissions',result.commandSubmissions,2)
      add('fieldBuildElapsedMs',result.materialFieldBuildMs,4)
      add('graphNonCheckpointElapsedMs',typeof result.graphMs==='number'&&typeof result.checkpointMs==='number'?result.graphMs-result.checkpointMs:undefined,4)
      for(const key of ['materialFieldBuilds','materialFieldHits','materialFieldUploadBytes'] as const)add(key,result[key],4)
      // Count packet visits, not authored nodes or executed shader effects.
      let remaining=scanLimit,nodeVisits=0,truncated=false
      // Never materialize Object.values/keys merely for diagnostic counting.
      // A capped scan cannot know the total or omitted-node/effect count.
      for(const key in scene.nodes){
        if(nodeVisits>=scanLimit){truncated=true;break}
        if(!Object.hasOwn(scene.nodes,key))continue
        const node=scene.nodes[key];nodeVisits++
        const count=Math.min(remaining,node.effects.length)
        add('costScanOmittedEffects',node.effects.length-count,8)
        if(count<node.effects.length){totals.tileCostCapped=1;totals.tileCostUnavailable|=8}
        for(let i=0;i<count;i++){
          const fx=node.effects[i];if(!fx.visible)continue
          add(fx.kind==='blur'?'effectBlurVisits':fx.kind==='background-blur'?'effectBackdropVisits':fx.kind==='shadow'||fx.kind==='inner-shadow'?'effectShadowVisits':'effectOtherVisits',1,8)
        }
        remaining-=count
      }
      add('sampledPacketNodeVisits',nodeVisits,8)
      if(truncated){
        totals.tileCostCapped=1;totals.tileCostUnavailable|=8
        for(const key of ['packetNodeVisits','costScanOmittedNodes','costScanOmittedEffects'])invalid.add(key)
      }else add('packetNodeVisits',nodeVisits,8)

    },
    snapshot(){const value={...totals};for(const key of invalid)delete value[key];return value},
  }
}
