/* eslint-disable */
// Electron-only module: desktop build resolves these at runtime.
// Web tsc skip: this file is excluded from the web bundle.
import { NativeRenderBridge } from '../native-render-bridge'

let bridge: NativeRenderBridge | undefined

export function initNativeRender(): NativeRenderBridge {
  if (!bridge) {
    const resources = (process as any).resourcesPath || ''
    const { join } = require('path')
    bridge = new NativeRenderBridge(
      join(resources, 'bin', 'design-render'),
      join(resources, 'fonts', 'NotoSansSC.ttf'),
    )
  }
  return bridge
}

export function getNativeRender(): NativeRenderBridge | undefined {
  return bridge
}

export const NATIVE_RENDER_CHANNELS = {
  load: 'native-render:load',
  frame: 'native-render:frame',
  stop: 'native-render:stop',
  stats: 'native-render:stats',
} as const
