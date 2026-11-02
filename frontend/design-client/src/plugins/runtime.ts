import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten'
import type { DesignDocument } from '../model'
import { PluginApiError, pluginErrorMessage } from './errors'
import { createGuestApi, guestPrelude, pluginErrorMessageIncludesClosed, type PluginHostHandler } from './guest'
import { openRustPluginSession, type RustPluginSession } from './kernel'
import { pluginLimits } from './limits'
import type { PluginBundle } from './manifest'
import { readPluginMessage, readPluginUiOptions, type PluginUiOptions } from './messages'
import { applyPluginPatch, pluginPatchMutatesDocument, type PluginPatch } from './patch'
import { createBrowserPluginStorage, type PluginStorage } from './storage'

export type PluginEditor = {
  state: { doc: DesignDocument; page: string; selection: string[]; version: number; view: { x: number; y: number; zoom: number } }
  change(label: string, fn: (draft: DesignDocument) => void, selection?: string[]): { status?: string; message?: string } | void
  set(patch: { selection?: string[]; page?: string; view?: PluginEditor['state']['view'] }): void
  notify(message: string): void
  requestReveal(ids: string[]): void
  subscribe(listener: () => void): () => void
}

export type PluginLaunchHooks = {
  onUi?: (ui: PluginUiOptions) => void
  onPluginMessage?: (message: unknown) => void
  onResize?: (size: { width: number; height: number }) => void
}

export type PluginController = {
  deliver(message: unknown): Promise<void>
  emit(event: 'selectionchange' | 'currentpagechange' | 'close'): Promise<void>
  stop(): Promise<void>
  closed: boolean
}

type LiveRuntime = {
  context: QuickJSContext
  runtime: QuickJSRuntime
  dispose(): void
  call(name: string, json?: string): Promise<void>
}

function drainGuestJobs(runtime: QuickJSRuntime) {
  for (let turn = 0; turn < 32; turn += 1) {
    const pending = runtime.executePendingJobs()
    if (pending.error) {
      pending.dispose()
      throw new PluginApiError('plugin_limit', 'Plugin exceeded its time limit')
    }
    const ran = pending.value
    pending.dispose()
    if (ran === 0) return
  }
}

function dumpedMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && 'message' in value) return String((value as { message: unknown }).message)
  return pluginErrorMessage(value)
}

export async function launchPlugin(editor: PluginEditor, bundle: PluginBundle, command: string, hooks: PluginLaunchHooks = {}, storage: PluginStorage = createBrowserPluginStorage()): Promise<PluginController> {
  const documentId = editor.state.doc.id
  let revision = editor.state.version
  let suppress = false
  const rust = await openRustPluginSession(JSON.stringify(editor.state.doc), JSON.stringify({
    pluginId: bundle.manifest.id,
    pageId: editor.state.page,
    selection: editor.state.selection,
  }))
  let closed = false
  const publish = () => {
    if (editor.state.doc.id !== documentId || editor.state.version !== revision) {
      throw new PluginApiError('conflict', 'The document changed while the plugin was running')
    }
    suppress = true
    try {
      const patch = JSON.parse(rust.call(JSON.stringify({ op: 'flush' }))) as PluginPatch
      if (pluginPatchMutatesDocument(patch, editor.state.doc)) {
        const result = editor.change(`Plugin: ${bundle.manifest.name}`, draft => applyPluginPatch(draft, patch), patch.selection)
        if (result && result.status === 'rejected') throw new PluginApiError('commit', result.message || 'Plugin edit was rejected')
        revision = editor.state.version
      } else if (patch.selection.join('\0') !== editor.state.selection.join('\0')) {
        editor.set({ selection: patch.selection })
      }
      if (patch.pageId && patch.pageId !== editor.state.page) editor.set({ page: patch.pageId })
    } finally {
      suppress = false
    }
  }
  const dispatch = (op: string, payload: Record<string, unknown>) => dispatchPlugin(op, payload, {
    editor, bundle, command, storage, rust, hooks, publish, close: () => { closed = true },
  })
  let live: LiveRuntime
  try {
    live = await openQuickJs(bundle, dispatch)
  } catch (error) {
    rust.free()
    throw error
  }
  const controller: PluginController = {
    closed: false,
    async deliver(message) {
      if (controller.closed) return
      const encoded = readPluginMessage({ pluginMessage: message })
      await live.call('__deliverUiMessage', JSON.stringify(encoded?.pluginMessage ?? null))
      publish()
    },
    async emit(event) {
      if (controller.closed || suppress) return
      await live.call('__emit', event)
    },
    async stop() {
      if (controller.closed) return
      controller.closed = true
      try { publish() } catch { /* The last turn already reported its error. */ }
      try { await live.call('__emit', 'close') } catch { /* The guest may already be closed. */ }
      live.dispose()
      rust.free()
    },
  }
  try {
    await live.call('__runPlugin')
    if (!closed) publish()
    else await controller.stop()
  } catch (error) {
    if (!pluginErrorMessageIncludesClosed(error)) {
      live.dispose()
      rust.free()
      controller.closed = true
      throw error
    }
    await controller.stop()
  }
  if (controller.closed) return controller
  let selectionKey = editor.state.selection.join('\0')
  let pageKey = editor.state.page
  const unsubscribe = editor.subscribe(() => {
    const nextSelection = editor.state.selection.join('\0')
    const nextPage = editor.state.page
    const selectionChanged = nextSelection !== selectionKey
    const pageChanged = nextPage !== pageKey
    selectionKey = nextSelection
    pageKey = nextPage
    if (suppress || controller.closed) return
    if (selectionChanged) void controller.emit('selectionchange')
    if (pageChanged) void controller.emit('currentpagechange')
  })
  const originalStop = controller.stop
  controller.stop = async () => {
    unsubscribe()
    await originalStop()
  }
  return controller
}

function dispatchPlugin(op: string, payload: Record<string, unknown>, scope: {
  editor: PluginEditor
  bundle: PluginBundle
  command: string
  storage: PluginStorage
  rust: RustPluginSession
  hooks: PluginLaunchHooks
  publish: () => void
  close: () => void
}): unknown {
  switch (op) {
    case 'meta':
      return { pluginId: scope.bundle.manifest.id, command: scope.command, editorType: 'figma' }
    case 'notify':
      scope.editor.notify(String(payload.message ?? '').slice(0, 500))
      return null
    case 'showUI': {
      const ui = readPluginUiOptions(payload.html, payload.options, scope.bundle.ui ?? '')
      scope.hooks.onUi?.(ui)
      return null
    }
    case 'uiPost':
      readPluginMessage({ pluginMessage: payload.message })
      scope.hooks.onPluginMessage?.(payload.message)
      return null
    case 'uiResize':
      scope.hooks.onResize?.({
        width: readPluginUiOptions('', { width: payload.width }, '').width,
        height: readPluginUiOptions('', { height: payload.height }, '').height,
      })
      return null
    case 'storageGet':
      return scope.storage.get(scope.bundle.manifest.id, String(payload.key ?? ''))
    case 'storageSet':
      scope.storage.set(scope.bundle.manifest.id, String(payload.key ?? ''), payload.value)
      return null
    case 'storageDelete':
      scope.storage.delete(scope.bundle.manifest.id, String(payload.key ?? ''))
      return null
    case 'storageKeys':
      return scope.storage.keys(scope.bundle.manifest.id)
    case 'viewport':
      return { ...scope.editor.state.view }
    case 'setViewport': {
      const zoom = Number(payload.zoom)
      if (!Number.isFinite(zoom) || zoom < 0.02 || zoom > 256) throw new PluginApiError('viewport', 'zoom must be between 0.02 and 256')
      scope.editor.set({ view: { ...scope.editor.state.view, zoom } })
      return null
    }
    case 'reveal':
      scope.editor.requestReveal((Array.isArray(payload.ids) ? payload.ids : []).filter((id): id is string => typeof id === 'string'))
      return null
    case 'close':
      scope.close()
      if (payload.message) scope.editor.notify(String(payload.message).slice(0, 500))
      return null
    case 'flush':
      scope.publish()
      return null
    default:
      return JSON.parse(scope.rust.call(JSON.stringify({ op, ...payload })))
  }
}

async function openQuickJs(bundle: PluginBundle, dispatch: PluginHostHandler): Promise<LiveRuntime> {
  const quick = await getQuickJS()
  const runtime = quick.newRuntime()
  runtime.setMemoryLimit(pluginLimits.guestMemoryBytes)
  runtime.setMaxStackSize(pluginLimits.guestStackBytes)
  const context = runtime.newContext()
  const host = context.newFunction('__host', (opHandle, payloadHandle) => {
    try {
      const op = context.getString(opHandle)
      const payloadText = context.getString(payloadHandle)
      if (payloadText.length > pluginLimits.messageBytes * 4) throw new PluginApiError('plugin_limit', 'Plugin payload is too large')
      const payload = JSON.parse(payloadText) as Record<string, unknown>
      return context.newString(JSON.stringify(dispatch(op, payload) ?? null))
    } catch (error) {
      throw new Error(pluginErrorMessage(error))
    }
  })
  const html = context.newString(bundle.ui ?? '')
  context.setProp(context.global, '__host', host)
  context.setProp(context.global, '__html__', html)
  host.dispose()
  html.dispose()
  const program = `${guestPrelude}\nfunction __runPlugin(){return (async()=>{\n${bundle.code}\n})()}\n`
  const defined = context.evalCode(program, 'plugin.js')
  if (defined.error) {
    const message = dumpedMessage(context.dump(defined.error))
    defined.error.dispose()
    context.dispose()
    runtime.dispose()
    throw new PluginApiError('plugin_error', message)
  }
  defined.value.dispose()
  return {
    context,
    runtime,
    dispose() {
      context.dispose()
      runtime.dispose()
    },
    async call(name, json) {
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + pluginLimits.runtimeMs))
      const fn = context.getProp(context.global, name)
      const arg = json === undefined ? undefined : context.newString(json)
      const called = arg ? context.callFunction(fn, context.undefined, arg) : context.callFunction(fn, context.undefined)
      fn.dispose()
      arg?.dispose()
      if (called.error) {
        const message = dumpedMessage(context.dump(called.error))
        called.error.dispose()
        throw new PluginApiError('plugin_error', message)
      }
      if (name === '__runPlugin') {
        drainGuestJobs(runtime)
        const state = context.getPromiseState(called.value)
        if (state.type === 'rejected') {
          const message = dumpedMessage(context.dump(state.error))
          state.error.dispose()
          called.value.dispose()
          throw new PluginApiError(message.includes('__plugin_closed__') ? 'plugin_closed' : 'plugin_error', message)
        }
        if (state.type === 'fulfilled') state.value.dispose()
        if (state.type === 'pending') {
          called.value.dispose()
          throw new PluginApiError('plugin_error', 'Plugin is still waiting. This host settles promises created by the plugin API, not arbitrary network or timers.')
        }
      } else {
        drainGuestJobs(runtime)
      }
      called.value.dispose()
    },
  }
}

export function createGuestForTests(dispatch: PluginHostHandler, html = '') {
  return createGuestApi(dispatch, html)
}

export async function runSandboxed(code: string, dispatch: PluginHostHandler, html = ''): Promise<void> {
  const live = await openQuickJs({
    code,
    ui: html,
    manifest: { name: 'Sandbox', id: 'sandbox.test', api: '1.0.0', main: 'code.js', editorType: ['figma'], menu: [], networkAccess: { requested: [], granted: false } },
  }, dispatch)
  try {
    await live.call('__runPlugin')
  } catch (error) {
    if (!pluginErrorMessageIncludesClosed(error)) throw error
  } finally {
    live.dispose()
  }
}
