/** 真实社区插件验证（默认跳过，需 PLUGIN_LIVE=1 并访问 GitHub）：
 *
 *   PLUGIN_LIVE=1 bunx vitest run src/plugins/plugin-samples-live.test.ts
 *
 * 从 figma/plugin-samples 官方仓库实时下载 zip，在沙箱容器中运行：
 *  - post-message：真实 UI iframe 消息 → 沙箱 console → 宿主日志 → 500ms
 *    后沙箱回包到 UI（完整 UI 双向链路）。
 *  - text-review：隐式 manifest v1、figma.command 缺省分支、notify 与
 *    插件自发 closePlugin。
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { createEditorDesignAutomation } from '../automation'
import { PluginHost } from './host'
import { loadPluginFromGitHub } from './loader'
import { createSandboxDom, until } from './test-support'

const live = process.env.PLUGIN_LIVE === '1'

/** 两个用例共享一次仓库下载（按 URL 缓存字节，重建 Response）。 */
const byteCache = new Map<string, Promise<Uint8Array>>()
const cachedFetch: typeof fetch = (input, init) => {
  const url = String(input)
  if (!byteCache.has(url)) {
    byteCache.set(url, (async () => {
      const response = await fetch(input, init)
      if (!response.ok) throw new Error(`GitHub 下载失败：HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    })())
  }
  return byteCache.get(url)!.then(bytes => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/zip' } }))
}

describe('figma/plugin-samples 真实插件（live）', () => {
  it.skipIf(!live)('post-message：真实 UI 双向消息链路', async () => {
    const bundle = await loadPluginFromGitHub('figma/plugin-samples/tree/main/post-message', cachedFetch)
    expect(bundle.manifest.name).toBe('Post Message')
    expect(bundle.manifest.manifestVersion).toBe(1)
    expect(bundle.mainCode).toContain('figma.showUI')

    const dom = createSandboxDom('https://live-post-message.test')
    const editor = new Editor(blank('Post Message 真实测试'))
    const api = createEditorDesignAutomation(editor)
    const logs: string[] = []
    const host = new PluginHost(bundle, {
      editor, api, container: dom.area, window: dom.window, frameUrl: dom.frameUrl,
      events: { onLog: (_level, message) => logs.push(message), onUi: () => {}, onNotify: () => {}, onClose: () => {} },
    })
    try {
      await host.ready
      await until(() => !!host.uiFrameElement, 'UI iframe 创建')
      const uiFrame = host.uiFrameElement!
      const uiInbound: unknown[] = []
      uiFrame.contentWindow!.addEventListener('message', (event: MessageEvent) => {
        if (event.data && typeof event.data === 'object' && 'pluginMessage' in event.data) uiInbound.push(event.data.pluginMessage)
      })
      // 真实点击插件 UI 的按钮：ui.html → parent.postMessage({pluginMessage})。
      uiFrame.contentDocument!.querySelector('button')!.click()
      // 沙箱 console.log("CODE LOG", ...) 经垫片转发到宿主日志。
      await until(() => logs.some(message => message.includes('CODE LOG') && message.includes('ui.html:')), '沙箱收到 UI 消息')
      // 500ms 后沙箱回包，UI iframe 收到 {pluginMessage: "code.js: ..."}。
      await until(() => uiInbound.some(message => typeof message === 'string' && message.startsWith('code.js:')), '沙箱回包到达 UI')
    } finally {
      host.dispose(); api.dispose(); editor.dispose(); dom.close()
    }
  }, 180000)

  it.skipIf(!live)('text-review：隐式 v1 manifest，notify 与插件自发 closePlugin', async () => {
    const bundle = await loadPluginFromGitHub('figma/plugin-samples/tree/main/text-review', cachedFetch)
    expect(bundle.manifest.manifestVersion).toBe(1)
    const dom = createSandboxDom('https://live-text-review.test')
    const editor = new Editor(blank('Text Review 真实测试'))
    const api = createEditorDesignAutomation(editor)
    const notified: string[] = []
    const closed: string[] = []
    const host = new PluginHost(bundle, {
      editor, api, container: dom.area, window: dom.window, frameUrl: dom.frameUrl,
      events: {
        onLog: () => {}, onUi: () => {},
        onNotify: message => notified.push(message),
        onClose: message => closed.push(message ?? ''),
      },
    })
    try {
      await host.ready
      // figma.command 为 undefined → else 分支：notify 后 closePlugin()。
      await until(() => notified.some(message => message.includes('running like any other plugin')), '真实插件 notify')
      await until(() => closed.length > 0, '插件自发 closePlugin')
      expect(host.uiFrameElement).toBeNull()
    } finally {
      host.dispose(); api.dispose(); editor.dispose(); dom.close()
    }
  }, 180000)
})
