/**
 * Electron 原生渲染桥:main 进程经 stdio 子进程驱动 design-gpu 的 serve 模式。
 * 默认走 NativeGpu(macOS 上 Metal/wgpu),帧统计携带真实的 E6 四桶 GPU
 * 内存台账;`--backend cpu` 回退到 TiledFrameHost(Sketch-parity CPU 瓦片
 * 渲染,117 实测平移 28ms)用于调试。
 *
 * 协议(JSON lines):
 *   → {"cmd":"load","document":"<json>","font":"<base64, optional>"}
 *   ← {"type":"loaded"} | {"type":"error","message":"..."}
 *   → {"cmd":"frame","options":{...},"damage":null|[rects],"pan":0}
 *   ← {"type":"frame","width":W,"height":H,"rgba":"<base64>","stats":{...,"gpu_memory":{...}}}
 *   → {"cmd":"stats"}
 *   ← {"type":"stats","stats":{"gpu_memory":{...}}}
 *   → {"cmd":"stop"}
 *   ← {"type":"error","message":"..."} 任何命令都可能返回,循环保持存活
 */
import { spawn, type ChildProcess } from 'node:child_process'

export type NativeFrameOptions = {
  pageId: string
  width: number
  height: number
  view: { x: number; y: number; zoom: number }
  transparent?: boolean
  rasterProfile?: string
}

/** design-kernel `GpuMemoryBreakdown` 的 serde camelCase 导出。 */
export type NativeGpuMemoryBreakdown = {
  textureBytes: number
  bufferBytes: number
  fixedArrayBytes: number
  blobBytes: number
  peakTextureBytes: number
  peakBufferBytes: number
  peakFixedArrayBytes: number
  peakBlobBytes: number
  peakTotalBytes: number
  totalBytes: number
  limitBytes: number
  needsFree: boolean
  freeEvents: number
  rejections: number
}

export type NativeFrameStats = {
  frames: number
  unchanged_frames: number
  tiles_rasterised: number
  tiles_cached: number
  full_frames: number
  render_ms: number
  backend?: string
  last_render_ms?: number
  draw_calls?: number
  submissions?: number
  peak_texture_bytes?: number
  gpu_memory?: NativeGpuMemoryBreakdown
}

export type NativeFrameResult = {
  width: number
  height: number
  rgba: Uint8Array
  stats: NativeFrameStats
}

export type NativeBackend = 'auto' | 'metal' | 'vulkan' | 'dx12' | 'cpu'

type Pending = {
  resolve: (result: NativeFrameResult | NativeFrameStats | undefined) => void
  reject: (error: Error) => void
  kind: 'loaded' | 'frame' | 'stats'
}

export class NativeRenderBridge {
  private proc: ChildProcess | undefined
  private buffer = ''
  private pending: Pending | undefined

  constructor(
    private readonly binaryPath: string,
    private readonly fontPath: string | undefined,
    private readonly backend: NativeBackend = process.platform === 'darwin' ? 'metal' : 'auto',
  ) {}

  get available(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null
  }

  async start(documentJson: string): Promise<void> {
    if (!this.available) {
      const args = ['--serve', '--backend', this.backend]
      if (this.fontPath) args.push('--font', this.fontPath)
      this.proc = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })

      this.proc.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8')
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            this.dispatch(JSON.parse(line))
          } catch { /* incomplete line */ }
        }
      })

      this.proc.on('error', (err) => {
        this.pending?.reject(err)
        this.pending = undefined
      })
      this.proc.on('exit', () => {
        this.pending?.reject(new Error('Native render process exited'))
        this.pending = undefined
        this.proc = undefined
      })
    }
    // 发送文档加载命令并等待 loaded 应答,让加载错误直接暴露给调用方。
    return this.request('loaded', { cmd: 'load', document: documentJson }) as Promise<void>
  }

  private dispatch(msg: { type?: string; message?: string; width?: number; height?: number; rgba?: string; stats?: NativeFrameStats }): void {
    const pending = this.pending
    if (!pending) return
    if (msg.type === 'error') {
      this.pending = undefined
      pending.reject(new Error(msg.message || 'Native render error'))
      return
    }
    if (msg.type === 'loaded' && pending.kind === 'loaded') {
      this.pending = undefined
      pending.resolve(undefined)
      return
    }
    if (msg.type === 'frame' && pending.kind === 'frame') {
      this.pending = undefined
      const rgba = Buffer.from(msg.rgba || '', 'base64')
      pending.resolve({
        width: msg.width || 0,
        height: msg.height || 0,
        rgba: new Uint8Array(rgba),
        stats: msg.stats || ({} as NativeFrameStats),
      })
      return
    }
    if (msg.type === 'stats' && pending.kind === 'stats') {
      this.pending = undefined
      pending.resolve(msg.stats || ({} as NativeFrameStats))
    }
  }

  private request(kind: Pending['kind'], msg: unknown): Promise<NativeFrameResult | NativeFrameStats | undefined> {
    if (!this.available) return Promise.reject(new Error('Native render bridge not started'))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, kind }
      this.send(msg)
    })
  }

  async frame(options: NativeFrameOptions, pan = 0): Promise<NativeFrameResult> {
    return this.request('frame', { cmd: 'frame', options, pan }) as Promise<NativeFrameResult>
  }

  /** 最新的四桶 GPU 内存台账(随每次 frame 更新;load 后可独立查询)。 */
  async stats(): Promise<NativeFrameStats> {
    return this.request('stats', { cmd: 'stats' }) as Promise<NativeFrameStats>
  }

  private send(msg: unknown): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  stop(): void {
    if (this.available) {
      try {
        this.send({ cmd: 'stop' })
      } catch { /* 进程已退出 */ }
    }
    this.proc?.kill()
    this.proc = undefined
    this.buffer = ''
    this.pending?.reject(new Error('Bridge stopped'))
    this.pending = undefined
  }
}
