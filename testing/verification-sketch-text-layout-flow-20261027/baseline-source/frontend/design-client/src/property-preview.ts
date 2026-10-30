/** The only preview targets admitted by the first color transaction slice.
 * Slot id AND index are deliberate: reorder, replacement and rebinding cannot
 * redirect a late sample into a different paint. No arbitrary property paths. */
export type SolidFillTarget = Readonly<{
  kind: 'solid-fill'
  nodeId: string
  fillId: string
  fillIndex: number
}>
declare const propertyPreviewCapability: unique symbol
/** Opaque, editor-local capability. A structurally similar object grants nothing. */
export type PropertyPreviewLease = Readonly<{ [propertyPreviewCapability]: true }>
export type SolidFillDraft = Readonly<{ color?: string; opacity?: number }>
export type PropertyPreviewResult = 'committed' | 'unchanged' | 'preview' | 'blocked' | 'stale' | 'rejected'
export type PropertyPreviewBoundary = 'outside' | 'save' | 'export' | 'tool' | 'navigation' | 'edit' | 'apply'

/** Narrow keyboard admission for the app-owned property popover only. Other
 * dialogs and editable controls retain their existing command ownership. */
export function ownedPropertyPreviewTarget(editor: { readonly propertyPreviewActive: boolean }, target: EventTarget | null): boolean {
  return editor.propertyPreviewActive && !!(target as Element | null)?.closest?.('[data-property-preview]')
}
