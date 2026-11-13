import { ExportRegionPicker } from './ExportRegionPicker'
import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { desktopPet } from './desktop-pet'
import { validateSvgOptions, svgFileBytes } from './export-options'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useInterfacePreferences } from './interface-preference'
import type { Editor } from './engine'
import { pdfVectorIssues, sliceExportTarget, type ExportTarget } from './export-metadata'
import { scene, unionBounds } from './geometry'
import { fitBounds } from './canvas-camera'
import { commitExportEdits } from './export-ownership'
import { desktopBridge } from './desktop'
import { KernelClient } from './kernel/client'
import {
  encodeDesktopFrames,
  motionFileName,
  motionPreviewTimes,
  MOTION_PREVIEW_FPS,
  MOTION_PREVIEW_HEIGHT,
  MOTION_PREVIEW_WIDTH,
  useVideoEncodeAvailable,
} from './motion-video'

const AllAssetsExport = lazy(() => import('./AllAssetsExport').then(module => ({ default: module.AllAssetsExport })))
type Asset = { name: string; url: string; width: number; height: number; scale: number; pdf: boolean; pdfVector: boolean }

export function ExportPanel({ editor, onClose, exportSelectedSketch, initialTarget }: { editor: Editor; onClose: () => void; exportSelectedSketch?:()=>Promise<string|undefined>; initialTarget?: 'assets' }) {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const { locale } = useInterfacePreferences()
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh
  const [kind, setKind] = useState<ExportTarget['kind'] | 'assets'>(initialTarget === 'assets' ? 'assets' : s.selection.length ? 'selection' : 'page')
  const [pickCanvas,setPickCanvas]=useState<HTMLElement|null>(null)
  const picking=useRef(false)
  const stopPicking=useCallback(()=>{picking.current=false;setPickCanvas(null)},[])
  const [padding, setPadding] = useState('40')
  const [region, setRegion] = useState(() => {
    const entries = scene(s.doc, s.page).filter((entry) => s.selection.includes(entry.id))
    const b = entries.length
      ? unionBounds(entries.map((entry) => entry.bounds))
      : { x: 0, y: 0, width: 24, height: 24 }
    return { x: String(b.x), y: String(b.y), width: String(b.width), height: String(b.height) }
  })
  const [format, setFormat] = useState<'png'|'jpeg'|'webp'|'tiff'|'pdf'|'pdf-vector'|'svg'|'sketch'>('png')
  const [gamut, setGamut] = useState<'srgb' | 'display-p3'>('srgb')
  const [svgScale, setSvgScale] = useState('1')
  const [embedFonts, setEmbedFonts] = useState(false)
  const [textMode, setTextMode] = useState<'outlines' | 'editable'>('outlines')
  const [precision, setPrecision] = useState('')
  const [compression, setCompression] = useState<'none' | 'gzip'>('none')
  const [scales, setScales] = useState(() => {
    if(!exportSelectedSketch || !s.selection.length)return [1,2,3]
    const w=Number(region.width),h=Number(region.height)
    let scale=1
    while(scale>0.001 && (w*scale>8192 || h*scale>8192 || w*h*scale*scale>16_000_000))scale/=2
    return [scale]
  })
  const [customScale, setCustomScale] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const request = useRef<AbortController | null>(null)
  const urls = useRef<string[]>([])
  const dialog = useRef<HTMLElement>(null)
  const videoReady = useVideoEncodeAvailable()
  const pageClip = s.doc.animations?.find(clip => clip.pageId === s.page)
  const close = useRef(onClose)
  close.current = onClose
  const release = useCallback(() => {
    for (const url of urls.current) URL.revokeObjectURL(url)
    urls.current = []
  }, [])
  // The vector option is gated on what the true-vector writer can preserve
  // for the currently chosen target; blocked targets fall back to bitmap PDF.
  const vectorIssues = useMemo(() => {
    try {
      if (kind === 'assets') return []
      const target: ExportTarget =
        kind === 'page'
          ? { kind }
          : kind === 'selection'
            ? { kind, nodeIds: s.selection }
            : {
                kind,
                bounds: {
                  x: Number(region.x),
                  y: Number(region.y),
                  width: Number(region.width),
                  height: Number(region.height),
                },
              }
      return pdfVectorIssues(s.doc, s.page, target)
    } catch {
      return []
    }
  }, [s.doc, s.page, kind, s.selection, region])
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if(picking.current)return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
      }
      if (event.key === 'Tab') {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]',
          ) || []),
        ]
        const first = controls[0],
          last = controls.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialog.current)
        ) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      request.current?.abort()
      request.current = null
      release()
      window.removeEventListener('keydown', keydown, true)
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [release])
  async function generate() {
    const trace = beginEditorAction(editor, CanvasAction.export, ActionSource.menu, 350 + ['png','jpeg','webp','pdf','pdf-vector','svg','tiff'].indexOf(format))
    try {
    if (kind === 'assets') { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
    if (request.current) { trace.result(ActionOutcome.blocked, ActionReason.busy); return }
    if (!commitExportEdits(editor)) { trace.result(ActionOutcome.blocked, ActionReason.validation); return }
    const committed = editor.state
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setStatus(tx(`正在生成 ${format.toUpperCase()}…`, `Generating ${format.toUpperCase()}…`))
    release()
    setAssets([])
    try {
      if(format==='sketch'){
        const selection=[...committed.selection]
        if(!selection.length)throw Error(tx('请选择图层或画板','Select a layer or frame'))
        let name:string|undefined
        if(exportSelectedSketch){
          name=await exportSelectedSketch()
        }else{
          const [{selectedDocument},{exportSketchInWorker},{download},{filename}]=await Promise.all([
            import('./clipboard-core'),import('./import-file-worker'),import('./persistence'),import('./export')
          ])
          const label=selection.length===1?committed.doc.nodes[selection[0]].name:tx('选区','Selection')
          const {document}=selectedDocument(committed.doc,selection,label)
          const bytes=await exportSketchInWorker(document,controller.signal)
          if(controller.signal.aborted||request.current!==controller)return
          name=filename(label)+'.sketch'
          download(name,new Blob([new Uint8Array(bytes).buffer],{type:'application/zip'}))
        }
        if(controller.signal.aborted||request.current!==controller)return
        setStatus(name?tx(`已导出 ${name}`,`Exported ${name}`):tx('已取消导出','Export cancelled'))
        trace.result(name?ActionOutcome.observed:ActionOutcome.cancelled)
        return
      }
      const document = structuredClone(committed.doc)
      const page = committed.page
      const selection = [...committed.selection]
      const target: ExportTarget =
        kind === 'page'
          ? { kind, padding: Number(padding) }
          : kind === 'selection'
            ? (selection.length===1 && document.nodes[selection[0]]?.kind==='slice' ? sliceExportTarget(document,selection[0]) : {kind, nodeIds:selection})
            : {
                kind,
                bounds: {
                  x: Number(region.x),
                  y: Number(region.y),
                  width: Number(region.width),
                  height: Number(region.height),
                },
              }
      if (kind === 'slice' && Object.values(region).some((value) => !value.trim()))
        throw new Error(tx('请填写完整的切片坐标和尺寸', 'Enter the full slice position and size.'))
      if (kind === 'page' && !padding.trim()) throw new Error(tx('请填写页面留白', 'Enter the page padding.'))
      if (format === 'svg') {
        if (!svgScale.trim()) throw new Error(tx('请填写 SVG 视口倍率', 'Enter the SVG viewport scale.'))
        const options = validateSvgOptions({ scale: Number(svgScale), precision: precision === '' ? undefined : Number(precision), compression, textMode, fontMode: textMode === 'editable' && embedFonts ? 'embed' : 'references', ...(embedFonts && textMode === 'editable' ? {fontEmbeddingAllowed: true} : {}) })
        const { svgSource, filename } = await import('./export')
        if (options.fontMode === 'embed') {
          const { createSvgArtifact } = await import('./svg-artifact')
          const artifact = await createSvgArtifact(document, page, target, options, controller.signal)
          if (controller.signal.aborted || request.current !== controller) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
          const url=URL.createObjectURL(artifact.blob); urls.current.push(url)
          trace.result(ActionOutcome.observed)
        desktopPet.event('export')
          setAssets([{name:`${filename(document.name)}.${options.compression === 'gzip' ? 'svgz' : 'svg'}`,url,width:artifact.bounds.width*options.scale,height:artifact.bounds.height*options.scale,scale:options.scale,pdf:false,pdfVector:false}])
          setStatus(tx('已生成含完整字体的 SVG；宿主可能忽略字体，外部显示仍可能不同。大型文件通过受限 SVG 字体文件通道导入。', 'Generated an SVG with the full fonts. The host may ignore them, and external display can still differ. Large files import through the restricted SVG font channel.'))
          return
        }
        const result = svgSource(document, page, target, options.scale, options.precision, options.textMode, options.fontMode, options.fontEmbeddingAllowed)
        if (result.issues.length) throw new Error(`SVG 无法保留这些效果：${result.issues.join('、')}；请选择原生文件或位图导出`)
        const bytes = svgFileBytes(result.source, options.compression)
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'image/svg+xml' }))
        urls.current.push(url)
        trace.result(ActionOutcome.observed)
        desktopPet.event('export')
        setAssets([{ name: `${filename(document.name)}.${options.compression === 'gzip' ? 'svgz' : 'svg'}`, url, width: result.box.width * options.scale, height: result.box.height * options.scale, scale: options.scale, pdf: false, pdfVector: false }])
        setStatus(tx(`已生成 SVG${options.compression === 'gzip' ? 'Z（无损 gzip 压缩）' : ''}${options.precision === undefined ? '' : '；坐标已按所选精度进行有损舍入'}`, `Generated SVG${options.compression === 'gzip' ? 'Z (lossless gzip)' : ''}${options.precision === undefined ? '' : '; coordinates were lossily rounded to the selected precision'}`))
        return
      }
      if (format === 'pdf-vector') {
        // Vector PDF is resolution-independent; one file covers every scale.
        const { exportPdfVector } = await import('./export')
        const asset = await exportPdfVector(document, page, target, controller.signal)
        if (controller.signal.aborted || request.current !== controller) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
        const url = URL.createObjectURL(asset.blob)
        urls.current.push(url)
        trace.result(ActionOutcome.observed)
        desktopPet.event('export')
        setAssets([
          {
            name: asset.name,
            url,
            width: asset.width,
            height: asset.height,
            scale: asset.scale,
            pdf: true,
            pdfVector: !asset.fallback,
          },
        ])
        setStatus(
          asset.fallback
            ? tx('内容包含矢量 PDF 暂不支持的效果，已生成位图 PDF', 'The content has effects vector PDF cannot keep yet, so a bitmap PDF was generated.')
            : tx('已生成 1 个矢量 PDF 文件', 'Generated 1 vector PDF file.'),
        )
        return
      }
      const { exportRasterBatch } = await import('./export')
      const colorOutput = gamut === 'display-p3' ? { space: 'display-p3' as const, toneMap: 'clip' as const } : undefined
      const results = await exportRasterBatch(
        document,
        page,
        [...scales].sort((a, b) => a - b),
        target,
        colorOutput,
        controller.signal,
        format,
      )
      if (controller.signal.aborted || request.current !== controller) { trace.result(ActionOutcome.cancelled, ActionReason.superseded); return }
      const next = results.map((asset) => {
        const url = URL.createObjectURL(asset.blob)
        urls.current.push(url)
        return {
          name: asset.name,
          url,
          width: asset.width,
          height: asset.height,
          scale: asset.scale,
          pdf: format === 'pdf',
          pdfVector: false,
        }
      })
      trace.result(ActionOutcome.observed)
        desktopPet.event('export')
      setAssets(next)
      setStatus(tx(`已生成 ${next.length} 个 ${format.toUpperCase()} 文件`, `Generated ${next.length} ${format.toUpperCase()} file${next.length === 1 ? '' : 's'}.`))
    } catch (error) {
      trace.result(controller.signal.aborted || request.current !== controller ? ActionOutcome.cancelled : ActionOutcome.rejected, controller.signal.aborted || request.current !== controller ? ActionReason.superseded : ActionReason.validation)
      if (!controller.signal.aborted && request.current === controller) {
        desktopPet.event('error')
        release()
        setStatus(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
    } finally { trace.finish() }
  }
  async function exportPageMotion(format: 'mp4' | 'webm') {
    const bridge = desktopBridge()?.videoEncode
    const clip = editor.state.doc.animations?.find(item => item.pageId === editor.state.page)
    if (!bridge || !clip) {
      setStatus(tx('当前页没有可编码的动画，或桌面未安装 FFmpeg。', 'This page has no animation to encode, or the desktop FFmpeg is not installed.'))
      return
    }
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setStatus(tx('正在烘焙动画帧，并由 Rust 调用打包的 FFmpeg 编码…', 'Baking frames. Rust will encode them with the bundled FFmpeg…'))
    release()
    setAssets([])
    const client = new KernelClient()
    try {
      const doc = editor.state.doc
      const bounds = unionBounds(scene(doc, clip.pageId).map(entry => entry.bounds))
      const size = { width: MOTION_PREVIEW_WIDTH, height: MOTION_PREVIEW_HEIGHT }
      const view = fitBounds(bounds, size, { padding: 24, maxZoom: 2 })
      const times = motionPreviewTimes(clip.delayMs + clip.durationMs)
      const frames: Uint8Array[] = []
      for (const timeMs of times) {
        if (controller.signal.aborted || request.current !== controller) return
        const frame = await client.render(doc, {
          ...size,
          pageId: clip.pageId,
          view,
          grid: false,
          transparent: false,
          rasterProfile: doc.rasterProfile || 'analytic',
          animation: { clipId: clip.id, timeMs },
        }, true)
        frames.push(frame.bytes)
      }
      if (controller.signal.aborted || request.current !== controller) return
      const encoded = await encodeDesktopFrames(bridge, { format, fps: MOTION_PREVIEW_FPS, frames })
      if (controller.signal.aborted || request.current !== controller) return
      const url = URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mime }))
      urls.current.push(url)
      setAssets([{
        name: motionFileName(clip.name, format),
        url,
        width: size.width,
        height: size.height,
        scale: 1,
        pdf: false,
        pdfVector: false,
      }])
      setStatus(tx(`已生成 ${format.toUpperCase()} 动效预览。`, `Generated a ${format.toUpperCase()} motion preview.`))
    } catch (error) {
      if (!controller.signal.aborted && request.current === controller) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    } finally {
      client.dispose()
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }
  if(pickCanvas)return <ExportRegionPicker editor={editor} canvas={pickCanvas} english={locale==='en'} onCancel={stopPicking} onPick={box=>{
    setRegion({x:String(box.x),y:String(box.y),width:String(box.width),height:String(box.height)})
    setKind('slice');stopPicking();release();setAssets([]);setStatus('')
  }}/>
  return (
    <div className="feature-backdrop">
      <section
        className="design-tools export-panel"
        role="dialog"
        aria-modal="true"
        aria-label={tx('导出图像', 'Export')}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{tx('导出图像', 'Export')}</strong>
          <button type="button" onClick={onClose} aria-label={tx('关闭切图', 'Close export')}>
            {tx('关闭', 'Close')}
          </button>
        </header>
        {kind !== 'assets' && format!=='sketch' && <p className="export-color-note">{tx(
          '默认是 sRGB：8 位 PNG 写入 sRGB 色彩块和 sRGB ICC。选择 Display P3 时，同一套 sRGB 像素会换算成 Display P3 并写入 ICC 与 cICP；JPEG、WebP、TIFF 和位图 PDF 带上同一份描述文件。这不改画布合成，也不是默认 PNG。其他色彩空间仍用 PNG。SVG 的 gzip 导出是 .svgz。桌面版在安装了打包的 FFmpeg 时，可以把当前页的动画烘焙成帧，再由 Rust 调用该二进制编成 MP4 或 WebM，不走系统 PATH。没有这个二进制时（含网页版）仍只导出静帧。',
          'The default is sRGB: 8-bit PNG writes an sRGB chunk and an sRGB ICC profile. Display P3 converts those sRGB samples and writes an ICC profile plus cICP. JPEG, WebP, TIFF and bitmap PDF carry the same profile. This does not change canvas compositing, and it is not the default PNG. Other color spaces still use PNG. Gzip SVG export is .svgz. On the desktop, when the bundled FFmpeg is installed, the current page animation can be baked to frames and encoded to MP4 or WebM by Rust invoking that binary, not a PATH lookup. Without that binary, including on the web, export stays a still image.',
        )}</p>}
        {kind !== 'assets' && (format === 'png' || format === 'jpeg' || format === 'webp' || format === 'tiff' || format === 'pdf') && <label>{tx('色彩空间', 'Color space')} <select aria-label={tx('导出色彩空间', 'Export color space')} value={gamut} disabled={busy} onChange={event => setGamut(event.target.value as 'srgb' | 'display-p3')}>
          <option value="srgb">sRGB</option>
          <option value="display-p3">Display P3</option>
        </select></label>}
        {kind !== 'assets' && <label>{tx('格式', 'Format')} <select aria-label={tx('导出图像格式', 'Export image format')} value={format} disabled={busy} onChange={e=>{const next=e.target.value as typeof format;setFormat(next);if(next==='sketch')setKind('selection');setStatus('');release();setAssets([])}}>
          <option value="sketch" disabled={!s.selection.length}>{tx('Sketch（可编辑）','Sketch (editable)')}</option><option value="svg">{tx('SVG / SVGZ（矢量）', 'SVG / SVGZ (vector)')}</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">{tx('WebP（无损）', 'WebP (lossless)')}</option><option value="tiff">TIFF</option><option value="pdf">{tx('PDF（精确位图）', 'PDF (exact bitmap)')}</option><option value="pdf-vector" disabled={vectorIssues.length>0}>{tx('PDF（矢量）', 'PDF (vector)')}</option>
        </select></label>}
        {kind !== 'assets' && format === 'svg' && <fieldset disabled={busy}>
          <legend>{tx('SVG 矢量选项', 'SVG vector options')}</legend>
          <label>{tx('视口倍率', 'Viewport scale')} <input aria-label={tx('SVG 视口倍率', 'SVG viewport scale')} type="number" min="0.001" max="128" step="any" value={svgScale} onChange={e => setSvgScale(e.target.value)} /></label>
          <label>{tx('文字模式', 'Text mode')} <select aria-label={tx('SVG 文字模式', 'SVG text mode')} value={textMode} onChange={e => setTextMode(e.target.value as typeof textMode)}><option value="outlines">{tx('轮廓（保持外观）', 'Outlines (keep appearance)')}</option><option value="editable">{tx('可编辑文字（需要对应字体）', 'Editable text (needs the font)')}</option></select></label>
          {textMode === 'editable' && <label><input type="checkbox" checked={embedFonts} onChange={e => setEmbedFonts(e.target.checked)} />{tx('嵌入本地字体（我确认拥有可编辑再分发授权；TTF/OTF 含内置字体总计不超过 24 MiB；宿主可能忽略嵌入字体）', 'Embed local fonts (I confirm an editable redistribution license; TTF/OTF plus built-in fonts stay within 24 MiB; the host may ignore embedded fonts)')}</label>}
          {textMode === 'editable' && !embedFonts && <p>{tx('字体不会嵌入；缺失字体、回退和浏览器排版可能改变外观。高级文字样式需使用轮廓模式。', 'Fonts are not embedded. Missing fonts, fallback and browser layout can change the appearance. Advanced text styles need outline mode.')}</p>}
          <label>{tx('坐标精度', 'Coordinate precision')} <select aria-label={tx('SVG 坐标精度', 'SVG coordinate precision')} value={precision} onChange={e => setPrecision(e.target.value)}><option value="">{tx('保留原始精度', 'Keep original precision')}</option>{[0,1,2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{tx(`${n} 位小数（有损）`, `${n} decimal places (lossy)`)}</option>)}</select></label>
          <label>{tx('压缩', 'Compression')} <select aria-label={tx('SVG 压缩', 'SVG compression')} value={compression} onChange={e => setCompression(e.target.value as typeof compression)}><option value="none">{tx('无（.svg）', 'None (.svg)')}</option><option value="gzip">{tx('无损 gzip（.svgz）', 'Lossless gzip (.svgz)')}</option></select></label>
          <p>{tx('倍率仅改变矢量视口尺寸，不是像素分辨率。精度舍入会改变几何形状；无损 gzip 不改变解压后的 SVG。FD 和 Sketch 原生文件不使用这些矢量选项。', 'Scale changes the vector viewport, not pixel resolution. Precision rounding changes geometry; lossless gzip does not change the decompressed SVG. FD and Sketch files do not use these vector options.')}</p>
        </fieldset>}
        {kind !== 'assets' && format==='jpeg'&&<p>{tx(`JPEG 为有损格式，使用质量 100，透明区域填充为白色，并写入 ${gamut === 'display-p3' ? 'Display P3' : 'sRGB'} ICC 描述文件。`, `JPEG is lossy, uses quality 100, fills transparent areas with white, and embeds a ${gamut === 'display-p3' ? 'Display P3' : 'sRGB'} ICC profile.`)}</p>}
        {kind !== 'assets' && format==='tiff'&&<p>{tx(`TIFF 导出未压缩的 8 位图像，保留透明度以及 ${gamut === 'display-p3' ? 'Display P3' : 'sRGB'} 配置。16 位样本会量化为 8 位；文档里的 HDR 数值保持不变。`, `TIFF exports an uncompressed 8-bit image with transparency and a ${gamut === 'display-p3' ? 'Display P3' : 'sRGB'} profile. 16-bit samples are quantized to 8-bit; authored HDR values stay in the document.`)}</p>}
        {kind !== 'assets' && format==='pdf'&&<p>{tx(`PDF 保留当前导出倍率的像素与透明度，页面按设计尺寸保存，并用 ${gamut === 'display-p3' ? 'Display P3' : 'sRGB'} ICCBased 标记颜色。使用 futureox-desgin 文件继续编辑图层。`, `PDF keeps the pixels and transparency of the chosen scale, stores the page at the design size, and tags colors with a ${gamut === 'display-p3' ? 'Display P3' : 'sRGB'} ICCBased space. Keep the futureox-desgin file to edit layers.`)}</p>}
        {kind !== 'assets' && format==='pdf-vector'&&<p>{tx('矢量 PDF 把路径、渐变与文字轮廓写为原生 PDF 对象，按设计尺寸保存（1 设计单位 = 1 pt）。', 'Vector PDF writes paths, gradients and text outlines as native PDF objects at the design size (1 design unit = 1 pt).')}</p>}
        {kind !== 'assets' && format==='png'&&<p>{tx(gamut === 'display-p3' ? 'PNG 使用 CPU 导出。未启用色彩管理时，8 位样本从 sRGB 换算到 Display P3，并写入 ICC 与 cICP，不写 sRGB 色彩块。已启用色彩管理的文档仍走 16 位色彩输出。' : 'PNG 使用 CPU 导出。8 位 sRGB 写入 sRGB 色彩块和 sRGB ICC。已启用色彩管理时，显式色彩输出再写入 16 位 ICC 与 cICP。画布上的 HDR / 广色域数值仍留在文档里。', gamut === 'display-p3' ? 'PNG is exported on the CPU. Without color management, 8-bit samples are converted from sRGB to Display P3 and tagged with ICC and cICP, and no sRGB chunk is written. A color-managed document still uses the 16-bit color output.' : 'PNG is exported on the CPU. 8-bit sRGB writes an sRGB chunk and an sRGB ICC profile. A color-managed document still writes 16-bit ICC and cICP when a color output is explicit. HDR and wide-gamut values stay in the document.')}</p>}
        {kind !== 'assets' && vectorIssues.length>0&&<p role="note">{tx(`当前导出内容包含${vectorIssues.join('、')}，矢量 PDF 暂不支持，该项已禁用；可导出 PDF（精确位图）。`, `This export includes ${vectorIssues.join(', ')}. Vector PDF cannot keep that yet, so the option is disabled. Exact bitmap PDF is available.`)}</p>}
        <fieldset disabled={busy}>
          <legend>{tx('导出目标', 'Export target')}</legend>
          <label>
            <input
              type="radio"
              name="export-target"
              disabled={format==='sketch'} checked={kind === 'page'}
              onChange={() => setKind('page')}
            />
            {tx('整页', 'Page')}
          </label>
          <label>
            <input
              type="radio"
              name="export-target"
              checked={kind === 'selection'}
              disabled={!s.selection.length}
              onChange={() => setKind('selection')}
            />
            {tx('选中图层 / Frame', 'Selection')}
          </label>
          <label>
            <input
              type="radio"
              name="export-target"
              disabled={format==='sketch'} checked={kind === 'slice'}
              onChange={() => setKind('slice')}
            />
            {tx('自定义区域', 'Custom region')}
          </label>
          <label>
            <input
              type="radio"
              name="export-target"
              disabled={format==='sketch'}
              checked={kind === 'assets'}
              onChange={() => { setKind('assets'); release(); setAssets([]); setStatus('') }}
            />
            {tx('全部图层预设', 'All layer presets')}
          </label>
          {kind === 'page' && (
            <label>
              {tx('页面留白', 'Page padding')}
              <input
                aria-label={tx('页面留白', 'Page padding')}
                type="number"
                min="0"
                value={padding}
                onChange={(event) => setPadding(event.target.value)}
              />
            </label>
          )}
          {kind==='slice' && <button type="button" disabled={busy} onClick={()=>{
            const canvas=document.querySelector<HTMLElement>('[data-testid="canvas"]')
            if(canvas){picking.current=true;setPickCanvas(canvas)}
          }}>{tx('在画布上框选…','Draw on canvas…')}</button>}
          {kind === 'slice' && (
            <div className="feature-row">
              {(['x', 'y', 'width', 'height'] as const).map((key) => (
                <label key={key}>
                  {{ x: 'X', y: 'Y', width: tx('宽', 'W'), height: tx('高', 'H') }[key]}
                  <input
                    aria-label={tx(`切片 ${key}`, `Slice ${key}`)}
                    type="number"
                    step="any"
                    value={region[key]}
                    onChange={(event) => setRegion({ ...region, [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
          )}
          <p>
            {kind === 'assets'
              ? tx('按各层已有预设勾选并分别导出。上面的整页、合并选区和自定义区域保持不变。', 'Check each layer’s presets and export them separately. Page, merged selection, and custom region above stay as they are.')
              : kind === 'selection'
              ? tx('按选中图层的几何边界裁切，保留内部效果与蒙版；不包含其他图层或祖先效果。合并为一个文件。', 'Crops to the selection bounds and keeps effects and masks inside it. Other layers and ancestor effects are excluded. The selection is one file.')
              : kind === 'slice'
                ? tx('按页面坐标裁切，保留该区域的整页合成效果。', 'Crops in page coordinates and keeps the composited page in that region.')
                : tx('包含可见内容和效果，页面留白可设为 0。', 'Includes visible content and effects. Page padding can be 0.')}
          </p>
        </fieldset>
        {kind === 'assets' && <Suspense fallback={<p role="status">{tx('正在打开全部资产…', 'Opening all assets…')}</p>}><AllAssetsExport editor={editor} /></Suspense>}
        {kind !== 'assets' && format!=='sketch' && <fieldset disabled={busy || format === 'pdf-vector' || format === 'svg'}>
          <legend>{tx('倍率', 'Scale')}</legend>
          {[...new Set([1, 2, 3, ...scales])].sort((a, b) => a - b).map((scale) => (
            <label key={scale}>
              <input
                type="checkbox"
                checked={scales.includes(scale)}
                onChange={(event) =>
                  setScales(
                    event.target.checked
                      ? [...scales, scale]
                      : scales.filter((value) => value !== scale),
                  )
                }
              />
              {scale}x
            </label>
          ))}
          <label>{tx('自定义倍率', 'Custom scale')} <input aria-label={tx('自定义导出倍率', 'Custom export scale')} type="number" min="0.001" max="128" step="any" value={customScale} onChange={e => setCustomScale(e.target.value)} /></label>
          <button type="button" onClick={() => {
            const value = Number(customScale)
            if (!customScale.trim() || !Number.isFinite(value) || value < .001 || value > 128) { setStatus(tx('自定义倍率必须在 0.001–128 之间', 'Custom scale must be from 0.001 to 128.')); return }
            if (!scales.includes(value) && scales.length >= 16) { setStatus(tx('最多选择 16 个导出倍率', 'Choose at most 16 export scales.')); return }
            setScales([...new Set([...scales, value])]); setCustomScale(''); setStatus('')
          }}>{tx('添加倍率', 'Add scale')}</button>
        </fieldset>}
        {kind !== 'assets' && <p>
          {format === 'svg' ? tx('SVG 是分辨率无关的矢量输出；SVGZ 可下载后使用支持 gzip 的查看器打开。', 'SVG is resolution-independent. SVGZ opens in a viewer that supports gzip.') : format === 'pdf-vector'
            ? tx('矢量输出与倍率无关，文件按设计尺寸保存。', 'Vector output ignores scale and is stored at the design size.')
            : tx('像素尺寸向上取整，不拉伸内容；不受画布缩放或设备 DPR 影响。小数尾像素覆盖范围会向右、向下扩展。', 'Pixel size rounds up without stretching. Canvas zoom and device DPR do not apply. A fractional edge extends right and down.')}
        </p>}
        {kind !== 'assets' && videoReady && pageClip && <fieldset disabled={busy}>
          <legend>{tx('动效预览', 'Motion preview')}</legend>
          <p>{tx(`把「${pageClip.name}」按 12 帧/秒烘焙一圈（最长 8 秒），再交给打包的 FFmpeg。重复播放只导出一轮。`, `Bakes one cycle of “${pageClip.name}” at 12 fps (8 seconds at most), then the bundled FFmpeg encodes it. Repeats export a single cycle.`)}</p>
          <button type="button" onClick={() => void exportPageMotion('mp4')}>MP4</button>
          <button type="button" onClick={() => void exportPageMotion('webm')}>WebM</button>
        </fieldset>}
        {kind !== 'assets' && <div className="feature-row">
          <button type="button" disabled={busy || (format==='sketch' ? !s.selection.length : format !== 'pdf-vector' && format !== 'svg' && !scales.length)} onClick={() => void generate()}>
            {format==='sketch'?tx('导出选区为 Sketch…','Export selection as Sketch…'):tx(`生成 ${format === 'pdf-vector' ? 'PDF（矢量）' : format.toUpperCase()}`, `Export ${format === 'pdf-vector' ? 'vector PDF' : format.toUpperCase()}`)}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                request.current?.abort()
                request.current = null
                setBusy(false)
                setStatus(tx('已取消导出', 'Export cancelled'))
              }}
            >
              {tx('取消导出', 'Cancel export')}
            </button>
          )}
        </div>}
        {kind !== 'assets' && <p role="status" aria-live="polite">
          {status}
        </p>}
        {kind !== 'assets' && <div className="export-assets">
          {assets.map((asset) => (
            <figure key={`${asset.name}-${asset.scale}`}>
              {asset.name.endsWith('.mp4') || asset.name.endsWith('.webm') ? <span>{asset.name.endsWith('.mp4') ? 'MP4' : 'WebM'}</span> : asset.name.endsWith('.svgz') ? <span>{tx('SVGZ · 矢量', 'SVGZ · vector')}</span> : asset.name.endsWith('.tiff') ? <span>{tx('TIFF · 8 位未压缩', 'TIFF · 8-bit uncompressed')}</span> : asset.pdf ? <span>{asset.pdfVector ? tx('PDF · 矢量', 'PDF · vector') : tx('PDF · 精确位图', 'PDF · exact bitmap')}</span> : <img src={asset.url} alt={tx(`${asset.scale}x 切图预览`, `${asset.scale}x export preview`)} />}
              <figcaption>
                {asset.width} × {asset.height} {asset.pdfVector ? 'pt' : 'px'}
              </figcaption>
              <a href={asset.url} download={asset.name}>
                {tx('下载', 'Download')} {asset.name}
              </a>
            </figure>
          ))}
        </div>}
      </section>
    </div>
  )
}
