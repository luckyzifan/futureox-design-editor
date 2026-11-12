import { webPath } from '../web-path'
export type InitializationLease = { signal: AbortSignal; assertCurrent(): void; commit(publish: () => void): void }
type Clock = {
  now(): number
  schedule(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  cancel(timer: ReturnType<typeof setTimeout>): void
}
const clock: Clock = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (timer) => clearTimeout(timer),
}

/** Bounds callers' wait and late adoption; it cannot terminate a WASM compilation. */
export class InitializationGate {
  private generation = 0
  private pending: Promise<void> | undefined
  private readonly milliseconds: number
  private readonly clock: Clock
  constructor(milliseconds = 30000, sourceClock: Clock = clock) {
    this.milliseconds = milliseconds
    this.clock = sourceClock
  }
  run(work: (lease: InitializationLease) => Promise<void>): Promise<void> {
    if (this.pending) return this.pending
    const generation = ++this.generation
    const controller = new AbortController()
    const deadline = this.clock.now() + this.milliseconds
    const expired = () => new Error('内核资源初始化超时或已过期；请重试')
    let timer: ReturnType<typeof setTimeout>
    let committed = false
    let resolveCommitted!: () => void
    const completion = new Promise<void>((resolve) => { resolveCommitted = resolve })
    const lease: InitializationLease = {
      signal: controller.signal,
      assertCurrent: () => {
        if (generation !== this.generation || controller.signal.aborted || this.clock.now() >= deadline)
          throw expired()
      },
      commit: (publish) => {
        lease.assertCurrent()
        if (committed) throw new Error('内核初始化已确认')
        publish()
        // Publication is the linearization point. There must be no await in
        // this callback; a trailing promise microtask cannot revoke this success.
        committed = true
        this.clock.cancel(timer!)
        resolveCommitted()
      },
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = this.clock.schedule(() => { controller.abort(); reject(expired()) }, this.milliseconds)
    })
    const attempt = Promise.resolve().then(() => { lease.assertCurrent(); return work(lease) }).then(() => {
      if (!committed) throw new Error('内核初始化未确认完成')
    })
    this.pending = Promise.race([completion, attempt, timeout]).finally(() => {
      this.clock.cancel(timer!)
      controller.abort()
      if (generation === this.generation && !committed) this.pending = undefined
    })
    return this.pending
  }
}

/** Fixed same-origin build assets only; check actual streamed bytes, not just headers. */
export async function readKernelAsset(
  path: '/kernel/design_kernel_bg.wasm' | '/fonts/NotoSansSC.ttf',
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(webPath(path), { signal, mode: 'same-origin', redirect: 'error' })
  if (!response.ok) throw new Error(`无法载入内核资源：HTTP ${response.status}`)
  if (Number(response.headers.get('Content-Length')) > limit)
    throw new Error('内核资源超过大小限制')
  if (!response.body) throw new Error('内核资源内容为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new Error('内核资源读取已取消')
      if (done) break
      length += value.byteLength
      if (length > limit) throw new Error('内核资源超过大小限制')
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
