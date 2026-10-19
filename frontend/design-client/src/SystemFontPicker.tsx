import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { desktopBridge, type DesktopFontData } from './desktop'
import type { Editor } from './engine'
import type { DesignDocument } from './model'
import { ImportOwner, importStep } from './import-ownership'
import { applySelectionFont, FONT_PAGE_SIZE, searchFontChoices, matchSourceFontsInDocument, unmatchedEditableSourceFonts } from './font-management'
import { commitPendingEdits } from './pending-edits'
import { matchFont, type FontResource } from './font-matching'
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
export function SystemFontPicker({ editor, ids, detachSharedStyle = false }: { editor: Editor; ids: string[]; detachSharedStyle?: boolean }) {
  const native = desktopBridge()?.fonts
  const [open, setOpen] = useState(false), [fonts, setFonts] = useState<SystemFont[]>([])
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [pageIndex, setPageIndex] = useState(0)
  const matches = useMemo(() => searchFontChoices(fonts, query), [fonts, query])
  const page = Math.min(pageIndex, Math.max(0, Math.ceil(matches.length / FONT_PAGE_SIZE) - 1))
  const visible = matches.slice(page * FONT_PAGE_SIZE, (page + 1) * FONT_PAGE_SIZE)
  const [owner] = useState(() => new ImportOwner())
  useEffect(() => { owner.activate(); return () => owner.dispose() }, [owner])
  const targetsKey = ids.join('\0')
  const session = useSyncExternalStore(editor.subscribe, () => editor.sessionGeneration)
  useEffect(() => { owner.invalidate(); setBusy(false) }, [owner, editor, targetsKey, session])
  const available = !!native || typeof window !== 'undefined' && !!queryFonts()
  const list = async (): Promise<{ fonts: SystemFont[]; notice: string }> => {
    if (native) {
      const result = await native.list()
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '已取消' : result.message)
      const notice = `${result.truncated ? '已达到本机返回上限' : ''}${result.skippedCollections ? `；跳过 ${result.skippedCollections} 个不可读取的字体集合` : ''}`
      return { fonts: result.fonts, notice }
    }
    const query = queryFonts()
    if (!query) throw new Error('此浏览器不支持本机字体访问，请导入 TTF / OTF 字体')
    // Called directly from a user click; never query fonts at page startup.
    return { fonts: (await query.call(window)).map(f => ({ id: f.postscriptName, family: f.family, style: f.style,
      postscript: f.postscriptName, index: 0, browserFont: f })), notice: '' }
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
    if (!commitPendingEdits(editor)) return
    setOpen(true); setBusy(true); setMessage('正在读取本机字体…')
    const request = owner.begin(editor)
    try {
      const result = await importStep(request, list)
      setFonts(result.fonts); setPageIndex(0)
      setMessage(`${result.fonts.length} 个字体${result.notice ? `；${result.notice}` : ''}`)
    } catch (e) { if (request.isCurrent()) setMessage(String(e)) }
    finally { if (request.isCurrent()) setBusy(false); request.finish() }
  }
  const choose = async (font: SystemFont) => {
    if (!commitPendingEdits(editor)) return
    const request = owner.begin(editor); setBusy(true)
    try {
      const resource = await importStep(request, () => read(font))
      const id = await importStep(request, () => resourceId(resource))
      request.assertCurrent()
      const result = applySelectionFont(editor, ids, id, { detachSharedStyle }, resource)
      setMessage(result.message)
      if (result.status === 'committed' || result.status === 'unchanged') setOpen(false)
    } catch (e) { if (request.isCurrent()) setMessage(String(e)) }
    finally { if (request.isCurrent()) setBusy(false); request.finish() }
  }
  const matchDocument = async () => {
    if (!commitPendingEdits(editor)) return
    const request = owner.begin(editor); setBusy(true); setMessage('正在匹配原字体…')
    try {
      const { fonts } = await importStep(request, list)
      const names = unmatchedEditableSourceFonts(editor.state.doc)
      const matched = new Map<string, { id: string; resource: FontResource }>(), missing: string[] = []
      const loaded = new Map<string, { id: string; resource: FontResource }>(), faces = new Map<string, { id: string; resource: FontResource }>()
      for (const name of names) {
        const font = matchFont(name, fonts)
        if (!font) { missing.push(name); continue }
        let entry = faces.get(font.id)
        if (!entry) {
          const resource = await importStep(request, () => read(font))
          const id = await importStep(request, () => resourceId(resource))
          entry = loaded.get(id)
          if (!entry) {
            // Admission allows 32 resources. Retain at most that many plus
            // the single face currently being identified; aliases reuse bytes.
            if (loaded.size >= 32) throw Error('文档最多支持 32 个字体资源；请先缩小原字体匹配范围')
            entry = { id, resource }; loaded.set(id, entry)
          }
          faces.set(font.id, entry)
        }
        matched.set(name, entry)
      }
      request.assertCurrent()
      if (!commitPendingEdits(editor)) { setMessage(editor.state.message); return }
      let changed = 0, skipped = 0
      const result = matched.size ? editor.change('匹配文档原字体', document => { const edit = matchSourceFontsInDocument(document, matched); changed = edit.changed; skipped = edit.skippedLinked + edit.skippedLocked }) : undefined
      setMessage(result?.status === 'rejected' ? result.message : `已匹配 ${changed} 处原字体引用${skipped ? `；跳过 ${skipped} 个锁定或共享样式图层` : ''}${missing.length ? `；未找到：${missing.join('、')}` : ''}`)
    } catch (e) { if (request.isCurrent()) setMessage(String(e)) }
    finally { if (request.isCurrent()) setBusy(false); request.finish() }
  }
  if (!available) return null
  return <>
    <button disabled={busy} onClick={() => void load()}>选择本机字体</button>
    <button disabled={busy} onClick={() => void matchDocument()}>匹配文档原字体</button>
    {!open && message && <p role="status">{message}</p>}
    {open && <section className="system-font-picker" aria-label="本机字体选择">
      <div className="remote-actions"><input aria-label="搜索本机字体" placeholder="字体名称或样式" value={query} onChange={e => { setQuery(e.target.value); setPageIndex(0) }} /><button onClick={() => { owner.invalidate(); setBusy(false); setOpen(false) }}>关闭</button></div>
      <p role="status">{message}</p>
      <div style={{maxHeight:240,overflowY:'auto'}}>{visible.map(f =>
        <button style={{display:'flex',width:'100%',justifyContent:'space-between'}} disabled={busy || !ids.length} key={f.id} onClick={() => void choose(f)}><span>{f.family}</span><small>{f.style}</small></button>)}</div>
      <div className="selection-actions"><button type="button" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>上一页字体</button><span>{matches.length ? page * FONT_PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * FONT_PAGE_SIZE, matches.length)} / {matches.length}</span><button type="button" disabled={(page + 1) * FONT_PAGE_SIZE >= matches.length} onClick={() => setPageIndex(page + 1)}>下一页字体</button></div>
    </section>}
  </>
}
