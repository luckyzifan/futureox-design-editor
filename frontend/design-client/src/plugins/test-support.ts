/** 插件容器测试共享夹具：jsdom 不执行 srcdoc iframe，用 ResourceLoader
 *  以 src 形式服务沙箱/插件 UI 两份文档（内容经 frameUrl 回调捕获，
 *  保留宿主注入的会话令牌）。仅测试使用，不进生产包。 */
import { createRequire } from 'node:module'
const { JSDOM, ResourceLoader } = createRequire(import.meta.url)('jsdom')

export interface SandboxDom {
  window: Window
  area: HTMLElement
  frameUrl(kind: 'sandbox' | 'ui', html: string): string
  close(): void
}

export function createSandboxDom(baseUrl = 'https://plugin-container.test'): SandboxDom {
  const sandboxUrl = `${baseUrl}/sandbox.html`
  const uiUrl = `${baseUrl}/plugin-ui.html`
  const served = new Map<string, string>()
  class Loader extends ResourceLoader {
    fetch(url: string) {
      const html = served.get(url)
      if (html !== undefined) return Promise.resolve(Buffer.from(html))
      throw new Error(`Unexpected network resource: ${url}`)
    }
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="area"></div></body></html>', {
    runScripts: 'dangerously', url: `${baseUrl}/index.html`,
    resources: new Loader(), pretendToBeVisual: true,
  })
  return {
    window: dom.window,
    area: dom.window.document.getElementById('area')!,
    frameUrl: (kind, html) => {
      const url = kind === 'sandbox' ? sandboxUrl : uiUrl
      served.set(url, html)
      return url
    },
    close: () => dom.window.close(),
  }
}

export async function until(condition: () => boolean, label: string, timeoutMs = 8000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
