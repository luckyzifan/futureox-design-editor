import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank, type DesignNode } from '../model'
import { createEditorDesignAutomation } from '../automation'
import { bundleFromFiles, buildSandboxDocument, PluginHost } from './host'
import { createSandboxDom, until, type SandboxDom } from './test-support'
import manifestRaw from './__fixtures__/hello-world/manifest.json?raw'
import codeRaw from './__fixtures__/hello-world/code.js?raw'
import uiRaw from './__fixtures__/hello-world/ui.html?raw'

const editors: Editor[] = []
const doms: SandboxDom[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  doms.splice(0).forEach(dom => dom.close())
})

function fixtureBundle() {
  return bundleFromFiles(
    { 'manifest.json': manifestRaw, 'code.js': codeRaw, 'ui.html': uiRaw },
    'unit-fixture',
  )
}

function pluginDom() {
  const dom = createSandboxDom()
  doms.push(dom)
  return dom
}

describe('buildSandboxDocument', () => {
  it('转义插件源码中的 </script> 并注入 CSP 与会话令牌', () => {
    const html = buildSandboxDocument('var close = "</script>"', 'session-a')
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain('window.__PLUGIN_SOURCE__=')
    expect(html).toContain('window.__PLUGIN_SESSION__="session-a"')
    // JSON 字符串里的 </script> 必须以 <\/ 形式转义，避免提前闭合脚本标签。
    expect(html).toContain('<\\/script>')
    expect(html).not.toMatch(/__PLUGIN_SOURCE__="[^"]*<\/script>/)
  })
  it('拒绝空与超限的 main 代码', () => {
    expect(() => buildSandboxDocument('', 's')).toThrow(/为空/)
    expect(() => buildSandboxDocument('x'.repeat(3 * 1024 * 1024), 's')).toThrow(/2 MiB/)
  })
})

describe('插件容器端到端（真实 Editor + 沙箱 iframe + 插件 UI iframe）', () => {
  it('运行 Hello Futureox：创建嵌套节点、UI 双向消息、notify、selection 与 closePlugin', async () => {
    const dom = pluginDom()
    const document = blank('插件容器测试')
    const editor = new Editor(document)
    editors.push(editor)
    const api = createEditorDesignAutomation(editor)
    const notified: string[] = []
    const closed: string[] = []
    const logs: string[] = []
    const host = new PluginHost(fixtureBundle(), {
      editor, api,
      container: dom.area,
      window: dom.window,
      frameUrl: dom.frameUrl,
      events: {
        onLog: (level, message) => logs.push(`[${level}] ${message}`),
        onUi: () => {},
        onNotify: message => notified.push(message),
        onClose: message => closed.push(message ?? ''),
      },
    })
    try {
      await host.ready
      // 沙箱启动：插件执行 showUI → UI iframe 创建；notify 已发出。
      await until(() => !!host.uiFrameElement, 'UI iframe 创建')
      await until(() => notified.some(message => message.includes('已启动')), '启动 notify')

      const uiFrame = host.uiFrameElement!
      // 模拟插件 UI 内点击“创建 Hello 卡片”（真实触发 UI 脚本的
      // parent.postMessage({pluginMessage}) 协议路径）。
      uiFrame.contentDocument!.getElementById('create')!.click()
      await until(() => Object.values(editor.state.doc.nodes).some((n: DesignNode) => n.kind === 'frame' && n.name === 'HelloCard'), 'HelloCard 落库')

      const doc = editor.state.doc
      const card = Object.values(doc.nodes).find((n: DesignNode) => n.name === 'HelloCard')!
      expect(card.children).toHaveLength(1)
      const label = doc.nodes[card.children[0]]!
      expect(label.kind).toBe('text')
      expect(label.text).toBe('Hello Futureox')
      expect(label.fontSize).toBe(18)
      expect(label.textRuns?.[0]?.color).toBe('#ffffff')
      expect(card.fills[0].color).toBe('#f56b52')
      expect(card.radii).toEqual([8, 8, 8, 8])
      // 插件设置的选区与画布真实选区一致。
      expect(editor.state.selection).toEqual([card.id])
      await until(() => notified.some(message => message.includes('已创建')), '创建 notify')

      // created 回包：沙箱 → UI iframe 的出站消息在 UI 文档中渲染。
      // （先断言 created，再触发 count；两者写同一个 #out 元素。）
      await until(() => /已创建节点/.test(uiOutText(uiFrame)), 'UI 渲染 created 回包')
      uiFrame.contentDocument!.getElementById('count')!.click()
      await until(() => /1\s*个根节点/.test(uiOutText(uiFrame)), 'UI 渲染 count 回包')

      // close 流程：closePlugin 触发宿主销毁。
      uiFrame.contentDocument!.getElementById('close')!.click()
      await until(() => closed.length > 0, 'closePlugin 回调')
      expect(closed).toEqual(['插件请求关闭'])
      expect(host.uiFrameElement).toBeNull()
    } finally {
      host.dispose()
      api.dispose()
    }
  }, 20000)

  it('插件创建的节点可被原生历史撤销', async () => {
    const dom = pluginDom()
    const editor = new Editor(blank('插件撤销测试'))
    editors.push(editor)
    const api = createEditorDesignAutomation(editor)
    const host = new PluginHost(fixtureBundle(), {
      editor, api,
      container: dom.area,
      window: dom.window,
      frameUrl: dom.frameUrl,
      events: { onLog: () => {}, onUi: () => {}, onNotify: () => {}, onClose: () => {} },
    })
    try {
      await host.ready
      await until(() => !!host.uiFrameElement, 'UI iframe 创建')
      host.uiFrameElement!.contentDocument!.getElementById('create')!.click()
      await until(() => Object.values(editor.state.doc.nodes).some((n: DesignNode) => n.name === 'HelloCard'), 'HelloCard 落库')
      expect(Object.keys(editor.state.doc.nodes).length).toBeGreaterThan(0)
      // 逐条撤销插件操作直至页面回到空状态（每个自动化操作一条原生历史）。
      let guard = 0
      while (editor.state.doc.pages[0].children.length > 0 && guard++ < 20) {
        const response = api.execute({ method: 'history.undo', documentId: editor.state.doc.id, expectedRevision: editor.state.version, session: editor.sessionGeneration })
        expect(response.ok).toBe(true)
      }
      expect(editor.state.doc.pages[0].children).toEqual([])
      expect(Object.keys(editor.state.doc.nodes)).toEqual([])
    } finally {
      host.dispose()
      api.dispose()
    }
  }, 20000)
})

function uiOutText(frame: HTMLIFrameElement): string {
  const out = frame.contentDocument?.getElementById('out')
  return out?.textContent ?? ''
}
