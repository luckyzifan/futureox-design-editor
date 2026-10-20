import { readDesignFile } from './persistence'
import { expect, test, vi } from 'vitest'
// @ts-expect-error test-only dependency
import { JSDOM } from 'jsdom'
import { importSvgArtifact } from './import-svg-artifact'
import { svgFileBytes } from './export-options'
const svg=(inner:string)=>`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
test('large-artifact admission does not trust canonical markers or active/external markup',()=>{
 const dom=new JSDOM('');vi.stubGlobal('DOMParser',dom.window.DOMParser)
 try {
  for(const source of [
   '<!DOCTYPE svg [<!ENTITY x "x">]>'+svg('&x;'),
   svg('<defs><script>alert(1)</script></defs>'),
   svg('<defs><style data-svg-font="1" data-font-id="x" data-font-family="X">@import url(https://example.com/font);</style></defs>'),
   svg('<rect width="5" height="5" style="unknown-property:1"/>'),
   svg('<style>rect{fill:red}</style><rect width="5" height="5"/>'),
   svg('<image href="https://example.com/image.png" width="5" height="5"/>'),
   svg('<rect width="5" height="5" fill="url(https://example.com/a)"/>'),
   svg('<g>'.repeat(65)+'<rect width="1" height="1"/>'+'</g>'.repeat(65)),
   svg('<g/>'.repeat(20000)),
  ]) expect(()=>importSvgArtifact(new TextEncoder().encode(source),'svg'),source.slice(0,150)).toThrow()
  expect(()=>importSvgArtifact(new Uint8Array([0xff,0xfe]),'svg')).toThrow()
  expect(()=>importSvgArtifact(svgFileBytes(svg(' '.repeat(100000)),'gzip'),'svgz')).toThrow(/ratio/)
  expect(()=>importSvgArtifact(svgFileBytes(svg('<rect/>'),'gzip'),'svg')).toThrow(/format/)
  const controller=new AbortController();controller.abort();expect(()=>importSvgArtifact(new TextEncoder().encode(svg('')),'svg',controller.signal)).toThrow()
 } finally{vi.unstubAllGlobals();dom.window.close()}
})

test('UI large SVG file route validates MIME and keeps generic limits unchanged',async()=>{
 const dom=new JSDOM('');vi.stubGlobal('DOMParser',dom.window.DOMParser)
 try {
  const source=svg(' '.repeat(8*1024*1024)+'<rect width="3" height="4"/>')
  const imported=await readDesignFile(new File([source],'large.svg',{type:'image/svg+xml'}))
  expect(Object.values(imported.document.nodes).some(n=>n.width===3&&n.height===4)).toBe(true)
  await expect(readDesignFile(new File([source],'large.svg',{type:'text/html'}))).rejects.toThrow(/MIME/)
  await expect(readDesignFile(new File([source],'large.html',{type:'image/svg+xml'}))).rejects.toThrow()
 } finally{vi.unstubAllGlobals();dom.window.close()}
})
