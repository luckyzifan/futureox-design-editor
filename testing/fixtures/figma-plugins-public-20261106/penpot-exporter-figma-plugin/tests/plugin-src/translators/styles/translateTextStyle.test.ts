import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translateStyleName } from '@plugin/translators/styles/translateStyleName';
import { translateTextStyle } from '@plugin/translators/styles/translateTextStyle';

vi.mock('@plugin/libraries', () => ({
  missingFonts: new Set<string>(),
  textStyles: new Map()
}));

// @ts-expect-error - Mocking global figma object (non-FigJam editor)
global.figma = { editorType: 'figma' };

const createTextStyle = (overrides: Partial<TextStyle> = {}): TextStyle =>
  ({
    type: 'TEXT',
    id: 'S:abc,',
    name: 'Heading 1 (40) ',
    remote: true,
    fontName: { family: 'Roboto', style: 'Bold' },
    fontSize: 40,
    textDecoration: 'NONE',
    textCase: 'ORIGINAL',
    letterSpacing: { unit: 'PERCENT', value: 0 },
    lineHeight: { unit: 'AUTO' },
    ...overrides
  }) as unknown as TextStyle;

describe('translateTextStyle', () => {
  let missingFonts: Set<string>;

  beforeEach(async () => {
    const libraries = await import('@plugin/libraries');
    missingFonts = libraries.missingFonts;
    missingFonts.clear();
  });

  it('does not throw and falls back to the default font family when fontName is undefined', () => {
    const figmaStyle = createTextStyle({ fontName: undefined as unknown as FontName });

    expect(() => translateTextStyle(figmaStyle)).not.toThrow();

    const result = translateTextStyle(figmaStyle);
    expect(result.textStyle.fontFamily).toBe('sourcesanspro');
    expect(result.textStyle.fontId).toBe('');
    expect(result.textStyle.fontVariantId).toBe('normal-400');
    expect(result.textStyle.fontWeight).toBe('400');
    expect(result.textStyle.fontStyle).toBe('normal');
    expect(result.textStyle.fontSize).toBe('40');
  });

  it('falls back to the default font family when fontName has no usable family/style (remote style edge case), without recording a missing font', () => {
    const figmaStyle = createTextStyle({ fontName: {} as FontName });

    const result = translateTextStyle(figmaStyle);

    expect(result.textStyle.fontFamily).toBe('sourcesanspro');
    expect(result.textStyle.fontId).toBe('');
    expect(result.textStyle.fontVariantId).toBe('normal-400');
    expect(result.textStyle.fontWeight).toBe('400');
    expect(result.textStyle.fontStyle).toBe('normal');
    expect(result.textStyle.fontSize).toBe('40');

    expect(missingFonts.size).toBe(0);
    expect(missingFonts.has(undefined as unknown as string)).toBe(false);
  });

  it('translates a healthy remote Google Font style', () => {
    const figmaStyle = createTextStyle({
      remote: true,
      fontName: { family: 'Roboto', style: 'Bold' }
    });

    const result = translateTextStyle(figmaStyle);

    expect(result.textStyle.fontFamily).toBe('Roboto');
    expect(result.textStyle.fontId).toBe('gfont-roboto');
    expect(result.textStyle.fontWeight).toBe('700');
    expect(result.typography.path).toBe('Remote');
    expect(result.typography.name).toBe(translateStyleName(figmaStyle));
  });

  it('registers a custom font family not found in the google/local font lists as missing (regression guard)', () => {
    const figmaStyle = createTextStyle({
      fontName: { family: 'Acme Sans', style: 'Regular' }
    });

    const result = translateTextStyle(figmaStyle);

    expect(result.textStyle.fontFamily).toBe('Acme Sans');
    expect(result.textStyle.fontId).toBe('');
    expect(missingFonts.has('Acme Sans')).toBe(true);
  });
});
