import {
  hit_test_json,
  hit_test_device_json,
  hit_test_fill_device_json,
  stroke_geometry_json,
  stroke_handles_json,
  geometry_bounds_json,
  export_region_plan_json,
  snap_pixel_json,
  VectorEngine,
  DocumentHistory,
} from '../generated/design-kernel/design_kernel'
import { initializeKernelModule, validateKernelDocument } from './module'
import { documentStage, DocumentStage } from '../document-lifecycle-diagnostics'
import { admitDocumentSync, admitDocumentJsonSync } from '../document-admission'
import { InitializationGate, readKernelAsset } from './initialization'
import { loadKernelResourcePair } from './kernel-resources'
import type { DesignNode, Point, DesignDocument, Bounds, Matrix } from '../model'
import { defaultLayout, defaultSizing, validateVariableModes } from '../model'
import { translationOnlyChanges } from './translation-preview'
let ready = false
// Opaque identity avoids counter wraparound and does not retain font resources.
// Canvas snapshots must not survive a changed main-thread font environment.
let geometryEpoch: object = {}
export const pickingGeometryEpoch = () => geometryEpoch
const initialization = new InitializationGate()
const cache = new WeakMap<DesignNode, string>()
const boundsCache = new WeakMap<DesignNode, { key: string; value: Bounds | null }>()
const geometryCache = new WeakMap<DesignNode, string>()
const svgCache = new WeakMap<DesignNode, { fill: string; stroke: string }>()
export function invalidateGeometry(n: DesignNode) {
  cache.delete(n)
  boundsCache.delete(n)
  geometryCache.delete(n)
  svgCache.delete(n)
}
let layoutEngine: VectorEngine | undefined
export function createDocumentHistory(document: DesignDocument) {
  if (!ready) throw new Error('编辑内核尚未就绪')
  return new DocumentHistory(JSON.stringify(document))
}
let loadedFonts: DesignDocument['fonts']
/** The native CPU kernel owns raster dimensions and document-to-pixel mapping. */
export function kernelExportPlan(bounds: Bounds, scale: number) {
  if (!ready) throw new Error('导出内核尚未就绪')
  return JSON.parse(export_region_plan_json(JSON.stringify(bounds), scale)) as {
    width: number
    height: number
    view: { x: number; y: number; zoom: number }
  }
}
export function kernelTextLayout(n: DesignNode) {
  if (!ready || !layoutEngine) throw new Error('文字内核尚未就绪')
  return JSON.parse(layoutEngine.text_layout(JSON.stringify(n))) as {
    spans: { path: string; color?: string; link?: string }[]
    bounds: Bounds | null
    width: number
    height: number
    lines: { start: number; end: number; width: number; y: number; height: number }[]
    glyphs: { pathTransform?:Matrix; size:number; cluster: number; clusterEnd: number; x: number; y: number; advance: number }[]
  }
}
export function kernelSvgPaths(n: DesignNode) {
  if (!ready || !layoutEngine) return null
  let paths = svgCache.get(n)
  if (!paths) {
    paths = JSON.parse(layoutEngine.svg_paths(JSON.stringify(n))) as {
      fill: string
      stroke: string
    }
    svgCache.set(n, paths)
  }
  return paths
}
/** True-vector single-page PDF through the shared layout engine, whose
 * resident fonts also shape the exported text outlines. The caller prepares
 * the document exactly like the PNG path (kernelLayout, selection
 * isolation); width/height become MediaBox points and RenderOptions.view is
 * ignored, so the caller must re-root content at the target origin. */
export function kernelPdfVector(
  document: DesignDocument,
  pageId: string,
  width: number,
  height: number,
  transparent: boolean,
): Uint8Array {
  if (!ready || !layoutEngine) throw new Error('导出内核尚未就绪')
  // The main-thread engine only serves stateless JSON entry points; loading
  // the export document just installs its scene/fonts for this one call.
  // install_document rebuilds named fonts from the document, so keep the
  // module's loadedFonts tracking in step for later kernelLayout calls.
  if (loadedFonts !== document.fonts) {
    layoutEngine.load_document_fonts(JSON.stringify(document.fonts || {}))
    geometryEpoch = {}
    loadedFonts = document.fonts
  }
  layoutEngine.load_document(JSON.stringify(document))
  geometryEpoch = {}
  return new Uint8Array(
    layoutEngine.export_pdf_vector(
      JSON.stringify({ pageId, width, height, view: { x: 0, y: 0, zoom: 1 }, transparent, grid: false }),
    ),
  )
}
export function initializePicking(resources?: { wasm: Uint8Array; font: Uint8Array }) {
  return initialization.run(async (lease) => {
    // The packaged NotoSansSC.ttf is 17,772,300 bytes; retain bounded headroom.
    const limit = 32 * 1024 * 1024
    if (resources?.font && resources.font.byteLength > limit) throw new Error('布局字体超过大小限制')
    // The font transfer is independent of WASM compilation. Keep both bounded
    // and gate publication exactly as before, without serializing cold startup.
    const fontBytes = await loadKernelResourcePair(
      () => initializeKernelModule(resources?.wasm),
      async () => resources?.font?.slice() || await readKernelAsset('/fonts/NotoSansSC.ttf', limit, lease.signal),
    )
    lease.assertCurrent()
    const engine = new VectorEngine()
    try {
      engine.load_font(fontBytes)
      lease.commit(() => {
        layoutEngine = engine
        ready = true
        geometryEpoch = {}
      })
    } catch (error) {
      engine.free()
      throw error
    }
  })
}
/** All file-opening paths share the same forward-only schema normalization. */
export function prepareDocumentForEditing(value: unknown, captureValidatedJson?: (json: string) => void): DesignDocument {
  return prepareAdmittedDocument(documentStage(DocumentStage.admission, () => admitDocumentSync(value)), captureValidatedJson)
}
/** Primitive source ownership avoids only the redundant JSON graph clone. */
export function prepareDocumentJsonForEditing(source: string, captureValidatedJson?: (json: string) => void, syntaxFailureAttempt?: object): DesignDocument {
  return prepareAdmittedDocument(admitDocumentJsonSync(source, syntaxFailureAttempt), captureValidatedJson)
}
function prepareAdmittedDocument(original: DesignDocument, captureValidatedJson?: (json: string) => void): DesignDocument {
  const prepared = documentStage(DocumentStage.layout, () => kernelLayout({
    ...original,
    schemaVersion: Math.max(2, original.schemaVersion) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
    rasterProfile: original.rasterProfile || (original.colorManagement ? 'figma' : 'analytic'),
  }))
  // Reject an invalid derived offset before adopting a persisted/imported scene.
  // Otherwise the first synchronous bounds/selection query can tear down React.
  documentStage(DocumentStage.derivedValidation, () => {
    for(const n of Object.values(prepared.nodes))if(n.pathOffset||n.vectorBrush)kernelBounds(n)
    const json = JSON.stringify(prepared)
    validateKernelDocument(json)
    captureValidatedJson?.(json)
  })
  return prepared
}
/** Restore the document-local font environment without repeating admission or layout. */
export function activateDocumentFonts(input: DesignDocument) {
  if (loadedFonts !== input.fonts) {
    if (!ready || !layoutEngine) throw new Error('字体内核尚未就绪')
    layoutEngine.load_document_fonts(JSON.stringify(input.fonts || {}))
    // The kernel stages font resources before replacing its environment;
    // failed loads keep both the old environment and this epoch intact.
    geometryEpoch = {}
    loadedFonts = input.fonts
    // Font identity is part of outline geometry, including unchanged text nodes.
    for (const n of Object.values(input.nodes)) invalidateGeometry(n)
  }
}
const layoutDefaultKeys = Object.keys(defaultLayout())
const sizingDefaultKeys = Object.keys(defaultSizing())
export function kernelLayout(input: DesignDocument, previous?: DesignDocument): DesignDocument {
  validateVariableModes(input)
  activateDocumentFonts(input)
  if (input.animations?.length) {
    if (!ready || !layoutEngine) throw new Error('动画内核尚未就绪')
    layoutEngine.validate_animations(JSON.stringify(input))
  }
  const inputNodes = Object.values(input.nodes)
  const connectors=inputNodes.some(n=>!!n.connector || (n.board?.kind==='code-block'&&!!n.board.language))
  let document = input
  for (const n of inputNodes) {
    const patch: Partial<DesignNode> = {}
    if (n.component && (!n.component.variants || !n.component.properties))
      patch.component = {
        ...n.component,
        variants: n.component.variants ?? {},
        properties: n.component.properties ?? {},
      }
    if (n.instance && (!n.instance.overrides || !n.instance.propertyValues))
      patch.instance = {
        ...n.instance,
        overrides: n.instance.overrides ?? {},
        propertyValues: n.instance.propertyValues ?? {},
      }
    if (n.layout && layoutDefaultKeys.some((key) => !(key in n.layout!)))
      patch.layout = { ...defaultLayout(), ...n.layout }
    if (n.sizing && sizingDefaultKeys.some((key) => !(key in n.sizing!)))
      patch.sizing = { ...defaultSizing(), ...n.sizing }
    if (Object.keys(patch).length) {
      if (document === input) document = { ...input, nodes: { ...input.nodes } }
      document.nodes[n.id] = { ...n, ...patch }
    }
  }
  // Resolution may have replaced incomplete legacy nodes; never classify the
  // stale input records after normalization.
  const documentNodes = document === input ? inputNodes : Object.values(document.nodes)
  if (previous) {
    const translated = translationOnlyChanges(previous, document)
    if (translated) {
      for (const id of translated) {
        // This JSON contains local geometry only. Hit/bounds caches also carry
        // placement or a composed matrix and must be recomputed for the move.
        const geometry = geometryCache.get(previous.nodes[id])
        if (geometry) geometryCache.set(document.nodes[id], geometry)
      }
      return document
    }
  }
  if (
    previous && !connectors &&
    previous.designSystem === document.designSystem &&
    previous.prototype === document.prototype &&
    previous.fonts === document.fonts &&
    previous.pages === document.pages &&
    Object.keys(previous.nodes).length === Object.keys(document.nodes).length
  ) {
    const changed = Object.keys(document.nodes).filter(
      (id) => document.nodes[id] !== previous.nodes[id],
    )
    const parents = new Map<string, string>()
    for (const n of documentNodes)
      for (const id of n.children) parents.set(id, n.id)
    const independent = (id: string) => {
      let at: string | undefined = id
      while (at) {
        const n = document.nodes[at]
        if (
          !n ||
          n.component ||
          n.componentSet ||
          n.instance ||
          n.instanceOrigin ||
          n.booleanOperation ||
          Object.keys(n.bindings || {}).length ||
          Object.keys(n.styleRefs || {}).length ||
          Object.keys(n.variableModes || {}).length
        )
          return false
        at = parents.get(at)
      }
      return true
    }
    const keys = [
      'kind',
      'width',
      'height',
      'transform',
      'children',
      'text',
      'fontSize',
      'textStyle',
      'textRuns',
      'layout',
      'sizing',
      'constraints',
      'visible',
      'network',
      // Removing the last selection must still resolve bound descendants.
      'variableModes',
    ] as const
    if (
      changed.every(
        (id) =>
          previous.nodes[id] &&
          independent(id) &&
          keys.every((key) => previous.nodes[id][key] === document.nodes[id][key]),
      )
    )
      return document
  }
  const components =
    !!document.designSystem ||
    !!document.prototype ||
    documentNodes.some(
      (n) => n.booleanOperation || Object.keys(n.variableModes || {}).length,
    ) ||
    documentNodes.some(
      (n) => n.component || n.componentSet || n.instance || n.instanceOrigin,
    )
  if (
    !components && !connectors &&
    !documentNodes.some((n) => n.layout || n.sizing || n.constraints)
  )
    return document
  if (
    previous && !connectors &&
    !components &&
    previous.fonts === document.fonts &&
    previous.pages === document.pages &&
    Object.keys(previous.nodes).length === Object.keys(document.nodes).length
  ) {
    const changed = Object.keys(document.nodes).filter(
      (id) => previous.nodes[id] !== document.nodes[id],
    )
    const layoutKeys = [
      'kind',
      'width',
      'height',
      'transform',
      'children',
      'text',
      'fontSize',
      'textStyle',
      'textRuns',
      'layout',
      'sizing',
      'constraints',
      'visible',
      'network',
      // Removing the last selection must still resolve bound descendants.
      'variableModes',
    ] as const
    if (
      changed.every(
        (id) =>
          previous.nodes[id] &&
          layoutKeys.every((key) => previous.nodes[id][key] === document.nodes[id][key]),
      )
    )
      return document
    // Page roots are independent layout islands. Resolve only islands that
    // contain a changed node, retaining the normal full validation on publish.
    const parents = new Map<string, string>()
    for (const n of documentNodes)
      for (const id of n.children) parents.set(id, n.id)
    const roots = new Set(
      changed.map((id) => {
        let at = id
        while (parents.has(at)) at = parents.get(at)!
        return at
      }),
    )
    const nodes: DesignDocument['nodes'] = {}
    const include = (id: string) => {
      nodes[id] = document.nodes[id]
      nodes[id].children.forEach(include)
    }
    roots.forEach(include)
    if (Object.keys(nodes).length < Object.keys(document.nodes).length) {
      const subset = {
        ...document,
        nodes,
        pages: document.pages.map((p) => ({
          ...p,
          children: p.children.filter((id) => roots.has(id)),
        })),
        animations: undefined,
      }
      const resolved = kernelLayout(subset)
      return { ...document, nodes: { ...document.nodes, ...resolved.nodes } }
    }
  }
  if (!ready || !layoutEngine) throw new Error('布局内核尚未就绪')
  if (components) {
    const changes = JSON.parse(layoutEngine.resolve_components(JSON.stringify(document))) as {
      nodes: Record<string, DesignNode>
      removed: string[]
    }
    if (!Object.keys(changes.nodes).length && !changes.removed.length) return document
    const nodes = { ...document.nodes, ...changes.nodes }
    for (const id of changes.removed) delete nodes[id]
    for (const n of Object.values(changes.nodes)) {
      for (const key of [
        'network',
        'layout',
        'sizing',
        'constraints',
        'component',
        'instance',
        'instanceOrigin',
        'componentKey',
      ] as const)
        if (n[key] === null) delete n[key]
    }
    return { ...document, nodes }
  }
  const patches = JSON.parse(layoutEngine.resolve_layout(JSON.stringify(document))) as Record<
    string,
    Partial<DesignNode> | null
  >
  if (!Object.keys(patches).length) return document
  const nodes = { ...document.nodes }
  for (const [id, patch] of Object.entries(patches)) {
    const next = { ...nodes[id], ...patch }
    for (const key of ['network', 'sizing', 'constraints'] as const)
      if (next[key] === null) delete next[key]
    nodes[id] = next
  }
  return { ...document, nodes }
}
function hitNodeJson(n: DesignNode): string {
  let json = cache.get(n)
  if (!json) {
    const paint = (p: DesignNode['fills'][number]) => ({ ...p, image: undefined, stops: [] })
    json = JSON.stringify({
      ...n,
      component: undefined,
      componentSet: undefined,
      componentKey: undefined,
      instance: undefined,
      instanceOrigin: undefined,
      layout: undefined,
      sizing: undefined,
      constraints: undefined,
      children: [],
      effects: [],
      text: '',
      fills: n.fills.map(paint),
      strokes: n.strokes.map((s) => ({ ...s, paint: paint(s.paint) })),
    })
    cache.set(n, json)
  }
  return json
}
export function kernelHit(n: DesignNode, p: Point, tolerance: number): boolean {
  if (!ready) return false
  return hit_test_json(hitNodeJson(n), p.x, p.y, Math.min(1000, tolerance))
}
/** CSS-pixel hit tolerance, using the complete node-to-world affine transform.
 * Rebase at the pointer before scaling to retain precision far from the origin.
 */
export function kernelHitWorld(
  n: DesignNode,
  point: Point,
  matrix: Matrix,
  zoom: number,
  tolerance = 5,
): boolean {
  if (!ready) return false
  if(n.textPath&&layoutEngine)return JSON.parse(layoutEngine.text_geometry(JSON.stringify(n),deviceHitMatrix(point,matrix,zoom),0,0,tolerance)).hit
  return hit_test_device_json(hitNodeJson(n), deviceHitMatrix(point, matrix, zoom), 0, 0, tolerance)
}
function deviceHitMatrix(point: Point, matrix: Matrix, zoom: number): string {
  return JSON.stringify([
    matrix[0] * zoom,
    matrix[1] * zoom,
    matrix[2] * zoom,
    matrix[3] * zoom,
    (matrix[4] - point.x) * zoom,
    (matrix[5] - point.y) * zoom,
  ])
}
/** Fill geometry only: no selection halo and no paint/alpha approximation change. */
export function kernelFillWorld(
  n: DesignNode,
  point: Point,
  matrix: Matrix,
  zoom: number,
): boolean {
  if (!ready) return false
  return hit_test_fill_device_json(hitNodeJson(n), deviceHitMatrix(point, matrix, zoom), 0, 0)
}

export function kernelStrokeContours(n: DesignNode): Point[][][] {
  if (!ready) throw new Error('矢量内核尚未就绪')
  return JSON.parse(stroke_geometry_json(JSON.stringify(n))) as Point[][][]
}
export function kernelStrokePaths(n: DesignNode): string[] {
  const paths = kernelStrokeContours(n)
  return paths.map((cs) =>
    cs.map((ps) => (ps.length ? `M${ps.map((p) => `${p.x},${p.y}`).join('L')}Z` : '')).join(''),
  )
}

export type StrokeHandle = { index: number; contour: number; point: Point; normal: Point }
export function kernelStrokeHandles(n: DesignNode, index: number): StrokeHandle[] {
  if (!ready) return []
  return JSON.parse(stroke_handles_json(JSON.stringify(n), index))
}

export function kernelBounds(n: DesignNode, matrix: Matrix = [1, 0, 0, 1, 0, 0]): Bounds | null {
  if (!ready) return null
  // Translation commutes with exact path extrema. Reusing the linear part
  // avoids reparsing/rebounding every descendant during a parent drag.
  // Invalid matrices still go through the kernel's normal validation path.
  const reusable = matrix.every(Number.isFinite)
  const basis: Matrix = reusable ? [matrix[0], matrix[1], matrix[2], matrix[3], 0, 0] : matrix
  const key = basis.join(','),
    cached = boundsCache.get(n)
  const positioned = (value: Bounds | null) => value && reusable
    ? { ...value, x: value.x + matrix[4], y: value.y + matrix[5] } : value
  if (cached?.key === key) return positioned(cached.value)
  let json = geometryCache.get(n)
  if (!json) {
    json = JSON.stringify({
      id: n.id,
      kind: n.kind,
      width: n.width,
      height: n.height,
      network: n.network,
      vectorBrush: n.vectorBrush,
      radii: n.radii,
      smoothing: n.smoothing,
      arc: n.arc,
      cornerRadius: n.cornerRadius,
      pathOffset:n.pathOffset,
      points: n.points,
      innerRadius: n.innerRadius,
    })
    geometryCache.set(n, json)
  }
  const value = n.textPath&&layoutEngine ? JSON.parse(layoutEngine.text_geometry(JSON.stringify(n),JSON.stringify(basis),0,0,0)).bounds as Bounds|null : JSON.parse(geometry_bounds_json(json, JSON.stringify(basis))) as Bounds | null
  boundsCache.set(n, { key, value })
  return positioned(value)
}
export function kernelSnapPoint(p: Point): Point {
  if (!ready) throw new Error('矢量内核尚未就绪')
  return JSON.parse(snap_pixel_json(JSON.stringify(p)))
}
