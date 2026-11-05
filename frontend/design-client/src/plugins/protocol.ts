/** 插件容器内部 RPC 协议。
 *
 * 三个参与者：
 *  - host：编辑器应用（持有 automation op 注册表与 Editor）
 *  - sandbox iframe：插件 main 代码 + figma API 垫片（sandbox="allow-scripts"，不透明源）
 *  - ui iframe：插件 ui.html（sandbox="allow-scripts ..."，不透明源）
 *
 * 消息通道约定（与 Figma 公开插件协议对齐的部分）：
 *  - UI iframe → host：`postMessage({pluginMessage: X}, '*')`（Figma 官方协议）
 *  - host → UI iframe：`postMessage({pluginMessage: X}, '*')`（Figma 官方协议）
 *  - sandbox ↔ host：本文件定义的私有信封，host 校验 event.source 后才接受。
 */

/** host → sandbox：初始化镜像（文档投影、选择集、字体表、当前页）。 */
export type PluginInitMessage = {
  type: 'plugin-init'
  documentId: string
  documentName: string
  revision: number
  pageId: string
  pages: { id: string; name: string; children: string[] }[]
  selection: string[]
  /** 当前页子树的节点投影（受 cap 限制）；id → 投影。 */
  nodes: Record<string, PluginNodeSnapshot>
  fonts: PluginFontRecord[]
  /** manifest.ui 的内容；插件 main 里以 __html__ 访问。 */
  uiHtml: string | null
}

/** host → sandbox：一次自动化操作的提交结果。 */
export type PluginOpResultMessage = {
  type: 'plugin-op-result'
  opId: number
  ok: boolean
  /** AutomationFailure.code / message。 */
  code?: string
  message?: string
  result?: unknown
  revision?: number
  /** 提交后刷新的节点投影（changed/created ids 上限截断）。 */
  refresh?: Record<string, PluginNodeSnapshot>
  removed?: string[]
  pageId?: string
  selection?: string[]
}

/** host → sandbox：UI iframe 发来的消息。 */
export type PluginUiMessage = { type: 'plugin-ui-message'; message: unknown }

/** host → sandbox：外部（用户或插件操作后）选择集变化。 */
export type PluginSelectionChangedMessage = { type: 'plugin-selection-changed'; pageId: string; selection: string[] }

/** host → sandbox：确认关闭。 */
export type PluginClosedMessage = { type: 'plugin-closed' }

/** sandbox → host：执行一个 automation 操作。 */
export type PluginOpRequest = {
  type: 'plugin-op'
  opId: number
  method: string
  params: Record<string, unknown>
}

/** sandbox → host：showUI。 */
export type PluginShowUiRequest = { type: 'plugin-show-ui'; html: string; width?: number; height?: number; themeColors?: boolean; visible?: boolean }

/** sandbox → host：UI 尺寸/可见性控制。 */
export type PluginUiControl = { type: 'plugin-ui-control'; action: 'hide' | 'show' | 'resize'; width?: number; height?: number }

/** sandbox → host：figma.ui.postMessage 的出站消息（转发给 UI iframe）。 */
export type PluginUiOutMessage = { type: 'plugin-ui-out'; message: unknown }

/** sandbox → host：notify / closePlugin / 日志。 */
export type PluginNotifyRequest = { type: 'plugin-notify'; message: string; error?: boolean; timeout?: number }
export type PluginCloseRequest = { type: 'plugin-close'; message?: string }
export type PluginLogRequest = { type: 'plugin-log'; level: 'info' | 'warn' | 'error'; message: string }

export type SandboxToHostMessage =
  | PluginOpRequest
  | PluginShowUiRequest
  | PluginUiControl
  | PluginUiOutMessage
  | PluginNotifyRequest
  | PluginCloseRequest
  | PluginLogRequest

export type HostToSandboxMessage =
  | PluginInitMessage
  | PluginOpResultMessage
  | PluginUiMessage
  | PluginSelectionChangedMessage
  | PluginClosedMessage

/** 节点投影：沙箱镜像的最小字段集（figma API 的同步读由此服务）。
 *  transform 为父局部矩阵 [a,b,c,d,tx,ty]；x/y 由 tx/ty 派生。 */
export interface PluginNodeSnapshot {
  id: string
  kind: string
  name: string
  x: number
  y: number
  width: number
  height: number
  /** 父局部矩阵 [a,b,c,d,tx,ty]。 */
  transform: number[]
  rotation: number
  visible: boolean
  locked: boolean
  opacity: number
  blend: string
  children: string[]
  parentId: string | null
  fills: unknown[]
  strokes: unknown[]
  effects: unknown[]
  radii: [number, number, number, number]
  clip: boolean
  /** text 节点 */
  text?: string
  fontSize?: number
  textStyle?: Record<string, unknown> | null
  /** polygon/star */
  points?: number
  innerRadius?: number
}

export interface PluginFontRecord {
  /** 文档字体 id（'default' 为内置默认字体）。 */
  id: string
  family: string
  /** 该字体资源可用的 weight 档位（内置默认按内置集合报告）。 */
  weights: number[]
}

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
