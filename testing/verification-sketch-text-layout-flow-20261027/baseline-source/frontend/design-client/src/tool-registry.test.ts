import { describe, expect, test } from 'vitest'
import { TOOL_COMMANDS, MAPPED_TOOL_COMMANDS, toolForCommand, unavailableReason } from './tool-registry'

describe('tool command registry (43 unique commands)', () => {
  test('covers the decoded set-tool surface', () => {
    const ids = new Set(TOOL_COMMANDS.map((c) => c.id))
    for (const required of [
      'set-tool-default', 'set-tool-frame', 'set-tool-rectangle', 'set-tool-pen',
      'set-tool-pencil', 'set-tool-marker', 'set-tool-eraser', 'set-tool-scale',
      'set-tool-washi-tape', 'set-tool-bend', 'set-tool-offset-path', 'set-tool-sticky',
    ])
      expect(ids.has(required), required).toBe(true)
    expect(TOOL_COMMANDS.length).toBeGreaterThanOrEqual(44)
  })

  test('core tools map to native Tool ids', () => {
    expect(toolForCommand('set-tool-default')).toBe('select')
    expect(toolForCommand('set-tool-rectangle')).toBe('rectangle')
    expect(toolForCommand('set-tool-pen')).toBe('pen')
    expect(toolForCommand('set-tool-marker')).toBe('marker')
    expect(toolForCommand('set-tool-hand')).toBe('hand')
  })

  test('whiteboard and vector commands have working tool routes', () => {
    expect(toolForCommand('set-tool-sticky')).toBe('sticky')
    expect(toolForCommand('set-tool-washi-tape')).toBe('washi-tape')
    expect(toolForCommand('set-tool-bend')).toBe('bend')
  })

  test('unknown ids are inert', () => {
    expect(toolForCommand('set-tool-nonsense')).toBeNull()
    expect(toolForCommand('zoom-in')).toBeNull()
  })

  test('each registered command has an explicit native tool route', () => {
    expect(MAPPED_TOOL_COMMANDS.length).toBeGreaterThan(15)
    expect(MAPPED_TOOL_COMMANDS.length).toBe(TOOL_COMMANDS.length)
  })
})
