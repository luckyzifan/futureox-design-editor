import type { DesktopResult } from '../desktop'

export type DesignAiModel = 'pro' | 'flash'
export type DesignAiLayer = {
  name: string; zIndex: number; x: number; y: number; width: number; height: number
  imageWidth: number; imageHeight: number; uri: string
}
export type DesignAiResult = { width: number; height: number; layers: DesignAiLayer[] }
export type DesignAiRequest = {
  requestId: string; mode: 'generate' | 'decompose'; model: DesignAiModel
  prompt: string; size: '1K' | '1.5K' | '2K'; image?: string
}
export interface DesignAiBridge {
  status(): Promise<DesktopResult<{ configured: boolean; busy: boolean }>>
  configure(request: { apiKey: string }): Promise<DesktopResult<{ configured: boolean; busy: boolean }>>
  run(request: DesignAiRequest): Promise<DesktopResult<{ result: DesignAiResult }>>
  cancel(request: { requestId: string }): Promise<DesktopResult>
}
