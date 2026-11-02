import type { DesignNode, Page } from '../model'

export type PluginSnapshot = {
  documentId: string
  documentName: string
  revision: number
  pageId: string
  pages: Page[]
  nodes: Record<string, DesignNode>
  selection: string[]
  viewport: { x: number; y: number; zoom: number }
}

export type PluginCommit = {
  mutated: boolean
  pageId: string
  selection: string[]
  pages: Page[] | null
  upserts: Record<string, DesignNode>
  deleted: string[]
  reveal: string[]
}

export type PluginUiState = {
  html: string
  width: number
  height: number
  title: string
  visible: boolean
}

export type PluginTurn = {
  commit: PluginCommit
  notifications: string[]
  ui: PluginUiState | null
  outbound: unknown[]
  closed: boolean
  closeMessage?: string
}

export type PluginWorkerRequest =
  | { type: 'start'; snapshot: PluginSnapshot; mainSource: string; uiHtml: string; pluginId: string; pluginName: string; command: string }
  | { type: 'ui'; pluginMessage: unknown }
  | { type: 'stop' }

export type PluginWorkerReply = { ok: true; turn: PluginTurn } | { ok: false; message: string }
