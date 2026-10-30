import { admitSketchTextTargets, admitSketchTextValue } from '../../design-desktop/src/sketch-session-contract.mjs'
import type { SketchSessionBridge, SketchSessionOwner, SketchTextTargets, SketchTextValue } from './desktop'
type Context = { owner: SketchSessionOwner; revision: number; instanceId: string }
type QueryState = Readonly<{ targets: SketchTextTargets['targets'] | null; path: string; value: SketchTextValue | null; pending: boolean; error: string }>
/** Read-only request generations: context/path changes and stop invalidate all late replies. */
export class SketchTextQuery {
  private generation = 0
  private context: Context | null = null
  private state: QueryState = { targets: null, path: '', value: null, pending: false, error: '' }
  private listeners = new Set<() => void>()
  constructor(private bridge: SketchSessionBridge) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(update: Partial<QueryState>) { this.state = { ...this.state, ...update }; this.listeners.forEach(f => f()) }
  stop() { ++this.generation; this.context = null }
  async load(owner: SketchSessionOwner, revision: number, instanceId: string) {
    const generation = ++this.generation
    const context = this.context = { owner: { ...owner }, revision, instanceId }
    this.set({ targets: null, path: '', value: null, pending: true, error: '' })
    try {
      const result = await this.bridge.textTargets({ owner: context.owner, expectedRevision: revision, instanceId })
      if (generation !== this.generation) return
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '查询已取消' : result.message)
      this.set({ targets: admitSketchTextTargets(result, context.owner, revision, instanceId).targets, pending: false })
    } catch (error) { if (generation === this.generation) this.set({ pending: false, error: String(error) }) }
  }
  async selectPath(path: string) {
    const context = this.context
    const generation = ++this.generation
    this.set({ path, value: null, pending: false, error: '' })
    if (!context || !path) return
    if (!this.state.targets?.some(t => t.targetPath === path)) { this.set({ error: '目标不在本次原生查询结果中' }); return }
    this.set({ pending: true })
    try {
      const result = await this.bridge.textValue({ owner: context.owner, expectedRevision: context.revision, instanceId: context.instanceId, targetPath: path })
      if (generation !== this.generation) return
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '查询已取消' : result.message)
      this.set({ value: admitSketchTextValue(result, context.owner, context.revision, context.instanceId, path), pending: false })
    } catch (error) { if (generation === this.generation) this.set({ pending: false, error: String(error) }) }
  }
}
