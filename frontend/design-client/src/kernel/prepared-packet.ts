/** Await a shared CPU result without giving one consumer cancellation authority
 * over the physical compiler or another consumer's exact output. */
export function waitForPacket<T>(bytes: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return bytes
  if (signal.aborted) return Promise.reject(Error('PREVIEW_CANCELLED'))
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(Error('PREVIEW_CANCELLED')) }
    const cleanup = () => signal.removeEventListener('abort', cancel)
    signal.addEventListener('abort', cancel, { once: true })
    bytes.then(value => { cleanup(); if (signal.aborted) reject(Error('PREVIEW_CANCELLED')); else resolve(value) }, error => { cleanup(); reject(error) })
  })
}
export type PacketCertificate = Readonly<{ lane: string; revision: number; options: string; settings: string }>
/** No device, encoder, texture, or asset decoder is owned by this receipt.
 * Typed-array contents cannot be frozen in JS, so bytes remain private until
 * one validated ownership transfer. Disposal of an obsolete packet is CPU-only. */
export class PreparedPacket<T = Uint8Array> {
  readonly certificate: PacketCertificate
  private bytes?: T
  constructor(certificate: PacketCertificate, bytes: T, private current: () => boolean, private signal?: AbortSignal) {
    this.certificate = Object.freeze({ ...certificate })
    this.bytes = bytes
  }
  consume(): T {
    if (!this.bytes) throw Error('PREPARED_PACKET_CONSUMED')
    if (this.signal?.aborted) { this.discard(); throw Error('PREVIEW_CANCELLED') }
    if (!this.current()) { this.discard(); throw Error('STALE_PREPARED_PACKET') }
    const result = this.bytes
    this.bytes = undefined
    return result
  }
  discard() { this.bytes = undefined }
}
