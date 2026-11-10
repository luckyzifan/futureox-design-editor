import { assertImportInputBytes } from './import-input-policy'
import { pinDocumentCapacity } from './document-capacity'
import { importFig } from './import-fig'
import { finalizeFigWarnings } from './import-warnings'
import { abeezeeLineBreakDiagnostic, fontDigestDiagnostic, fontDownloadFor, matchBundledImportFonts, retainedFontWarnings } from './bundled-import-fonts'
import { initializeKernelModule } from './kernel/module'
import { uid, type DesignDocument } from './model'
type FileJob = { name: string; format: 'fig' | 'sketch' | 'sketch-library' | 'pdf' } & ({ bytes: ArrayBuffer } | { file: File })
  | { document: DesignDocument; format: 'sketch-export' }
  | { name: string; format: 'sketch-with-libraries'; project: ArrayBuffer | File; libraries: Array<ArrayBuffer | File> }

const SKETCH_LIBRARY_COUNT_MESSAGE = '打开前请附上 1 到 8 个本地 .sketch 库'

function sketchByteSource(value: unknown): { size: number; read?: () => Promise<ArrayBuffer>; buffer?: ArrayBuffer } {
  if (value instanceof ArrayBuffer) return { size: value.byteLength, buffer: value }
  if (value && typeof value === 'object' && typeof (value as File).arrayBuffer === 'function' && typeof (value as File).size === 'number') {
    const file = value as File
    return { size: file.size, read: () => file.arrayBuffer() }
  }
  throw new Error('Sketch 库必须是未读取的文件或已校验的字节')
}

self.onmessage = async (event: MessageEvent<FileJob & { memoryBytes?: number }>) => {
  let importStage = 238 // initialize
  try {
    if (event.data.memoryBytes !== undefined) pinDocumentCapacity(event.data.memoryBytes, 'trusted-worker-bootstrap')
    if (event.data.format === 'sketch-with-libraries') {
      const libraries = event.data.libraries
      if (!Array.isArray(libraries) || libraries.length < 1 || libraries.length > 8) throw new Error(SKETCH_LIBRARY_COUNT_MESSAGE)
      const parts = [sketchByteSource(event.data.project), ...libraries.map(sketchByteSource)]
      for (const part of parts) assertImportInputBytes(part.size)
      importStage = 231 // read
      self.postMessage({ kind: 'import-stage', importStage })
      const buffers: ArrayBuffer[] = []
      for (const part of parts) {
        const read = part.buffer ?? await part.read!()
        assertImportInputBytes(read.byteLength)
        buffers.push(read)
      }
      await initializeKernelModule()
      const kernel = await import('./generated/design-kernel/design_kernel') as {
        import_sketch_with_libraries_json?: (bytes: Uint8Array, libraries: Uint8Array[]) => string
      }
      if (typeof kernel.import_sketch_with_libraries_json !== 'function') {
        throw new Error('当前内核不能在打开前附上 Sketch 库')
      }
      importStage = 233 // decode
      const [project, ...attached] = buffers
      const result = JSON.parse(kernel.import_sketch_with_libraries_json(new Uint8Array(project), attached.map(buffer => new Uint8Array(buffer))))
      result.document.id = uid()
      result.document.name = event.data.name || result.document.name
      self.postMessage({ result })
      return
    }
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
      const warnings=retainedFontWarnings(result.warnings, fonts)
      for(const item of fonts.digestMismatches){
        const message=fontDigestDiagnostic(item.name, item.digest)
        if(!warnings.includes(message)) warnings.push(message)
      }
      for(const item of fonts.substitutions){
        const message=`字体 ${item.from} 没有同名文件，已用 ${item.face} 显示`
        if(!warnings.includes(message)) warnings.push(message)
      }
      for(const name of fonts.missing){
        if(fonts.digestMismatches.some(item => item.name === name)) continue
        const specific=abeezeeLineBreakDiagnostic(name)
        const link=fontDownloadFor(name)
        const message=specific??(link?`字体 ${name} 未捆绑。许可 ${link.license}，下载：${link.url}`:`字体 ${name} 未捆绑，文字已保留，显示用当前回退。`)
        if(!warnings.includes(message)) warnings.push(message)
      }
      const report=finalizeFigWarnings(warnings, result.droppedOccurrences ?? 0)
      result.warnings=report.warnings
      if(report.droppedOccurrences) result.droppedOccurrences=report.droppedOccurrences
      else delete result.droppedOccurrences
      self.postMessage({ result })
    } else throw new Error('不支持的导入格式')
  } catch (error) {
    self.postMessage({ importStage, error: error instanceof Error ? error.message : String(error) })
  }
}
