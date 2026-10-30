/** CPU-only, real WASM phase profile. Private fixture bytes stay local.
 * bun scripts/profile-document.ts /absolute/document.fd */
import { readFile } from 'node:fs/promises'
import { initializePicking, prepareDocumentForEditing, kernelLayout } from '../src/kernel/picking'
import { createEditingHistory } from '../src/kernel/graph-history'
import { validateDocument, type DesignDocument } from '../src/model'
import { documentPatch, shareDocument } from '../src/document-patch'
import { compileEditOps } from '../src/kernel/op-sync'
import { VectorEngine, image_sampling_grid_placed, image_sampling_axes_placed } from '../src/generated/design-kernel/design_kernel'
import { prepareDocument } from '../src/prepared-document'
import { Editor } from '../src/engine'
import { blank } from '../src/model'
const file = process.argv[2]
if (!file) throw Error('Provide a private FD fixture path')
const timings: Record<string, number> = {}
const time = <T>(name: string, task: () => T) => { const start = performance.now(); const result = task(); timings[name] = performance.now() - start; return result }
const input = await readFile(file, 'utf8')
const initAt = performance.now()
const wasm = new Uint8Array(await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)))
const font = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)))
await initializePicking({ wasm, font }); timings.initializePicking = performance.now() - initAt
const source = time('parse', () => JSON.parse(input) as DesignDocument)
const doc = time('prepareDocumentForEditing', () => prepareDocumentForEditing(source))
const editor = new Editor(blank())
time('legacySecondPreparationAtAdoption', () => editor.load(doc))
const prepared = time('prepareOwnedDocument', () => prepareDocument(source))
time('ownedSaveSnapshot', () => prepared.snapshot())
time('ownedAdoption', () => editor.load(prepared))
time('idleHistoryWarm', () => editor.warmEditingHistory(editor.state.doc, editor.sessionGeneration))
const id = doc.pages[0].children[1] || doc.pages[0].children[0], root = doc.nodes[id]
const moved = { ...doc, nodes: { ...doc.nodes, [id]: { ...root, transform: [...root.transform.slice(0, 4), root.transform[4] + 100, root.transform[5] + 50] as typeof root.transform } } }
time('translationLayout', () => kernelLayout(moved, doc))
time('validateJs', () => validateDocument(moved))
time('shareDocument', () => shareDocument(doc, moved))
time('compileEditOps', () => compileEditOps(doc, moved))
const history = time('historyOpen', () => createEditingHistory(doc))
try {
  time('historyApply', () => history.apply(history.revision, moved))
  time('historyUndo', () => history.undo()); time('historyRedo', () => history.redo())
} finally { history.free() }
const kernel = new VectorEngine()
try {
  time('workerLoadFont', () => kernel.load_font(font))
  time('workerLoadDocument', () => kernel.load_document(JSON.stringify(doc)))
  time('workerDamagePatch', () => kernel.apply_document_patch_with_damage(JSON.stringify(documentPatch(doc, moved))))
} finally { kernel.free() }
const fieldArgs: Parameters<typeof image_sampling_grid_placed> = [JSON.stringify({ x: 8192, y: 13312, w: 843, h: 1100 }),
  new Float64Array([15.278, 0, 0, 15.278, -6263.98, 5469.524]), new Float64Array([1922, 1080]), new Uint32Array([1922, 1080]),
  JSON.stringify({ kind: 'image', color: '#ffffff', fit: 'cover' }), 0, 0, new Int32Array([0, 0])]
const dense = time('denseImageCoordinates', () => image_sampling_grid_placed(...fieldArgs))
const axes = time('axesImageCoordinates', () => image_sampling_axes_placed(...fieldArgs))
console.log(JSON.stringify({ nodes: Object.keys(doc.nodes).length, scope: 'Bun CPU/WASM phases, not browser/GPU frame time', timings,
  coordinateBytes: { dense: dense.byteLength, axes: axes.byteLength } }, null, 2))
