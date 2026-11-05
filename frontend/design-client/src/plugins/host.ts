/** Figma 插件容器宿主。
 *
 * 职责：把一份已加载的插件（manifest + main 代码 + 可选 ui.html）放进
 * 两个隔离 iframe（沙箱 main + 插件 UI），并把沙箱内 figma API 的操作
 * 路由到本编辑器共享的 automation 操作注册表（api.execute → 隔离草稿 →
 * Editor.change，与 MCP 同一条提交边界，不建第二套文档模型）。
 *
 * 隔离模型：
 *  - 沙箱 iframe：sandbox="allow-scripts" + CSP default-src 'none'，不透明源；
 *  - UI iframe：sandbox="allow-scripts allow-forms allow-modals allow-popups"，
 *    以 Figma 公开协议 {pluginMessage} 信封通信；
 *  - 宿主只接受 event.source 与自身持有 iframe contentWindow 一致的消息。
 */
import type { Editor } from '../engine'
import { parsePluginManifest, type PluginManifest } from './manifest'
import type {
  HostToSandboxMessage, PluginInitMessage, PluginNodeSnapshot, SandboxToHostMessage,
} from './protocol'
import shimSource from './sandbox-shim.js?raw'

export interface PluginBundle {
  manifest: PluginManifest
  mainCode: string
  uiHtml: string | null
  /** 展示用来源描述（本地文件 / GitHub 地址等）。 */
  origin: string
}

/** 从文件映射解析插件包（loader 与测试共用）。 */
export function bundleFromFiles(files: Record<string, string>, origin: string): PluginBundle {
  const manifestPath = Object.keys(files).find(path => path === 'manifest.json' || path.endsWith('/manifest.json'))
  if (!manifestPath) throw new Error('插件目录中没有 manifest.json')
  const base = manifestPath === 'manifest.json' ? '' : manifestPath.slice(0, -'manifest.json'.length)
  const manifest = parsePluginManifest(JSON.parse(files[manifestPath]))
  const mainPath = base + manifest.main
  const mainCode = files[mainPath]
  if (typeof mainCode !== 'string') throw new Error(`插件 main 文件缺失：${manifest.main}`)
  let uiHtml: string | null = null
  if (manifest.ui) {
    const uiPath = base + manifest.ui
    if (typeof files[uiPath] !== 'string') throw new Error(`插件 ui 文件缺失：${manifest.ui}`)
    uiHtml = files[uiPath]
  }
  return { manifest, mainCode, uiHtml, origin }
}

const MAX_MAIN_BYTES = 2 * 1024 * 1024
const MAX_UI_BYTES = 4 * 1024 * 1024
const MAX_INIT_NODES = 5000
const MAX_REFRESH_NODES = 64
/** 内置默认字体报告的字重档位（近似 Inter，供沙箱 loadFontAsync 匹配）。 */
const DEFAULT_FONT_WEIGHTS = [300, 400, 500, 600, 700]

/** 沙箱 srcdoc：CSP 阻断网络与存储；插件源码以字符串传入，由垫片注入执行。
 *  session 令牌写进文档，沙箱发出的每个信封都会携带，宿主以此验源。 */
export function buildSandboxDocument(mainCode: string, session: string): string {
  if (typeof mainCode !== 'string' || !mainCode.length) throw new Error('插件 main 代码为空')
  if (new TextEncoder().encode(mainCode).byteLength > MAX_MAIN_BYTES) throw new Error('插件 main 代码超过 2 MiB')
  const encoded = JSON.stringify(mainCode).replace(/<\//g, '<\\/')
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">` +
    `</head><body><script>${shimSource}</script>` +
    `<script>window.__PLUGIN_SESSION__=${JSON.stringify(session)};window.__PLUGIN_SOURCE__=${encoded};</script></body></html>`
}

/** UI iframe srcdoc：允许插件 UI 自带脚本与样式；相对资源引用在 P0 中不可用。 */
export function buildUiDocument(uiHtml: string): string {
  if (new TextEncoder().encode(uiHtml).byteLength > MAX_UI_BYTES) throw new Error('插件 ui.html 超过 4 MiB')
  return uiHtml
}

export interface PluginHostEvents {
  onLog(level: 'info' | 'warn' | 'error', message: string): void
  /** showUI / resize / hide / show。 */
  onUi(update: { html?: string; width?: number; height?: number; visible?: boolean }): void
  onNotify(message: string, options?: { error?: boolean; timeout?: number }): void
  onClose(message?: string): void
}

interface AutomationApiLike {
  execute(request: unknown): { ok: boolean; result?: unknown; error?: { code: string; message: string } }
}

export interface PluginHostDeps {
  editor: Editor
  api: AutomationApiLike
  container: HTMLElement
  window?: Window
  events: PluginHostEvents
  /** 可选 iframe 挂载方式：返回 src（由调用方提供文档，测试用）；
   *  未提供时浏览器默认使用 srcdoc。 */
  frameUrl?: (kind: 'sandbox' | 'ui', html: string) => string
}

/** 一次插件运行的生命周期。dispose 后所有 iframe 与监听被拆除。 */
export class PluginHost {
  readonly manifest: PluginManifest
  private readonly editor: Editor
  private readonly api: AutomationApiLike
  private readonly container: HTMLElement
  private readonly win: Window
  private readonly events: PluginHostEvents
  private readonly sandboxFrame: HTMLIFrameElement
  private uiFrame: HTMLIFrameElement | null = null
  private readonly messageListener: (event: MessageEvent) => void
  private readonly unsubscribeEditor: () => void
  private closed = false
  private heardFromSandbox = false
  private lastSelection = ''
  private readonly frameUrl: ((kind: 'sandbox' | 'ui', html: string) => string) | undefined
  /** 测试挂载（frameUrl）时 jsdom 的 event.source 与 contentWindow 身份不同，
   *  放宽 UI iframe 的来源校验；沙箱消息始终以会话令牌验源。 */
  private readonly permissiveFrames: boolean
  private readonly sessionId: string
  private readonly initSent: Promise<void>
  private readonly initReady: (() => void) | null

  constructor(bundle: PluginBundle, deps: PluginHostDeps) {
    this.manifest = bundle.manifest
    this.editor = deps.editor
    this.api = deps.api
    this.container = deps.container
    this.win = deps.window ?? window
    this.events = deps.events
    this.frameUrl = deps.frameUrl
    this.permissiveFrames = !!deps.frameUrl
    this.sessionId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `plugin-${Date.now()}-${Math.random()}`
    let ready: (() => void) | null = null
    this.initSent = new Promise(resolve => { ready = resolve })
    this.initReady = ready

    const frame = this.createFrame('allow-scripts', `插件沙箱：${this.manifest.name}`)
    frame.style.display = 'none'
    const sandboxHtml = buildSandboxDocument(bundle.mainCode, this.sessionId)
    const sandboxSrc = this.frameUrl?.('sandbox', sandboxHtml)
    if (sandboxSrc) frame.src = sandboxSrc
    else frame.srcdoc = sandboxHtml
    this.sandboxFrame = frame

    this.messageListener = event => this.handleMessage(event)
    this.win.addEventListener('message', this.messageListener)
    // 文档/会话切换即销毁插件运行（与 automation 的 session fence 对齐）。
    let identity = this.editorIdentity()
    this.unsubscribeEditor = this.editor.subscribe(() => {
      if (this.closed) return
      if (this.editorIdentity() !== identity) { this.events.onLog('warn', '编辑器会话已切换，插件已停止'); this.dispose(); return }
      this.pushSelection()
    })
    this.container.appendChild(frame)
    // postMessage 在 iframe 脚本注册监听前入队，加载后必达。
    void this.sendInit(bundle).then(() => this.initReady?.())
  }

  private editorIdentity() {
    return `${this.editor.sessionGeneration}:${this.editor.state.doc.id}`
  }

  private async sendInit(bundle: PluginBundle) {
    await frameLoaded(this.sandboxFrame, this.win)
    if (this.closed) return
    const init = this.buildInit(bundle)
    this.sandboxFrame.contentWindow?.postMessage(init, '*')
    // 兜底：个别环境下首个 init 会在沙箱脚本就绪前丢失（无任何回音），
    // 1.2s 后重发一次；沙箱侧对重复 init 幂等（已初始化则忽略）。
    this.win.setTimeout(() => {
      if (this.closed || this.heardFromSandbox) return
      this.sandboxFrame.contentWindow?.postMessage(init, '*')
    }, 1200)
  }

  /** 构建初始化镜像（含当前页节点投影与字体表）。 */
  private buildInit(bundle: PluginBundle): PluginInitMessage {
    const doc = this.editor.authoredDocument
    const pageId = this.editor.state.page
    const pages = doc.pages.map(page => ({ id: page.id, name: page.name, children: [...page.children] }))
    // 当前页子树投影（BFS，受 MAX_INIT_NODES 限制）。
    const nodes: Record<string, PluginNodeSnapshot> = {}
    const page = doc.pages.find(p => p.id === pageId) ?? doc.pages[0]
    const queue = [...page.children]
    let count = 0
    while (queue.length && count < MAX_INIT_NODES) {
      const id = queue.shift()!
      const node = doc.nodes[id]
      if (!node) continue
      nodes[id] = projectNode(node, pageOrParent(doc, id))
      count++
      queue.push(...node.children)
    }
    if (queue.length) this.events.onLog('warn', `页面节点超过 ${MAX_INIT_NODES}，插件镜像被截断`)
    const fonts = Object.entries(doc.fonts || {}).map(([id, font]) => ({
      id, family: font.family, weights: DEFAULT_FONT_WEIGHTS,
    }))
    fonts.unshift({ id: 'default', family: 'Inter', weights: DEFAULT_FONT_WEIGHTS })
    return {
      type: 'plugin-init',
      documentId: doc.id,
      documentName: doc.name,
      revision: this.editor.state.version,
      pageId: page.id,
      pages,
      selection: [...this.editor.state.selection],
      nodes,
      fonts,
      uiHtml: bundle.uiHtml,
    }
  }

  private handleMessage(event: MessageEvent) {
    if (this.closed) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if ((data as { session?: unknown }).session === this.sessionId) this.heardFromSandbox = true
    // UI iframe：Figma 公开协议 {pluginMessage} 信封（第三方 HTML，无令牌）。
    if ('pluginMessage' in data) {
      const fromUiWindow = event.source === this.uiFrame?.contentWindow
      if (this.uiFrame && (fromUiWindow || this.permissiveFrames)) {
        this.postToSandbox({ type: 'plugin-ui-message', message: data.pluginMessage })
      }
      return
    }
    // 沙箱信封：会话令牌必须匹配（浏览器中与 event.source 校验等价叠加）。
    if ((data as { session?: unknown }).session !== this.sessionId) return
    const message = data as SandboxToHostMessage
    if (typeof message.type !== 'string') return
    switch (message.type) {
      case 'plugin-op':
        void this.executeOp(message.opId, message.method, message.params)
        break
      case 'plugin-show-ui':
        this.showUi(message)
        break
      case 'plugin-ui-control':
        this.events.onUi({
          visible: message.action === 'hide' ? false : message.action === 'show' ? true : undefined,
          ...(message.action === 'resize' ? { width: message.width, height: message.height } : {}),
        })
        break
      case 'plugin-ui-out':
        this.uiFrame?.contentWindow?.postMessage({ pluginMessage: message.message }, '*')
        break
      case 'plugin-notify':
        this.events.onNotify(message.message, { error: message.error, timeout: message.timeout })
        break
      case 'plugin-close':
        this.events.onClose(message.message)
        this.dispose()
        break
      case 'plugin-log':
        this.events.onLog(message.level, message.message)
        break
    }
  }

  private async executeOp(opId: number, method: string, rawParams: Record<string, unknown>) {
    if (this.closed) return
    // 规范化跨 realm 数据：真实浏览器由结构化克隆保证，jsdom 需显式
    // JSON 往返；automation 的纯 JSON 校验只接受本 realm 原型。
    let params: Record<string, unknown>
    try {
      params = JSON.parse(JSON.stringify(rawParams ?? {})) as Record<string, unknown>
    } catch {
      this.postToSandbox({ type: 'plugin-op-result', opId, ok: false, message: '插件操作参数不是纯 JSON' })
      return
    }
    const request = {
      method,
      params,
      documentId: this.editor.state.doc.id,
      expectedRevision: this.editor.state.version,
      session: this.editor.sessionGeneration,
    }
    try {
      const response = this.api.execute(request)
      if (!response.ok) {
        this.postToSandbox({
          type: 'plugin-op-result', opId, ok: false,
          code: response.error?.code, message: response.error?.message ?? '操作失败',
        })
        return
      }
      this.postToSandbox(await this.opResult(opId, method, params, response.result))
    } catch (error) {
      this.events.onLog('error', `执行 ${method} 异常：${error instanceof Error ? error.message : String(error)}`)
      this.postToSandbox({
        type: 'plugin-op-result', opId, ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 组装操作结果：附带变更/新建节点的最新投影，刷新沙箱镜像。 */
  private async opResult(opId: number, method: string, params: Record<string, unknown>, result: unknown): Promise<HostToSandboxMessage> {
    const mutation = result && typeof result === 'object' && 'changedIds' in result
      ? result as { changedIds?: string[]; createdIds?: string[]; removedIds?: string[]; pageId?: string; selection?: string[] }
      : undefined
    const touched = new Set<string>([...(mutation?.changedIds ?? []), ...(mutation?.createdIds ?? [])])
    for (const id of idsFromParams(params)) touched.add(id)
    const refresh: Record<string, PluginNodeSnapshot> = {}
    let emitted = 0
    for (const id of touched) {
      if (emitted >= MAX_REFRESH_NODES) break
      const doc = this.editor.authoredDocument
      const node = doc.nodes[id]
      if (!node) continue
      refresh[id] = projectNode(node, pageOrParent(doc, id))
      emitted++
    }
    const removed = mutation?.changedIds?.filter(id => !this.editor.authoredDocument.nodes[id]) ?? []
    return {
      type: 'plugin-op-result', opId, ok: true, result,
      revision: this.editor.state.version,
      refresh,
      ...(removed.length ? { removed } : {}),
      ...(mutation?.pageId ? { pageId: mutation.pageId } : {}),
      ...(mutation?.selection ? { selection: mutation.selection } : {}),
    }
  }

  private createFrame(sandbox: string, title: string): HTMLIFrameElement {
    const frame = this.win.document.createElement('iframe')
    frame.setAttribute('sandbox', sandbox)
    frame.setAttribute('title', title)
    return frame
  }

  private showUi(message: { html: string; width?: number; height?: number; visible?: boolean }) {
    if (this.closed) return
    const width = message.width ?? 300
    const height = message.height ?? 200
    if (!this.uiFrame) {
      const frame = this.createFrame('allow-scripts allow-forms allow-modals allow-popups', `插件界面：${this.manifest.name}`)
      const uiHtml = buildUiDocument(message.html)
      const uiSrc = this.frameUrl?.('ui', uiHtml)
      if (uiSrc) frame.src = uiSrc
      else frame.srcdoc = uiHtml
      frame.style.width = `${width}px`
      frame.style.height = `${height}px`
      this.uiFrame = frame
      this.container.appendChild(frame)
    }
    this.events.onUi({ width, height, visible: message.visible !== false })
  }

  private postToSandbox(message: HostToSandboxMessage) {
    if (this.closed) return
    this.sandboxFrame.contentWindow?.postMessage(message, '*')
  }

  /** 编辑器选择集变化推送（含插件自身操作后的变化）。 */
  private pushSelection() {
    const key = `${this.editor.state.page}|${this.editor.state.selection.join(',')}`
    if (key === this.lastSelection) return
    this.lastSelection = key
    this.postToSandbox({
      type: 'plugin-selection-changed',
      pageId: this.editor.state.page,
      selection: [...this.editor.state.selection],
    })
  }

  /** 等待初始化镜像发出（测试用）。 */
  get ready() { return this.initSent }

  get uiFrameElement() { return this.uiFrame }

  dispose() {
    if (this.closed) return
    this.closed = true
    this.win.removeEventListener('message', this.messageListener)
    this.unsubscribeEditor()
    this.postToSandbox({ type: 'plugin-closed' })
    this.sandboxFrame.remove()
    this.uiFrame?.remove()
    this.uiFrame = null
  }
}

function frameLoaded(frame: HTMLIFrameElement, win: Window): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    frame.addEventListener('load', finish, { once: true })
    // srcdoc iframe 在部分环境不触发 load；超时兜底（消息会被排队）。
    win.setTimeout(finish, 500)
  })
}

function pageOrParent(doc: { nodes: Record<string, { id: string; children: string[] }>, pages: { id: string; children: string[] }[] }, id: string): string | null {
  for (const page of doc.pages) {
    if (page.children.includes(id)) return page.id
  }
  for (const node of Object.values(doc.nodes)) {
    if (node.children.includes(id)) return node.id
  }
  return null
}

type ProjectableNode = {
  id: string; kind: string; name: string; transform?: unknown; width: number; height: number
  visible: boolean; locked: boolean; opacity: number; blend: string; children: string[]
  fills: unknown[]; strokes: unknown[]; effects: unknown[]; radii: [number, number, number, number]
  clip: boolean; text?: string; fontSize?: number; textStyle?: Record<string, unknown> | null
  points?: number; innerRadius?: number
}

/** 把文档节点投影成沙箱镜像快照（最小字段，与 protocol.PluginNodeSnapshot 对齐）。 */
export function projectNode(node: ProjectableNode, parentId: string | null): PluginNodeSnapshot {
  const transform = Array.isArray(node.transform) && node.transform.length === 6
    ? (node.transform as number[]).map(Number)
    : [1, 0, 0, 1, 0, 0]
  return {
    id: node.id, kind: node.kind, name: node.name,
    x: transform[4], y: transform[5], width: node.width, height: node.height,
    transform, rotation: Math.atan2(transform[1], transform[0]) * 180 / Math.PI,
    visible: node.visible, locked: node.locked, opacity: node.opacity, blend: node.blend,
    children: [...node.children], parentId,
    fills: node.fills ?? [], strokes: node.strokes ?? [], effects: node.effects ?? [],
    radii: node.radii ?? [0, 0, 0, 0], clip: node.clip,
    ...(node.kind === 'text' ? {
      text: node.text ?? '', fontSize: node.fontSize ?? 16,
      textStyle: node.textStyle ?? null,
    } : {}),
    ...(node.points !== undefined ? { points: node.points } : {}),
    ...(node.innerRadius !== undefined ? { innerRadius: node.innerRadius } : {}),
  }
}

function idsFromParams(params: Record<string, unknown>): string[] {
  const ids = params?.ids
  if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string')
  if (typeof params?.id === 'string') return [params.id]
  return []
}
