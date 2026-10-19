type ImportEditor = {
  readonly sessionGeneration: number
  readonly state: { doc: { id: string } }
  subscribe?(listener: () => void): () => void
}
export type ImportRequest = {
  readonly signal: AbortSignal
  isCurrent(): boolean
  isLatest(): boolean
  assertCurrent(): void
  finish(): void
}

/** Local request ownership is separate from the document ID, which may be reopened. */
export class ImportOwner {
  private generation = 0
  private active = true
  private pending?: AbortController
  activate() { this.active = true }
  invalidate() { this.generation++; this.pending?.abort(); this.pending = undefined }
  dispose() { this.active = false; this.invalidate() }
  begin(editor: ImportEditor): ImportRequest {
    this.pending?.abort()
    const controller = new AbortController()
    this.pending = controller
    const generation = ++this.generation
    const session = editor.sessionGeneration
    const id = editor.state.doc.id
    const isLatest = () => this.active && generation === this.generation
    const isCurrent = () => isLatest() && editor.sessionGeneration === session && editor.state.doc.id === id
    // Direct workspace/tab navigation can retire a request without going
    // through App's file picker. Abort its work as soon as the editor changes.
    const unsubscribe = editor.subscribe?.(() => { if (!isCurrent()) controller.abort() })
    if (unsubscribe) controller.signal.addEventListener('abort', unsubscribe, { once: true })
    return {
      signal: controller.signal, isLatest, isCurrent,
      finish: () => {
        unsubscribe?.()
        if (this.pending === controller) this.pending = undefined
      },
      assertCurrent() { if (!isCurrent()) throw new Error('导入请求已过期，文件或编辑会话已切换；请重新导入') },
    }
  }
}

export async function importStep<T>(request: ImportRequest, work: () => Promise<T>): Promise<T> {
  request.assertCurrent()
  const result = await work()
  request.assertCurrent()
  return result
}
