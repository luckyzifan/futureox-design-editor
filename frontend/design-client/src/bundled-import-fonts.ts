import type { DesignDocument } from './model'
import { applyMatchedFonts, matchFont, unmatchedSourceFonts, type FontResource } from './font-matching'
import { font_faces_json } from './generated/design-kernel/design_kernel'

// These exact, unmodified OFL faces ship with both web and desktop. Importing
// never contacts a font service or guesses an unavailable family/weight.
export const bundledImportFonts = [
  {family:'Poppins',style:'Regular',postscript:'Poppins-Regular',sha:'7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba'},
  {family:'Poppins',style:'Medium',postscript:'Poppins-Medium',sha:'90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05'},
  {family:'Poppins',style:'Bold',postscript:'Poppins-Bold',sha:'983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c'},
  {family:'Poppins',style:'SemiBold',postscript:'Poppins-SemiBold',sha:'d3bf1bdaf0550e83da9ac0b1d1d9fe6db086835a83aa28578e609a394b9a0286'},
] as const
type Face = typeof bundledImportFonts[number]
const MAX_ASSET_BYTES=1024*1024
async function readBundledFont(face:Face):Promise<Uint8Array>{
  // Worker scripts live in src/ during development and assets/ in a build.
  // Their sibling fonts/ directory retains the application's deployment base.
  const response=await fetch(new URL(`../fonts/poppins/${face.postscript}.ttf`,self.location.href),{cache:'force-cache'})
  if(!response.ok||!response.body)throw Error('Bundled font is unavailable')
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0
  try{
    while(true){const {value,done}=await reader.read();if(done)break
      length+=value.byteLength;if(length>MAX_ASSET_BYTES){await reader.cancel();throw Error('Bundled font exceeds its bounded asset size')}
      parts.push(value)
    }
  }finally{reader.releaseLock()}
  const bytes=new Uint8Array(length);let offset=0
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
  return bytes
}

/** Only a fresh imported document is mutated. The import worker owns this
 * bounded two-task preparation and termination revokes the whole operation. */
export async function matchBundledImportFonts(document:DesignDocument,read=readBundledFont):Promise<{changed:number;missing:string[];families:string[]}>{
  const names=new Set<string>()
  for(const node of Object.values(document.nodes))unmatchedSourceFonts(document,node).forEach(name=>names.add(name))
  const requested=[...new Set([...names].map(name=>matchFont(name,[...bundledImportFonts])).filter((face):face is Face=>!!face))]
  const available=Math.max(0,32-Object.keys(document.fonts||{}).length)
  const candidates=requested.filter(face=>document.fonts?.[face.sha+'-0']).concat(requested.filter(face=>!document.fonts?.[face.sha+'-0']).slice(0,available))
  const loaded=new Map<Face,{id:string;resource:FontResource}>();let next=0
  const prepare=async()=>{while(next<candidates.length){const face=candidates[next++]
    try{
      const bytes=await read(face)
      if(bytes.byteLength>MAX_ASSET_BYTES)continue
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)),v=>v.toString(16).padStart(2,'0')).join('')
      if(hash!==face.sha)continue
      const faces=JSON.parse(font_faces_json(bytes)) as {family:string;postscript:string;index:number}[]
      if(faces.length!==1||![face.family,`${face.family} ${face.style}`].includes(faces[0].family)||faces[0].postscript!==face.postscript||faces[0].index!==0)continue
      let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768))
      const id=face.sha+'-0',resource={family:`${face.family} ${face.style}`,postscript:face.postscript,index:0,data:btoa(binary)}
      const old=document.fonts?.[id]
      if(old&&(old.data!==resource.data||(old.index||0)!==0))continue
      loaded.set(face,{id,resource:old||resource})
    }catch{/* A missing or rejected optional face keeps its original source identity and warning. */}
  }}
  await Promise.all(Array.from({length:Math.min(2,candidates.length)},prepare))
  const matches=new Map<string,{id:string;resource:FontResource}>()
  for(const name of names){const face=matchFont(name,[...bundledImportFonts]),entry=face&&loaded.get(face);if(entry)matches.set(name,entry)}
  const changed=applyMatchedFonts(document,matches)
  const missing=new Set<string>();for(const node of Object.values(document.nodes))unmatchedSourceFonts(document,node).forEach(name=>missing.add(name))
  return {changed,missing:[...missing],families:[...new Set([...loaded.keys()].map(face=>face.family))]}
}
