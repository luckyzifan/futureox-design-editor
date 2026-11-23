import { describe, expect, it } from 'vitest'
import { stampKeys, insertInstance } from '../components'
import { emptySystem } from '../design-system'
import { Editor } from '../engine'
import { blank, defaultTextStyle, effect, node, paint, stroke, type DesignDocument } from '../model'
import { createDesignAutomation } from './core'
import { exportDesignCode, exportExtensions, type CodeExportOptions } from './export'

function compileScssSubset(scss: string): string {
  const vars = new Map<string, string>()
  const body: string[] = []
  for (const line of scss.split('\n')) {
    const declaration = line.match(/^\$([A-Za-z_][A-Za-z0-9_-]*): (.+);$/)
    if (declaration && body.length === 0) {
      const value = declaration[2].replaceAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g, (_match, name: string) => {
        const resolved = vars.get(name)
        if (resolved === undefined) throw new Error(`Undefined Sass variable $${name}`)
        return resolved
      })
      vars.set(declaration[1], value)
    } else body.push(line)
  }
  return body.join('\n').replaceAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g, (_match, name: string) => {
    const resolved = vars.get(name)
    if (resolved === undefined) throw new Error(`Undefined Sass variable $${name}`)
    return resolved
  })
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
    const rule = selected.scss!.split('\n').find(line => line.startsWith(selected.nodeIdMap[child.id].selector))
    expect(rule).toContain('linear-gradient($Accent,$Accent)')
    expect(rule).toContain('border:4px solid #222222')
    expect(rule).not.toContain('solid $Accent')
    expect(selected.warnings).toContainEqual(expect.objectContaining({ code: 'SCSS_INACTIVE_MODES_OMITTED' }))
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

  it('reports the SCSS mappings it does not emit', () => {
    const { document, system } = themed(['light', 'dark'])
    system.variables.brand = { name: 'Brand', kind: 'color', collection: 'theme', values: { light: '#123456', dark: '#654321' } }
    system.variables.size = { name: 'Size', kind: 'number', collection: 'theme', values: { light: 22, dark: 30 } }
    system.variables.show = { name: 'Show', kind: 'boolean', collection: 'theme', values: { light: false, dark: true } }
    system.variables.label = { name: 'Label', kind: 'string', collection: 'theme', values: { light: '$Injected: red;', dark: 'Dark' } }
    system.styles.heading = { name: 'Heading', kind: 'text', value: { ...defaultTextStyle(), weight: 700 } }
    system.styles.card = { name: 'Card', kind: 'paint', value: [paint('#abcdef')] }
    system.styles.shadow = { name: 'Card Shadow', kind: 'effect', value: [effect('shadow')] }
    const frame = add(document, node('frame', 0, 0, 120, 80))
    const text = node('text', 8, 8, 80, 24)
    text.text = 'Before'
    text.fills = [paint('#ffffff')]
    text.bindings = { 'fills.0.color': 'brand', fontSize: 'size', text: 'label' }
    text.styleRefs = { textStyle: 'heading' }
    const box = node('rectangle', 8, 40, 40, 20)
    box.fills = [paint('#000000')]
    box.effects = []
    box.bindings = { visible: 'show' }
    box.styleRefs = { fills: 'card', effects: 'shadow' }
    document.nodes[text.id] = text
    document.nodes[box.id] = box
    frame.children = [text.id, box.id]
    const result = exportDesignCode(document, { syntax: 'scss' })
    expect(result.css).toContain('font-size:22px')
    expect(result.css).toContain('font-weight:700')
    expect(result.css).toContain('#abcdef')
    expect(result.css).toContain('box-shadow:')
    expect(result.css).toContain('display:none')
    expect(result.html).toContain('$Injected: red;')
    expect(result.scss).toContain('$Brand: #123456;')
    expect(result.scss).not.toContain('$Size')
    expect(result.scss).not.toContain('$Show')
    expect(result.scss).not.toContain('$Injected')
    expect(result.scss).not.toContain('$Heading')
    expect(result.scss).not.toContain('$Card')
    expect(result.scss).not.toContain('@mixin')
    expect(result.scss).not.toContain('@include')
    const textRule = result.scss!.split('\n').find(line => line.startsWith(`${result.nodeIdMap[text.id].selector}{`))
    expect(textRule).toBeTruthy()
    expect(result.scss!.split('\n').find(line => line.startsWith(`${result.nodeIdMap[frame.id].selector}{`))).not.toContain(result.nodeIdMap[text.id].selector)
    for (const code of ['SCSS_NUMBER_BINDINGS_OMITTED', 'SCSS_BOOLEAN_BINDINGS_OMITTED', 'SCSS_TEXT_STYLE_OMITTED', 'SCSS_EFFECT_STYLE_OMITTED', 'SCSS_PAINT_STYLE_OMITTED', 'SCSS_NESTING_OMITTED', 'SCSS_INACTIVE_MODES_OMITTED'])
      expect(result.warnings).toContainEqual(expect.objectContaining({ code }))
    expect(result.warnings.some(warning => warning.code.includes('STRING'))).toBe(false)
    expectCompiles(result)
    expect(() => exportDesignCode(document, { syntax: 'less' } as unknown as CodeExportOptions)).toThrow(/syntax/)
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
})
