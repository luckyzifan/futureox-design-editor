import type { DesignDocument, Page } from './model'

/** Inert Figma file receipt. It round-trips through save/open and does not execute variables. */
export type FigDocumentReceipt = {
  source: 'figma'
  documentId?: string
  colorProfile?: string
  internalPages?: string[]
  notes?: string[]
  variables?: unknown
  unusableDocumentName?: string
}

export function figReceipt(doc: DesignDocument): FigDocumentReceipt | undefined {
  const value = doc.designSystem?.sketchContainers?.figDocument
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as FigDocumentReceipt
}

export function internalPageIds(doc: DesignDocument): string[] {
  const ids = figReceipt(doc)?.internalPages
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && doc.pages.some(page => page.id === id)) : []
}

/** Pages a person can switch to. Hidden Figma canvases stay in the file so component masters remain reachable. */
export function userPages(doc: DesignDocument): Page[] {
  const hidden = new Set(internalPageIds(doc))
  const visible = doc.pages.filter(page => !hidden.has(page.id))
  return visible.length ? visible : doc.pages
}

/** Figma keeps at least one page in the page list. A hidden canvas does not count as that page. */
export function canDeletePage(doc: DesignDocument, pageId: string): boolean {
  if (!doc.pages.some(page => page.id === pageId) || doc.pages.length <= 1) return false
  const visible = userPages(doc)
  return !(visible.length === 1 && visible[0].id === pageId)
}
