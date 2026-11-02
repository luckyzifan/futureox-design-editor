import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten'
import { PluginApiError, PluginClosed } from './errors'
import { PLUGIN_LIMITS } from './limits'
import { assertPluginBundle, type PluginBundle } from './manifest'
import { PLUGIN_PRELUDE } from './prelude'
import { createPluginSession, type PluginUiState } from './session'

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
}

export class PluginController {
  readonly notifications: readonly string[]
  readonly logs: readonly string[]
  private runtime: QuickJSRuntime | null
  private context: QuickJSContext | null
  private constructor(
    private readonly session: ReturnType<typeof createPluginSession>,
    runtime: QuickJSRuntime,
    context: QuickJSContext,
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
    const session = createPluginSession(editor, { name: bundle.manifest.name, uiHtml: bundle.ui, hooks })
    const controller = new PluginController(session, runtime, context)
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
      controller.evaluate(PLUGIN_PRELUDE + '\n' + bundle.main)
      session.flush()
      if (!session.ui || session.closed) controller.release()
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

  deliver(message: unknown) {
    if (!this.context) throw new PluginApiError('plugin_closed', 'The plugin has finished')
    const json = JSON.stringify(message ?? null)
    if (json.length > PLUGIN_LIMITS.messageBytes) throw new PluginApiError('message_too_large', 'Plugin UI message is too large')
    const payload = this.context.newString(json)
    this.context.setProp(this.context.global, '__pluginMessageJson', payload)
    payload.dispose()
    this.evaluate('globalThis.__deliverPluginMessage(JSON.parse(globalThis.__pluginMessageJson))')
    this.session.flush()
    if (this.session.closed) this.release()
  }

  close() { this.release() }

  private arm() {
    this.runtime?.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + PLUGIN_LIMITS.runtimeMs))
  }

  private evaluate(code: string) {
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

export async function openPlugin(editor: Parameters<typeof createPluginSession>[0], bundle: PluginBundle, hooks?: PluginHooks) {
  return PluginController.open(bundle, editor, hooks)
}
