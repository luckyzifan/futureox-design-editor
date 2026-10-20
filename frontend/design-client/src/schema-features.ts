import type { DesignDocument } from './model'
/** Authored schema admission shared by edits and previews; not a renderer downgrade. */
export function hasSchema15Features(d: DesignDocument): boolean {
  for (const n of Object.values(d.nodes)) {
    if (n.repeat !== undefined || n.vectorBrush !== undefined ||
      Object.keys(n.component?.slots || {}).length || Object.keys(n.instance?.slotContents || {}).length ||
      (n.textStyle?.textCase !== undefined && n.textStyle.textCase !== 'original') ||
      n.textRuns?.some(r => r.textCase !== undefined)) return true
  }
  return Object.values(d.prototype?.interactions || {}).some(events =>
    events.some(event => event.actions.some(a => a.kind === 'if' || a.expression !== undefined)))
}
