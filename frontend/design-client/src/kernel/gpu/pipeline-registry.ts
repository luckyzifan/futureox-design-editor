/** Device-owned exact programs. One promise per descriptor also remembers a
 * compilation failure, so repeated input cannot start a compile/retry storm.
 * A replacement GPU device owns a new registry; failures never cross devices. */
export class PipelineRegistry {
  private entries = new Map<string, { build: () => Promise<void>; pending?: Promise<void> }>()
  builds = 0
  ready = 0
  buildMs = 0
  register(key: string, build: () => Promise<void>) {
    if (!this.entries.has(key)) this.entries.set(key, { build })
  }
  keys() { return this.entries.keys() }
  async prepare(keys: Iterable<string>) {
    const jobs = [...new Set(keys)].map(key => {
      const entry = this.entries.get(key)
      if (!entry) return Promise.reject(Error(`Unknown GPU pipeline ${key}`))
      return entry.pending ??= (async () => {
        const start = performance.now(); this.builds++
        try { await entry.build(); this.ready++ }
        finally { this.buildMs += performance.now() - start }
      })()
    })
    // Never let a failed sibling outlive device cleanup.
    const results = await Promise.allSettled(jobs)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
