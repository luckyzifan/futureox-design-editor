import { expect, it } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { blank, paint, stroke, type DesignDocument } from '../../design-client/src/model'
import { VectorEngine } from '../../design-client/src/generated/design-kernel/design_kernel'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { connect, sha256 } from './ai-generation-client'

it('authors the macOS presentation via real MCP, exports editable FD/SVG and native CPU PNGs', async () => {
  const out=process.env.FUTUREOX_BRAND_DIR
  if(!out || !path.isAbsolute(out)) throw Error('Set absolute FUTUREOX_BRAND_DIR')
  await mkdir(out,{recursive:true})
  const save=async(name:string,data:any)=>writeFile(path.join(out,name),typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data,null,2))
  const inputBytes=await readFile(new URL('../../../docs/branding/history/futureox-macos-refined-v4.fd',import.meta.url))
  const client=await connect(decodeDocumentBinary(inputBytes) as DesignDocument)
  const frame='73000000-0000-4000-8000-000000000001',tile='73000000-0000-4000-8000-000000000002',mark='73000000-0000-4000-8000-000000000003'
  const art='73000000-0000-4000-8000-000000000004',substrate='73000000-0000-4000-8000-000000000005'
  const network=(points:number[][])=>({fillRule:'nonzero',vertices:points.map(([x,y],i)=>({id:`v${i}`,x,y})),edges:points.map((_,i)=>({id:`e${i}`,from:`v${i}`,to:`v${(i+1)%points.length}`}))})
  const curveNetwork=(points:number[][],curves:Record<number,number[][]>)=>{const value=network(points);for(const [edge,control] of Object.entries(curves)){Object.assign(value.edges[Number(edge)],{c1:{x:control[0][0],y:control[0][1]},c2:{x:control[1][0],y:control[1][1]}})}return value}
  try {
    const page=client.editor.state.page
    const corner='73000000-0000-4000-8000-000000000006',handle='73000000-0000-4000-8000-000000000007'
    const before=client.editor.state.doc
    const operations=[{method:'node.delete',params:{ids:[corner,handle]}}]
    await save('authored-operations.json',operations)
    await client.mutate('batch.apply',{operations,label:'Remove all canvas controls from selected Mac icon'})
    const source=client.editor.state.doc
    expect(Object.keys(source.nodes)).toHaveLength(5)
    for(const id of [frame,tile,mark,art,substrate]) {
      const expected=structuredClone(before.nodes[id])
      if(id===frame) expected.children=expected.children.filter(id=>id!==corner&&id!==handle)
      expect(source.nodes[id]).toEqual(expected)
    }
    await client.mutate('history.undo',{});expect(client.editor.state.doc).toEqual(before)
    await client.mutate('history.redo',{});expect(client.editor.state.doc).toEqual(source)
    const check=(await client.read('design.check',{pageId:page,nodeIds:[frame]})).result
    expect(check.issues.filter((i:any)=>i.severity==='error')).toHaveLength(0);await save('design-check.json',check)
    const svg=(await client.read('vector.export',{pageId:page,nodeIds:[frame],precision:4,scale:1})).result
    expect(svg.content).toContain('<svg');expect(svg.content).toContain('<path')
    await save('futureox-desgin.svg',svg.content);await save('svg-export-metadata.json',{...svg,content:undefined})
    const fd=(await client.read('document.export',{format:'fd'})).result,bytes=Buffer.from(fd.base64,'base64')
    expect(decodeDocumentBinary(bytes)).toEqual(source);await save('futureox-desgin.fd',bytes)
    const reopened=await connect(decodeDocumentBinary(bytes) as DesignDocument)
    try {await reopened.mutate('node.update',{ids:[mark],patch:{name:'Editable native F verified'}});expect(reopened.editor.state.doc.nodes[mark].name).toBe('Editable native F verified');await reopened.mutate('history.undo',{});expect(reopened.editor.state.doc).toEqual(source);await save('fd-reopen-transcript.json',reopened.transcript)}finally{await reopened.close()}
    const engine=new VectorEngine(),renders=[]
    try {
      engine.load_document(JSON.stringify(source))
      for(const size of [16,32,64,128,256,512,1024,1536]) {
        const request={pageId:page,nodeIds:[frame],bounds:{x:0,y:0,width:512,height:512},scale:size/512,rasterProfile:'analytic'}
        const png=Buffer.from(engine.render_region_png(JSON.stringify(request)))
        expect(png.readUInt32BE(16)).toBe(size);expect(png.readUInt32BE(20)).toBe(size)
        const name=size>=512?`futureox-desgin@${size/512}x.png`:`futureox-desgin-${size}.png`
        await save(name,png);renders.push({name,size,sha256:sha256(png),request})
      }
    }finally{engine.free()}
    await save('provenance.json',{inputFdSha256:sha256(inputBytes),refinement:'Only deletion of the two corner-control nodes from selected refined-v4 FD via real MCP. Remaining node geometry and styles checked exactly unchanged; undo/redo verified.',path:'Actual JSON-RPC NDJSON → DesignMcpServer → OperationBackend → Editor/WASM native vector network creation → MCP resource export',nativeRaster:'Actual VectorEngine.render_region_png / analytic CPU from the MCP-authored document',inMemoryTransport:true,browser:false,gpu:false,svgSha256:sha256(svg.content),fdSha256:sha256(bytes),renders})
  }finally{await save('mcp-transcript.json',client.transcript);await client.close()}
},120000)
