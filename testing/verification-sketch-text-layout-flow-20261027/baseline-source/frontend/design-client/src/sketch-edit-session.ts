import { admitSketchSession } from '../../design-desktop/src/sketch-session-contract.mjs'
import type { SketchSessionBridge, SketchSessionStatus, SketchNativeFrame, DesktopResult } from './desktop'
export type SketchEditState = Readonly<{ session: SketchSessionStatus | null; displayName: string; pending: boolean; error: string; uncertain: boolean }>
/** One UI owner, no automatic mutation replay and no dependency on Figma Editor. */
export class SketchEditSession {
  private state: SketchEditState = { session: null, displayName: '', pending: false, error: '', uncertain: false }
  private listeners = new Set<() => void>()
  private active = true
  private bridge: SketchSessionBridge
  constructor(bridge: SketchSessionBridge) { this.bridge = bridge }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate() { this.active = true }
  dispose() { this.active = false }
  private set(update: Partial<SketchEditState>) { if (this.active) { this.state = { ...this.state, ...update }; this.listeners.forEach(f => f()) } }
  private admit(result: DesktopResult<SketchSessionStatus>) {
    if (result.status !== 'ok') throw Object.assign(new Error(result.status === 'cancelled' ? '操作已取消' : result.message), { code: result.status === 'cancelled' ? 'CANCELLED' : result.code })
    const owner = this.state.session?.owner || result.owner
    return admitSketchSession(result, owner)
  }
  private async run(work: () => Promise<void>) {
    if (!this.active || this.state.pending) return
    this.set({ pending: true, error: '' })
    try { await work() }
    catch (error) {
      const owner = this.state.session?.owner
      let uncertain = !!owner || (error as { code?: string })?.code === 'SKETCH_OPEN_UNCERTAIN'
      if (owner) {
        try { const session = this.admit(await this.bridge.status({ owner })); this.set({ session: session.active ? session : null }); uncertain = false } catch { /* No replay: keep last known identity and block edits. */ }
      }
      this.set({ uncertain, error: `${error instanceof Error ? error.message : String(error)}${owner ? uncertain ? '；状态无法核对，编辑已暂停，未重试操作。' : '；已核对当前状态，未重试操作。' : ''}` })
    } finally { this.set({ pending: false }) }
  }
  open() { return this.run(async () => {
    if (this.state.session) throw new Error('请先关闭当前 Sketch 会话')
    const result = await this.bridge.open()
    if (result.status === 'cancelled') { this.set({ uncertain: false }); return }
    this.set({ session: this.admit(result), displayName: result.status === 'ok' ? result.displayName : '', uncertain: false })
  }) }
  refresh() { return this.run(async () => {
    const owner = this.state.session?.owner
    if (!owner) return
    const session = this.admit(await this.bridge.status({ owner })); this.set({ session: session.active ? session : null, uncertain: false })
  }) }
  private mutate(work: (s: SketchSessionStatus) => Promise<DesktopResult<SketchSessionStatus>>) { return this.run(async () => {
    if (!this.state.session || this.state.uncertain) throw new Error('没有已核对的 Sketch 编辑会话')
    this.set({ session: this.admit(await work(this.state.session)) })
  }) }
  rename(layerId: string, name: string) { return this.mutate(s => this.bridge.rename({ owner: s.owner, expectedRevision: s.revision, layerId, name })) }
  resizeLegacyContainer(layerId: string, width: number, height: number) { return this.mutate(s => this.bridge.resizeLegacyContainer({ owner: s.owner, expectedRevision: s.revision, layerId, width, height })) }
  setTextOverride(instanceId: string, targetPath: string, text: string) { return this.mutate(s => this.bridge.setTextOverride({ owner: s.owner, expectedRevision: s.revision, instanceId, targetPath, text })) }
  setLeafFrame(layerId: string, frame: SketchNativeFrame) { return this.mutate(s => this.bridge.setLeafFrame({ owner: s.owner, expectedRevision: s.revision, layerId, ...frame })) }
  undo() { return this.mutate(s => this.bridge.undo({ owner: s.owner, expectedRevision: s.revision })) }
  redo() { return this.mutate(s => this.bridge.redo({ owner: s.owner, expectedRevision: s.revision })) }
  saveAs() { return this.run(async () => {
    const s = this.state.session
    if (!s || this.state.uncertain) throw new Error('请先核对 Sketch 会话状态')
    const result = await this.bridge.saveAs({ owner: s.owner, expectedRevision: s.revision })
    if (result.status === 'cancelled') return
    this.set({ session: this.admit(result), displayName: result.status === 'ok' ? result.displayName : this.state.displayName,
      error: result.status === 'ok' ? result.saveWarning || '' : '' })
  }) }
  async close(): Promise<boolean> {
    if (this.state.pending) return false
    let closed = false
    await this.run(async () => {
      const s = this.state.session
      if (!s) { if (this.state.uncertain) throw Object.assign(new Error('打开结果尚未核对，请再次点击打开以恢复已有会话'), { code: 'SKETCH_OPEN_UNCERTAIN' }); closed = true; return }
      const result = await this.bridge.close({ owner: s.owner, expectedRevision: s.revision, discard: true })
      if (result.status === 'cancelled') return
      if (result.status !== 'ok') throw new Error(result.message)
      this.set({ session: null, uncertain: false }); closed = true
    })
    return closed && this.active
  }
}
