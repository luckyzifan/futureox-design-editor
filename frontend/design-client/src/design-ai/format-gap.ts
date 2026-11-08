import { userPages } from '../fig-document'
import { import_sketch_json } from '../generated/design-kernel/design_kernel'
import { importFig } from '../import-fig'
import type { DesignDocument, DesignNode } from '../model'
import { exportSketchDocument } from '../automation/sketch'

export type PageOutline = { name: string; frames: string[]; texts: string[] }
export type DesignOutline = { pages: PageOutline[] }
export type DesignGap = { code: 'missing-text' | 'extra-text' | 'missing-frame' | 'page-count'; detail: string }

export function outlineDocument(doc: DesignDocument): DesignOutline {
  return {
    pages: userPages(doc).map(page => {
      const frames: string[] = []
      const texts: string[] = []
      const visit = (id: string) => {
        const node = doc.nodes[id]
        if (!node) return
        if (node.kind === 'frame' || node.kind === 'section') frames.push(node.name)
        if (node.kind === 'text' && node.text.trim()) texts.push(node.text.trim())
        node.children.forEach(visit)
      }
      page.children.forEach(visit)
      return { name: page.name, frames, texts }
    }),
  }
}

export function compareOutlines(current: DesignOutline, reference: DesignOutline, label: string): DesignGap[] {
  const gaps: DesignGap[] = []
  if (current.pages.length !== reference.pages.length) {
    gaps.push({ code: 'page-count', detail: `${label}：当前 ${current.pages.length} 页，参照 ${reference.pages.length} 页` })
  }
  const currentTexts = new Set(current.pages.flatMap(page => page.texts))
  const referenceTexts = new Set(reference.pages.flatMap(page => page.texts))
  for (const text of referenceTexts) if (!currentTexts.has(text)) gaps.push({ code: 'missing-text', detail: `${label} 有「${clip(text)}」，当前页面没有` })
  for (const text of currentTexts) if (!referenceTexts.has(text)) gaps.push({ code: 'extra-text', detail: `当前页面有「${clip(text)}」，${label} 没有` })
  const currentFrames = new Set(current.pages.flatMap(page => page.frames))
  for (const frame of new Set(reference.pages.flatMap(page => page.frames))) {
    if (!currentFrames.has(frame)) gaps.push({ code: 'missing-frame', detail: `${label} 有画板「${clip(frame)}」，当前页面没有` })
  }
  return gaps.slice(0, 40)
}

export async function compareUserFile(current: DesignDocument, file: File): Promise<DesignGap[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (/\.fig$/i.test(file.name)) {
    const imported = importFig(bytes, file.name.replace(/\.fig$/i, ''))
    return compareOutlines(outlineDocument(current), outlineDocument(imported.document), file.name)
  }
  if (/\.sketch$/i.test(file.name)) {
    const opened = JSON.parse(import_sketch_json(bytes)) as { document: DesignDocument }
    return compareOutlines(outlineDocument(current), outlineDocument(opened.document), file.name)
  }
  throw new Error('请选择 .fig 或 .sketch 文件')
}

export function sketchRoundTripGaps(doc: DesignDocument): { gaps: DesignGap[]; warnings: string[] } {
  try {
    const exported = exportSketchDocument(doc)
    const bytes = Uint8Array.from(atob(exported.base64), char => char.charCodeAt(0))
    const opened = JSON.parse(import_sketch_json(bytes)) as { document: DesignDocument }
    return {
      gaps: compareOutlines(outlineDocument(doc), outlineDocument(opened.document), 'Sketch 往返'),
      warnings: exported.warnings.map(warning => warning.message),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = error && typeof error === 'object' && 'details' in error ? JSON.stringify((error as { details?: unknown }).details) : ''
    return { gaps: [{ code: 'missing-frame', detail: `Sketch 往返被真实编码器拒绝：${message}${reason ? ` ${reason}` : ''}` }], warnings: [message] }
  }
}

function clip(value: string) {
  return value.length > 48 ? `${value.slice(0, 48)}…` : value
}

export function nodeText(node: DesignNode | undefined) {
  return node?.kind === 'text' ? node.text : ''
}
