import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

for (const host of ['web', 'electron']) for (const flag of [undefined, '0', 'true', '1'])
  test(`${host} desktop display launch flag ${String(flag)} is default-on, explicitly disableable and pinned`, async () => {
    vi.resetModules()
    vi.stubEnv('VITE_DESIGN_DESKTOP_DISPLAY', flag)
    vi.stubEnv('VITE_DESIGN_HDR', '0')
    vi.stubGlobal('window', host === 'electron' ? { coreDesktop: { version: 1, renderPolicy: { cpuOnly: false } } } : {})
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('localStorage', { getItem: () => null })
    const { renderExecutionPolicy } = await import('./client')
    expect(renderExecutionPolicy.desktopDisplay).toBe(host === 'electron' && flag !== '0')
    expect(renderExecutionPolicy.desktopFullMath).toBe(host === 'electron')
    expect(Object.isFrozen(renderExecutionPolicy)).toBe(true)
    vi.stubEnv('VITE_DESIGN_DESKTOP_DISPLAY', flag === '1' ? '0' : '1')
    expect(renderExecutionPolicy.desktopDisplay).toBe(host === 'electron' && flag !== '0')
  })
