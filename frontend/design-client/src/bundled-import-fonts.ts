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
  {family:'Poppins',style:'Italic',postscript:'Poppins-Italic',sha:'4fa76ae75b40f926420514044722cb97f32186cafd3b38263cc34dad7174d46d'},
  {family:'Poppins',style:'Medium Italic',postscript:'Poppins-MediumItalic',sha:'765addf6c7c11ec3c54325cacd68cabd05df8e4b6455302d812a9b9bafd1c614'},
  {family:'Poppins',style:'SemiBold Italic',postscript:'Poppins-SemiBoldItalic',sha:'16bb118aa232c9a13fa238027d24d7854dd1a1d9cbaf99b17fec4388d56b432c'},
  {family:'Poppins',style:'Bold Italic',postscript:'Poppins-BoldItalic',sha:'3572ac8116a0ac7317d342262b29937bcbaf94d8f03f90df6fe666fa7e2fb43a'},
  {family:'Inter',style:'Regular',postscript:'Inter-Regular',sha:'40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82'},
  {family:'Inter',style:'Medium',postscript:'Inter-Medium',sha:'97ad806f526e41546d46365bb3a393145f75b7b1568913db74549ad8b8dba872'},
  {family:'Inter',style:'SemiBold',postscript:'Inter-SemiBold',sha:'78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3'},
  {family:'Inter',style:'Bold',postscript:'Inter-Bold',sha:'288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f'},
  {family:'ABeeZee',style:'Regular',postscript:'ABeeZee-Regular',sha:'2901c8df256648cc2bb2e3afb381cb8d28e65ed3dbe11de20695ae4d5ffdeda9'},
  {family:'DejaVu Sans',style:'Regular',postscript:'DejaVuSans',sha:'ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280'},
] as const
type Face = typeof bundledImportFonts[number]
const MAX_ASSET_BYTES=2*1024*1024
export const fontDownloads = [
  { family: 'Noto Sans SC', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf', license: 'OFL-1.1', note: '本仓库已带 public/fonts/NotoSansSC.ttf，供画布渲染；不把 17MB 写进每份文档。' },
  { family: 'Roboto', url: 'https://github.com/googlefonts/roboto/releases', license: 'Apache-2.0' },
  { family: 'Source Sans 3', url: 'https://github.com/adobe-fonts/source-sans/releases', license: 'OFL-1.1' },
  { family: 'Noto Sans', url: 'https://github.com/notofonts/latin-greek-cyrillic/releases', license: 'OFL-1.1' },
] as const
export function fontDownloadFor(name: string) {
  const compact = name.toLowerCase().replace(/[\s_-]/g, '')
  return fontDownloads.find(entry => compact.startsWith(entry.family.toLowerCase().replace(/[\s_-]/g, '')))
}
function fontRelative(face: Face) {
  if (face.postscript.startsWith('Inter-')) return `inter/${face.postscript}.ttf`
  if (face.postscript.startsWith('ABeeZee')) return `abeezee/${face.postscript}.ttf`
  if (face.postscript.startsWith('DejaVu')) return `dejavu/${face.postscript}.ttf`
  return `poppins/${face.postscript}.ttf`
}
function nearestBundled(name: string): Face | undefined {
  const compact = name.toLowerCase().replace(/[\s_-]/g, '')
  const family = compact.startsWith('poppins') ? 'Poppins'
    : compact.startsWith('inter') ? 'Inter'
    : compact.startsWith('abeezee') ? 'ABeeZee'
    : compact.startsWith('dejavusans') ? 'DejaVu Sans'
    : ''
  if (!family) return
  const italic = compact.includes('italic') || compact.includes('oblique')
  const weight = family === 'ABeeZee' || family === 'DejaVu Sans' ? 'Regular'
    : compact.includes('semibold') || compact.includes('demibold') ? 'SemiBold'
    : compact.includes('medium') ? 'Medium'
    : compact.includes('bold') || compact.includes('black') || compact.includes('heavy') ? 'Bold'
    : 'Regular'
  const style = !italic || family === 'ABeeZee' || family === 'DejaVu Sans' ? weight : weight === 'Regular' ? 'Italic' : `${weight} Italic`
  return bundledImportFonts.find(face => face.family === family && face.style === style)
}
async function readBundledFont(face:Face):Promise<Uint8Array>{
  // Worker scripts live in src/ during development and assets/ in a build.
  // Their sibling fonts/ directory retains the application's deployment base.
  // Node tests read the same files from public/fonts when that fetch has no origin.
  try {
    const response=await fetch(new URL(`../fonts/${fontRelative(face)}`,self.location.href),{cache:'force-cache'})
    if(response.ok&&response.body){
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
  } catch { /* The public file below is the same OFL face. */ }
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../public/fonts/${fontRelative(face)}`, import.meta.url))))
}

/** Only a fresh imported document is mutated. The import worker owns this
 * bounded two-task preparation and termination revokes the whole operation. */
function foldedFontName(value: string) {
  return value.normalize('NFKC').toLowerCase()
}

function namesSameFamily(name: string, family: string) {
  const left = foldedFontName(name)
  const right = foldedFontName(family)
  return left === right || left.startsWith(right + ' ') || left.startsWith(right + '-')
}

/** Drop the generic “family still needs a match” warning once that family was
 * attached, including a different casing. A still-missing face of the family
 * keeps the warning. Other warnings stay. */
export function retainedFontWarnings(warnings: readonly string[], fonts: {
  families: readonly string[]
  missing: readonly string[]
  substitutions: readonly { from: string }[]
}) {
  return warnings.filter(warning => {
    const family = /^字体 (.+) 尚需匹配，已保留文字内容$/.exec(warning)?.[1]
    if (!family) return true
    if (fonts.substitutions.some(item => namesSameFamily(item.from, family))) return false
    const attached = fonts.families.some(name => foldedFontName(name) === foldedFontName(family))
    return !attached || fonts.missing.some(name => namesSameFamily(name, family))
  })
}

export async function matchBundledImportFonts(document:DesignDocument,read=readBundledFont):Promise<{changed:number;missing:string[];families:string[];substitutions:{from:string;face:string}[]}>{
  const names=new Set<string>()
  for(const node of Object.values(document.nodes))unmatchedSourceFonts(document,node).forEach(name=>names.add(name))
  const substitutions: {from:string; face:string}[] = []
  const requested=[...new Set([...names].map(name=>matchFont(name,[...bundledImportFonts]) || nearestBundled(name)).filter((face):face is Face=>!!face))]
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
  for(const name of names){
    const exact=matchFont(name,[...bundledImportFonts])
    const face=exact || nearestBundled(name)
    const entry=face&&loaded.get(face)
    if(!entry) continue
    matches.set(name,entry)
    if(!exact) substitutions.push({ from: name, face: `${face.family} ${face.style}` })
  }
  const changed=applyMatchedFonts(document,matches)
  if(document.designSystem?.fontSources) for(const source of Object.values(document.designSystem.fontSources)){
    const namesOnNode=[source.style, ...Object.values(source.runs || {})].filter((item): item is string => !!item)
    const resolved=substitutions.filter(item=>namesOnNode.includes(item.from)).map(item=>item.from)
    if(resolved.length) source.resolved=[...new Set([...(source.resolved || []), ...resolved])]
  }
  const missing=new Set<string>();for(const node of Object.values(document.nodes))unmatchedSourceFonts(document,node).forEach(name=>missing.add(name))
  return {changed,missing:[...missing],families:[...new Set([...loaded.keys()].map(face=>face.family))],substitutions}
}
