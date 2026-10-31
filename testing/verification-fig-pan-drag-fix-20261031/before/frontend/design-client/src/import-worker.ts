import { assertImportInputBytes } from './import-input-policy'
import { pinDocumentCapacity } from './document-capacity'
import { importFig } from './import-fig'
import { matchBundledImportFonts } from './bundled-import-fonts'
import { initializeKernelModule } from './kernel/module'
import { uid, type DesignDocument } from './model'
type FileJob = { name: string; format: 'fig' | 'sketch' | 'sketch-library' | 'pdf' } & ({ bytes: ArrayBuffer } | { file: File })
  | { document: DesignDocument; format: 'sketch-export' }
self.onmessage = async (event: MessageEvent<FileJob & { memoryBytes?: number }>) => {
  let importStage = 238 // initialize
  try {
    if (event.data.memoryBytes !== undefined) pinDocumentCapacity(event.data.memoryBytes, 'trusted-worker-bootstrap')
    if (event.data.format === 'sketch-export') {
      await initializeKernelModule()
      const { export_sketch_json } = await import('./generated/design-kernel/design_kernel')
      const bytes = new Uint8Array(export_sketch_json(JSON.stringify(event.data.document))).buffer
      self.postMessage({ bytes }, { transfer: [bytes] })
      return
    }
    let source: ArrayBuffer
    if ('file' in event.data) {
      // Recheck in this realm before allocating. File/Blob is not transferable;
      // only the eventual ArrayBuffer exists as a JS-owned buffer in this worker.
      assertImportInputBytes(event.data.file.size)
      importStage = 231 // read
      self.postMessage({ kind: 'import-stage', importStage })
      source = await event.data.file.arrayBuffer()
      importStage = 238 // initialize
      self.postMessage({ kind: 'import-stage', importStage })
    } else source = event.data.bytes
    assertImportInputBytes(source.byteLength)
    const bytes = new Uint8Array(source)
    if (event.data.format === 'sketch' || event.data.format === 'sketch-library') {
      await initializeKernelModule()
      const { import_sketch_json } = await import('./generated/design-kernel/design_kernel')
      importStage = 233 // decode
      const result = JSON.parse(import_sketch_json(bytes))
      if (event.data.format !== 'sketch-library') result.document.id = uid()
      result.document.name = event.data.name || result.document.name
      self.postMessage({ result })
    } else if (event.data.format === 'pdf') {
      await initializeKernelModule()
      const { import_pdf_json } = await import('./generated/design-kernel/design_kernel')
      importStage = 233 // decode
      const document = JSON.parse(import_pdf_json(bytes))
      document.id = uid()
      // The PDF codec uses local sequential identifiers. Give the imported
      // tree host-independent UUIDs before shared document admission.
      const ids = new Map<string, string>(Object.keys(document.nodes).map(id => [id, uid()]))
      document.nodes = Object.fromEntries(Object.entries(document.nodes).map(([id, value]) => {
        const node = value as DesignDocument['nodes'][string]
        const next = { ...node, id: ids.get(id)!, children: node.children.map(child => ids.get(child)!) }
        return [next.id, next]
      }))
      document.pages = document.pages.map((page: DesignDocument['pages'][number]) => ({
        ...page, id: uid(), children: page.children.map(child => ids.get(child)!),
      }))
      document.name = event.data.name || document.name
      self.postMessage({ result: { document, warnings: ['PDF 文本内容未导入；矢量路径与图像已转换为可编辑图层'] } })
    } else if (event.data.format === 'fig') {
      await initializeKernelModule()
      importStage = 233 // decode
      const result=importFig(bytes,event.data.name)
      const fonts=await matchBundledImportFonts(result.document)
      result.warnings=result.warnings.filter(warning=>{
        const family=/^字体 (.+) 尚需匹配，已保留文字内容$/.exec(warning)?.[1]
        return !family||!fonts.families.includes(family)||fonts.missing.some(name=>name===family||name.startsWith(family+'-')||name.startsWith(family+' '))
      })
      self.postMessage({ result })
    } else throw new Error('不支持的导入格式')
  } catch (error) {
    self.postMessage({ importStage, error: error instanceof Error ? error.message : String(error) })
  }
}
