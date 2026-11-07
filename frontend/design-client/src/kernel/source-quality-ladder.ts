/** A resource failure is local to the requested camera. Actual lower-tier
 * tiles may supply pixels, but only native-density coverage can be ready. */
export function sourceRasterLimit(error:unknown){
  return /GPU (?:surface budget exceeded|表面内存预算超限|浮点图片内存预算超限|积分模糊半径超过|display resident budget exceeded)|WebGPU 纹理尺寸超限|Parameter field exceeds 64 MiB|Sampling coordinate field exceeds|Gaussian sigma must be in/.test(String(error))
}
export class SourceQualityLadder{
  scale?:number
  reason=''
  private upper=Infinity
  private best=0
  private steps=0
  private original=0
  private retriedOriginal=false
  limited=false
  reset(){this.scale=undefined;this.upper=Infinity;this.best=0;this.steps=0;this.original=0;this.retriedOriginal=false;this.limited=false;this.reason=''}
  /** Proactive outward floor: a continuous wheel zoom-out seeds the ladder at
   * an interaction-density step instead of paying a rejected full-density
   * raster to discover it. Escalation stays bounded by the original scale. */
  seed(scale:number,original:number){
    if(!(scale>0)||!(original>0)||scale>=original)return
    this.scale=scale
    if(this.upper===Infinity)this.upper=original
    if(!this.original)this.original=original
  }
  rejected(scale:number,error:unknown){
    if(!sourceRasterLimit(error))return false
    this.reason=String(error).replace(/^Error: /,'');this.upper=Math.min(scale,this.upper)
    if(!this.original)this.original=scale
    if(this.retriedOriginal&&scale===this.original&&this.best){this.scale=this.best;this.limited=true;return true}
    this.steps++
    if(this.best && (this.steps>=5||this.upper/this.best<1.25)){
      this.scale=this.best;this.limited=true;return true
    }
    if(this.steps>=7||scale<=.002)return false
    this.scale=Math.max(.001,this.best?Math.sqrt(this.best*this.upper):scale/2)
    return true
  }
  /** Only the compositor acknowledgement of a fully covered tier may
   * advance it. A raster completion or a timer alone proves no visible detail. */
  presented(scale:number){
    if(this.scale===undefined||Math.abs(scale/this.scale-1)>1e-8)return false
    // A speculative preview is not evidence that native rendering failed.
    // After its first covered presentation request the original quality,
    // without spending several geometric steps or declaring a false limit.
    if(!this.reason){this.reset();return true}
    this.best=Math.max(this.best,scale)
    if(this.limited)return false
    if(this.steps>=5||this.upper/this.best<1.25){
      if(!this.retriedOriginal&&this.best>=this.original*.8){
        this.retriedOriginal=true;this.scale=this.original;return true
      }
      this.limited=true;return false
    }
    this.steps++;this.scale=Math.sqrt(this.best*this.upper);return true
  }
  settle(){if(this.scale!==undefined&&!this.reason)this.reset()}
}
