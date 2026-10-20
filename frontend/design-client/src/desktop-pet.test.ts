import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopPet } from './desktop-pet'
import type { DesktopBridge } from './desktop'
import { Editor, type EditorEditEvent } from './engine'
import { blank, node } from './model'

describe('optional desktop pet semantic bridge', () => {
  const event = vi.fn(), configure = vi.fn()
  const pet = () => new DesktopPet(() => ({ petEvent: event, petConfigure: configure }) as unknown as DesktopBridge)
  beforeEach(() => { vi.useFakeTimers(); event.mockReset(); configure.mockReset(); vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() }) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it('defaults off and never emits disabled events', () => {
    const bridge = pet(); bridge.start(); bridge.event('edit'); bridge.navigate()
    expect(bridge.snapshot()).toBe('off'); expect(configure).toHaveBeenCalledWith('off'); expect(event).not.toHaveBeenCalled()
  })
  it('coalesces edit bursts before IPC and transmits only enums', () => {
    const bridge = pet(); bridge.configure('active')
    for(let i=0;i<1000;i++) bridge.event('edit')
    bridge.event('save'); bridge.event('undo'); bridge.event('export'); bridge.event('error')
    expect(event.mock.calls).toEqual([['edit'], ['save'], ['undo'], ['export'], ['error']])
    vi.advanceTimersByTime(1200); bridge.event('edit'); expect(event).toHaveBeenCalledTimes(6)
  })
  it('sends one navigation pair for wheel frames and holds through a stationary pan', () => {
    const bridge = pet(); bridge.configure('quiet')
    bridge.navigate(true)
    for(let i=0;i<100;i++) { bridge.navigate(); vi.advanceTimersByTime(16) }
    vi.advanceTimersByTime(2000); expect(event.mock.calls).toEqual([['navigation-start']])
    bridge.navigate(false); vi.advanceTimersByTime(249); expect(event).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1); expect(event.mock.calls).toEqual([['navigation-start'], ['navigation-end']])
  })
  it('cancels navigation timer when disabled', () => {
    const bridge = pet(); bridge.configure('active'); bridge.navigate(); bridge.configure('off')
    vi.advanceTimersByTime(1000); bridge.event('error')
    expect(event.mock.calls).toEqual([['navigation-start'], ['navigation-end']])
  })
  it('binds committed edits and undo, never raw pointer or document content', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('active')
    let listener!: (event: EditorEditEvent) => void
    const remove = vi.fn(), bridge = pet()
    const cleanup = bridge.bind({ subscribeEdits: callback => { listener = callback; return remove } })
    listener({ kind: 'edit', source: 'user', documentId: 'private', summary: 'private text', session: 1, revision: 1 })
    listener({ kind: 'undo', source: 'user', documentId: 'private', summary: 'private text', session: 1, revision: 2 })
    expect(event.mock.calls).toEqual([['edit'], ['undo']]); cleanup(); expect(remove).toHaveBeenCalledOnce()
  })
  it('observes real committed mutations and undo, but not drag previews or cancelled edits', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('active')
    const document = blank('Private document'), shape = node('rectangle', 0, 0, 30, 30)
    document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
    const editor = new Editor(document), bridge = pet(), cleanup = bridge.bind(editor)
    try {
      editor.begin('Move'); editor.preview({ [shape.id]: { transform: [1, 0, 0, 1, 20, 20] } })
      expect(event).not.toHaveBeenCalled(); editor.cancel(); expect(event).not.toHaveBeenCalled()
      editor.begin('Move'); editor.preview({ [shape.id]: { transform: [1, 0, 0, 1, 40, 40] } }); editor.commit()
      expect(event.mock.calls).toEqual([['edit']]); editor.undo(); expect(event.mock.calls).toEqual([['edit'], ['undo']])
    } finally { cleanup(); editor.dispose() }
  })
  it('reports sanitized backend failures and ignores obsolete configure replies', async () => {
    const bridge = pet()
    configure.mockResolvedValue({ ok: false, failed: true, mode: 'off', detail: 'secret backend text' })
    bridge.configure('active'); await Promise.resolve(); expect(bridge.statusSnapshot()).toBe('unavailable')
    configure.mockRejectedValue(Error('secret backend text'))
    bridge.configure('quiet'); await Promise.resolve(); expect(bridge.statusSnapshot()).toBe('unavailable')
    let settle!: (value: unknown) => void
    configure.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    bridge.configure('active')
    configure.mockResolvedValue({ ok: true, failed: false, mode: 'off', phase: 'off', revision: 2 })
    bridge.configure('off'); await Promise.resolve(); expect(bridge.statusSnapshot()).toBe('off')
    settle({ ok: false, failed: true }); await Promise.resolve(); expect(bridge.statusSnapshot()).toBe('off')
  })
  it('subscribes before configure and observes starting, ready, async crash and failed load', async () => {
    vi.mocked(localStorage.getItem).mockReturnValue('active')
    let push!: (status: import('./desktop-pet').PetStatus) => void
    const unsubscribe = vi.fn(), order: string[] = []
    const bridge = new DesktopPet(() => ({
      onPetStatus: (callback: (status: import('./desktop-pet').PetStatus) => void) => { order.push('subscribe'); push = callback; return unsubscribe },
      petConfigure: async (mode: import('./desktop-pet').PetMode) => { order.push(mode); return { ok: true, failed: false, mode, phase: mode === 'off' ? 'off' : 'starting', revision: mode === 'off' ? 10 : 1 } },
    }) as unknown as DesktopBridge)
    const cleanup = bridge.bind({ subscribeEdits: () => () => {} })
    await Promise.resolve(); expect(order).toEqual(['subscribe', 'active']); expect(bridge.statusSnapshot()).toBe('checking')
    push({ mode: 'active', phase: 'ready', revision: 2 }); expect(bridge.statusSnapshot()).toBe('ready')
    push({ mode: 'off', phase: 'unavailable', revision: 3 }); expect(bridge.statusSnapshot()).toBe('unavailable')
    expect(bridge.snapshot()).toBe('active')
    push({ mode: 'active', phase: 'ready', revision: 2 }); expect(bridge.statusSnapshot()).toBe('unavailable')
    push({ mode: 'active', phase: 'starting', revision: 4 }); push({ mode: 'off', phase: 'unavailable', revision: 5 })
    expect(bridge.statusSnapshot()).toBe('unavailable')
    cleanup(); expect(unsubscribe).toHaveBeenCalledOnce(); await Promise.resolve()
    push({ mode: 'active', phase: 'ready', revision: 11 }); expect(bridge.statusSnapshot()).toBe('off')
  })
  it('does not infer readiness from ok without an explicit runtime phase', async () => {
    const bridge = pet(); configure.mockResolvedValue({ ok: true, failed: false, mode: 'active' })
    bridge.configure('active'); await Promise.resolve(); expect(bridge.statusSnapshot()).toBe('unavailable')
  })
  it('unmount switches host off without replacing the stored preference', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('active')
    const bridge = pet(), cleanup = bridge.bind({ subscribeEdits: () => () => {} })
    bridge.navigate(true); cleanup()
    expect(configure.mock.calls).toEqual([['active'], ['off']]); expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(event.mock.calls).toEqual([['navigation-start'], ['navigation-end']])
    bridge.releaseNavigation(); vi.advanceTimersByTime(1000); expect(event).toHaveBeenCalledTimes(2)
  })
  it('blur or cancelled capture ends held navigation without cleanup restarting it', () => {
    const bridge = pet(); bridge.configure('active'); bridge.navigate(true)
    bridge.stopNavigation(); bridge.releaseNavigation(); vi.advanceTimersByTime(1000)
    expect(event.mock.calls).toEqual([['navigation-start'], ['navigation-end']])
  })
  it('isolates absent, throwing and rejected optional APIs and denied storage', async () => {
    const bridge = pet(); configure.mockImplementation(() => { throw Error('disconnected') }); event.mockRejectedValue(Error('disconnected'))
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw Error('denied') })
    expect(bridge.configure('active')).toBe(false); expect(() => bridge.event('save')).not.toThrow()
    expect(() => new DesktopPet(() => undefined).configure('off')).not.toThrow()
    await Promise.resolve()
  })
})
