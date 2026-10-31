/// <reference types="@webgpu/types" />
import {
  color_encode_display,
  float16_decode,
  float16_encode,
} from '../generated/design-kernel/design_kernel'
import { defaultColorSettings, type ColorSettings } from '../color'

/** Display encoding is separate from composition. A tiny transport probe guards
 * the fast ImageBitmap route; browsers that clamp it retain float readback. */
export class ColorPresenter {
  private lost = false
  private disposed = false
  bitmapTransport = false
  private constructor(
    private canvas: HTMLCanvasElement,
    private device: GPUDevice,
    private context: GPUCanvasContext,
    public space: 'srgb' | 'display-p3',
    public hdr: boolean,
    private shared = { references: 1 },
  ) {
    device.lost.then(() => {
      this.lost = true
    })
  }
  private configure() {
    this.context.configure({
      device: this.device,
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      alphaMode: 'premultiplied',
      colorSpace: this.space,
      toneMapping: { mode: this.hdr ? 'extended' : 'standard' },
    })
    const actual = this.context.getConfiguration()
    if (actual?.format !== 'rgba16float' || (this.hdr && actual.toneMapping?.mode !== 'extended'))
      throw new Error('浏览器未接受 HDR 浮点显示配置')
  }
  static async create(canvas: HTMLCanvasElement) {
    if (!navigator.gpu) throw new Error('显示端无 WebGPU，使用 sRGB SDR 预览')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('显示端无 GPU 适配器，使用 sRGB SDR 预览')
    const device = await adapter.requestDevice()
    try {
      const context = canvas.getContext('webgpu')
      if (!context) throw new Error('无法创建浮点显示表面')
      const presenter = new ColorPresenter(
        canvas,
        device,
        context,
        matchMedia('(color-gamut: p3)').matches ? 'display-p3' : 'srgb',
        matchMedia('(dynamic-range: high)').matches,
      )
      presenter.configure()
      try {
        presenter.bitmapTransport = await presenter.probeBitmap()
      } catch {
        presenter.bitmapTransport = false
      }
      return presenter
    } catch (error) {
      device.destroy()
      throw error
    }
  }
  private async done() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.device.queue.onSubmittedWorkDone(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.device.destroy()
            reject(new Error('显示 GPU 超时'))
          }, 10000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  private prepare(width: number, height: number) {
    if (this.lost) throw new Error('浮点显示设备已丢失')
    if (
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D
    )
      throw new Error('浮点显示尺寸超限')
    const space = matchMedia('(color-gamut: p3)').matches ? 'display-p3' : 'srgb',
      hdr = matchMedia('(dynamic-range: high)').matches
    if (space !== this.space || hdr !== this.hdr) {
      this.space = space
      this.hdr = hdr
      this.configure()
    }
    this.canvas.width = width
    this.canvas.height = height
    this.canvas.dataset.colorSpace = this.space
    this.canvas.dataset.dynamicRange = this.hdr ? 'extended' : 'standard'
    this.canvas.dataset.workingSpace = 'srgb-linear'
  }
  private async copyBitmap(bitmap: ImageBitmap, width: number, height: number, capture = false) {
    this.prepare(width, height)
    this.device.pushErrorScope('validation')
    const texture = this.context.getCurrentTexture()
    let scopeOpen = true
    let buffer: GPUBuffer | undefined
    const stride = Math.ceil((width * 8) / 256) * 256
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture, colorSpace: this.space, premultipliedAlpha: true },
        [width, height],
      )
      if (capture) {
        if (width * height > 4096) throw new Error('显示传输探针尺寸超限')
        buffer = this.device.createBuffer({
          size: stride * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const encoder = this.device.createCommandEncoder()
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [width, height])
        this.device.queue.submit([encoder.finish()])
      }
      await this.done()
      const error = await this.device.popErrorScope()
      scopeOpen = false
      if (error) throw new Error(error.message)
      if (buffer) {
        await buffer.mapAsync(GPUMapMode.READ)
        const bytes = new Uint8Array(buffer.getMappedRange()),
          packed = new Uint8Array(width * height * 8)
        for (let y = 0; y < height; y++)
          packed.set(bytes.subarray(y * stride, y * stride + width * 8), y * width * 8)
        return float16_decode(new Uint16Array(packed.buffer))
      }
      return undefined
    } finally {
      buffer?.destroy()
      if (scopeOpen) await this.device.popErrorScope()
    }
  }
  private async probeBitmap() {
    const source = new OffscreenCanvas(2, 1),
      context = source.getContext('webgpu')
    if (!context) return false
    let bitmap: ImageBitmap | undefined
    try {
      context.configure({
        device: this.device,
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        colorSpace: 'srgb',
        alphaMode: 'premultiplied',
        toneMapping: { mode: 'extended' },
      })
      if (context.getConfiguration()?.toneMapping?.mode !== 'extended') return false
      const values = new Float32Array([4, 2, 1, 1, 0.5, -0.025, 0.125, 0.5]),
        settings = JSON.stringify(defaultColorSettings())
      const encoded = float16_encode(color_encode_display(values, settings, 'srgb'))
      this.device.queue.writeTexture(
        { texture: context.getCurrentTexture() },
        new Uint16Array(encoded),
        { bytesPerRow: 16 },
        [2, 1],
      )
      await this.done()
      bitmap = source.transferToImageBitmap()
      const actual = await this.copyBitmap(bitmap, 2, 1, true),
        expected = color_encode_display(values, settings, this.space)
      return (
        !!actual &&
        actual.length === expected.length &&
        actual.every((v, i) => Number.isFinite(v) && Math.abs(v - expected[i]) < 0.008)
      )
    } finally {
      bitmap?.close()
      context.unconfigure()
    }
  }
  async presentBitmap(bitmap: ImageBitmap, width: number, height: number) {
    if (!this.bitmapTransport) throw new Error('位图未通过扩展范围传输验证')
    await this.copyBitmap(bitmap, width, height)
    this.canvas.dataset.transport = 'extended-image-bitmap'
  }
  async present(linear: Float32Array, width: number, height: number, settings: ColorSettings) {
    if (linear.length !== width * height * 4) throw new Error('浮点显示尺寸不匹配')
    this.prepare(width, height)
    const encoded = color_encode_display(linear, JSON.stringify(settings), this.space),
      half = float16_encode(encoded)
    this.device.pushErrorScope('validation')
    this.device.queue.writeTexture(
      { texture: this.context.getCurrentTexture() },
      new Uint16Array(half),
      { bytesPerRow: width * 8 },
      [width, height],
    )
    await this.done()
    const error = await this.device.popErrorScope()
    if (error) throw new Error(error.message)
    this.canvas.dataset.transport = 'linear-float-buffer'
  }
  fork(canvas: HTMLCanvasElement) {
    if (this.lost || this.disposed) throw new Error('浮点显示设备已关闭')
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('无法创建浮点显示表面')
    this.shared.references++
    const presenter = new ColorPresenter(
      canvas,
      this.device,
      context,
      this.space,
      this.hdr,
      this.shared,
    )
    try {
      presenter.configure()
      return presenter
    } catch (error) {
      presenter.dispose()
      throw error
    }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.context.unconfigure()
    if (--this.shared.references === 0) this.device.destroy()
  }
}
