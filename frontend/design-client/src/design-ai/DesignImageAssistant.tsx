import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from '../engine'
import { captureImageImportAnchor } from '../append-image-files'
import { captureDesignAiOwner, importDesignAiLayers, selectedDesignAiImage } from './import-layers'
import type { DesignAiBridge, DesignAiModel, DesignAiResult } from './types'

export function designAiAnchor(editor: Editor) {
  const canvas = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect()
  return captureImageImportAnchor(editor, { width: canvas?.width ?? 0, height: canvas?.height ?? 0 })
}

export function DesignImageAssistant({ editor, bridge }: { editor: Editor; bridge?: DesignAiBridge }) {
  useSyncExternalStore(editor.subscribe, () => editor.state)
  const [configured, setConfigured] = useState(false), [key, setKey] = useState(''), [savingKey, setSavingKey] = useState(false)
  const [mode, setMode] = useState<'generate' | 'decompose' | 'edit'>('generate')
  const [model, setModel] = useState<DesignAiModel>('pro'), [size, setSize] = useState<'1K' | '1.5K' | '2K'>('2K')
  const [prompt, setPrompt] = useState(''), [split, setSplit] = useState(true)
  const [busy, setBusy] = useState(false), [stage, setStage] = useState(''), [error, setError] = useState('')
  const [result, setResult] = useState<DesignAiResult | null>(null), [inserted, setInserted] = useState(false)
  const generation = useRef(0), request = useRef<string | null>(null)
  const selected = selectedDesignAiImage(editor)
  useEffect(() => {
    let current = true
    void bridge?.status().then(status => {
      if (current && status.status === 'ok') setConfigured(status.configured)
    }).catch(() => { if (current) setError('无法读取图片服务状态。') })
    return () => { current = false; generation.current++; if (request.current) void bridge?.cancel({ requestId: request.current }).catch(() => {}) }
  }, [bridge])
  const configure = async () => {
    if (!bridge) return
    setSavingKey(true); setError('')
    try {
      const response = await bridge.configure({ apiKey: key.trim() })
      setKey('')
      if (response.status !== 'ok') throw new Error('message' in response ? response.message : '连接已取消。')
      setConfigured(response.configured)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败。') }
    finally { setSavingKey(false) }
  }
  const cancel = () => {
    generation.current++
    if (request.current) void bridge?.cancel({ requestId: request.current }).catch(() => {})
    request.current = null; setBusy(false); setStage('已取消。已生成的结果可手动添加；服务端可能仍在处理请求。')
  }
  const start = async (splitResult = false) => {
    if (!bridge || busy) return
    const token = ++generation.current
    const current = () => { if (generation.current !== token) throw new DOMException('Cancelled', 'AbortError') }
    const owner = captureDesignAiOwner(editor)
    let generated = false
    setBusy(true); setError(''); setInserted(false)
    const invoke = async (kind: 'generate' | 'decompose', text: string, image?: string) => {
      current()
      const id = crypto.randomUUID(); request.current = id
      const reply = await bridge.run({ requestId: id, mode: kind, prompt: text, model, size, image })
      current(); request.current = null
      if (reply.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError')
      if (reply.status !== 'ok') throw new Error(reply.message)
      return reply.result
    }
    try {
      owner()
      const anchor = designAiAnchor(editor)
      let output: DesignAiResult
      if (splitResult || mode === 'decompose') {
        const image = splitResult ? result?.layers[0]?.uri : selected
        if (!image) throw new Error('请先选中一个 PNG / JPEG 图片图层。')
        setStage('正在拆分图片…')
        output = await invoke('decompose', splitResult ? '' : prompt, image)
      } else {
        if (mode === 'edit' && !selected) throw new Error('请先选中一个 PNG / JPEG 图片图层。')
        setStage(mode === 'edit' ? '正在根据描述修改原图…' : '正在生成设计图片…')
        output = await invoke('generate', prompt, mode === 'edit' ? selected : undefined)
        generated = true; setResult(output)
        if (split) {
          setStage('图片已生成，正在拆成独立图层…')
          output = await invoke('decompose', '', output.layers[0].uri)
        }
      }
      current(); setResult(output); setStage('正在添加到画布…')
      const imported = await importDesignAiLayers(editor, output, anchor, () => { current(); owner() })
      current(); setInserted(true); setStage(`已添加 ${imported.count} 个独立图层。关闭面板即可继续编辑。`)
    } catch (failure) {
      if (generation.current !== token) return
      if (failure instanceof DOMException && failure.name === 'AbortError') setStage('任务已取消。')
      else {
        setError(failure instanceof Error ? failure.message : '图片任务失败。')
        setStage(generated ? '已保留生成的图片。可添加到画布，或重试分层。' : '')
      }
    } finally { if (generation.current === token) { request.current = null; setBusy(false) } }
  }
  const insert = async () => {
    if (!result || busy || inserted) return
    const token = ++generation.current
    setBusy(true); setError('')
    try {
      const owner = captureDesignAiOwner(editor)
      const imported = await importDesignAiLayers(editor, result, designAiAnchor(editor), () => {
        if (generation.current !== token) throw new DOMException('Cancelled', 'AbortError')
        owner()
      })
      setInserted(true); setStage(`已添加 ${imported.count} 个独立图层。`)
    } catch (failure) { if (generation.current === token) setError(failure instanceof Error ? failure.message : '添加失败。') }
    finally { if (generation.current === token) setBusy(false) }
  }
  return <div className="design-ai-image-panel">
    <p>先生成画面，再拆成独立图层。移动、缩放、透明度和图片效果均可继续编辑。</p>
    {!bridge && <p role="status">请使用桌面版连接图片服务。当前浏览器不会发送生成请求。</p>}
    {bridge && <details open={!configured}>
      <summary>{configured ? '图片服务已连接 · 更换密钥' : '连接火山方舟'}</summary>
      <div className="design-ai-key-row"><input type="password" aria-label="火山方舟 API Key" placeholder="API Key" value={key}
        autoComplete="off" onChange={event => setKey(event.target.value)} disabled={busy || savingKey}/>
        <button type="button" onClick={() => void configure()} disabled={!key.trim() || busy || savingKey}>连接</button></div>
      <small>密钥仅保留在本次桌面会话。提示词和选中的原图会发送给火山方舟。</small>
    </details>}
    <div className="design-ai-options">
      <label>操作<select value={mode} onChange={event => setMode(event.target.value as typeof mode)} disabled={busy}>
        <option value="generate">生成设计</option><option value="decompose">拆分选中原图</option><option value="edit">修改选中原图</option>
      </select></label>
      <label>模型<select value={model} onChange={event => setModel(event.target.value as DesignAiModel)} disabled={busy}>
        <option value="pro">Seedream 5.0 Pro</option><option value="flash">Seedream 5.0 Flash</option>
      </select></label>
      {mode !== 'decompose' && <label>分辨率<select value={size} onChange={event => setSize(event.target.value as typeof size)} disabled={busy}>
        <option>1K</option><option>1.5K</option><option>2K</option>
      </select></label>}
    </div>
    {mode !== 'generate' && <small>{selected ? '将使用选中图层的原始图片；新结果另建画板，保留原图。' : '先关闭面板，选中一个图片图层，再回来操作。'}</small>}
    <label>设计描述<textarea aria-label="设计描述" rows={4} maxLength={6000} value={prompt} disabled={busy}
      onChange={event => setPrompt(event.target.value)} placeholder={mode === 'decompose' ? '可留空自动分层，也可指定要拆出的主体、文字或装饰…' : '例如：为咖啡品牌设计一张秋日海报，暖棕配色，留出标题空间…'}/></label>
    {mode !== 'decompose' && <label className="design-ai-check"><input type="checkbox" checked={split} disabled={busy} onChange={event => setSplit(event.target.checked)}/>生成后自动分层（两次模型请求）</label>}
    <div className="design-ai-actions"><button type="button" className="primary" onClick={() => void start()}
      disabled={!bridge || !configured || busy || savingKey || (mode !== 'decompose' && !prompt.trim()) || (mode !== 'generate' && !selected)}>开始{mode === 'decompose' ? '分层' : '生成'}</button>
      {busy && <button type="button" onClick={cancel}>取消</button>}
      {result && !inserted && <button type="button" disabled={busy} onClick={() => void insert()}>添加到当前画布</button>}
      {result?.layers.length === 1 && <button type="button" disabled={busy || !configured} onClick={() => void start(true)}>拆分生成结果</button>}
    </div>
    {stage && <p role="status" aria-live="polite">{stage}</p>}{error && <p role="alert">{error}</p>}
    {result && <div className="design-ai-result">
      <div className="design-ai-image-preview" aria-label="生成结果预览" style={{ aspectRatio: `${result.width} / ${result.height}` }}>
        {[...result.layers].sort((a,b) => a.zIndex-b.zIndex).map(layer => <img key={layer.zIndex} src={layer.uri} alt={layer.name} style={{
          left: `${layer.x / result.width * 100}%`, top: `${layer.y / result.height * 100}%`, width: `${layer.width / result.width * 100}%`, height: `${layer.height / result.height * 100}%`,
        }}/>)}</div>
      <small>{result.layers.length} 个图片图层 · 分层文字仍是图片，可用文字工具重新排版。</small>
    </div>}
  </div>
}
