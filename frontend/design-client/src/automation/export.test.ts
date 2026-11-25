import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { blank, node, paint, effect, stroke, validateDocument, defaultLayout, defaultSizing } from '../model'
import { layoutFixture } from '../layout-fixtures'
import { componentFixture } from '../component-fixtures'
import { emptySystem } from '../design-system'
import { getDesignContext } from './context'
import { decodeDocumentBinary } from '../kernel/binfmt'
import { defaultTextStyle } from '../model'
import { Editor } from '../engine'
import { createDesignAutomation } from './core'
import { exportDesignCode, exportDesignSvg, exportNativeDocument, exportBinaryDocument, importNativeDocument, captureDesignPreview, exportExtensions } from './export'

function fixture() {
  const document = blank('Export fixture'), frame = node('frame', 5, 10, 300, 200), text = node('text', 10, 10, 150, 50)
  text.text = 'Native to semantic'; text.fontSize = 20; frame.children = [text.id]
  document.nodes = { [frame.id]: frame, [text.id]: text }; document.pages[0].children = [frame.id]
  return { document, frame, text }
}
describe('AI-friendly semantic export', () => {
  it('preserves authored text and identifies the HTML approximation of title case', () => {
    const { document, text } = fixture()
    document.schemaVersion = 15
    text.textStyle = { ...defaultTextStyle(), textCase: 'title' }
    text.textRuns = [{ start: 0, end: 6, textCase: 'original' }]
    const result = exportDesignCode(document)
    expect(result.css).toContain('text-transform:capitalize')
    expect(result.css).toContain('text-transform:none')
    expect(result.html).toContain('Native')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'TEXT_CASE_APPROXIMATION', nodeId: text.id }))
  })
  it.each(['horizontal', 'grid'] as const)('exports the real %s layout deterministically with complete stable node-ID mappings', kind => {
    const document = layoutFixture(kind), before = JSON.stringify(document)
    const a = exportDesignCode(document), b = exportDesignCode(document)
    expect(a).toEqual(b); expect(JSON.stringify(document)).toBe(before)
    expect(a.css).toContain(kind === 'grid' ? 'display:grid' : 'display:flex')
    for (const id of Object.keys(document.nodes)) {
      expect(a.html).toContain(`data-node-id="${id}"`)
      expect(a.css).toContain(a.nodeIdMap[id].selector)
    }
    expect(a.warnings.some(w => w.code === 'LAYOUT_APPROXIMATION')).toBe(true)
    expect(a.fidelity).toBe('approximate')
  })
  it('escapes hostile names, text and URLs without emitting executable user strings', () => {
    const { document, frame, text } = fixture(); document.schemaVersion = 5
    document.name = '</title><script>alert(1)</script>'
    frame.name = '"><img src=x onerror=alert(1)>'
    text.text = '<script>alert("unsafe")</script>'
    text.textRuns = [{ start: 0, end: text.text.length, link: 'javascript:alert(1)' }]
    const image = paint('#fff', 'image'); image.image = 'data:image/svg+xml,<svg onload="alert(1)"/>'; frame.fills.push(image)
    const result = exportDesignCode(document)
    expect(result.html).not.toContain('<script>'); expect(result.html).not.toContain('<img ')
    expect(result.html).toContain('&lt;script&gt;'); expect(result.html).not.toContain('href="javascript:')
    expect(result.css).not.toContain('onload'); expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNSAFE_ASSET_URL' }), expect.objectContaining({ code: 'UNSAFE_LINK' })]))
    expect(result.html).toContain("script-src 'none'")
  })
  it('exports portable image manifests and safe links, and flags unsupported material effects', () => {
    const { document, frame, text } = fixture(); document.schemaVersion = 5
    const image = paint('#fff', 'image'); image.image = 'data:image/png;base64,iVBORw0KGgo='; frame.fills = [image]; frame.effects = [effect('glass'), effect('noise')]
    text.textRuns = [{ start: 0, end: text.text.length, link: 'https://example.test/?a=1&b=2', underline: true }]
    const result = exportDesignCode(document)
    expect(result.assets[0]).toMatchObject({ source: 'embedded', emitted: true, dataUrl: image.image })
    expect(result.html).toContain('href="https://example.test/?a=1&amp;b=2"')
    expect(result.css).toContain('text-decoration:underline')
    expect(result.warnings.some(w => w.code === 'UNSUPPORTED_EFFECT' && w.nodeId === frame.id)).toBe(true)
  })
  it('keeps old 32-bit hash collisions distinct while deduplicating genuinely identical images', () => {
    // These two different URLs collide under the previous FNV-1a identity.
    const urls = ['https://assets.example.test/000339ff.png', 'https://assets.example.test/00078880.png']
    const legacyHash = (value: string) => { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }
    expect(legacyHash(urls[0])).toBe(legacyHash(urls[1]))
    const document = blank('Asset identities'), nodes = [0, 1, 0].map(index => {
      const n = node('rectangle'), p = paint('#fff', 'image'); p.image = urls[index]; n.fills = [p]
      document.nodes[n.id] = n; document.pages[0].children.push(n.id); return n
    })
    const context = getDesignContext(document), code = exportDesignCode(document)
    expect(context.assets).toHaveLength(2); expect(code.assets).toHaveLength(2)
    expect(context.assets[0].id).not.toBe(context.assets[1].id)
    expect(context.assets[0].nodeIds).toEqual([nodes[0].id, nodes[2].id])
    expect(code.assets.map(a => a.id)).toEqual(context.assets.map(a => a.id))
    expect(code.assets.map(a => a.uri)).toEqual(urls)
    expect(context.nodes[0].materialRefs[0].assetId).toBe(context.nodes[2].materialRefs[0].assetId)
    expect(context.nodes[1].materialRefs[0].assetId).not.toBe(context.nodes[0].materialRefs[0].assetId)
    const pageOne = getDesignContext(document, { limit: 1 }), pageTwo = getDesignContext(document, { limit: 1, cursor: pageOne.pagination.nextCursor! })
    expect(pageOne.assets[0].id).toBe(context.assets[0].id)
    expect(pageTwo.assets[0].id).toBe(context.assets[1].id)
  })
  it('exports component-resolved content and token values through existing kernel layout', () => {
    const { doc } = componentFixture()
    const result = exportDesignCode(doc)
    expect(result.html).toContain('继续')
    expect(Object.keys(result.nodeIdMap).length).toBeGreaterThan(5)
    const { document, text } = fixture(); document.schemaVersion = 4; document.designSystem = emptySystem()
    document.designSystem.collections.colors = { name: 'Colors', modes: ['light'], defaultMode: 'light' }
    document.designSystem.variables.brand = { name: 'Brand', kind: 'color', collection: 'colors', values: { light: '#123456' } }
    text.bindings = { 'fills.0.color': 'brand' }
    expect(exportDesignCode(document).css).toContain('#123456')
  })
  it('fails bounded scope instead of silently dropping nodes', () => {
    const { document } = fixture()
    expect(() => exportDesignCode(document, { maxNodes: 1 })).toThrow('maxNodes')
    expect(() => exportDesignCode(document, { nodeIds: ['missing'] })).toThrow('selected page')
  })
  it('places absolute children on the padding edge and maps gradient paints into CSS', () => {
    const document = blank('CSS geometry')
    document.schemaVersion = 4
    const frame = node('frame', 0, 0, 200, 120)
    frame.layout = { ...defaultLayout(), mode: 'horizontal', padding: [30, 10, 0, 40], gap: 0, lineGap: 0 }
    const child = node('rectangle', 10, 15, 20, 20)
    child.sizing = { ...defaultSizing(), absolute: true }
    const gradient = node('rectangle', 0, 280, 200, 80)
    const linear = paint('#ff0000', 'linear')
    linear.angle = 0
    linear.stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }]
    gradient.fills = [linear]
    const faded = node('rectangle', 0, 380, 200, 80)
    const vertical = paint('#112233', 'linear')
    vertical.angle = 0
    vertical.opacity = 0.5
    vertical.transform = [0, 1, -1, 0, 1, 0]
    vertical.stops = [{ offset: 0, color: '#112233' }, { offset: 1, color: '#abcdef' }]
    faded.fills = [vertical]
    const radialNode = node('ellipse', 0, 480, 100, 60)
    const radial = paint('#00ff00', 'radial')
    radial.stops = [{ offset: 1, color: '#0000ff' }, { offset: 0, color: '#00ff00' }]
    radialNode.fills = [radial]
    frame.children = [child.id]
    document.nodes = { [frame.id]: frame, [child.id]: child, [gradient.id]: gradient, [faded.id]: faded, [radialNode.id]: radialNode }
    document.pages[0].children = [frame.id, gradient.id, faded.id, radialNode.id]
    const css = exportDesignCode(document).css
    expect(css).toContain('.design-node{position:absolute;left:0;top:0;transform-origin:0 0}')
    expect(css).toContain('padding:30px 10px 0px 40px')
    expect(css).toContain('transform:matrix(1,0,0,1,10,15)')
    expect(css).toContain('linear-gradient(90deg,#ff0000 0%,#0000ff 100%)')
    expect(css).toContain('linear-gradient(180deg,color-mix(in srgb, #112233 50%, transparent) 0%,color-mix(in srgb, #abcdef 50%, transparent) 100%)')
    expect(css).toContain('radial-gradient(ellipse closest-side at center,#00ff00 0%,#0000ff 100%)')
  })
})

function ruleFor(css: string, selector: string) {
  const start = css.indexOf(`${selector}{`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start) + 1)
}
/** A rule with nested rules, such as an @supports block, up to its closing brace. */
function blockFor(css: string, marker: string) {
  const start = css.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  throw new Error(`Unclosed block at ${marker}`)
}
const FADED_IMAGE = 'data:image/png;base64,iVBORw0KGgo='
const ESCAPED_IMAGE = 'url("data\\3a image\\2f png\\3b base64\\2c iVBORw0KGgo\\3d ")'

describe('CSS export of paint, stroke, flow, text, and blur', () => {
  it('fades only the image fill and leaves the node, stroke, and other fill alone', () => {
    const document = blank('Image opacity')
    document.schemaVersion = 31
    const frame = node('rectangle', 0, 0, 80, 40)
    const under = paint('#00ff00')
    const image = paint('#fff', 'image')
    image.opacity = 0.25
    image.fit = 'contain'
    image.image = FADED_IMAGE
    frame.fills = [under, image]
    frame.strokes = [{ ...stroke('#ff0000', 4), align: 'inside' }]
    document.nodes = { [frame.id]: frame }
    document.pages[0].children = [frame.id]
    const result = exportDesignCode(document)
    // The node rule holds what every engine parses: the node opacity and the
    // fill that needs no fade. A fade written here would take that fill down
    // with it wherever the fade is not understood.
    const rule = ruleFor(result.css, '#design-node-1')
    expect(rule).toContain('opacity:1')
    expect(rule).not.toContain('opacity:25%')
    expect(rule).toContain('background-image:linear-gradient(#00ff00,#00ff00)')
    expect(rule).not.toContain('cross-fade(')
    expect(rule).not.toContain('color-mix(in srgb, #00ff00')
    expect(rule).not.toContain('border:')
    // Chromium and WebKit fade one layer only through the prefixed
    // three-argument form. No tested engine parses the unprefixed one, and
    // declarations that use it alone are dropped.
    const exact = blockFor(result.css, '@supports (')
    expect(exact).toContain(`@supports (background-image:-webkit-cross-fade(url(a.png),url(b.png),0%)){#design-node-1{`)
    expect(exact).toContain(`-webkit-cross-fade(${ESCAPED_IMAGE},linear-gradient(transparent,transparent),75%),linear-gradient(#00ff00,#00ff00)`)
    expect(exact).not.toMatch(/(^|[^-])cross-fade\(/)
    expect(exact).toContain('background-size:contain,auto;background-position:center;background-repeat:no-repeat')
    // Firefox has no cross-fade: the image moves to a box above the other
    // fill and below the children, while the stroke keeps ::before.
    const fallback = blockFor(result.css, '@supports not (')
    expect(fallback).toContain('@supports not (background-image:-webkit-cross-fade(url(a.png),url(b.png),0%)){#design-node-1::after{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;')
    expect(fallback).toContain(`background-image:${ESCAPED_IMAGE};background-size:contain;background-position:center;background-repeat:no-repeat;opacity:25%}`)
    expect(fallback).not.toContain('#00ff00')
    expect(fallback).not.toContain('::before')
    expect(ruleFor(result.css, '#design-node-1::before')).toContain('border:4px solid #ff0000')
    expect(result.warnings.some(warning => warning.code === 'PAINT_COMPOSITING' && warning.nodeId === frame.id)).toBe(true)
    expect(result.warnings.some(warning => warning.code === 'IMAGE_OPACITY_FALLBACK')).toBe(false)
  })

  it('moves the fills above a bottom faded image to a second box without cross-fade', () => {
    const document = blank('Image under')
    document.schemaVersion = 31
    const frame = node('frame', 0, 0, 80, 40), child = node('rectangle', 8, 8, 20, 20)
    child.fills = [paint('#0000ff')]
    frame.children = [child.id]
    const image = paint('#fff', 'image')
    image.opacity = 0.25
    image.fit = 'stretch'
    image.image = FADED_IMAGE
    const overlay = paint('#ff0000')
    overlay.opacity = 0.5
    frame.fills = [image, overlay]
    document.nodes = { [frame.id]: frame, [child.id]: child }
    document.pages[0].children = [frame.id]
    const result = exportDesignCode(document)
    // Nothing stays on the node itself: both fills sit in boxes of their own.
    expect(ruleFor(result.css, '#design-node-1')).not.toContain('background-image')
    const veil = 'background-image:linear-gradient(color-mix(in srgb, #ff0000 50%, transparent),color-mix(in srgb, #ff0000 50%, transparent))'
    expect(blockFor(result.css, '@supports (')).toContain(`${veil},-webkit-cross-fade(${ESCAPED_IMAGE},linear-gradient(transparent,transparent),75%)`)
    const fallback = blockFor(result.css, '@supports not (')
    const imageBox = fallback.indexOf('#design-node-1::before{'), veilBox = fallback.indexOf('#design-node-1::after{')
    expect(imageBox).toBeGreaterThanOrEqual(0)
    // ::after follows ::before in tree order, so the veil still covers the image.
    expect(veilBox).toBeGreaterThan(imageBox)
    expect(fallback.slice(imageBox, veilBox)).toContain(`background-image:${ESCAPED_IMAGE};background-size:100% 100%;background-position:center;background-repeat:no-repeat;opacity:25%}`)
    expect(fallback.slice(veilBox)).toContain(`${veil}}`)
    expect(result.warnings.some(warning => warning.code === 'IMAGE_OPACITY_FALLBACK')).toBe(false)
  })

  it('keeps the other fills and warns when a faded image sits between them', () => {
    const document = blank('Image between')
    document.schemaVersion = 31
    const rectangle = node('rectangle', 0, 0, 80, 40)
    const image = paint('#fff', 'image')
    image.opacity = 0.25
    image.image = FADED_IMAGE
    rectangle.fills = [paint('#00ff00'), image, paint('#0000ff')]
    document.nodes = { [rectangle.id]: rectangle }
    document.pages[0].children = [rectangle.id]
    const result = exportDesignCode(document)
    expect(ruleFor(result.css, '#design-node-1')).toContain('background-image:linear-gradient(#0000ff,#0000ff),linear-gradient(#00ff00,#00ff00)')
    const fallback = blockFor(result.css, '@supports not (')
    expect(fallback).toContain('#design-node-1::after{')
    expect(fallback).toContain('opacity:25%}')
    expect(fallback).not.toContain('::before')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'IMAGE_OPACITY_FALLBACK', nodeId: rectangle.id }))
  })

  it('places inside, center, and outside strokes on different sides of the box', () => {
    const styles = (['inside', 'center', 'outside'] as const).map(align => {
      const document = blank(align)
      document.schemaVersion = 31
      const rectangle = node('rectangle', 0, 0, 40, 40)
      rectangle.fills = []
      rectangle.strokes = [{ ...stroke('#ff0000', 4), align }]
      document.nodes = { [rectangle.id]: rectangle }
      document.pages[0].children = [rectangle.id]
      return exportDesignCode(document).css
    })
    const rules = styles.map(css => ruleFor(css, '#design-node-1'))
    expect(rules.every(rule => !rule.includes('border:'))).toBe(true)
    expect(ruleFor(styles[0], '#design-node-1::before')).toContain('border:4px solid #ff0000')
    expect(rules[0]).not.toContain('outline:')
    expect(ruleFor(styles[1], '#design-node-1::before')).toContain('border:2px solid #ff0000')
    expect(rules[1]).toContain('outline:2px solid #ff0000')
    expect(rules[2]).toContain('outline:4px solid #ff0000')
    expect(styles[2]).not.toContain('#design-node-1::before')
    expect(new Set(rules).size).toBe(3)
  })

  it('reverses flex flow from stacking order and leaves grid in source order', () => {
    const flow = (mode: 'horizontal' | 'vertical' | 'grid', layout: Record<string, unknown>) => {
      const document = blank(mode)
      document.schemaVersion = 31
      const frame = node('frame', 0, 0, 120, 80)
      frame.layout = { ...defaultLayout(), mode, padding: [0, 0, 0, 0], gap: 0, lineGap: 0, ...layout }
      const first = node('rectangle', 0, 0, 10, 10)
      const second = node('rectangle', 20, 0, 10, 10)
      frame.children = [first.id, second.id]
      document.nodes = { [frame.id]: frame, [first.id]: first, [second.id]: second }
      document.pages[0].children = [frame.id]
      return exportDesignCode(document).css
    }
    const horizontal = flow('horizontal', { reverseFlow: true })
    expect(horizontal).toContain('flex-direction:row-reverse')
    expect(horizontal).toContain('justify-content:start')
    const vertical = flow('vertical', { reverseFlow: true, justify: 'end' })
    expect(vertical).toContain('flex-direction:column-reverse')
    expect(vertical).toContain('justify-content:safe end')
    expect(flow('horizontal', { stackingOrder: 'first-on-top' })).toContain('flex-direction:row-reverse')
    const overridden = flow('horizontal', { reverseFlow: true, stackingOrder: 'last-on-top' })
    expect(overridden).toContain('flex-direction:row;')
    expect(overridden).not.toContain('row-reverse')
    const grid = flow('grid', { reverseFlow: true, stackingOrder: 'first-on-top', columns: 2 })
    expect(grid).toContain('display:grid')
    expect(grid).not.toContain('flex-direction')
    expect(grid).not.toContain('row-reverse')
    const wrapped = flow('horizontal', { reverseFlow: true, wrap: true })
    expect(ruleFor(wrapped, '#design-node-1')).toContain('align-content:start')
    expect(ruleFor(wrapped, '#design-node-1')).toContain('flex-direction:row;flex-wrap:wrap')
    expect(ruleFor(wrapped, '#design-node-2')).toContain('order:-1')
    expect(ruleFor(wrapped, '#design-node-2')).toContain('z-index:1')
    expect(ruleFor(wrapped, '#design-node-3')).toContain('order:-2')
    expect(ruleFor(wrapped, '#design-node-3')).toContain('z-index:2')
  })

  it('writes italic, letter-spacing, and line-height on the text fragment', () => {
    const document = blank('Runs')
    document.schemaVersion = 31
    const text = node('text', 0, 0, 80, 40)
    text.fontSize = 16
    text.text = 'Hello'
    text.textStyle = { ...defaultTextStyle(), letterSpacing: 1, lineHeight: 1.5 }
    text.textRuns = [{ start: 0, end: 5, italic: true, letterSpacing: 4, lineHeight: 2, fontSize: 20 }]
    document.nodes = { [text.id]: text }
    document.pages[0].children = [text.id]
    const css = exportDesignCode(document).css
    const nodeRule = ruleFor(css, '#design-node-1')
    const runRule = ruleFor(css, '.design-node-1-run-0')
    expect(nodeRule).toContain('letter-spacing:1px')
    expect(nodeRule).toContain('line-height:1.5')
    expect(runRule).toContain('font-size:20px')
    expect(runRule).toContain('font-style:italic')
    expect(runRule).toContain('letter-spacing:4px')
    expect(runRule).toContain('line-height:2')
  })

  it('writes gaussian blur like layer blur and still omits a gradient blur', () => {
    const exported = (kind: 'blur' | 'gaussian-blur', gradient: boolean) => {
      const document = blank(kind)
      document.schemaVersion = 31
      const rectangle = node('rectangle', 0, 0, 80, 40)
      const blur = effect(kind)
      blur.radius = 6
      if (gradient) blur.gradientBlur = {
        start: [0, 0], end: [80, 40], startCount: 1, endCount: 1, smooth: false,
        ...(kind === 'gaussian-blur' ? { sketch: { shape: 'linear' as const, ellipse: 0, stops: [{ offset: 0, strength: 0 }, { offset: 1, strength: 1 }] } } : {}),
      }
      rectangle.effects = [blur]
      document.nodes = { [rectangle.id]: rectangle }
      document.pages[0].children = [rectangle.id]
      return exportDesignCode(document)
    }
    const plain = exported('blur', false)
    const gaussian = exported('gaussian-blur', false)
    expect(ruleFor(plain.css, '#design-node-1')).toContain('filter:blur(6px)')
    expect(ruleFor(gaussian.css, '#design-node-1')).toContain('filter:blur(6px)')
    expect(gaussian.warnings.some(warning => warning.code === 'EFFECT_APPROXIMATION')).toBe(true)
    expect(gaussian.warnings.some(warning => warning.code === 'UNSUPPORTED_EFFECT')).toBe(false)
    const ramped = exported('gaussian-blur', true)
    expect(ramped.css).not.toContain('filter:')
    expect(ramped.warnings.some(warning => warning.code === 'UNSUPPORTED_EFFECT' && warning.message.includes('gradient blur'))).toBe(true)
  })

  it('emits a shifted radial ellipse and omits one CSS cannot align', () => {
    const exported = (transform: [number, number, number, number, number, number]) => {
      const document = blank('Radial')
      document.schemaVersion = 31
      const rectangle = node('rectangle', 0, 0, 200, 80)
      const radial = paint('#ff0000', 'radial')
      radial.transform = transform
      radial.stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }]
      rectangle.fills = [radial]
      document.nodes = { [rectangle.id]: rectangle }
      document.pages[0].children = [rectangle.id]
      return exportDesignCode(document)
    }
    const shifted = exported([1, 0, 0, 1, -0.25, 0.1])
    const rule = ruleFor(shifted.css, '#design-node-1')
    expect(rule).toContain('radial-gradient(ellipse 50% 50% at 25% 60%,#ff0000 0%,#0000ff 100%)')
    expect(rule).not.toContain('at center')
    const skewed = exported([1, 0.3, 0.2, 1, 0, 0])
    expect(ruleFor(skewed.css, '#design-node-1')).not.toContain('radial-gradient')
    expect(skewed.warnings.some(warning => warning.code === 'RADIAL_TRANSFORM')).toBe(true)
  })
})
describe('native document roundtrip', () => {
  it('returns lossless deterministic source and appends with remapped graph IDs, tokens and behavior', () => {
    const { document: source, frame, text } = fixture(); source.schemaVersion = 4
    source.designSystem = emptySystem(); source.designSystem.collections.c = { name: 'Spacing', modes: ['base'], defaultMode: 'base' }
    source.designSystem.variables.size = { name: 'Size', kind: 'number', collection: 'c', values: { base: 20 } }; text.bindings = { fontSize: 'size' }
    source.prototype = { startNode: frame.id, interactions: { [frame.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: text.id }] }] } }
    const exported = exportNativeDocument(source)
    expect(validateDocument(JSON.parse(exported.content))).toEqual(source)
    expect(exportNativeDocument(source)).toEqual(exported)
    const destination = blank('Destination'), originalId = destination.id, context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    const result = importNativeDocument(destination, { format: 'native-json', content: exported.content }, context)
    expect(destination.id).toBe(originalId); expect(result.rootIds).toHaveLength(1)
    expect(result.nodeIdMap[frame.id]).not.toBe(frame.id)
    expect(destination.nodes[result.nodeIdMap[frame.id]].children).toEqual([result.nodeIdMap[text.id]])
    expect(destination.nodes[result.nodeIdMap[text.id]].text).toBe(text.text)
    expect(destination.prototype?.interactions[result.nodeIdMap[frame.id]][0].actions[0].target).toBe(result.nodeIdMap[text.id])
    expect(Object.keys(destination.designSystem!.variables)).toHaveLength(1)
    expect(context.createdIds).toHaveLength(3)
  })
  it('roundtrips actual .fd binfmt with a valid embedded font, components, and checksum rejection', () => {
    // Tiny valid TTF built from one original triangle glyph, no external font or OS dependency.
    const font = 'AAEAAAAKAIAAAwAgT1MvMkUARDUAAAEoAAAAYGNtYXAAdQBbAAABkAAAADxnbHlmGK0tqwAAAdQAAAAYaGVhZC9jsVYAAACsAAAANmhoZWEFFgH2AAAA5AAAACRobXR4AlgAAAAAAYgAAAAIbG9jYQAMAAwAAAHMAAAACG1heHAABQAFAAABCAAAACBuYW1lUXVW+QAAAewAAAFxcG9zdAApAAMAAANgAAAAKAABAAAAAQAA2FGhaF8PPPUAAQPoAAAAAOb7tt0AAAAA5vu23QAyAAACJgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYAAAAZAH0AAEAAAAAAAAAAAAAAAAAAAABAAEAAAADAAMAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAQQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAKAAAAAYABAABAAIAIABB//8AAAAgAEH////i/8AAAQAAAAAAAAAAAAAADAAMAAEAMgAAAiYCvAACAAAzExMy+voCvP1EAAAACgB+AAEAAAAAAAEAFAAAAAEAAAAAAAIABwAUAAEAAAAAAAMAGgAbAAEAAAAAAAQAHAA1AAEAAAAAAAYAGgAbAAMAAQQJAAEAKABRAAMAAQQJAAIADgB5AAMAAQQJAAMANACHAAMAAQQJAAQAOAC7AAMAAQQJAAYANACHQXV0b21hdGlvbiBUZXN0IEZvbnRSZWd1bGFyQXV0b21hdGlvblRlc3RGb250LVJlZ3VsYXJBdXRvbWF0aW9uIFRlc3QgRm9udCBSZWd1bGFyAEEAdQB0AG8AbQBhAHQAaQBvAG4AIABUAGUAcwB0ACAARgBvAG4AdABSAGUAZwB1AGwAYQByAEEAdQB0AG8AbQBhAHQAaQBvAG4AVABlAHMAdABGAG8AbgB0AC0AUgBlAGcAdQBsAGEAcgBBAHUAdABvAG0AYQB0AGkAbwBuACAAVABlAHMAdAAgAEYAbwBuAHQAIABSAGUAZwB1AGwAYQByAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAACQAAw=='
    const { doc: source, ids } = componentFixture(); source.schemaVersion = 4
    source.fonts = { test: { family: 'Automation Test Font', data: font } }
    source.nodes[ids.label].text = 'A A'
    source.nodes[ids.button].component!.properties[ids.title].defaultValue = 'A A'
    source.nodes[ids.label].textStyle = { ...defaultTextStyle(), fontId: 'test' }
    const exported = exportBinaryDocument(source)
    expect(exported.filename).toBe('design.fd'); expect(exported.mimeType).toBe('application/vnd.futureox-desgin')
    const bytes = Uint8Array.from(atob(exported.base64), c => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('FXDK')
    expect(decodeDocumentBinary(bytes)).toEqual(source)
    const destination = blank(), context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    const result = importNativeDocument(destination, { format: 'fd', base64: exported.base64 }, context)
    expect(Object.values(destination.fonts ?? {}).some(f => f.data === font)).toBe(true)
    expect(destination.nodes[result.nodeIdMap[ids.a]].instance?.componentId).toBe(result.nodeIdMap[ids.button])
    expect(destination.nodes[result.nodeIdMap[ids.label]].text).toBe('A A')
    const before = JSON.stringify(destination)
    bytes[bytes.length - 1] ^= 1
    const corrupt = btoa(String.fromCharCode(...bytes))
    expect(() => importNativeDocument(destination, { format: 'fd', base64: corrupt }, context)).toThrow('checksum')
    expect(JSON.stringify(destination)).toBe(before)
  })
  it('carries the bundled 17.77 MB CJK font through real .fd import/export under the 32 MiB envelope', async () => {
    const font = await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))
    const { document: source, text } = fixture()
    source.fonts = { cjk: { family: 'Noto Sans SC', data: font.toString('base64') } }
    text.textStyle = { ...defaultTextStyle(), fontId: 'cjk' }; text.text = '真实字体'
    const exported = exportBinaryDocument(source)
    expect(exported.base64.length).toBeGreaterThan(8 * 1024 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(exported)).byteLength).toBeLessThan(32 * 1024 * 1024)
    const destination = blank(), context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    const result = importNativeDocument(destination, { format: 'fd', base64: exported.base64 }, context)
    expect(destination.nodes[result.nodeIdMap[text.id]].text).toBe('真实字体')
    expect(Object.values(destination.fonts ?? {})[0].data).toBe(font.toString('base64'))
  }, 30000)
  it('rejects malformed/native-format mismatches atomically', () => {
    const destination = blank(), before = JSON.stringify(destination), context = { pageId: destination.pages[0].id, selection: [], createdIds: [] as string[] }
    for (const params of [{ format: 'html', content: '<html/>' }, { format: 'native-json', content: '{bad' }, { format: 'native-json', document: {} }, { format: 'native-json', content: '{}', document: {} }]) {
      expect(() => importNativeDocument(destination, params, context)).toThrow()
      expect(JSON.stringify(destination)).toBe(before); expect(context.createdIds).toEqual([])
    }
  })
  it('runs import/export through the actual automation boundary and one-step undo', () => {
    const { document: source } = fixture(), editor = new Editor(blank()), api = createDesignAutomation(editor, exportExtensions)
    try {
      const read = api.execute({ method: 'document.export' }); expect(read.ok).toBe(true)
      const before = editor.state.doc
      const imported = api.execute({ method: 'document.import', documentId: read.documentId, session: read.session, expectedRevision: read.revision, params: { format: 'native-json', content: exportNativeDocument(source).content } })
      expect(imported.ok).toBe(true); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(3)
      const exported = api.execute({ method: 'document.export' }); expect(exported.ok).toBe(true)
      if (exported.ok) expect(Object.keys(JSON.parse((exported.result as { content: string }).content).nodes)).toHaveLength(3)
      editor.undo(); expect(editor.state.doc).toEqual(before)
    } finally { api.dispose(); editor.dispose() }
  })
})
describe('existing vector and raster adapters', () => {
  it('exports actual native SVG text outlines for a whole page', () => {
    const { document } = fixture(), result = exportDesignSvg(document)
    expect(result.content).toContain('<svg'); expect(result.content).toContain('<path')
    expect(result.content).not.toContain('<text'); expect(result.bounds.width).toBeGreaterThan(0)
    expect(result.sourceNodeIds).toEqual(document.pages[0].children)
  })
  it('rejects unsupported SVG materials and unsafe URLs rather than claiming fidelity', () => {
    const { document, frame } = fixture(); frame.effects = [effect('glass')]
    expect(() => exportDesignSvg(document)).toThrow('cannot faithfully')
    frame.effects = []; const image = paint('#fff', 'image'); image.image = 'javascript:alert(1)'; frame.fills = [image]
    expect(() => exportDesignSvg(document)).toThrow('unsafe image')
  })
  it('rejects unavailable or over-budget raster requests before rendering and respects cancellation', async () => {
    const { document, frame } = fixture()
    await expect(captureDesignPreview(document, { scale: 0 })).rejects.toThrow('scale')
    const controller = new AbortController(); controller.abort()
    await expect(captureDesignPreview(document, { signal: controller.signal })).rejects.toThrow()
    frame.width = 10000; frame.height = 10000
    await expect(captureDesignPreview(document)).rejects.toThrow('megapixels')
  })
})

it('MCP vector export validates type-specific options and returns real gzip/precision output', async () => {
  const { gunzipSync } = await import('fflate')
  const { document } = fixture(), editor = new Editor(document), api = createDesignAutomation(editor, exportExtensions)
  const result = api.execute({ method: 'vector.export', params: { pageId: document.pages[0].id, scale: 2, precision: 3, compression: 'gzip' } })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const out = result.result as { filename: string; base64: string; options: object; precisionLossy: boolean; warnings: { code: string }[] }
  expect(out.filename).toBe('design.svgz'); expect(out.precisionLossy).toBe(true)
  expect(out.options).toEqual({ scale: 2, precision: 3, compression: 'gzip', textMode: 'outlines', fontMode: 'references' })
  expect(out.warnings.some(w => w.code === 'SVG_PRECISION_LOSS')).toBe(true)
  expect(new TextDecoder().decode(gunzipSync(Uint8Array.from(atob(out.base64), c => c.charCodeAt(0))))).toContain('<svg')
  for (const [method, params] of [['vector.export', { precision: 9 }], ['vector.export', { quality: 90 }], ['vector.export', { compression: 'zip' }], ['document.export', { format: 'fd', precision: 2 }], ['document.export', { format: 'fd', compression: 'gzip' }]] as const) expect(api.execute({ method, params }).ok).toBe(false)
  editor.dispose()
})

it('FD component instance nodeIdMap points to committed materialized descendants', () => {
  const source = componentFixture().doc, editor = new Editor(blank()), api = createDesignAutomation(editor, exportExtensions)
  try {
    const read = api.execute({ method: 'document.export' })
    const response = api.execute({ method: 'document.import', documentId: read.documentId, session: read.session, expectedRevision: read.revision, params: { format: 'fd', base64: exportBinaryDocument(source).base64 } })
    expect(response.ok, JSON.stringify(response)).toBe(true); if (!response.ok) return
    const result = response.result as { operations: { result: { nodeIdMap: Record<string, string>; createdIds: string[] } }[] }
    const imported = result.operations[0].result
    expect(Object.keys(imported.nodeIdMap).length).toBeGreaterThan(10)
    for (const id of Object.values(imported.nodeIdMap)) expect(editor.state.doc.nodes[id], id).toBeDefined()
    for (const id of imported.createdIds) expect(editor.state.doc.nodes[id], id).toBeDefined()
    editor.undo(); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0)
  } finally { api.dispose(); editor.dispose() }
})
