import { describe, expect, it } from 'vitest'
import { stampKeys, insertInstance } from '../components'
import { emptySystem } from '../design-system'
import { Editor } from '../engine'
import { blank, defaultLayout, defaultTextStyle, effect, node, paint, stroke, type DesignDocument } from '../model'
import { createDesignAutomation } from './core'
import { exportDesignCode, exportExtensions, type CodeExportOptions } from './export'

function resolveExpr(text: string, vars: Map<string, string>): string {
  const lookup = (name: string) => {
    const resolved = vars.get(name)
    if (resolved === undefined) throw new Error(`Undefined Sass variable $${name}`)
    return resolved
  }
  const interpolated = text
    .replaceAll(/#\{\(1 - \$([A-Za-z_][A-Za-z0-9_-]*)\) \* 100%\}/g, (_match, name: string) => {
      const value = Number(lookup(name))
      if (!Number.isFinite(value)) throw new Error(`Sass number expected for $${name}`)
      return String(Math.round((1 - value) * 100 * 1e6) / 1e6) + '%'
    })
    .replaceAll(/#\{\$([A-Za-z_][A-Za-z0-9_-]*) \* 100%\}/g, (_match, name: string) => {
      const value = Number(lookup(name))
      if (!Number.isFinite(value)) throw new Error(`Sass number expected for $${name}`)
      return String(Math.round(value * 100 * 1e6) / 1e6) + '%'
    })
    .replaceAll(/#\{\$([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, name: string) => lookup(name))
  return interpolated.replaceAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g, (_match, name: string) => lookup(name))
    .replaceAll(/calc\((-?[0-9.]+)px \/ 2\)/g, (_match, width: string) => String(Number(width) / 2) + 'px')
}

function splitDepth0(body: string): string[] {
  const parts: string[] = []
  let start = 0, depth = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === '{') depth++
    else if (char === '}') depth--
    else if (char === ';' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  if (start < body.length) parts.push(body.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

/** Expand the Sass subset this exporter emits: variables, mixins, and @at-root. */
function compileScssSubset(scss: string): string {
  const vars = new Map<string, string>()
  const mixins = new Map<string, string>()
  const expandRule = (rule: string): string[] => {
    const open = rule.indexOf('{')
    if (open < 0 || !rule.endsWith('}')) throw new Error(`Bad rule: ${rule.slice(0, 80)}`)
    const selector = rule.slice(0, open)
    const own: string[] = []
    const lifted: string[] = []
    for (const part of splitDepth0(rule.slice(open + 1, -1))) {
      if (part.startsWith('@at-root ')) lifted.push(...expandRule(part.slice('@at-root '.length)))
      else if (part.startsWith('@include ')) {
        const name = part.slice('@include '.length).trim()
        const body = mixins.get(name)
        if (body === undefined) throw new Error(`Missing mixin ${name}`)
        for (const decl of splitDepth0(body)) own.push(resolveExpr(decl, vars))
      } else own.push(resolveExpr(part, vars))
    }
    return [`${selector}{${own.join(';')}}`, ...lifted]
  }
  const rules: string[] = []
  for (const line of scss.split('\n')) {
    if (!line) continue
    const declaration = line.match(/^\$([A-Za-z_][A-Za-z0-9_-]*): (.+);$/)
    const mixin = line.match(/^@mixin ([A-Za-z_][A-Za-z0-9_-]*)\{(.*)\}$/)
    if (declaration) vars.set(declaration[1], resolveExpr(declaration[2], vars))
    else if (mixin) mixins.set(mixin[1], mixin[2])
    else rules.push(...expandRule(line))
  }
  return `${rules.join('\n')}\n`
}

function themed(modes = ['light'], active = 'light') {
  const document = blank('SCSS')
  document.schemaVersion = 6
  const system = document.designSystem = emptySystem()
  system.collections.theme = { name: 'Theme', modes, defaultMode: modes[0] }
  system.activeModes.theme = active
  return { document, system }
}

function add(document: DesignDocument, item: ReturnType<typeof node>) {
  document.nodes[item.id] = item
  document.pages[0].children.push(item.id)
  return item
}

function expectCompiles(result: ReturnType<typeof exportDesignCode>) {
  expect(result.scss).toBeTruthy()
  expect(compileScssSubset(result.scss!)).toBe(result.css)
  expect(result.language).toBe('html-css')
  expect(result.html).toContain('styles.css')
  expect(result.html).not.toContain('.scss')
}

describe('selection SCSS color variables', () => {
  it('keeps the flat CSS export and adds a Sass variable for a bound fill color', () => {
    const { document, system } = themed()
    system.variables.brand = { name: 'Brand', kind: 'color', collection: 'theme', values: { light: '#123456' } }
    system.variables.muted = { name: 'Muted', kind: 'color', collection: 'theme', values: { light: '#abcdef' } }
    const box = add(document, node('rectangle', 0, 0, 40, 20))
    box.fills = [paint('#ffffff')]
    box.bindings = { 'fills.0.color': 'brand' }
    const before = JSON.stringify(document)
    const plain = exportDesignCode(document)
    const result = exportDesignCode(document, { syntax: 'scss' })
    expect(JSON.stringify(document)).toBe(before)
    expect(plain).not.toHaveProperty('scss')
    expect(plain.warnings.some(warning => warning.code.startsWith('SCSS_'))).toBe(false)
    expect(exportDesignCode(document, { syntax: 'css' })).toEqual(plain)
    expect(result.css).toBe(plain.css)
    expect(result.html).toBe(plain.html)
    expect(result.css).toContain('width:40px;height:20px;opacity:1')
    expect(result.scss).toContain('$Brand: #123456;')
    expect(result.scss).toContain('linear-gradient($Brand,$Brand)')
    expect(result.scss).not.toContain('$Muted')
    expect(result.scss).not.toContain('@mixin')
    expect(result.warnings.some(warning => warning.code.startsWith('SCSS_'))).toBe(false)
    expectCompiles(result)
  })

  it('follows aliases, effective modes, hidden fill indexes and leaves an unbound identical stroke literal', () => {
    const { document, system } = themed(['day', 'night'], 'day')
    system.variables.brand = { name: 'Colors/Brand', kind: 'color', collection: 'theme', values: { day: '#111111', night: '#222222' } }
    system.variables.accent = { name: 'Accent', kind: 'color', collection: 'theme', values: { day: { alias: 'brand' }, night: { alias: 'brand' } } }
    const frame = add(document, node('frame', 0, 0, 200, 80))
    frame.variableModes = { theme: 'night' }
    const child = node('rectangle', 8, 8, 30, 16)
    child.fills = [paint('#ffffff'), paint('#ffffff')]
    child.fills[0].visible = false
    child.strokes = [stroke('#222222', 4)]
    child.bindings = { 'fills.1.color': 'accent' }
    document.nodes[child.id] = child
    frame.children = [child.id]
    const selected = exportDesignCode(document, { syntax: 'scss', nodeIds: [child.id] })
    expect(selected.css).toContain('#222222')
    expect(selected.css).not.toContain('#111111')
    expect(selected.scss).toContain('$Colors-Brand: #222222;')
    expect(selected.scss).toContain('$Accent: $Colors-Brand;')
    expect(selected.scss!.indexOf('$Colors-Brand:')).toBeLessThan(selected.scss!.indexOf('$Accent:'))
    const selector = selected.nodeIdMap[child.id].selector
    const rules = selected.scss!.split('\n')
    const rule = rules.find(line => line.startsWith(`${selector}{`))
    const strokeRule = rules.find(line => line.startsWith(`${selector}::before{`))
    expect(rule).toContain('linear-gradient($Accent,$Accent)')
    expect(strokeRule).toContain('border:2px solid #222222')
    expect(rule).toContain('outline:2px solid #222222')
    expect(rule).not.toContain('solid $Accent')
    expect(strokeRule).not.toContain('solid $Accent')
    expect(selected.scss).toContain('$Colors-Brand-day: #111111;')
    expect(selected.scss).toContain('$Accent-day: $Colors-Brand-day;')
    expect(selected.warnings.some(warning => warning.code === 'SCSS_INACTIVE_MODES_OMITTED')).toBe(false)
    expect(selected.warnings.some(warning => warning.code === 'SCSS_NESTING_OMITTED')).toBe(false)
    expectCompiles(selected)

    const day = add(document, node('rectangle', 0, 120, 20, 20))
    const night = add(document, node('rectangle', 40, 120, 20, 20))
    for (const item of [day, night]) { item.fills = [paint('#ffffff')]; item.bindings = { 'fills.0.color': 'brand' } }
    night.variableModes = { theme: 'night' }
    const both = exportDesignCode(document, { syntax: 'scss', nodeIds: [day.id, night.id] })
    expect(both.scss).toContain('$Colors-Brand-day: #111111;')
    expect(both.scss).toContain('$Colors-Brand-night: #222222;')
    expect(both.warnings.some(warning => warning.code === 'SCSS_INACTIVE_MODES_OMITTED')).toBe(false)
    expectCompiles(both)
  })

  it('sanitizes hostile and colliding names and resolves a component instance with the same variable', () => {
    const { document, system } = themed()
    system.variables.one = { name: 'Brand;}body{background:url(javascript:alert(1))', kind: 'color', collection: 'theme', values: { light: '#123456' } }
    system.variables.two = { name: 'Brand', kind: 'color', collection: 'theme', values: { light: '#654321' } }
    system.variables.also = { name: 'Brand', kind: 'color', collection: 'theme', values: { light: '#010101' } }
    system.variables.mark = { name: '品牌', kind: 'color', collection: 'theme', values: { light: '#abcdef' } }
    const first = add(document, node('rectangle', 0, 0, 10, 10))
    const second = add(document, node('rectangle', 20, 0, 10, 10))
    const third = add(document, node('rectangle', 40, 0, 10, 10))
    const fourth = add(document, node('rectangle', 60, 0, 10, 10))
    first.fills = [paint('#ffffff')]; first.bindings = { 'fills.0.color': 'one' }
    second.fills = [paint('#ffffff')]; second.bindings = { 'fills.0.color': 'two' }
    third.fills = [paint('#ffffff')]; third.bindings = { 'fills.0.color': 'mark' }
    fourth.fills = [paint('#ffffff')]; fourth.bindings = { 'fills.0.color': 'also' }
    const named = exportDesignCode(document, { syntax: 'scss', nodeIds: [first.id, second.id, third.id, fourth.id] })
    const lines = named.scss!.split('\n')
    expect(named.scss).not.toContain('javascript')
    expect(named.scss).not.toContain('品牌')
    expect(lines.some(line => line.startsWith('$') && /[;{}()]/.test(line.slice(1).split(':')[0]))).toBe(false)
    expect(lines.filter(line => /^\$Brand: #(?:654321|010101);$/.test(line))).toHaveLength(1)
    expect(lines.some(line => /^\$Brand-[a-z0-9]+: #(?:654321|010101);$/.test(line))).toBe(true)
    expect(lines.some(line => /^\$color-[a-z0-9]+: #123456;$/.test(line))).toBe(true)
    expect(lines.some(line => /^\$color-[a-z0-9]+: #abcdef;$/.test(line))).toBe(true)
    expectCompiles(named)

    const master = node('frame', 0, 80, 80, 40)
    const label = node('text', 4, 4, 60, 20)
    label.text = 'Label'
    label.fills = [paint('#ffffff')]
    label.bindings = { 'fills.0.color': 'two' }
    master.children = [label.id]
    master.component = { variants: {}, properties: {} }
    document.nodes[master.id] = master
    document.nodes[label.id] = label
    document.pages[0].children.push(master.id)
    stampKeys(document, master.id)
    const instanceId = insertInstance(document, master.id, document.pages[0].id, { x: 200, y: 80 })
    const instance = exportDesignCode(document, { syntax: 'scss', nodeIds: [instanceId] })
    expect(instance.css).toContain('#654321')
    expect(instance.scss).toContain('$Brand: #654321;')
    expect(instance.scss).not.toContain('$Muted')
    expectCompiles(instance)
  })

  it('emits numbers, booleans, shared styles, nesting and unused modes that compile to the same css', () => {
    const { document, system } = themed(['light', 'dark'])
    system.variables.brand = { name: 'Brand', kind: 'color', collection: 'theme', values: { light: '#123456', dark: '#654321' } }
    system.variables.size = { name: 'Size', kind: 'number', collection: 'theme', values: { light: 22, dark: 30 } }
    system.variables.show = { name: 'Show', kind: 'boolean', collection: 'theme', values: { light: false, dark: true } }
    system.variables.label = { name: 'Label', kind: 'string', collection: 'theme', values: { light: '$Injected: red;', dark: 'Dark' } }
    system.variables.paragraph = { name: 'Paragraph', kind: 'number', collection: 'theme', values: { light: 8, dark: 12 } }
    system.styles.heading = { name: 'Heading', kind: 'text', value: { ...defaultTextStyle(), weight: 700 } }
    system.styles.card = { name: 'Card', kind: 'paint', value: [paint('#abcdef')] }
    system.styles.shadow = { name: 'Card Shadow', kind: 'effect', value: [effect('shadow')] }
    const frame = add(document, node('frame', 0, 0, 120, 80))
    const text = node('text', 8, 8, 80, 24)
    text.text = 'Before'
    text.fills = [paint('#ffffff')]
    text.bindings = { 'fills.0.color': 'brand', fontSize: 'size', text: 'label', 'textStyle.paragraphSpacing': 'paragraph' }
    text.styleRefs = { textStyle: 'heading' }
    const box = node('rectangle', 8, 40, 40, 20)
    box.fills = [paint('#000000')]
    box.effects = []
    box.bindings = { visible: 'show' }
    box.styleRefs = { fills: 'card', effects: 'shadow' }
    document.nodes[text.id] = text
    document.nodes[box.id] = box
    frame.children = [text.id, box.id]
    const plain = exportDesignCode(document)
    const result = exportDesignCode(document, { syntax: 'scss' })
    expect(result.css).toBe(plain.css)
    expect(result.html).toBe(plain.html)
    expect(result.css).toContain('font-size:22px')
    expect(result.css).toContain('font-weight:700')
    expect(result.css).toContain('#abcdef')
    expect(result.css).toContain('box-shadow:')
    expect(result.css).toContain('display:none')
    expect(result.css).not.toContain('#654321')
    expect(result.html).toContain('$Injected: red;')
    expect(result.scss).toContain('$Brand: #123456;')
    expect(result.scss).toContain('$Brand-dark: #654321;')
    expect(result.scss).toContain('$Size: 22;')
    expect(result.scss).toContain('$Size-dark: 30;')
    expect(result.scss).toContain('font-size:#{$Size}px')
    expect(result.scss).not.toContain('$Size: 22px')
    expect(result.scss).toContain('$Show: false;')
    expect(result.scss).toContain('$Show-dark: true;')
    expect(result.scss).toContain('$Card: #abcdef;')
    expect(result.scss).toContain('linear-gradient($Card,$Card)')
    expect(result.scss).toContain('@mixin Heading{')
    expect(result.scss).toContain('font-weight:700')
    expect(result.scss).toContain('@include Heading')
    expect(result.scss).toContain('@mixin Card-Shadow{')
    expect(result.scss).toContain('@include Card-Shadow')
    expect(result.scss).toContain(`@at-root ${result.nodeIdMap[text.id].selector}{`)
    expect(result.scss).toContain(`@at-root ${result.nodeIdMap[box.id].selector}{`)
    expect(result.scss).not.toContain('$Injected')
    expect(result.scss).not.toContain('$Paragraph')
    expect(result.scss).not.toContain('$Label')
    expect(result.scss).not.toContain('@if')
    expect(result.scss).not.toContain(`${result.nodeIdMap[frame.id].selector} ${result.nodeIdMap[text.id].selector}`)
    for (const code of ['SCSS_NUMBER_BINDINGS_OMITTED', 'SCSS_BOOLEAN_BINDINGS_OMITTED', 'SCSS_TEXT_STYLE_OMITTED', 'SCSS_EFFECT_STYLE_OMITTED', 'SCSS_PAINT_STYLE_OMITTED', 'SCSS_NESTING_OMITTED', 'SCSS_INACTIVE_MODES_OMITTED'])
      expect(result.warnings.some(warning => warning.code === code)).toBe(false)
    expect(result.warnings.some(warning => warning.code.includes('STRING'))).toBe(false)
    expectCompiles(result)
    expect(() => exportDesignCode(document, { syntax: 'less' } as unknown as CodeExportOptions)).toThrow(/syntax/)
  })

  it('keeps one unitless number across px and unitless uses, and does not collapse a gradient style', () => {
    const { document, system } = themed(['light', 'dark'])
    system.variables.one = { name: 'One', kind: 'number', collection: 'theme', values: { light: 1, dark: 2 } }
    system.variables.fade = { name: 'Fade', kind: 'number', collection: 'theme', values: { light: 0.5, dark: 0.25 } }
    system.variables.border = { name: 'Border', kind: 'number', collection: 'theme', values: { light: 3, dark: 6 } }
    system.variables.radius = { name: 'Radius', kind: 'number', collection: 'theme', values: { light: 6, dark: 1 } }
    system.variables.gap = { name: 'Gap', kind: 'number', collection: 'theme', values: { light: 12, dark: 20 } }
    system.variables.pad = { name: 'Pad', kind: 'number', collection: 'theme', values: { light: 8, dark: 10 } }
    system.variables.weight = { name: 'Weight', kind: 'number', collection: 'theme', values: { light: 500, dark: 700 } }
    system.variables.leading = { name: 'Leading', kind: 'number', collection: 'theme', values: { light: 1.2, dark: 1.5 } }
    system.variables.track = { name: 'Track', kind: 'number', collection: 'theme', values: { light: 1, dark: 2 } }
    system.styles.heading = { name: 'Heading;}@mixin x{color:red', kind: 'text', value: { ...defaultTextStyle(), weight: 400 } }
    const gradient = paint('#ff0000', 'linear')
    gradient.stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ff00' }]
    system.styles.wash = { name: 'Wash', kind: 'paint', value: [gradient] }
    const frame = add(document, node('frame', 0, 0, 200, 120))
    frame.layout = { ...defaultLayout(), gap: 12, lineGap: 4, padding: [8, 8, 8, 8] }
    frame.bindings = { 'layout.gap': 'gap', 'layout.padding.0': 'pad' }
    const text = node('text', 8, 8, 80, 24)
    text.text = 'Size'
    text.opacity = 1
    text.fontSize = 1
    text.fills = [paint('#111111')]
    text.fills[0].opacity = 0.5
    text.strokes = [stroke('#112233', 3)]
    text.radii = [6, 0, 0, 0]
    text.bindings = {
      opacity: 'one', fontSize: 'one', 'fills.0.opacity': 'fade', 'strokes.0.width': 'border', 'radii.0': 'radius',
      'textStyle.weight': 'weight', 'textStyle.lineHeight': 'leading', 'textStyle.letterSpacing': 'track',
    }
    text.styleRefs = { textStyle: 'heading' }
    const swatch = node('rectangle', 8, 40, 40, 20)
    swatch.fills = [paint('#000000')]
    swatch.styleRefs = { fills: 'wash' }
    document.nodes[text.id] = text
    document.nodes[swatch.id] = swatch
    frame.children = [text.id, swatch.id]
    const plain = exportDesignCode(document)
    const result = exportDesignCode(document, { syntax: 'scss' })
    expect(result.css).toBe(plain.css)
    expect(result.scss).toContain('$One: 1;')
    expect(result.scss).not.toContain('$One: 1px')
    expect(result.scss).toContain('opacity:$One')
    expect(result.scss).toContain('font-size:#{$One}px')
    expect(result.scss).toContain('$Fade: 0.5;')
    expect(result.scss).toContain('#{$Fade * 100%}')
    expect(result.css).toContain('border:1.5px solid #112233}')
    expect(result.css).toContain('outline:1.5px solid #112233')
    expect(result.scss).toContain('border:calc(#{$Border}px / 2) solid #112233}')
    expect(result.scss).toContain('outline:calc(#{$Border}px / 2) solid #112233')
    expect(result.scss).toContain('border-radius:#{$Radius}px')
    expect(result.scss).toContain('padding:#{$Pad}px')
    expect(result.scss).toContain('#{$Gap}px')
    expect(result.scss).toContain('font-weight:$Weight')
    expect(result.scss).toContain('line-height:$Leading')
    expect(result.scss).toContain('letter-spacing:#{$Track}px')
    expect(result.scss).toContain('@include')
    expect(result.scss).not.toContain('@mixin x')
    expect(result.scss).not.toContain('color:red')
    expect(result.scss).not.toContain('$Wash:')
    expect(result.css).toContain('linear-gradient')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'SCSS_PAINT_STYLE_OMITTED' }))
    expect(result.scss).not.toContain('@if')
    expectCompiles(result)
  })

  it('accepts syntax scss through the operation schema and rejects other syntaxes', () => {
    const { document, system } = themed()
    system.variables.brand = { name: 'Brand', kind: 'color', collection: 'theme', values: { light: '#123456' } }
    const box = add(document, node('rectangle'))
    box.fills = [paint('#ffffff')]
    box.bindings = { 'fills.0.color': 'brand' }
    box.fills[0].opacity = 0.5
    const editor = new Editor(document), api = createDesignAutomation(editor, exportExtensions)
    try {
      const ok = api.execute({ method: 'code.export', params: { syntax: 'scss', nodeIds: [box.id] } })
      expect(ok.ok).toBe(true)
      if (!ok.ok) return
      const result = ok.result as { scss: string; css: string }
      expect(result.scss).toContain('color-mix(in srgb, $Brand 50%, transparent)')
      expect(compileScssSubset(result.scss)).toBe(result.css)
      expect(api.execute({ method: 'code.export', params: { syntax: 'less' } }).ok).toBe(false)
    } finally { api.dispose(); editor.dispose() }
  })

  it('uses a unitless image opacity token for both the cross-fade weight and the fallback box, and exports its idle mode', () => {
    const { document, system } = themed(['light', 'dark'], 'light')
    system.variables.fade = { kind: 'number', name: 'Image Opacity', collection: 'theme', values: { light: 0.25, dark: 0.6 } }
    const box = add(document, node('rectangle'))
    const fill = paint('#ffffff', 'image')
    fill.image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4GBgQEADQUCAOAHawIAAAAASUVORK5CYII='
    box.fills = [fill]
    box.bindings = { 'fills.0.opacity': 'fade' }
    const output = exportDesignCode(document, { syntax: 'scss' })
    expect(output.css).toContain(',linear-gradient(transparent,transparent),75%)')
    expect(output.css).toContain(';opacity:25%}')
    expect(output.css).not.toContain(' 25%,transparent)')
    expect(output.scss).toContain('$Image-Opacity: 0.25;')
    expect(output.scss).toContain('$Image-Opacity-dark: 0.6;')
    expect(output.scss).toContain('#{$Image-Opacity * 100%}')
    expect(output.scss).toContain('#{(1 - $Image-Opacity) * 100%}')
    // The feature-tested rules are plain rules to the Sass pass: nothing nests into them.
    expect(output.scss).toContain('@supports (background-image:-webkit-cross-fade(url(a.png),url(b.png),0%)){#design-node-1{')
    expect(output.scss).toContain('@supports not (background-image:-webkit-cross-fade(url(a.png),url(b.png),0%)){#design-node-1::after{')
    expectCompiles(output)
    // A faded image below another fill splits over two boxes in the fallback.
    const veil = paint('#ff0000')
    veil.opacity = 0.5
    box.fills = [fill, veil]
    const split = exportDesignCode(document, { syntax: 'scss' })
    expect(split.css).toContain('::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;')
    expect(split.css).toContain(';opacity:25%}#design-node-1::after{')
    expectCompiles(split)
  })
})
