/** One GPU encoder owner, with interactive work ahead of queued refinement.
 * A batch can yield between completed tiles, never inside a GPU encoder. */
// A scheduling quantum in completed jobs, not milliseconds or GPU submissions.
// Keep the interactive burst short while amortizing one lane restoration per tile.
export const GPU_PRIORITY_BURST = 4

export class RenderWorkQueue {
  private running = false
  private tasks: {
    work: () => Promise<void>
    priority: number
    resolve: () => void
    reject: (error: unknown) => void
  }[] = []
  run(work: () => Promise<void>, priority = 0): Promise<void> {
    const done = new Promise<void>((resolve, reject) =>
      this.tasks.push({ work, priority, resolve, reject }),
    )
    void this.drain()
    return done
  }
  /** Called only by the current owner at a completed-frame boundary. Equal
   * priority work stays queued, preserving document revision order. */
  async yieldToHigherPriority(priority: number, maxTasks = Infinity): Promise<void> {
    // Tile callers bound interruptions so a stream of new pointer jobs cannot
    // monopolize a suspended batch. Commit barriers retain the unbounded default.
    let completed = 0
    while (completed < maxTasks && this.tasks.some(task => task.priority > priority)) {
      let best = 0
      for (let i = 1; i < this.tasks.length; i++)
        if (this.tasks[i].priority > this.tasks[best].priority) best = i
      const task = this.tasks.splice(best, 1)[0]
      try { await task.work(); task.resolve() }
      catch (error) { task.reject(error) }
      completed++
    }
  }
  private async drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.tasks.length) {
        let best = 0
        for (let i = 1; i < this.tasks.length; i++)
          if (this.tasks[i].priority > this.tasks[best].priority) best = i
        const task = this.tasks.splice(best, 1)[0]
        try {
          await task.work()
          task.resolve()
        } catch (error) {
          task.reject(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
