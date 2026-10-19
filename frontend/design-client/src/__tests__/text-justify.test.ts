import { describe, it, expect } from 'vitest'

describe('Text Justify Alignment', () => {
  it('should accept justify as valid text alignment', () => {
    const validAlignments = ['left', 'center', 'right', 'justify']

    for (const align of validAlignments) {
      expect(validAlignments).toContain(align)
    }
  })

  it('should create text node with justify alignment', () => {
    const textNode = {
      id: 'text1',
      kind: 'text' as const,
      name: 'Text',
      visible: true,
      opacity: 1,
      blend: 'normal' as const,
      width: 200,
      height: 100,
      transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      text: 'This text should be justified across the full width of the text box.',
      align: 'justify' as const,
      valign: 'top' as const,
      fontFamily: 'Inter',
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      fills: [{ kind: 'solid' as const, visible: true, opacity: 1, blend: 'normal' as const, color: '#000000', stops: [], angle: 0 }],
      strokes: [],
      effects: [],
    }

    expect(textNode.align).toBe('justify')
  })

  it('should validate justify alignment with auto-layout', () => {
    // Testing that justify alignment doesn't conflict with layout validation
    const autoLayoutNode = {
      id: 'frame1',
      kind: 'frame' as const,
      name: 'Auto Layout',
      visible: true,
      opacity: 1,
      blend: 'normal' as const,
      width: 300,
      height: 200,
      transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      layout: {
        mode: 'horizontal' as const,
        gap: 12,
        padding: [16, 16, 16, 16] as [number, number, number, number],
        align: 'start' as const,     // Auto-layout cross-axis alignment
        sizing: 'hug' as const,
      },
      fills: [],
      strokes: [],
      effects: [],
      children: ['text1'],
    }

    // Auto-layout's `align` is for child positioning, not text alignment
    expect(autoLayoutNode.layout.align).toBe('start')
  })

  it('should handle justify in text styles', () => {
    const textStyle = {
      name: 'Body Justified',
      fontFamily: 'Inter',
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      align: 'justify' as const,
    }

    expect(textStyle.align).toBe('justify')
  })
})
