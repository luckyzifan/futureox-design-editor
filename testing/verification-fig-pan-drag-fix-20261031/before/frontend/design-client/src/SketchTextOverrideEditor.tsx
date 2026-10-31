import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SketchEditSession } from './sketch-edit-session'
import type { SketchSessionBridge, SketchSessionStatus } from './desktop'
import { SketchTextQuery } from './sketch-text-query'
import { parseSketchTextOverrideDraft, type SketchTextOverrideDraft } from './sketch-text-override-draft'
export function SketchTextOverrideEditor({ bridge, session, controller, selected, blocked }: { bridge: SketchSessionBridge; session: SketchSessionStatus; controller: SketchEditSession; selected: string; blocked: boolean }) {
  const [query] = useState(() => new SketchTextQuery(bridge))
  const state = useSyncExternalStore(query.subscribe, query.getSnapshot)
  const [draft, setDraft] = useState<SketchTextOverrideDraft>({ targetPath: '', text: '', clearText: false })
  const [composing, setComposing] = useState(false)
  const key = JSON.stringify([session.owner, session.revision, selected])
  useEffect(() => { if (selected) void query.load(session.owner, session.revision, selected); return () => query.stop() }, [query, key])
  useEffect(() => { setDraft({ targetPath: state.path, text: state.value?.explicitText ?? '', clearText: false }) }, [state.path, state.value])
  const replacement = parseSketchTextOverrideDraft(selected, draft)
  const ready = !!state.value && state.value.targetPath === draft.targetPath
  if (!selected) return null
  return <fieldset disabled={blocked}>
    <legend>原生 Symbol 实例文本覆盖</legend>
    <p>仅替换实例的 stringValue，不编辑主组件或富文本样式。目标由独立 Sketch 内核枚举，不接受文件路径。</p>
    {state.targets === null ? <p role="status">{state.pending ? '正在查询本地原生文本目标…' : state.error}</p> : <>
      <label>原生文本目标<select value={state.path} onChange={event => { void query.selectPath(event.target.value) }}>
        <option value="">请选择目标</option>{state.targets.map(target => <option key={target.targetPath} value={target.targetPath}>{target.targetPath}</option>)}
      </select></label>
      {!state.targets.length && <p>当前本地主组件没有可枚举的文本目标。</p>}
      {state.pending && <p role="status">正在核对所选目标的原生记录…</p>}
      {state.error && <p role="alert">{state.error}</p>}
    </>}
    {state.value && <>
      <p>本实例显式覆盖：{state.value.explicitText === null ? '未设置' : state.value.explicitText === '' ? '空字符串' : state.value.explicitText}</p>
      <p>主组件源文本：{state.value.masterText === null ? '未提供' : state.value.masterText === '' ? '空字符串' : state.value.masterText}</p>
      <p>这两项不是最终渲染继承值；嵌套实例的覆盖优先级尚未计算。输入框只载入本实例显式覆盖，未设置时保持空白。</p>
    </>}
    <label>替换文本<textarea disabled={!ready || state.pending} value={draft.text} maxLength={100000}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onChange={event => setDraft(previous => ({ ...previous, text: event.target.value, clearText: false }))} /></label>
    <p>{draft.text.length} / 100000 UTF-16 单元（多数 emoji 计 2 单元）。原样保留空格与换行。</p>
    {draft.text === '' && <label><input type="checkbox" disabled={!ready} checked={draft.clearText} onChange={event => setDraft(previous => ({ ...previous, clearText: event.target.checked }))} />明确将目标文本覆盖为空字符串</label>}
    <button type="button" disabled={blocked || state.pending || !ready || composing || !replacement} onClick={() => { if (ready && replacement && !composing) void controller.setTextOverride(replacement.instanceId, replacement.targetPath, replacement.text) }}>
      {draft.text === '' ? '应用空文本覆盖' : '应用文本覆盖'}
    </button>
    <p>查询失败不截断结果。切换图层或 revision 清空输入；同一 revision 写入失败保留输入。成功可撤销/重做。当前预览尚不绘制文本或 Symbol。</p>
  </fieldset>
}
