/** Within the existing capacity only. The last completed source viewport has
 * a stronger claim than an older zoom level or a recently touched preview. */
export function sourceTileRetirement<T extends {key:string;used:number}>(tiles:Iterable<T>,
  completed:Iterable<ReadonlySet<string>>, preferLast:boolean):T[] {
  const history=[...completed]
  const rank=(key:string)=>{
    for(let i=history.length-1;i>=0;i--)if(history[i].has(key))return preferLast?i+1:1
    return 0
  }
  return [...tiles].sort((a,b)=>rank(a.key)-rank(b.key)||a.used-b.used)
}
