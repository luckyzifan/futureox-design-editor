import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { CanvasAction } from '../canvas-action-diagnostics'
import { NODE_FIELDS } from './node-input-descriptors'
import { createEditorDesignAutomation } from './index'
import { attachDesktopAutomation, type DesktopAutomationTransport } from './bridge'
import { buildOperationCoverage, UNIMPLEMENTED_SEMANTIC_METHODS, type CoverageMethod } from './operation-coverage'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
// @ts-expect-error The native host is a tested JavaScript module without declarations.
import { WORKSPACE_AUTOMATION_METHODS } from '../../../design-desktop/src/workspace-automation.mjs'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
function fixture() {
  const document=blank('Coverage'), rectangle=node('rectangle')
  document.nodes[rectangle.id]=rectangle;document.pages[0].children.push(rectangle.id)
  const editor=new Editor(document);cleanup.push(()=>editor.dispose())
  const api=createEditorDesignAutomation(editor);cleanup.push(()=>api.dispose())
  let mounted:CoverageMethod[]=[]
  const transport={
    register:vi.fn(async (value:{methods:CoverageMethod[]}|null)=>{if(value)mounted=value.methods}),
    onRequest:()=>()=>{},onCancel:()=>()=>{},
    recordEdit:async()=>({accepted:true}),respond:async()=>{},
  } as unknown as DesktopAutomationTransport
  cleanup.push(attachDesktopAutomation(editor,transport,{api}))
  const host=WORKSPACE_AUTOMATION_METHODS as CoverageMethod[]
  const descriptors=[...mounted,...host]
  // Catalog construction does not enable a bridge, open a listener, grant
  // access, perform native host actions or start a renderer.
  const backend=new OperationBackend({capabilities:{version:1,methods:descriptors},execute:r=>api.execute(r),
    scope:'write',grants:{workspace:'write',settings:'write'}})
  const fence=()=>({documentId:editor.state.doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version})
  return {editor,rectangle,api,mounted,host,descriptors,backend,fence}
}

it('generates every UI category and actual shared/host descriptor without claiming full behavioral parity',async()=>{
  const f=fixture(),manifest=buildOperationCoverage({shared:f.api.methods(),mounted:f.mounted,host:f.host,advertisedTools:f.backend.listTools()})
  expect(manifest.ui.map(row=>row.action).sort()).toEqual(Object.keys(CanvasAction).sort())
  expect(manifest.operations.map(row=>row.method).sort()).toEqual(f.descriptors.map(row=>row.name).sort())
  expect(manifest.operations.every(row=>row.advertised)).toBe(true)
  expect(manifest.ui.flatMap(row=>row.methods).every(row=>row.registered&&row.advertised)).toBe(true)
  expect(new Set(manifest.operations.map(row=>row.tool)).size).toBe(manifest.operations.length)
  expect(manifest.importSemantics).toMatchObject({uiOpen:'new-copy',mcpImport:'append'})
  expect(manifest.collaboration).toEqual({backend:false,authenticatedActors:false,remoteApply:false,conflictMerge:false,authorityFromLocalProfile:false})
  expect(manifest.ui.find(row=>row.action==='scale')?.status).toBe('partial')
  expect(manifest.ui.find(row=>row.action==='import')?.status).toBe('partial')
  const output=process.env.FUTUREOX_COVERAGE_MANIFEST
  if(output){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({...manifest,nodeInputFields:[...NODE_FIELDS].sort()},null,2)+'\n')}
})

it('generates read-only and ungranted coverage from actual filtering, never from a universal tool count',()=>{
  const f=fixture()
  const backend=new OperationBackend({capabilities:{version:1,methods:f.descriptors},execute:r=>f.api.execute(r),scope:'read'})
  const manifest=buildOperationCoverage({shared:f.api.methods(),mounted:f.mounted,host:f.host,advertisedTools:backend.listTools()})
  expect(manifest.operations.filter(row=>row.advertised).every(row=>!row.mutates&&row.grant==='document')).toBe(true)
  expect(manifest.operations.some(row=>row.mutates&&!row.advertised)).toBe(true)
  expect(manifest.operations.filter(row=>row.boundary==='native-host').every(row=>!row.advertised)).toBe(true)
})

it.each(UNIMPLEMENTED_SEMANTIC_METHODS)('unsupported %s is absent and fails explicitly without state/history changes',async method=>{
  const f=fixture(),before=f.editor.state.doc,revision=f.editor.state.version
  expect(f.descriptors.some(row=>row.name===method)).toBe(false)
  expect(f.api.execute({method,...f.fence()})).toMatchObject({ok:false,error:{code:'unsupported_method'}})
  await expect(f.backend.callTool(`design_${method.replaceAll('.','_')}`,{params:{},...f.fence()})).rejects.toMatchObject({code:'unsupported_method'})
  expect(f.editor.state.doc).toBe(before);expect(f.editor.state.version).toBe(revision);expect(f.editor.canUndo).toBe(false)
})

it('unsupported import modes/formats fail instead of silently switching append into replacement',()=>{
  const f=fixture(),before=f.editor.state.doc
  for(const params of [
    {format:'fig',base64:'AAAA'},
    {format:'pdf',base64:'AAAA'},
    {format:'native-json',document:blank(),mode:'new-copy'},
    {format:'native-json',document:blank(),mode:'replace'},
  ])expect(f.api.execute({method:'document.import',params,...f.fence()})).toMatchObject({ok:false,error:{code:'invalid_params'}})
  expect(f.editor.state.doc).toBe(before);expect(f.editor.canUndo).toBe(false)
})

it('caller-supplied actor/admin/source metadata cannot grant authority or forge provenance',()=>{
  const f=fixture(),before=f.editor.state.doc
  for(const field of ['actorId','role','source','permissions']) {
    expect(f.api.execute({method:'node.update',params:{ids:[f.rectangle.id],patch:{name:'No'}},...f.fence(),[field]:'admin'}))
      .toMatchObject({ok:false,error:{code:'invalid_request'}})
  }
  const restricted=createEditorDesignAutomation(f.editor,{grants:[]})
  try {
    expect(restricted.execute({method:'node.update',params:{ids:[f.rectangle.id],patch:{name:'No'}},...f.fence()}))
      .toMatchObject({ok:false,error:{code:'permission_denied'}})
  } finally {restricted.dispose()}
  expect(f.editor.state.doc).toBe(before);expect(f.editor.canUndo).toBe(false)
})
