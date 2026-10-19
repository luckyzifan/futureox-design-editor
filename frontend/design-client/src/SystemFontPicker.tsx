import { useEffect, useState } from 'react'
import { desktopBridge, type DesktopFontData } from './desktop'
import type { Editor } from './engine'
import type { DesignDocument } from './model'
import { ImportOwner, importStep } from './import-ownership'
import { applyWholeTextStyle } from './text'
import { applyMatchedFonts, matchFont, unmatchedSourceFonts, type FontResource } from './font-matching'
import { initializeKernelModule } from './kernel/module'
import { font_faces_json } from './generated/design-kernel/design_kernel'

type BrowserFont = { family: string; style: string; postscriptName: string; blob(): Promise<Blob> }
type SystemFont = { id: string; family: string; style: string; postscript: string; index: number; browserFont?: BrowserFont }
const queryFonts = () => (window as unknown as { queryLocalFonts?: () => Promise<BrowserFont[]> }).queryLocalFonts

export async function browserFontResource(font: BrowserFont): Promise<FontResource> {
  const blob = await font.blob()
  if (blob.size > 20 * 1024 * 1024) throw new Error('字体资源超过 20 MiB')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await initializeKernelModule()
  const faces = JSON.parse(font_faces_json(bytes)) as Array<{ postscript: string; index: number }>
  const found = faces.filter(f => f.postscript === font.postscriptName)
  if (found.length !== 1) throw new Error(`字体文件没有唯一匹配的字形：${font.postscriptName}`)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return { family: `${font.family} ${font.style}`.trim().slice(0, 200), postscript: font.postscriptName,
    data: btoa(binary), index: found[0].index }
}

async function resourceId(resource: FontResource) {
  const bytes = Uint8Array.from(atob(resource.data), c => c.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') + `-${resource.index || 0}`
}
/** read.index addresses the returned bytes; a collection's source index addresses different bytes. */
export function nativeFontResource(read: DesktopFontData): NonNullable<DesignDocument['fonts']>[string] {
  if (!Number.isSafeInteger(read.index) || read.index < 0 || (read.extracted && read.index !== 0))
    throw new Error('本机字体返回了无效的字形索引，请重新读取字体')
  return { family: `${read.font.family} ${read.font.style}`.trim().slice(0, 200), data: read.data, index: read.index,
    ...(read.font.postscript ? { postscript: read.font.postscript } : {}) }
}
export function SystemFontPicker({ editor, ids }: { editor: Editor; ids: string[] }) {
  const native = desktopBridge()?.fonts
  const [open, setOpen] = useState(false), [fonts, setFonts] = useState<SystemFont[]>([])
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [owner] = useState(() => new ImportOwner())
  useEffect(() => { owner.activate(); return () => owner.dispose() }, [owner])
  const available = !!native || typeof window !== 'undefined' && !!queryFonts()
  const list = async (): Promise<SystemFont[]> => {
    if (native) {
      const result = await native.list()
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '已取消' : result.message)
      return result.fonts
    }
    const query = queryFonts()
    if (!query) throw new Error('此浏览器不支持本机字体访问，请导入 TTF / OTF 字体')
    // Called directly from a user click; never query fonts at page startup.
    return (await query.call(window)).map(f => ({ id: f.postscriptName, family: f.family, style: f.style,
      postscript: f.postscriptName, index: 0, browserFont: f }))
  }
  const read = async (font: SystemFont) => {
    if (font.browserFont) return browserFontResource(font.browserFont)
    if (!native) throw new Error('本机字体访问已不可用')
    const result = await native.read({ id: font.id })
    if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '已取消' : result.message)
    if (result.data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) throw new Error('字体资源超过 20 MiB')
    return nativeFontResource(result)
  }
  const load = async () => {
    setOpen(true); setBusy(true); setMessage('正在读取本机字体…')
    const request = owner.begin(editor)
    try {
      const result = await importStep(request, list)
      setFonts(result)
      setMessage(`${result.length} 个字体`)
    } catch (e) { if (request.isCurrent()) setMessage(String(e)) }
    finally { if (request.isCurrent()) setBusy(false) }
  }
  const choose = async (font: SystemFont) => {
    const request = owner.begin(editor); setBusy(true)
    try {
      const resource = await importStep(request, () => read(font))
      const id = await importStep(request, () => resourceId(resource))
      request.assertCurrent()
      editor.change('使用本机字体', document => {
        // The host extracts TTC faces into standalone bytes. Use the read
        // response's index and identity, never the original collection index.
        document.fonts = { ...document.fonts, [id]: resource }
        for (const target of ids) if (document.nodes[target]?.kind === 'text')
          applyWholeTextStyle(document.nodes[target], { fontId: id })
      })
      setOpen(false)
    } catch (e) { if (request.isCurrent()) setMessage(String(e)) }
    finally { if (request.isCurrent()) setBusy(false) }
  }
  const matchDocument = async () => {
    const request = owner.begin(editor); setBusy(true); setMessage('正在匹配原字体…')
    try {
      const fonts = await importStep(request, list)
      const names = new Set(Object.values(editor.state.doc.nodes).flatMap(n => unmatchedSourceFonts(editor.state.doc, n)))
      const matched = new Map<string, { id: string; resource: FontResource }>(), missing: string[] = []
      for (const name of names) {
        const font = matchFont(name, fonts)
        if (!font) { missing.push(name); continue }
        const resource = await importStep(request, () => read(font))
        matched.set(name, { id: await importStep(request, () => resourceId(resource)), resource })
      }
      request.assertCurrent()
      if (matched.size) editor.change('匹配文档原字体', document => { applyMatchedFonts(document, matched) })
      setMessage(`已匹配 ${matched.size} 种原字体${missing.length ? `；未找到：${missing.join('、')}` : ''}`)
    } catch (e) { if (request.isCurrent()) setMessage(String(e)) }
    finally { if (request.isCurrent()) setBusy(false) }
  }
  if (!available) return null
  return <>
    <button disabled={busy} onClick={() => void load()}>选择本机字体</button>
    <button disabled={busy} onClick={() => void matchDocument()}>匹配文档原字体</button>
    {!open && message && <p role="status">{message}</p>}
    {open && <section className="system-font-picker" aria-label="本机字体选择">
      <div className="remote-actions"><input aria-label="搜索本机字体" placeholder="字体名称或样式" value={query} onChange={e => setQuery(e.target.value)} /><button onClick={() => { owner.invalidate(); setBusy(false); setOpen(false) }}>关闭</button></div>
      <p role="status">{message}</p>
      <div style={{maxHeight:240,overflowY:'auto'}}>{fonts.filter(f => `${f.family} ${f.style} ${f.postscript}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,100).map(f =>
        <button style={{display:'flex',width:'100%',justifyContent:'space-between'}} disabled={busy} key={f.id} onClick={() => void choose(f)}><span>{f.family}</span><small>{f.style}</small></button>)}</div>
    </section>}
  </>
}
