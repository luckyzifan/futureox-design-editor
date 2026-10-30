import {readFileSync} from 'node:fs'
import {expect,test,vi} from 'vitest'
import {blank,node,defaultTextStyle} from './model'
import {emptySystem} from './design-system'
import {importFigTextRuns} from './import-fig-text'
import {bundledImportFonts,matchBundledImportFonts} from './bundled-import-fonts'
const read=async(face:typeof bundledImportFonts[number])=>new Uint8Array(readFileSync(new URL(`../public/fonts/poppins/${face.postscript}.ttf`,import.meta.url)))
function fixture(names=['Regular','Medium','Bold','SemiBold']){
 const document=blank('Known imported faces');document.designSystem=emptySystem();document.designSystem.fontSources={}
 for(const style of names){const n=node('text',20,20,100,40);n.text='AB';n.textStyle=defaultTextStyle()
  document.designSystem.fontSources[n.id]=importFigTextRuns(n,{fontName:{family:'Poppins',style}},new Set())
  document.nodes[n.id]=n;document.pages[0].children.push(n.id)
 }
 return document
}
test('real bundled faces match exact source identities with at most two preparation jobs',async()=>{
 const doc=fixture(),sources=structuredClone(doc.designSystem!.fontSources);let active=0,peak=0
 const result=await matchBundledImportFonts(doc,async face=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));try{return await read(face)}finally{active--}})
 expect(peak).toBe(2);expect(result.changed).toBe(4);expect(result.missing).toEqual([])
 expect(Object.keys(doc.fonts!)).toHaveLength(4);expect(doc.designSystem!.fontSources).toEqual(sources)
 for(const n of Object.values(doc.nodes)){const font=doc.fonts![n.textStyle!.fontId!];expect(font.postscript).toMatch(/^Poppins-/);expect(font.data.length).toBeGreaterThan(100000)}
})
test('unknown weights and unavailable or altered assets keep explicit unresolved source identities',async()=>{
 const doc=fixture(['Italic','Regular','Bold']),before=structuredClone(doc.designSystem!.fontSources)
 const result=await matchBundledImportFonts(doc,async face=>{if(face.style==='Regular')return new Uint8Array([1,2,3]);throw Error('Unavailable')})
 expect(result.changed).toBe(0);expect(Object.keys(doc.fonts||{})).toHaveLength(0)
 expect(result.missing).toHaveLength(3);expect(doc.designSystem!.fontSources).toEqual(before)
 expect(Object.values(doc.nodes).every(n=>n.textStyle?.fontId==='default')).toBe(true)
})
test('matching the base face never guesses an unavailable run or overwrites a user-assigned font',async()=>{
 const doc=fixture(['Regular']),n=Object.values(doc.nodes)[0]
 doc.designSystem!.fontSources![n.id]=importFigTextRuns(n,{fontName:{family:'Poppins',style:'Regular'},textData:{characterStyleIDs:[0,1],styleOverrideTable:[{styleID:1,fontName:{family:'Poppins',style:'Italic'}}]}},new Set())
 const result=await matchBundledImportFonts(doc,read)
 expect(result.changed).toBe(1);expect(result.missing).toContain('Poppins Italic');expect(n.textRuns?.find(r=>r.start===1)?.fontId).toBe('default')
 n.textStyle!.fontId='user-font';const loader=vi.fn(read);await matchBundledImportFonts(doc,loader)
 expect(n.textStyle!.fontId).toBe('user-font');expect(loader).not.toHaveBeenCalled()
})
test('the existing document font resource limit also bounds optional import matching',async()=>{
 const doc=fixture();doc.fonts=Object.fromEntries(Array.from({length:32},(_,i)=>['existing-'+i,{family:'Existing',data:'AA==',index:0}]))
 const loader=vi.fn(read),result=await matchBundledImportFonts(doc,loader)
 expect(loader).not.toHaveBeenCalled();expect(result.changed).toBe(0);expect(Object.keys(doc.fonts)).toHaveLength(32)
})
