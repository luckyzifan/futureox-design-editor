import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten'
import type { PluginStorage } from './client-storage'
import { PluginApiError, PluginClosed } from './errors'
import { matchNetworkAccess, type PluginFetch } from './network'
import { PLUGIN_LIMITS } from './limits'
import { assertPluginBundle, type PluginBundle } from './manifest'
import { PLUGIN_PRELUDE } from './prelude'
import { createPluginSession, type PluginFontJob, type PluginSystemFonts, type PluginUiState } from './session'

const CLOSED_PREFIX = '__futureox_plugin_closed__:'
let quickJsModule: ReturnType<typeof getQuickJS> | null = null

async function quickJs() {
  quickJsModule ??= getQuickJS()
  return quickJsModule
}

function guestText(context: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = context.dump(handle)
  const text = dumped && typeof dumped === 'object' && 'message' in dumped ? String((dumped as { message: unknown }).message) : String(dumped)
  return text.replace(/^Error:\s*/i, '').slice(0, 2000)
}

function closedNotice(message: string): string | null {
  const index = message.indexOf(CLOSED_PREFIX)
  return index < 0 ? null : message.slice(index + CLOSED_PREFIX.length)
}

function errorFromGuest(message: string): Error {
  if (message === 'interrupted' || message.endsWith('interrupted')) return new PluginApiError('plugin_limit', `Plugin exceeded ${PLUGIN_LIMITS.runtimeMs}ms`)
  const match = /^([a-z0-9_]+): ([\s\S]*)$/i.exec(message)
  if (match) return new PluginApiError(match[1], match[2])
  return new PluginApiError('plugin_error', message)
}

export type PluginHooks = {
  onNotify?: (message: string) => void
  onUi?: (ui: PluginUiState) => void
  onPostMessage?: (message: unknown) => void
  /** Manifest menu command. Omitted when the plugin has no menu. */
  command?: string
  storage?: PluginStorage
  /** Test double for declared-domain fetch. Production uses the platform fetch. */
  fetch?: PluginFetch
  /** Host font catalog. Production reads the desktop `fonts` bridge; the web build has none. */
  systemFonts?: PluginSystemFonts
}

export class PluginController {
  readonly notifications: readonly string[]
  readonly logs: readonly string[]
  private runtime: QuickJSRuntime | null
  private context: QuickJSContext | null
  private systemFaces: Promise<readonly import('./session').PluginSystemFontFace[] | null> | null = null
  private constructor(
    private readonly session: ReturnType<typeof createPluginSession>,
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    private readonly fetchImpl: PluginFetch | undefined,
    private readonly networkDomains: readonly string[],
    private readonly systemFonts: PluginSystemFonts | undefined,
  ) {
    this.runtime = runtime
    this.context = context
    this.notifications = session.notifications
    this.logs = session.logs
  }

  static async open(bundle: PluginBundle, editor: Parameters<typeof createPluginSession>[0], hooks?: PluginHooks) {
    assertPluginBundle(bundle)
    const quick = await quickJs()
    const runtime = quick.newRuntime()
    runtime.setMemoryLimit(PLUGIN_LIMITS.guestMemoryBytes)
    runtime.setMaxStackSize(PLUGIN_LIMITS.guestStackBytes)
    const context = runtime.newContext()
    const session = createPluginSession(editor, {
      name: bundle.manifest.name,
      pluginId: bundle.manifest.id,
      command: hooks?.command,
      uiHtml: bundle.ui,
      storage: hooks?.storage,
      networkDomains: bundle.manifest.networkDomains,
      fetch: hooks?.fetch,
      systemFonts: hooks?.systemFonts,
      hooks,
    })
    const controller = new PluginController(session, runtime, context, hooks?.fetch, bundle.manifest.networkDomains, hooks?.systemFonts)
    const host = context.newFunction('__host', (opHandle, payloadHandle) => {
      try {
        const op = context.getString(opHandle)
        const payloadText = context.getString(payloadHandle)
        if (payloadText.length > PLUGIN_LIMITS.payloadBytes) throw new PluginApiError('plugin_limit', 'Plugin payload is too large')
        const payload = JSON.parse(payloadText) as unknown
        const result = session.call(op, payload)
        return context.newString(JSON.stringify({ ok: true, result: result ?? null }))
      } catch (error) {
        if (error instanceof PluginClosed) return context.newString(JSON.stringify({ ok: false, code: 'plugin_closed', message: error.message }))
        const code = error instanceof PluginApiError ? error.code : 'plugin_failed'
        const message = error instanceof Error ? error.message : String(error)
        return context.newString(JSON.stringify({ ok: false, code, message: message.slice(0, 2000) }))
      }
    })
    context.setProp(context.global, '__host', host)
    host.dispose()
    const html = context.newString(bundle.ui ?? '')
    context.setProp(context.global, '__html__', html)
    html.dispose()
    try {
      const pending = controller.evaluate(PLUGIN_PRELUDE + '\n' + bundle.main)
      if (pending) await pending
      session.flush()
      if (session.closed || (!session.uiShown && !session.listening)) controller.release()
      return controller
    } catch (error) {
      controller.release()
      throw error
    }
  }

  get ui(): PluginUiState | null { return this.session.ui }
  get closed() { return this.session.closed }
  get closeMessage() { return this.session.closeMessage }
  get flushes() { return this.session.flushes }
  get pluginId() { return this.session.pluginId }
  get applying() { return this.session.applying }

  emit(type: 'selectionchange' | 'currentpagechange' | 'documentchange') {
    if (!this.context || this.session.closed) return
    const pending = this.evaluate(`globalThis.__deliverPluginEvent(${JSON.stringify(type)})`)
    const finish = () => { this.session.flush(); if (this.session.closed) this.release() }
    if (pending) return pending.then(finish)
    finish()
  }

  deliver(message: unknown) {
    if (!this.context) throw new PluginApiError('plugin_closed', 'The plugin has finished')
    const json = JSON.stringify(message ?? null)
    if (json.length > PLUGIN_LIMITS.messageBytes) throw new PluginApiError('message_too_large', 'Plugin UI message is too large')
    const payload = this.context.newString(json)
    this.context.setProp(this.context.global, '__pluginMessageJson', payload)
    payload.dispose()
    const pending = this.evaluate('globalThis.__deliverPluginMessage(JSON.parse(globalThis.__pluginMessageJson))')
    const finish = () => { this.session.flush(); if (this.session.closed) this.release() }
    if (pending) return pending.then(finish)
    finish()
  }

  close() { this.release() }

  private arm() {
    this.runtime?.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + PLUGIN_LIMITS.runtimeMs))
  }

  private evaluate(code: string): Promise<void> | void {
    if (!this.context) throw new PluginApiError('plugin_closed', 'The plugin has finished')
    this.arm()
    const evaluated = this.context.evalCode(code, 'plugin.js', { type: 'global' })
    try {
      if (evaluated.error) {
        const message = guestText(this.context, evaluated.error)
        if (closedNotice(message) != null) return
        throw errorFromGuest(message)
      }
      this.drain()
      if (this.session.hasNetwork() || this.session.hasFontJobs()) return this.finishAsync()
    } finally { evaluated.dispose() }
  }

  private async finishAsync() {
    while (this.session.hasNetwork() || this.session.hasFontJobs()) {
      if (this.session.hasNetwork()) {
        const job = this.session.takeNetwork()
        if (!job) break
        let payload: Record<string, unknown>
        try { payload = await performPluginFetch(job, this.fetchImpl, this.networkDomains) }
        catch (error) {
          payload = { ok: false, code: error instanceof PluginApiError ? error.code : 'network_denied', message: error instanceof Error ? error.message : String(error) }
        }
        this.inject(`globalThis.__finishFetch(${job.id}, ${JSON.stringify(payload)})`)
        this.drain()
        continue
      }
      const job = this.session.takeFontJobs()
      if (!job) break
      const payload = await this.loadSystemFont(job)
      this.inject(`globalThis.__finishFont(${JSON.stringify(job.id)}, ${JSON.stringify(payload)})`)
      this.drain()
    }
  }
  /** Resolves one loadFontAsync miss: catalog match, byte read, then the same
   * `font.import` admission (parsing, embedding rights, budgets) as any other
   * caller. The plugin promise resolves only after the document owns the font. */
  private async loadSystemFont(job: PluginFontJob): Promise<Record<string, unknown>> {
    try {
      if (!this.systemFonts) return { ok: false, code: 'font_unavailable', message: `Font ${job.family} is not loaded in this document` }
      this.systemFaces ??= this.systemFonts.list()
      const faces = await this.systemFaces
      if (!faces) return { ok: false, code: 'font_unavailable', message: 'No system font catalog is available in this build' }
      const face = this.session.matchSystemFont(faces, job.family, job.style)
      if (!face) return { ok: false, code: 'font_unavailable', message: `Font ${job.family} ${job.style} is not installed` }
      const bytes = await this.systemFonts.read({ id: face.id })
      if (!bytes) return { ok: false, code: 'font_unavailable', message: `Font ${job.family} could not be read` }
      this.session.importSystemFont(job, bytes.data, bytes.face ?? face)
      return { ok: true }
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'font_failed'
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code, message: message.slice(0, 500) }
    }
  }

  private inject(code: string) {
    if (!this.context) return
    const evaluated = this.context.evalCode(code, 'plugin-fetch.js', { type: 'global' })
    try {
      if (evaluated.error) {
        const message = guestText(this.context, evaluated.error)
        if (closedNotice(message) == null) throw errorFromGuest(message)
      }
    } finally { evaluated.dispose() }
  }

  private drain() {
    if (!this.runtime || !this.context) return
    for (let guard = 0; guard < 100 && this.runtime.hasPendingJob(); guard++) {
      const jobs = this.runtime.executePendingJobs(1000)
      try {
        if (jobs.error) {
          const message = guestText(this.context, jobs.error)
          if (closedNotice(message) == null) throw errorFromGuest(message)
        }
      } finally { jobs.dispose() }
    }
    if (this.runtime.hasPendingJob()) throw new PluginApiError('plugin_limit', 'Plugin async work did not finish')
  }

  private release() {
    const context = this.context
    const runtime = this.runtime
    this.context = null
    if (context) context.dispose()
    runtime?.dispose()
    this.runtime = null
  }
}

async function performPluginFetch(
  job: { url: string; method: string; headers: Record<string, string>; body: string | null },
  fetchImpl: PluginFetch | undefined,
  domains: readonly string[],
) {
  const result = await (fetchImpl ?? platformFetch)(job.url, {
    method: job.method, headers: job.headers, ...(job.body == null || job.method === 'GET' || job.method === 'HEAD' ? {} : { body: job.body }),
  })
  const decision = matchNetworkAccess(result.url, domains)
  if (!decision.ok) throw new PluginApiError('network_denied', 'Plugin fetch redirected outside declared domains')
  if (result.body.byteLength > 1_000_000) throw new PluginApiError('plugin_limit', 'Plugin fetch response is too large')
  let binary = ''
  for (const byte of result.body) binary += String.fromCharCode(byte)
  return { ok: true, status: result.status, url: result.url, headers: result.headers, bodyBase64: btoa(binary) }
}

async function platformFetch(input: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const response = await fetch(input, {
    method: init.method, headers: init.headers, body: init.body, redirect: 'follow', credentials: 'omit',
    signal: AbortSignal.timeout(8_000),
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers: Record<string, string> = {}
  const type = response.headers.get('content-type')
  if (type) headers['content-type'] = type
  return { status: response.status, url: response.url, headers, body: bytes }
}

export async function openPlugin(editor: Parameters<typeof createPluginSession>[0], bundle: PluginBundle, hooks?: PluginHooks) {
  return PluginController.open(bundle, editor, hooks)
}
