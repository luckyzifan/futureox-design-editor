/** Within the existing capacity only. The last completed source viewport has
 * a stronger claim than an older zoom level or a recently touched preview. */
export function sourceTileRetirement<T extends {key:string;used:number}>(tiles:Iterable<T>,
  completed:Iterable<ReadonlySet<string>>, preferLast:boolean, wider?:ReadonlySet<string>):T[] {
  const history=[...completed]
  const rank=(key:string)=>{
    if(wider?.has(key))return history.length+1
    for(let i=history.length-1;i>=0;i--)if(history[i].has(key))return preferLast?i+1:1
    return 0
  }
  return [...tiles].sort((a,b)=>rank(a.key)-rank(b.key)||a.used-b.used)
}

/** Coarsest completed cohort in the existing two-slot history. It is the
 * picture a 3200% → 100%/25% return still has. The old caller only passed
 * this set while the live raster scale was at least 2, so the return to 25%
 * (scale 0.5 at DPR 2) evicted it first and the new viewport had nothing
 * left to paint. The current scale's own keys are not a second cohort. */
export function zoomOutRetentionCohort<T>(history:Iterable<readonly [number,T]>,currentScale:number):T|undefined{
  if(!(currentScale>0)||!Number.isFinite(currentScale))return
  let bestScale=Infinity,best:T|undefined
  for(const [scale,value] of history){
    if(!(scale>0)||!Number.isFinite(scale)||scale>=bestScale)continue
    bestScale=scale;best=value
  }
  if(best===undefined||bestScale===currentScale)return
  return best
}

/** Two completed density cohorts, as before. Repeated nearly equal high zooms
 * replace their nearest cohort instead of throwing out the wide return view.
 * This is eviction priority only; no camera/key/sample value is quantized. */
export function rememberSourceTier(history:Map<number,Set<string>>,scale:number,keys:Set<string>){
  history.delete(scale)
  if(history.size>=2){
    const nearest=[...history.keys()].sort((a,b)=>Math.abs(Math.log(a/scale))-Math.abs(Math.log(b/scale)))[0]
    history.delete(nearest)
  }
  history.set(scale,keys)
}
