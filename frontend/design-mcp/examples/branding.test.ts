import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { blank, paint, stroke, type DesignDocument } from '../../design-client/src/model'
import { VectorEngine } from '../../design-client/src/generated/design-kernel/design_kernel'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { connect, sha256 } from './ai-generation-client'

it('authors the original F via real MCP, exports editable FD/SVG and native CPU PNGs', async () => {
  const out=process.env.FUTUREOX_BRAND_DIR
  if(!out || !path.isAbsolute(out)) throw Error('Set absolute FUTUREOX_BRAND_DIR')
  await mkdir(out,{recursive:true})
  const save=async(name:string,data:any)=>writeFile(path.join(out,name),typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data,null,2))
  const client=await connect(blank('Futureox / original F-D brand icon'))
  const frame='73000000-0000-4000-8000-000000000001',tile='73000000-0000-4000-8000-000000000002',mark='73000000-0000-4000-8000-000000000003'
  const network=(points:number[][])=>({fillRule:'nonzero',vertices:points.map(([x,y],i)=>({id:`v${i}`,x,y})),edges:points.map((_,i)=>({id:`e${i}`,from:`v${i}`,to:`v${(i+1)%points.length}`}))})
  const curveNetwork=(points:number[][],curves:Record<number,number[][]>)=>{const value=network(points);for(const [edge,control] of Object.entries(curves)){Object.assign(value.edges[Number(edge)],{c1:{x:control[0][0],y:control[0][1]},c2:{x:control[1][0],y:control[1][1]}})}return value}
  try {
    const page=client.editor.state.page
    const operations=[
      {method:'node.create',params:{id:frame,parentId:page,kind:'frame',x:0,y:0,width:512,height:512,patch:{name:'Original F / 512px master',fills:[],strokes:[]}}},
      {method:'node.create',params:{id:tile,parentId:frame,kind:'vector',x:0,y:0,width:512,height:512,patch:{name:'Futureox blue D / artboard corner tile',fills:[paint('#3459D4')],strokes:[stroke('#3459D4',8)],network:curveNetwork([[96,32],[256,32],[480,256],[256,480],[96,480],[32,416],[32,96]],{1:[[390,32],[480,132]],2:[[480,380],[390,480]]})}}},
      {method:'node.create',params:{id:mark,parentId:frame,kind:'vector',x:0,y:0,width:512,height:512,patch:{name:'F with open D curve / editable Bezier handles',fills:[paint('#FFFFFF')],strokes:[],network:curveNetwork([[136,128],[272,128],[384,208],[320,208],[272,192],[200,192],[200,256],[304,256],[256,312],[200,312],[200,384],[136,384]],{1:[[344,128],[384,160]],3:[[320,198],[304,192]],7:[[304,290],[284,312]]})}}},
    ]
    await save('authored-operations.json',operations)
    await client.mutate('batch.apply',{operations,label:'Author original Futureox F'})
    const source=client.editor.state.doc
    expect(Object.keys(source.nodes)).toHaveLength(3)
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
      for(const size of [16,32,64,256,512,1024,1536]) {
        const request={pageId:page,nodeIds:[frame],bounds:{x:0,y:0,width:512,height:512},scale:size/512,rasterProfile:'analytic'}
        const png=Buffer.from(engine.render_region_png(JSON.stringify(request)))
        expect(png.readUInt32BE(16)).toBe(size);expect(png.readUInt32BE(20)).toBe(size)
        const name=size>=512?`futureox-desgin@${size/512}x.png`:`futureox-desgin-${size}.png`
        await save(name,png);renders.push({name,size,sha256:sha256(png),request})
      }
    }finally{engine.free()}
    await save('provenance.json',{path:'Actual JSON-RPC NDJSON → DesignMcpServer → OperationBackend → Editor/WASM native vector network creation → MCP resource export',nativeRaster:'Actual VectorEngine.render_region_png / analytic CPU from the MCP-authored document',inMemoryTransport:true,browser:false,gpu:false,svgSha256:sha256(svg.content),fdSha256:sha256(bytes),renders})
  }finally{await save('mcp-transcript.json',client.transcript);await client.close()}
},120000)
