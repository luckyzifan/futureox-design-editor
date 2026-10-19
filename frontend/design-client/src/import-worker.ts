import { importFig } from './import-fig'
import { initializeKernelModule } from './kernel/module'
import { uid, type DesignDocument } from './model'
type FileJob = { bytes: ArrayBuffer; name: string; format: 'fig' | 'sketch' | 'pdf' }
  | { document: DesignDocument; format: 'sketch-export' }
self.onmessage = async (event: MessageEvent<FileJob>) => {
  try {
    if (event.data.format === 'sketch-export') {
      await initializeKernelModule()
      const { export_sketch_json } = await import('./generated/design-kernel/design_kernel')
      const bytes = new Uint8Array(export_sketch_json(JSON.stringify(event.data.document))).buffer
      self.postMessage({ bytes }, { transfer: [bytes] })
      return
    }
    const bytes = new Uint8Array(event.data.bytes)
    if (event.data.format === 'sketch') {
      await initializeKernelModule()
      const { import_sketch_json } = await import('./generated/design-kernel/design_kernel')
      const result = JSON.parse(import_sketch_json(bytes))
      result.document.id = uid()
      result.document.name = event.data.name || result.document.name
      self.postMessage({ result })
    } else if (event.data.format === 'pdf') {
      await initializeKernelModule()
      const { import_pdf_json } = await import('./generated/design-kernel/design_kernel')
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
      self.postMessage({ result: importFig(bytes, event.data.name) })
    } else throw new Error('不支持的导入格式')
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
