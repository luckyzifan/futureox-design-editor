import type { Editor } from './engine'
import { node, type DesignDocument, type Matrix } from './model'
import { apply, bounds, boxPoints, multiply } from './geometry'
import { commitPendingEdits } from './pending-edits'
import { canvasActions, CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'

export const frameCategories = { phone: '手机', tablet: '平板', desktop: '桌面', watch: '手表', social: '社交媒体', plugin: '插件' } as const
export type FrameCategory = keyof typeof frameCategories
export type FramePreset = { id: string; category: FrameCategory; name: string; width: number; height: number }
// Reference design-canvas dimensions, not physical screen pixels or hardware emulation.
const groups: [FrameCategory, [string, number, number][]][] = [
  ['phone', [['iPhone 13 mini',375,812],['iPhone SE',320,568],['iPhone 13 Pro Max',428,926],['iPhone 13 / 13 Pro',390,844],['iPhone 11 Pro Max',414,896],['iPhone 11 Pro / X',375,812],['iPhone 8 Plus',414,736],['iPhone 8',375,667],['Android Small',360,640],['Android Large',360,800],['Google Pixel 2',411,731],['Google Pixel 2 XL',411,823]]],
  ['tablet', [['iPad mini 5',768,1024],['Surface Pro 4',1368,912]]],
  ['desktop', [['MacBook',1152,700],['MacBook Pro',1440,900],['Surface Book',1500,1000],['iMac',1280,720],['Macintosh 128k',512,342]]],
  ['watch', [['Apple Watch 42mm',156,195],['Apple Watch 38mm',136,170]]],
  ['social', [['Twitter header',1500,500],['Facebook post',1200,630],['Facebook cover',820,312],['Instagram post',1080,1350],['Instagram story',1080,1920],['Dribbble shot',400,300],['Dribbble shot HD',800,600],['LinkedIn cover',1584,396]]],
  ['plugin', [['Plugin icon',128,128],['Profile banner',1680,240],['Plugin / file cover',1920,1080]]],
]
export const framePresets: readonly FramePreset[] = groups.flatMap(([category, entries]) => entries.map(([name,width,height], index) => ({ id: `${category}-${index}`, category, name, width, height })))
export function filterFramePresets(query: string, category: FrameCategory | 'all') {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return framePresets.filter(p => (category === 'all' || p.category === category) && terms.every(term => `${p.name} ${p.width} ${p.height}`.toLocaleLowerCase().includes(term)))
}
export function validFrameSize(width: number, height: number) {
  return [width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 100000)
}
/** Iterative, bounded-by-node-count traversal: imported depth cannot exhaust the
 * JS call stack. Reject repeated/missing links instead of guessing placement for
 * cyclic or multiply-parented graphs. Hidden and locked nodes remain included. */
export function framePlacementRight(doc: DesignDocument, pageId: string): number {
  const owner = doc.pages.find(page => page.id === pageId)
  if (!owner) throw new Error('Invalid frame placement page')
  const stack: { id: string; matrix: Matrix }[] = owner.children.map(id => ({ id, matrix: [1,0,0,1,0,0] }))
  const visited = new Set<string>()
  let right = -Infinity
  while (stack.length) {
    const {id,matrix} = stack.pop()!
    if (visited.has(id) || !doc.nodes[id]) throw new Error('Invalid frame placement hierarchy')
    visited.add(id)
    const n = doc.nodes[id], world = multiply(matrix,n.transform)
    const b = bounds(boxPoints({x:0,y:0,width:n.width,height:n.height}).map(point => apply(world,point)))
    if (![b.x,b.y,b.width,b.height].every(Number.isFinite)) throw new Error('Invalid frame placement bounds')
    right = Math.max(right,b.x+b.width)
    for (const child of n.children) stack.push({id:child,matrix:world})
  }
  return right
}
export function createPresetFrame(editor: Editor, size: { name: string; width: number; height: number }) {
  const trace = canvasActions(editor), token = trace.begin(CanvasAction.create, ActionSource.menu, { commandCode: 204, targetCount: 1 })
  let outcome: typeof ActionOutcome[keyof typeof ActionOutcome] = ActionOutcome.rejected
  let reason: typeof ActionReason[keyof typeof ActionReason] = ActionReason.validation
  let widthComparison = 0, heightComparison = 0
  try {
    if (!validFrameSize(size.width,size.height)) return { ok: false, error: '宽高必须为 1–100000 的整数' }
    if (editor.state.busy || editor.interactionActive || !commitPendingEdits(editor)) {
      outcome = ActionOutcome.blocked; reason = ActionReason.busy
      return { ok: false, error: '请先结束当前输入或操作' }
    }
    const { doc, page, view } = editor.state, owner = doc.pages.find(p => p.id === page)
    if (!owner) return { ok: false, error: '当前页面不可用' }
    let right: number
    try { right = framePlacementRight(doc,page) }
    catch { return {ok:false,error:'页面层级无效，无法安全放置画板'} }
    const x = Math.max((80-view.x)/view.zoom, Number.isFinite(right) ? right+64 : -Infinity), y = (80-view.y)/view.zoom
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '当前画布位置不可用' }
    const frame = node('frame',x,y,size.width,size.height); frame.name = size.name || '自定义画板'
    const result = editor.change('创建设备画板', draft => {
      draft.nodes[frame.id] = frame
      draft.pages.find(p => p.id === page)!.children.push(frame.id)
    },[frame.id])
    if (result.status !== 'committed') return { ok:false,error:'画板未创建，请结束当前编辑后重试' }
    const actual = editor.state.doc.nodes[frame.id]
    widthComparison = actual.width === size.width ? 1 : 2; heightComparison = actual.height === size.height ? 1 : 2
    outcome = ActionOutcome.committed; reason = ActionReason.none
    editor.requestReveal([frame.id])
    return { ok:true,id:frame.id }
  } finally {
    trace.finish(token,outcome,reason,{expectedWidthComparison:widthComparison,expectedHeightComparison:heightComparison})
  }
}
