import React from 'react'
import { blank, node, defaultTextStyle, validateDocument, hasSchema20Features, type DesignDocument, type DesignNode } from './model'
import { kernelTextLayout } from './kernel/picking'

export const EDITABLE_TEXT_WARNING = 'Editable SVG references font families without embedding fonts. Missing fonts, fallback, shaping and browser layout can change appearance; use outlines for visual fidelity.'
function supported(n: DesignNode) {
  const s = n.textStyle
  if (n.textRuns?.some(r => r.color && !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(r.color))) throw new Error('Editable SVG run colors require hexadecimal colors')
  if (n.textPath || s?.writingMode === 'vertical' || s?.features?.length || s?.variations?.length || s?.align === 'justify' || (s?.textCase && s.textCase !== 'original') || n.textRuns?.some(r => r.paragraph?.align === 'justify' || r.link || (r.textCase && r.textCase !== 'original')))
    throw new Error('Editable SVG does not support text paths, vertical/justified text, OpenType overrides, case transforms or links; use outlines')
  if (n.fills.filter(p => p.visible).length !== 1 || n.strokes.some(s => s.visible)) throw new Error('Editable SVG requires one visible text fill and no text strokes; use outlines')
}
export function EditableSvgText({ n, fonts, paintProps }: { n: DesignNode; fonts: DesignDocument['fonts']; paintProps: React.SVGProps<SVGPathElement> }) {
  supported(n)
  const family = (id = 'default') => id === 'default' ? 'Noto Sans SC' : fonts?.[id]?.family || id
  const cssFamily = (id?: string) => [id || n.textStyle?.fontId || 'default', ...(n.textStyle?.fallbacks || []), 'default'].filter((id,index,ids)=>ids.indexOf(id)===index).map(id => JSON.stringify(family(id))).join(', ') + ', sans-serif'
  const layout = kernelTextLayout(n)
  const metadata = JSON.stringify({ text: n.text, fontSize: n.fontSize, textStyle: n.textStyle, textRuns: n.textRuns, width: n.width, height: n.height, fontFamilies: Object.fromEntries(['default', n.textStyle?.fontId || 'default', ...(n.textStyle?.fallbacks || []), ...(n.textRuns || []).map(r=>r.fontId || 'default')].map(id=>[id,family(id)])) })
  return <text {...paintProps as unknown as React.SVGProps<SVGTextElement>} data-editable-text="1" data-text-model={metadata} fontFamily={cssFamily()} fontSize={n.fontSize} fontWeight={n.textStyle?.weight || 400} letterSpacing={n.textStyle?.letterSpacing || 0} xmlSpace="preserve" style={{...paintProps.style, whiteSpace:'pre'}} direction={n.textStyle?.direction === 'rtl' ? 'rtl' : 'ltr'}>
    {layout.lines.map((line, i) => {
      const glyphs = layout.glyphs.filter(g => g.cluster >= line.start && g.cluster < line.end)
      const glyph = glyphs[0]
      // SVG start anchors follow direction. The shaped line's right edge is the
      // RTL anchor; anchoring to its first glyph incorrectly shifts the line.
      const rtl = n.textStyle?.direction === 'rtl'
      const x = glyphs.length ? (rtl ? glyphs.reduce((edge, g) => Math.max(edge, g.x + g.advance), -Infinity) : glyphs.reduce((edge, g) => Math.min(edge, g.x), Infinity)) : 0
      const cuts = [...new Set([line.start, line.end, ...(n.textRuns || []).flatMap(r => [r.start,r.end]).filter(p => p > line.start && p < line.end)])].sort((a,b)=>a-b)
      return <tspan key={i} x={x} y={glyph?.y ?? line.y + n.fontSize}>{cuts.slice(0,-1).map((start,j) => {
        const run = n.textRuns?.find(r => r.start <= start && r.end > start)
        return <tspan key={j} fontFamily={cssFamily(run?.fontId)} fontSize={run?.fontSize || n.fontSize} fontWeight={run?.weight || n.textStyle?.weight || 400} fill={run?.color || paintProps.fill} textDecoration={[run?.underline?'underline':'',run?.strikethrough?'line-through':''].filter(Boolean).join(' ') || undefined}>{n.text.slice(start,cuts[j+1]).replace(/\n/g,'')}</tspan>
      })}</tspan>
    })}
  </text>
}
/** Only our bounded generated text tree is admitted. Metadata is untrusted and
 * validated as a document before any fields are copied into the imported node. */
export function readEditableSvgText(el: Element, target: DesignNode, fonts: DesignDocument['fonts'], admitDescendant: (relativeDepth: number) => void): boolean {
  if (el.getAttribute('data-editable-text') !== '1') return false
  const allowedAttributes = ['data-editable-text','data-text-model','font-family','font-size','font-weight','letter-spacing','xml:space','style','direction','fill','fill-opacity','fill-rule']
  if (Array.from(el.attributes).some(a => !allowedAttributes.includes(a.name))) throw new Error('Unsupported editable SVG text attribute')
  const declarations = (el.getAttribute('style') || '').split(';').filter(Boolean)
  if (declarations.some(d => !/^white-space:pre$|^mix-blend-mode:normal$/.test(d.trim()))) throw new Error('Unsupported editable SVG text style')
  // The ordinary importer does not visit these model-backed descendants.
  // Charge them to its SAME depth/node budget before reading the model. Walk
  // with DOM pointers, avoiding recursion or an unbounded selector result.
  let child: Element | null = el.firstElementChild, relativeDepth = 1
  while (child) {
    admitDescendant(relativeDepth)
    if (child.localName !== 'tspan' || Array.from(child.attributes).some(a => !['x','y','font-family','font-size','font-weight','fill','text-decoration'].includes(a.name))) throw new Error('Unsupported editable SVG text child or attribute')
    if (child.firstElementChild) { child = child.firstElementChild; relativeDepth++; continue }
    while (child && child !== el && !child.nextElementSibling) { child = child.parentElement; relativeDepth-- }
    if (!child || child === el) break
    child = child.nextElementSibling
  }
  const raw = el.getAttribute('data-text-model') || ''
  if (raw.length > 1024 * 1024) throw new Error('Editable SVG text metadata exceeds budget')
  const value = JSON.parse(raw)
  const allowed = ['text','fontSize','textStyle','textRuns','width','height']
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k) && k !== 'fontFamilies')) throw new Error('Invalid editable SVG text metadata')
  const probe = node('text'); for (const key of allowed) if (Object.hasOwn(value,key)) (probe as unknown as Record<string,unknown>)[key] = value[key]
  const resolve = (id: string) => {
    if (typeof id !== 'string') throw new Error('Invalid editable SVG font reference')
    return id === 'default' ? (!!fonts?.__svg_bundled_default && fonts.__svg_bundled_default.family === value.fontFamilies?.default ? '__svg_bundled_default' : id) : Object.entries(fonts || {}).find(([key,font]) => key === id && font.family === value.fontFamilies?.[id])?.[0] || 'default'
  }
  const embeddedDefault = !!fonts?.__svg_bundled_default && fonts.__svg_bundled_default.family === value.fontFamilies?.default
  if (!probe.textStyle && embeddedDefault) probe.textStyle = defaultTextStyle()
  if (probe.textStyle) { probe.textStyle = {...probe.textStyle, fontId: resolve(probe.textStyle.fontId), fallbacks: Array.isArray(probe.textStyle.fallbacks) ? probe.textStyle.fallbacks.map(resolve) : probe.textStyle.fallbacks} }
  if (embeddedDefault && probe.textStyle && probe.textStyle.fontId !== '__svg_bundled_default' && !probe.textStyle.fallbacks.includes('__svg_bundled_default')) probe.textStyle.fallbacks = [...probe.textStyle.fallbacks, '__svg_bundled_default']
  if (Array.isArray(probe.textRuns)) probe.textRuns = probe.textRuns.map(r=>({...r,...(r.fontId ? {fontId:resolve(r.fontId)} : {})}))
  const doc = blank(); doc.schemaVersion = 15; doc.fonts = fonts; doc.nodes[probe.id] = probe; doc.pages[0].children = [probe.id]
  if (hasSchema20Features(doc)) doc.schemaVersion=20
  validateDocument(doc); supported(probe)
  if (el.textContent !== probe.text.replace(/\n/g,'')) throw new Error('Editable SVG text content does not match its model')
  for (const key of allowed) if (Object.hasOwn(value,key)) (target as unknown as Record<string,unknown>)[key] = (probe as unknown as Record<string,unknown>)[key]
  if (embeddedDefault && !Object.hasOwn(value,'textStyle')) target.textStyle = probe.textStyle
  return true
}
