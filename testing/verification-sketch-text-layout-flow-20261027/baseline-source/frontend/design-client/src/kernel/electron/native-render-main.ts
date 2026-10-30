/* eslint-disable */
// Electron-only module: register in main.ts via registerNativeRenderHandler().
import { initNativeRender, getNativeRender, NATIVE_RENDER_CHANNELS } from './native-render-preload'

export function registerNativeRenderHandler(): void {
  const ipcMain = (globalThis as any).require?.('electron')?.ipcMain
  if (!ipcMain) {
    console.warn('原生渲染桥:非 Electron 环境,跳过')
    return
  }
  const bridge = initNativeRender()
  if (!bridge) {
    console.warn('原生渲染桥初始化失败——回退到 WASM worker')
    return
  }

  ipcMain.handle(NATIVE_RENDER_CHANNELS.load, async (_e: any, docJson: string) => {
    try {
      await bridge.start(docJson)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle(NATIVE_RENDER_CHANNELS.frame, async (_e: any, opts: any, pan: number) => {
    try {
      const result = await bridge.frame(opts, pan)
      return {
        ok: true,
        width: result.width,
        height: result.height,
        rgba: Buffer.from(result.rgba).toString('base64'),
        stats: result.stats,
      }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle(NATIVE_RENDER_CHANNELS.stop, () => {
    bridge.stop()
    return { ok: true }
  })

  ipcMain.handle(NATIVE_RENDER_CHANNELS.stats, async () => {
    try {
      const stats = await bridge.stats()
      return { ok: true, stats }
    } catch (e: any) {
      return { ok: false, error: String(e) }
    }
  })
}
