import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten'
import { AutomationError } from '../../automation/types'
import type { PluginStorage, PluginStorageRequest } from './client-storage'
import { PluginApiError, PluginClosed } from './errors'
import { matchNetworkAccess, type PluginFetch } from './network'
import { PLUGIN_LIMITS } from './limits'
import { assertPluginBundle, pluginEditorType, type PluginBundle, type PluginLaunchMode } from './manifest'
import { PLUGIN_PRELUDE } from './prelude'
import { createPluginSession, type PluginFontJob, type PluginSystemFonts, type PluginUiState } from './session'
import type { PluginDocumentChanges } from './document-changes'
import type { PluginEditorEvent } from './ui-document'

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
  onError?: (error: unknown) => void
  /** The guest finished itself with closePlugin. Host-initiated stop does not fire it. */
  onClose?: (message: string) => void
  /** Manifest menu command. Omitted when the plugin has no menu. */
  command?: string
  mode?: PluginLaunchMode
  isModeCurrent?: () => boolean
  signal?: AbortSignal
  storage?: PluginStorage
  storageRequest?: PluginStorageRequest
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
  private readonly asyncResults = new Set<QuickJSHandle>()
  private readonly intervalResults = new Set<QuickJSHandle>()
  private readonly exportAbort = new AbortController()
  private currentTurn: Promise<void> | null = null
  private queuedTurns = 0
  private cancelTimerWait: (() => void) | null = null
  private intervalWakeup: ReturnType<typeof setTimeout> | null = null
  private intervalTurnPending = false
  private readonly stopOnAbort = () => { queueMicrotask(() => this.close()) }
  private systemFaces: Promise<readonly import('./session').PluginSystemFontFace[] | null> | null = null
  private constructor(
    private readonly session: ReturnType<typeof createPluginSession>,
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    private readonly fetchImpl: PluginFetch | undefined,
    private readonly networkDomains: readonly string[],
    private readonly systemFonts: PluginSystemFonts | undefined,
    private readonly signal: AbortSignal | undefined,
    private readonly onError: PluginHooks['onError'],
  ) {
    this.runtime = runtime
    this.context = context
    this.notifications = session.notifications
    this.logs = session.logs
    this.signal?.addEventListener('abort', this.stopOnAbort, { once: true })
  }

  static async open(bundle: PluginBundle, editor: Parameters<typeof createPluginSession>[0], hooks?: PluginHooks) {
    assertPluginBundle(bundle)
    const mode = hooks?.mode ?? 'default'
    const editorType = pluginEditorType(mode)
    if (!bundle.manifest.editorType.includes(editorType))
      throw new PluginApiError('unsupported_editor_type', `Plugin does not support the ${editorType === 'dev' ? 'Dev inspection' : 'Figma design'} context`)
    hooks?.signal?.throwIfAborted()
    const quick = await quickJs()
    hooks?.signal?.throwIfAborted()
    if (hooks?.isModeCurrent && !hooks.isModeCurrent())
      throw new PluginApiError('editor_mode_changed', 'The editor mode changed before the plugin started')
    const runtime = quick.newRuntime()
    runtime.setMemoryLimit(PLUGIN_LIMITS.guestMemoryBytes)
    runtime.setMaxStackSize(PLUGIN_LIMITS.guestStackBytes)
    const context = runtime.newContext()
    const session = createPluginSession(editor, {
      name: bundle.manifest.name,
      pluginId: bundle.manifest.id,
      command: hooks?.command,
      mode,
      isModeCurrent: hooks?.isModeCurrent,
      uiHtml: bundle.ui,
      storage: hooks?.storage,
      storageRequest: hooks?.storageRequest,
      networkDomains: bundle.manifest.networkDomains,
      fetch: hooks?.fetch,
      systemFonts: hooks?.systemFonts,
      hooks,
    })
    const controller = new PluginController(session, runtime, context, hooks?.fetch, bundle.manifest.networkDomains, hooks?.systemFonts, hooks?.signal, hooks?.onError)
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
    if (bundle.uiFiles) {
      const uiFiles = context.newObject(context.null)
      for (const [name, content] of Object.entries(bundle.uiFiles)) {
        const file = context.newString(content)
        context.setProp(uiFiles, name, file)
        file.dispose()
      }
      context.setProp(context.global, '__uiFiles__', uiFiles)
      uiFiles.dispose()
    }
    try {
      const pending = controller.evaluate(PLUGIN_PRELUDE + '\n' + bundle.main)
      if (pending) await pending
      hooks?.signal?.throwIfAborted()
      controller.finishTurn()
      return controller
    } catch (error) {
      // A failed turn drops only the unflushed queue. commitUndo, closePlugin,
      // export, and reads that already flushed stay in the undo history.
      session.abandonTurn()
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

  watches(type: PluginEditorEvent) { return this.session.watches(type) }

  emit(type: PluginEditorEvent, change?: PluginDocumentChanges) {
    return this.dispatch(`globalThis.__deliverPluginEvent(${JSON.stringify(type)}, ${JSON.stringify(change ?? null)})`)
  }

  deliver(message: unknown) {
    if (!this.context) throw new PluginApiError('plugin_closed', 'The plugin has finished')
    const json = JSON.stringify(message ?? null)
    if (json.length > PLUGIN_LIMITS.messageBytes) throw new PluginApiError('message_too_large', 'Plugin UI message is too large')
    return this.dispatch(`globalThis.__deliverPluginMessage(JSON.parse(${JSON.stringify(json)}))`)
  }

  close() {
    this.session.abandonTurn()
    this.release()
  }

  private dispatch(code: string | (() => string | undefined)): Promise<void> | void {
    const run = () => {
      if (!this.context || this.session.closed) return
      const fail = (error: unknown) => { this.close(); throw error }
      try {
        const source = typeof code === 'function' ? code() : code
        const pending = source === undefined ? undefined : this.evaluate(source)
        if (pending) return pending.then(() => this.finishTurn()).catch(fail)
        this.finishTurn()
      } catch (error) { fail(error) }
    }
    const previous = this.currentTurn
    let completion
    if (previous) {
      if (this.queuedTurns >= PLUGIN_LIMITS.pendingTurns) throw new PluginApiError('plugin_limit', 'Too many pending plugin messages')
      this.queuedTurns += 1
      completion = previous.then(run).finally(() => { this.queuedTurns -= 1 })
    } else completion = run()
    if (!completion) return
    this.currentTurn = completion
    const clear = () => { if (this.currentTurn === completion) this.currentTurn = null }
    void completion.then(clear, clear)
    return completion
  }

  private finishTurn() {
    if (!this.context) return
    this.session.flush()
    if (this.session.closed || (!this.session.uiShown && !this.session.listening && !this.session.nextInterval())) this.release()
    else this.scheduleInterval()
  }

  private scheduleInterval() {
    if (this.intervalWakeup !== null) clearTimeout(this.intervalWakeup)
    this.intervalWakeup = null
    if (!this.context || this.session.closed || this.intervalTurnPending) return
    const next = this.session.nextInterval()
    if (!next) return
    this.intervalWakeup = setTimeout(() => {
      this.intervalWakeup = null
      this.intervalTurnPending = true
      const complete = () => { this.intervalTurnPending = false; this.scheduleInterval() }
      const fail = (error: unknown) => { this.close(); this.onError?.(error) }
      try {
        const turn = this.dispatch(() => this.session.advanceInterval(next.id)
          ? `globalThis.__deliverPluginTimer(${next.id})` : undefined)
        if (turn) void turn.then(complete, fail)
        else complete()
      } catch (error) { fail(error) }
    }, Math.max(0, Math.ceil(next.due - performance.now())))
  }

  private waitForTimer(delay: number) {
    return new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(handle)
        this.cancelTimerWait = null
        resolve()
      }
      const handle = setTimeout(finish, Math.max(0, delay))
      this.cancelTimerWait = finish
    })
  }

  private evaluate(code: string): Promise<void> | void {
    if (!this.context || !this.runtime) throw new PluginApiError('plugin_closed', 'The plugin has finished')
    const deadline = performance.now() + PLUGIN_LIMITS.runtimeMs
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + PLUGIN_LIMITS.runtimeMs))
    const result = this.evalGuest(code)
    if (!result) return
    try {
      this.drain()
      this.observeIntervalResults()
      const waiting = this.completionPending(result)
      if (!this.session.closed && (this.session.hasNetwork() || this.session.hasFontJobs() || this.session.hasExportJobs() || this.session.hasTimers() || this.session.hasStorageJobs())) {
        // Hold completion promises so an asynchronous throw reaches the
        // caller, and dispose them before closing a suspended QuickJS turn.
        this.asyncResults.add(result)
        return this.finishAsync(deadline).then(() => {
          this.observeIntervalResults()
          for (const completion of this.asyncResults) {
            if (this.completionPending(completion) && this.retainForInterval(completion)) this.asyncResults.delete(completion)
          }
        }).finally(() => this.disposeAsyncResults())
      }
      if (waiting) this.retainForInterval(result)
    } finally {
      if (result.alive && !this.asyncResults.has(result) && !this.intervalResults.has(result)) result.dispose()
    }
  }

  private evalGuest(code: string, filename = 'plugin.js') {
    const context = this.context
    if (!context) return
    const evaluated = context.evalCode(code, filename, { type: 'global' })
    if (evaluated.error) {
      const message = guestText(context, evaluated.error)
      evaluated.dispose()
      if (closedNotice(message) != null) return
      throw errorFromGuest(message)
    }
    return evaluated.value
  }

  /** The script completion promise is the host-visible channel for an async rejection.
   * A caught rejection fulfills. closePlugin's sentinel is a normal stop, not a failure. */
  private completionPending(result: QuickJSHandle): boolean {
    if (!this.context || !result.alive) return false
    const state = this.context.getPromiseState(result)
    if (state.type !== 'rejected') {
      if (state.type === 'fulfilled' && !state.notAPromise) state.value.dispose()
      return state.type === 'pending'
    }
    const message = guestText(this.context, state.error)
    state.error.dispose()
    if (closedNotice(message) != null) return false
    throw errorFromGuest(message)
  }

  private retainForInterval(result: QuickJSHandle) {
    if (!this.session.nextInterval()) return false
    if (this.intervalResults.size >= PLUGIN_LIMITS.pendingTimers)
      throw new PluginApiError('plugin_limit', 'Too many outstanding interval promises')
    this.intervalResults.add(result)
    return true
  }

  private observeIntervalResults() {
    const intervals = this.session.nextInterval()
    for (const result of this.intervalResults) {
      if (this.completionPending(result) && intervals) continue
      this.intervalResults.delete(result)
      result.dispose()
    }
  }

  private async finishAsync(deadline: number) {
    let firedTimers = 0
    while (this.context && !this.session.closed) {
      const storage = this.session.takeStorageJob()
      if (storage) {
        let payload: Record<string, unknown>
        try { payload = { ok: true, value: await this.session.performStorage(storage.operation) } }
        catch (error) {
          payload = {
            ok: false, code: error instanceof PluginApiError ? error.code : 'storage_failed',
            message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          }
        }
        this.inject(`globalThis.__finishPluginStorage(${storage.id}, ${JSON.stringify(payload)})`)
        this.drain()
        continue
      }
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
      if (this.session.hasFontJobs()) {
        const job = this.session.takeFontJobs()
        if (!job) break
        const payload = await this.loadSystemFont(job)
        this.inject(`globalThis.__finishFont(${JSON.stringify(job.id)}, ${JSON.stringify(payload)})`)
        this.drain()
        continue
      }
      const job = this.session.takeExportJobs()
      if (job) {
        let payload: Record<string, unknown>
        try { payload = { ok: true, ...(await this.session.captureRasterExport(job, this.exportAbort.signal)) } }
        catch (error) {
          const code = error instanceof PluginApiError || error instanceof AutomationError && error.code === 'export_limit' ? error.code : 'export_failed'
          payload = { ok: false, code, message: (error instanceof Error ? error.message : String(error)).slice(0, 500) }
        }
        this.inject(`globalThis.__finishExport(${JSON.stringify(job.id)}, ${JSON.stringify(payload)})`)
        this.drain()
        continue
      }
      const timer = this.session.nextTimer()
      if (!timer) break
      if (++firedTimers > PLUGIN_LIMITS.timerCallbacksPerTurn || timer.due > deadline || performance.now() >= deadline) {
        throw new PluginApiError('plugin_limit', 'Plugin timer work exceeded its turn budget')
      }
      await this.waitForTimer(Math.ceil(timer.due - performance.now()))
      if (!this.context || this.session.closed) break
      if (performance.now() >= deadline) throw new PluginApiError('plugin_limit', 'Plugin timer work exceeded its turn budget')
      this.session.assertCurrent()
      if (this.session.consumeTimer(timer.id)) {
        const result = this.evalGuest(`globalThis.__deliverPluginTimer(${timer.id})`, 'plugin-timer.js')
        if (result) this.asyncResults.add(result)
        this.drain()
        this.observeIntervalResults()
        if (result) this.completionPending(result)
      }
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
      if (!this.context || this.session.closed) return { ok: false, code: 'plugin_closed', message: 'The plugin has finished' }
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
    this.evalGuest(code, 'plugin-async.js')?.dispose()
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
    this.session.abandonTurn()
    this.signal?.removeEventListener('abort', this.stopOnAbort)
    this.exportAbort.abort()
    this.cancelTimerWait?.()
    if (this.intervalWakeup !== null) clearTimeout(this.intervalWakeup)
    this.intervalWakeup = null
    for (const completion of this.intervalResults) completion.dispose()
    this.intervalResults.clear()
    this.disposeAsyncResults()
    if (context) context.dispose()
    runtime?.dispose()
    this.runtime = null
  }

  private disposeAsyncResults() {
    for (const completion of this.asyncResults) completion.dispose()
    this.asyncResults.clear()
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
