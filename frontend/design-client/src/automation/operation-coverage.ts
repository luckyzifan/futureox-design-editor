import { CanvasAction } from '../canvas-action-diagnostics'
import type { AutomationMethod } from './types'

type Coverage = {
  status: 'authored-operation' | 'partial' | 'ui-only'
  domain: string
  methods: readonly string[]
  limitation: string
}
const ui = (domain: string, limitation: string): Coverage => ({ status: 'ui-only', domain, methods: [], limitation })
const authored = (domain: string, methods: string[], limitation = 'Authored operation only; pointer gestures, focus, and visual parity are not claimed.'): Coverage =>
  ({ status: 'authored-operation', domain, methods, limitation })
const partial = (domain: string, methods: string[], limitation: string): Coverage => ({ status: 'partial', domain, methods, limitation })

/** Audit metadata, not a registry or authorization source. Every diagnostic UI
 * category must be classified, including unimplemented and interaction-only
 * paths. Broad categories are intentionally partial, not fake parity claims. */
export const UI_OPERATION_COVERAGE = {
  unknown: ui('unclassified', 'Unknown input is not evidence of a supported command.'),
  pointer: ui('canvas input', 'No pointer-event injection API.'),
  hitTest: ui('canvas picking', 'No MCP hit-testing or GPU pixel-picking API.'),
  selection: authored('editor selection', ['selection.get', 'selection.set']),
  grab: ui('camera interaction', 'Temporary pointer capture is UI-only.'),
  move: partial('node placement', ['node.patch', 'node.move'], 'Explicit local transforms/reparenting; drag snapping and modifier behavior remain UI-only.'),
  resize: partial('node geometry', ['node.patch', 'layout.patch'], 'Authored dimensions/sizing; no pointer-anchor resize command.'),
  scale: partial('selection scale', ['node.update'], 'Whole-property edits do not implement Editor.scaleSelection and its dependent-value scaling.'),
  rotate: partial('node transforms', ['node.patch'], 'Explicit matrix leaves; no rotation-handle gesture or pivot inference.'),
  pivot: ui('selection pivot', 'Transient manipulation pivot is not an authored MCP operation.'),
  marquee: ui('selection gesture', 'Explicit selection is available separately; no marquee hit-test command.'),
  pan: ui('camera', 'No camera pan operation.'),
  zoom: ui('camera', 'No camera zoom operation.'),
  create: authored('node creation', ['node.create']),
  vertex: partial('vector network', ['node.update'], 'Whole network replacement, not stable vertex-level patches.'),
  handle: partial('vector control handles', ['node.update'], 'Whole network replacement; no control-handle gesture operation.'),
  width: partial('stroke profiles', ['node.update'], 'Whole stroke replacement; no width-tool pointer operation.'),
  parameter: partial('shape parameters', ['node.patch', 'node.update'], 'Typed authored fields; shape-handle constraints must not be inferred.'),
  crop: partial('image paint', ['paint.patch', 'node.update'], 'Existing paint transforms or whole fills; no crop interaction workflow.'),
  text: authored('text editing', ['text.set', 'text.styleRange', 'text.replaceRange']),
  utility: partial('mixed canvas utilities', ['node.update'], 'Only representable authored fields; not every UI utility has a semantic MCP command.'),
  copy: ui('system clipboard', 'No OS clipboard access from MCP operation arguments.'),
  cut: ui('system clipboard', 'node.delete is not an atomic clipboard cut.'),
  paste: partial('document append', ['document.import', 'sketch.import', 'svg.import'], 'Explicit supplied content only; not OS clipboard or paste-placement parity.'),
  undo: authored('native editing history', ['history.undo']),
  redo: authored('native editing history', ['history.redo']),
  delete: authored('node graph', ['node.delete']),
  duplicate: authored('node graph', ['node.duplicate']),
  group: authored('node graph', ['node.group']),
  ungroup: authored('node graph', ['node.ungroup'], 'Ordinary groups/frames only; component and boolean cases retain dedicated restrictions.'),
  selectAll: partial('selection query', ['node.find', 'selection.set'], 'Bounded queries plus explicit IDs; no implicit all-document selection or limit bypass.'),
  command: ui('command routing', 'No arbitrary command/eval endpoint; use discovered semantic operations.'),
  newDocument: ui('document lifecycle', 'No MCP new-copy/open-local-file command; native lifecycle confirmation is separate from append.'),
  tool: ui('active canvas tool', 'No active-tool or synthetic-input MCP method.'),
  page: authored('page graph', ['page.list', 'page.get', 'page.create', 'page.update', 'page.reorder', 'page.duplicate', 'page.delete', 'page.setCurrent']),
  save: partial('local workspace', ['workspace.save'], 'Requires an independent native workspace grant and storage CAS; editor revision is not storage revision.'),
  import: partial('file import', ['document.import', 'sketch.import', 'svg.import', 'svg.importArtifact'], 'MCP appends; UI opens a new copy. FIG/PDF UI import has no MCP equivalent. Exact mutationId retry is not a second import.'),
  export: partial('artifact export', ['document.export', 'sketch.export', 'vector.export', 'vector.exportArtifact', 'raster.export', 'code.export', 'app.export'], 'No PDF MCP export. CPU design-content export is not a GUI/GPU screenshot; external-format warnings remain authoritative.'),
  settings: partial('canvas preferences', ['settings.get', 'settings.update'], 'Independent native settings grant; allowlisted preferences only, never account/security or collaboration authority.'),
  layer: partial('layer management', ['node.find', 'node.move', 'node.patch', 'node.delete'], 'Graph/field operations only; broad sidebar workflows are not all separate commands.'),
  eraser: partial('vector regions', ['vector.shapeBuilder.preview', 'vector.shapeBuilder.apply'], 'Shape Builder supported closed-fill regions only, not arbitrary freehand eraser parity.'),
  boardCreate: partial('local board nodes', ['node.create', 'node.update'], 'Typed board facets, not a collaborative whiteboard service.'),
  measure: ui('measurement overlay', 'Read-only geometry can be inspected through context; no measuring-overlay command.'),
  lasso: ui('selection gesture', 'No lasso hit-testing command.'),
  bend: partial('vector network', ['node.update'], 'Whole network replacement; no bend-tool semantic command.'),
  guide: partial('ruler guides', ['page.update', 'node.update'], 'Whole guide arrays; no ruler-drag UI operation.'),
  layoutHandle: partial('layout properties', ['layout.patch', 'layout.set'], 'Authored spacing/sizing, not pointer-handle inference.'),
  smartSelection: partial('arrangement', ['node.align', 'node.distribute'], 'Explicit IDs; smart-selection drag/reorder gestures are not implied.'),
  scrollbar: ui('camera', 'No scrollbar manipulation operation.'),
  offsetPath: partial('path offset', ['node.update'], 'Authored pathOffset field, not every bake/geometry workflow.'),
  paintBucket: partial('paint and vector regions', ['style.set', 'paint.patch', 'vector.shapeBuilder.apply'], 'Explicit nodes/regions only; no pointer-based bucket hit test.'),
  textPath: partial('text-on-path', ['node.update'], 'Whole textPath facet; no attach-to-pointer workflow.'),
  review: authored('local reviews', ['review.list', 'review.create', 'review.reply', 'review.resolve', 'review.delete'], 'Local document comments only; Automation author is not an authenticated human and nothing is remotely published.'),
  propertyInput: partial('property editing', ['node.patch', 'layout.patch', 'paint.patch', 'text.styleRange', 'node.update'], 'Typed fields and existing facets only; pending UI drafts and native validation remain authoritative.'),
} satisfies Record<keyof typeof CanvasAction, Coverage>

/** These are deliberately absent methods, never placeholder successful tools.
 * Adding a real implementation requires updating the audit and its tests. */
export const UNIMPLEMENTED_SEMANTIC_METHODS = [
  'fig.import', 'pdf.import', 'pdf.export', 'document.newCopy',
  'collaboration.connect', 'collaboration.applyRemote', 'auth.login', 'role.set',
  'vector.patchVertex', 'selection.scale', 'command.execute',
] as const

export type CoverageMethod = AutomationMethod & { grant?: 'workspace' | 'settings' }
export function buildOperationCoverage(input: {
  shared: readonly CoverageMethod[]
  mounted: readonly CoverageMethod[]
  host: readonly CoverageMethod[]
  advertisedTools: readonly { name: string }[]
}) {
  const shared = new Set(input.shared.map(m => m.name))
  const host = new Set(input.host.map(m => m.name))
  const methods = [...input.mounted, ...input.host].sort((a, b) => a.name.localeCompare(b.name))
  const names = new Set<string>(), tools = new Set<string>()
  const advertised = new Set(input.advertisedTools.map(t => t.name))
  const operations = methods.map(method => {
    const tool = `design_${method.name.replaceAll('.', '_').replaceAll('-', '_')}`
    if (names.has(method.name) || tools.has(tool)) throw Error('Operation coverage contains a descriptor/MCP name collision')
    names.add(method.name); tools.add(tool)
    return {
      method: method.name, tool, mutates: method.mutates, advertised: advertised.has(tool),
      boundary: shared.has(method.name) ? 'shared-editor' : host.has(method.name) ? 'native-host' : 'mounted-renderer',
      grant: method.grant ?? 'document', inputSchema: method.inputSchema,
    }
  })
  for (const method of input.shared) if (!names.has(method.name)) throw Error(`Mounted registry omitted shared method ${method.name}`)
  const ui = Object.entries(UI_OPERATION_COVERAGE).map(([action, coverage]) => ({
    action, actionCode: CanvasAction[action as keyof typeof CanvasAction], ...coverage,
    methods: coverage.methods.map(method => ({
      method, registered: names.has(method),
      advertised: advertised.has(`design_${method.replaceAll('.', '_')}`),
    })),
  }))
  return {
    format: 'futureox.local-operation-coverage.v1',
    claim: 'Complete classification of current CanvasAction categories and actual supplied descriptors; not proof of every UI subcommand, gesture parity, rendering fidelity, or real-client acceptance.',
    counts: { shared: input.shared.length, mounted: input.mounted.length, nativeHost: input.host.length, registered: operations.length, advertised: input.advertisedTools.length, uiCategories: ui.length },
    collaboration: { backend: false, authenticatedActors: false, remoteApply: false, conflictMerge: false, authorityFromLocalProfile: false },
    importSemantics: { uiOpen: 'new-copy', mcpImport: 'append', retryDeduplication: 'exact batch.apply mutationId within document-session only' },
    operations, ui, unimplementedMethods: [...UNIMPLEMENTED_SEMANTIC_METHODS],
  }
}
