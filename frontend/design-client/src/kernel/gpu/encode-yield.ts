/** Yield CPU graph encoding to the display-message task without finishing or
 * reordering its render passes. The presenter owns a separate encoder/buffers. */
export class EncodeYield {
  private deadline = 0
  private channel?: MessageChannel
  private resolve?: () => void
  begin() { this.deadline = performance.now() + 4 }
  checkpoint(enabled: boolean, force = false): Promise<void> | undefined {
    if (!enabled || !force && performance.now() < this.deadline) return
    this.channel ??= new MessageChannel()
    const channel = this.channel
    return new Promise(resolve => {
      this.resolve = resolve
      channel.port1.onmessage = () => {
        this.deadline = performance.now() + 4
        this.resolve = undefined
        resolve()
      }
      channel.port2.postMessage(0)
    })
  }
  dispose() { this.channel?.port1.close(); this.channel?.port2.close(); this.resolve?.(); this.resolve = undefined }
}
