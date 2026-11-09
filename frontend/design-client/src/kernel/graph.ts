/**
 * Handle-based graph API bindings.
 *
 * Wraps the generated wasm `GraphApi` with a stable, free-safe surface:
 * handles are validated, the wasm instance is disposed deterministically,
 * and facets/ops/tiles expose typed helpers instead of raw numbers.
 */
import { GraphApi } from '../generated/design-kernel/design_kernel'

export const INVALID_HANDLE = 0

export type FacetPayload =
  | { kind: 'document'; name: string }
  | { kind: 'canvas'; background: string }
  | { kind: 'frame'; width: number; height: number; cornerRadius: number }
  | { kind: 'transform'; matrix: [number, number, number, number, number, number] }
  | { kind: 'clip'; on: boolean }
  | { kind: 'mask'; on: boolean; maskType?: string }
  | { kind: 'stack'; horizontal: boolean; grid: boolean; gap: number; padding: [number, number, number, number] }
  | { kind: 'constraints'; horizontal: string; vertical: string }
  | { kind: 'vector'; pointCount: number }
  | { kind: 'text'; characters: number }
  | { kind: 'shape'; points: number }
  | { kind: 'instance'; componentId: string }
  | { kind: 'componentish'; componentKey?: string }
  | { kind: 'variable'; modes: Record<string, string> }
  | { kind: 'effects'; count: number }
  | { kind: 'export'; settings: number }
  | { kind: 'blend'; mode: string; opacity: number }
  | { kind: 'prototype'; interactions: number }
  | { kind: 'annotation'; visible: boolean }
  | { kind: 'keyframe'; animations: number }

export type FacetKind = FacetPayload['kind']
export type ReadOnlyFacetKind = 'vector' | 'text' | 'effects' | 'export' | 'prototype' | 'keyframe'
export type WritableFacetKind = Exclude<FacetKind, ReadOnlyFacetKind>
export type WritableFacetPayload = Exclude<FacetPayload, { kind: ReadOnlyFacetKind }>
export type FacetCapability = { kind: FacetKind; access: 'readOnly' | 'readWrite'; present: boolean }
type ApplyFacetOp = {
  [K in WritableFacetKind]: { type: 'applyFacet'; id: string; kind: K; facet: Extract<WritableFacetPayload, { kind: K }> }
}[WritableFacetKind]

export type Op =
  | { type: 'setName'; id: string; name: string }
  | { type: 'setVisible'; id: string; visible: boolean }
  | { type: 'setOpacity'; id: string; opacity: number }
  | { type: 'setTransform'; id: string; matrix: number[] }
  | { type: 'resize'; id: string; width: number; height: number }
  | ApplyFacetOp
  | { type: 'insertNode'; parent: string; index: number; node: unknown }
  | { type: 'removeNode'; id: string }
  | { type: 'reorderChild'; parent: string; from: number; to: number }
  | { type: 'clearFacet'; id: string; kind: string }

export type EditSource = 'system' | 'user' | 'plugin' | 'onboarding' | 'autosave' | 'ai'

/** Edit-scope transaction options carried by one op batch. `ignoreUndoRedo`
 * applies the batch without an undo entry; `writeInReadonly` is a reserved
 * explicit authorization channel (no document readonly mode yet). */
export interface EditScope {
  source: EditSource
  ignoreUndoRedo?: boolean
  writeInReadonly?: boolean
}

export class GraphApiHandleError extends Error {}

/** Deterministic RAII wrapper over the generated wasm GraphApi. */
export class Graph {
  private disposed = false
  private constructor(readonly api: GraphApi) {}

  static open(documentJson: string): Graph {
    const api = new GraphApi(documentJson)
    api.set_edit_scope_strict(true)
    return new Graph(api)
  }

  free(): void {
    if (!this.disposed) { this.disposed = true; this.api.free() }
  }

  /** Whole-document edit; returns the new revision. */
  replaceDocument(documentJson: string, scope: EditScope = { source: 'user' }): number {
    return this.api.replace_document_scoped(documentJson, JSON.stringify(scope))
  }

  documentJson(): string {
    return this.api.document_json()
  }

  [Symbol.dispose](): void {
    this.free()
  }

  private require(handle: number, what: string): number {
    if (!this.api.node_exists(handle)) {
      throw new GraphApiHandleError(`stale ${what} handle ${handle}`)
    }
    return handle
  }

  handle(id: string): number {
    return this.api.node_handle(id)
  }

  id(handle: number): string {
    this.require(handle, 'node')
    return this.api.node_id(handle)
  }

  kind(handle: number): string {
    this.require(handle, 'node')
    return this.api.node_kind(handle)
  }

  name(handle: number): string {
    this.require(handle, 'node')
    return this.api.node_name(handle)
  }

  setName(handle: number, name: string): void {
    this.require(handle, 'node')
    this.applyOps([{ type: 'setName', id: this.id(handle), name }])
  }

  children(handle: number): number[] {
    this.require(handle, 'node')
    return Array.from(this.api.node_children(handle))
  }

  parent(handle: number): number {
    this.require(handle, 'node')
    const parent = this.api.node_parent(handle)
    return parent === INVALID_HANDLE ? INVALID_HANDLE : this.require(parent, 'parent')
  }

  containingPage(handle: number): number {
    this.require(handle, 'node')
    const page = this.api.find_containing_page(handle)
    return page === INVALID_HANDLE ? INVALID_HANDLE : this.require(page, 'page')
  }

  transform(handle: number): number[] {
    this.require(handle, 'node')
    return Array.from(this.api.node_transform(handle))
  }

  setTransform(handle: number, matrix: number[]): void {
    this.require(handle, 'node')
    if (matrix.length !== 6) throw new GraphApiHandleError('transform must have 6 entries')
    this.applyOps([{ type: 'setTransform', id: this.id(handle), matrix }])
  }

  scale(handle: number, factor: number): void {
    this.require(handle, 'node')
    // Preserve the kernel's scale validation and geometry semantics while
    // declaring this local user action at the same scoped mutation boundary.
    this.api.apply_scale_transform_scoped(handle, factor, JSON.stringify({ source: 'user' }))
  }

  facetKinds(handle: number): string[] {
    this.require(handle, 'node')
    return this.api.facet_kinds(handle)
  }

  /** Declared capabilities distinguish absent optional values from read-only summaries. */
  facetCapabilities(handle: number): FacetCapability[] {
    this.require(handle, 'node')
    return JSON.parse(this.api.facet_capabilities_json(handle)) as FacetCapability[]
  }

  facet<K extends FacetKind>(handle: number, kind: K): Extract<FacetPayload, { kind: K }> | undefined {
    this.require(handle, 'node')
    const json = this.api.facet_json(handle, kind)
    return json === undefined ? undefined : (JSON.parse(json) as Extract<FacetPayload, { kind: K }>)
  }

  applyFacet<K extends WritableFacetKind>(handle: number, kind: K, facet: Extract<WritableFacetPayload, { kind: NoInfer<K> }>): void {
    this.require(handle, 'node')
    this.applyOps([{ type: 'applyFacet', id: this.id(handle), kind, facet } as ApplyFacetOp])
  }

  undo(): boolean {
    return this.api.undo()
  }

  redo(): boolean {
    return this.api.redo()
  }

  undoDepth(): number {
    return this.api.undo_depth()
  }

  redoDepth(): number {
    return this.api.redo_depth()
  }

  /** Every production submission explicitly declares provenance. */
  applyOps(ops: Op[], scope: EditScope = { source: 'user' }): void {
    this.api.apply_ops_json(JSON.stringify({ ops, ...scope }))
  }

  /** Encode ops as a binary sync frame; `lz4` toggles payload compression. */
  opsFrame(ops: Op[], revision: number, lz4 = true): Uint8Array {
    return this.api.ops_frame(JSON.stringify(ops), revision, lz4)
  }

  decodeOpsFrame(bytes: Uint8Array, lz4 = true): { revision: number; ops: Op[] } {
    const [revision, json] = this.api.decode_ops_frame(bytes, lz4)
    return { revision: Number(revision), ops: JSON.parse(json) as Op[] }
  }

  exportBinary(): Uint8Array {
    return this.api.export_binary()
  }

  importBinary(bytes: Uint8Array, scope: EditScope = { source: 'user' }): void {
    this.api.import_binary_scoped(bytes, JSON.stringify(scope))
  }

  levelForZoom(zoom: number): number {
    return GraphApi.level_for_zoom(zoom)
  }

  tile(level: number, x: number, y: number): number {
    return this.api.tile_handle(level, x, y)
  }

  tileViewport(handle: number): number[] {
    return Array.from(this.api.tile_viewport(handle))
  }

  tileScissorForClear(handle: number): number[] {
    return Array.from(this.api.tile_scissor_for_clear(handle))
  }

  tileUvRect(handle: number): number[] {
    return Array.from(this.api.tile_uv_rect(handle))
  }

  tileNeedsColorClear(handle: number): boolean {
    return this.api.tile_needs_color_clear(handle)
  }

  tileToNode(level: number, x: number, y: number): number[] {
    return Array.from(this.api.tile_to_node(level, x, y))
  }

  releaseTile(handle: number): void {
    this.api.tile_release(handle)
  }
}
