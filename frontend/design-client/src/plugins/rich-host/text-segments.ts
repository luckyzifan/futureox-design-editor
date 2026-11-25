import type { DesignNode, TextRun } from '../../model'
import { PluginApiError } from './errors'

export function styledTextSegments(node: DesignNode, requested: unknown, rawStart: unknown, rawEnd: unknown) {
  if (node.kind !== 'text') throw new PluginApiError('invalid_kind', 'Styled segments require a text node')
  if (!Array.isArray(requested)) throw new PluginApiError('invalid_value', 'Styled segment fields must be an array')
  if (rawStart !== undefined && rawEnd === undefined) throw new PluginApiError('invalid_value', 'A styled segment start requires an end')
  const start = rawStart === undefined ? 0 : rawStart
  const end = rawEnd === undefined ? node.text.length : rawEnd
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) ||
    start < 0 || end < start || end > node.text.length) {
    throw new PluginApiError('invalid_value', 'Styled segment offsets must be inside the text')
  }

  const style = node.textStyle
  const readers = {
    fontSize: (run?: TextRun) => run?.fontSize ?? node.fontSize,
    fontWeight: (run?: TextRun) => run?.weight ?? style?.weight ?? 400,
    fontStyle: (run?: TextRun) => run?.italic ? 'ITALIC' : 'REGULAR',
    textDecoration: (run?: TextRun) => run?.strikethrough ? 'STRIKETHROUGH' : run?.underline ? 'UNDERLINE' : 'NONE',
    textCase: (run?: TextRun) => {
      const value = run?.textCase ?? style?.textCase
      return value === 'upper' ? 'UPPER' : value === 'lower' ? 'LOWER' : value === 'title' ? 'TITLE' : 'ORIGINAL'
    },
    lineHeight: (run?: TextRun) => run?.lineHeight === undefined && style?.lineHeightAuto
      ? { unit: 'AUTO' }
      : { unit: 'PERCENT', value: Math.round((run?.lineHeight ?? style?.lineHeight ?? 1.35) * 1000) / 10 },
    letterSpacing: (run?: TextRun) => ({ unit: 'PIXELS', value: run?.letterSpacing ?? style?.letterSpacing ?? 0 }),
    paragraphSpacing: (run?: TextRun) => run?.paragraph?.spacing ?? style?.paragraphSpacing ?? 0,
    paragraphIndent: (run?: TextRun) => run?.paragraph?.indent ?? style?.paragraphIndent ?? 0,
  }
  const fields: (keyof typeof readers)[] = []
  for (const field of new Set(requested)) {
    if (typeof field !== 'string' || !Object.hasOwn(readers, field))
      throw new PluginApiError('unsupported_api', `Styled segment field ${String(field)} is not available`)
    fields.push(field as keyof typeof readers)
  }

  const segments: { start: number; end: number; values: Record<string, unknown>; signature: string }[] = []
  function append(from: number, to: number, run?: TextRun) {
    if (from >= to) return
    const values = Object.fromEntries(fields.map(field => [field, readers[field](run)]))
    const signature = JSON.stringify(values)
    const previous = segments.at(-1)
    if (previous?.signature === signature) previous.end = to
    else segments.push({ start: from, end: to, values, signature })
  }
  let cursor = start
  for (const run of node.textRuns ?? []) {
    if (run.end <= start) continue
    if (run.start >= end) break
    append(cursor, run.start)
    cursor = Math.min(run.end, end)
    append(Math.max(run.start, start), cursor, run)
  }
  append(cursor, end)
  return segments.map(({ start, end, values }) => ({ start, end, characters: node.text.slice(start, end), ...values }))
}
