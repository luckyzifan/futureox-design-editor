import { defaultTextStyle, type DesignDocument, type DesignNode, type TextRun, type TextStyle } from './model'

/** Inspector formatting applies to the entire layer; range formatting stays in styleTextRange. */
export function applyWholeTextStyle(node: DesignNode, patch: Partial<TextStyle>) {
  if (node.kind !== 'text') return
  node.textStyle = { ...defaultTextStyle(), ...node.textStyle, ...patch }
  for (const run of node.textRuns || []) {
    if (patch.fontId !== undefined) delete run.fontId
    if (patch.weight !== undefined) delete run.weight
  }
}

export function setWholeTextFontSize(node: DesignNode, size: number) {
  if (node.kind !== 'text') return
  node.fontSize = size
  for (const run of node.textRuns || []) delete run.fontSize
}

/** Layer fill edits replace range colors while preserving every other run attribute. */
export function clearWholeTextRunColor(node: DesignNode) {
  if (node.kind !== 'text') return
  for (const run of node.textRuns || []) delete run.color
}

export function importFonts(target: DesignDocument, source: DesignDocument, nodes: DesignNode[]) {
  const ids = new Set(
    nodes
      .flatMap((n) => [
        n.textStyle?.fontId,
        ...(n.textStyle?.fallbacks || []),
        ...(n.textRuns || []).map((r) => r.fontId),
      ])
      .filter((id): id is string => !!id && id !== 'default'),
  )
  for (const id of ids) {
    const resource = source.fonts?.[id]
    if (!resource) throw new Error('剪贴板缺少字体资源')
    if (target.fonts?.[id] && target.fonts[id].data !== resource.data)
      throw new Error('字体标识冲突，原文件已保留')
    target.fonts = { ...target.fonts, [id]: resource }
  }
}
const boundaries = (text: string) =>
  new Set([
    text.length,
    ...Array.from(
      new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text),
      (g) => g.index,
    ),
  ])
export function styleTextRange(node:DesignNode,start:number,end:number,patch:Partial<Omit<TextRun,'start'|'end'>>) {
  const valid=boundaries(node.text)
  if(start>=end||!valid.has(start)||!valid.has(end))throw new Error('请选择完整字素范围')
  const cuts=new Set([start,end,...(node.textRuns||[]).flatMap(r=>[r.start,r.end])])
  const points=[...cuts].sort((a,b)=>a-b),runs:TextRun[]=[]
  for(let i=0;i+1<points.length;i++){
    const a=points[i],b=points[i+1],old=node.textRuns?.find(r=>r.start<=a&&b<=r.end)
    if(!old&&(a<start||b>end))continue
    const next={...old,...(a>=start&&b<=end?patch:{}),start:a,end:b}
    runs.push(next)
  }
  node.textRuns=runs
}
/** Preserve styles outside the edit; inserted text inherits the insertion style. */
export function replaceText(node: DesignNode, text: string) {
  const old = node.text,
    oldBoundaries = boundaries(old),
    nextBoundaries = boundaries(text)
  let start = 0
  while (start < old.length && start < text.length && old[start] === text[start]) start++
  while (start && (!oldBoundaries.has(start) || !nextBoundaries.has(start))) start--
  let end = old.length,
    nextEnd = text.length
  while (end > start && nextEnd > start && old[end - 1] === text[nextEnd - 1]) {
    end--
    nextEnd--
  }
  while (end < old.length && (!oldBoundaries.has(end) || !nextBoundaries.has(nextEnd))) {
    end++
    nextEnd++
  }
  const delta = nextEnd - end,
    runs: TextRun[] = []
  const inherited = node.textRuns?.find((run) => run.start <= start && start <= run.end)
  for (const run of node.textRuns || []) {
    if (run.start < start) runs.push({ ...run, end: Math.min(run.end, start) })
    if (run.end > end)
      runs.push({ ...run, start: Math.max(run.start, end) + delta, end: run.end + delta })
  }
  if (inherited && nextEnd > start) runs.push({ ...inherited, start, end: nextEnd })
  runs.sort((a, b) => a.start - b.start)
  node.text = text
  if (node.textRuns) node.textRuns = runs.filter((r) => r.start < r.end)
}
