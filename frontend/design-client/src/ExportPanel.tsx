import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { desktopPet } from './desktop-pet'
import { validateSvgOptions, svgFileBytes } from './export-options'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useInterfacePreferences } from './interface-preference'
import type { Editor } from './engine'
import { pdfVectorIssues, type ExportTarget } from './export-metadata'
import { scene, unionBounds } from './geometry'
import { commitExportEdits } from './export-ownership'

type Asset = { name: string; url: string; width: number; height: number; scale: number; pdf: boolean; pdfVector: boolean }

export function ExportPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const { locale } = useInterfacePreferences()
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh
  const [kind, setKind] = useState<ExportTarget['kind']>(s.selection.length ? 'selection' : 'page')
  const [padding, setPadding] = useState('40')
  const [region, setRegion] = useState(() => {
    const entries = scene(s.doc, s.page).filter((entry) => s.selection.includes(entry.id))
    const b = entries.length
      ? unionBounds(entries.map((entry) => entry.bounds))
      : { x: 0, y: 0, width: 24, height: 24 }
    return { x: String(b.x), y: String(b.y), width: String(b.width), height: String(b.height) }
  })
  const [format, setFormat] = useState<'png'|'jpeg'|'webp'|'pdf'|'pdf-vector'|'svg'>('png')
  const [svgScale, setSvgScale] = useState('1')
  const [embedFonts, setEmbedFonts] = useState(false)
  const [textMode, setTextMode] = useState<'outlines' | 'editable'>('outlines')
  const [precision, setPrecision] = useState('')
  const [compression, setCompression] = useState<'none' | 'gzip'>('none')
  const [scales, setScales] = useState([1, 2, 3])
  const [customScale, setCustomScale] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const request = useRef<AbortController | null>(null)
  const urls = useRef<string[]>([])
  const dialog = useRef<HTMLElement>(null)
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
    const trace = beginEditorAction(editor, CanvasAction.export, ActionSource.menu, 350 + ['png','jpeg','webp','pdf','pdf-vector','svg'].indexOf(format))
    try {
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
      const document = structuredClone(committed.doc)
      const page = committed.page
      const selection = [...committed.selection]
      const target: ExportTarget =
        kind === 'page'
          ? { kind, padding: Number(padding) }
          : kind === 'selection'
            ? { kind, nodeIds: selection }
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
      const results = await exportRasterBatch(
        document,
        page,
        [...scales].sort((a, b) => a - b),
        target,
        undefined,
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
        <p className="export-color-note">{tx(
          'PNG 写入 sRGB 色彩块。JPEG 与 WebP 写入 sRGB ICC；PDF 使用 sRGB ICCBased，并把页面 DefaultRGB 指到它。需要广色域时请改用 PNG。本面板不编码 FFmpeg、MP4 或 WebM 视频。',
          'PNG writes an sRGB chunk. JPEG and WebP embed an sRGB ICC profile. PDF uses an sRGB ICCBased space and points the page DefaultRGB at it. Use PNG when a wide-gamut color output is requested. This panel does not encode FFmpeg, MP4 or WebM video.',
        )}</p>
        <label>{tx('格式', 'Format')} <select aria-label={tx('导出图像格式', 'Export image format')} value={format} disabled={busy} onChange={e=>setFormat(e.target.value as typeof format)}>
          <option value="svg">{tx('SVG / SVGZ（矢量）', 'SVG / SVGZ (vector)')}</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">{tx('WebP（无损）', 'WebP (lossless)')}</option><option value="pdf">{tx('PDF（精确位图）', 'PDF (exact bitmap)')}</option><option value="pdf-vector" disabled={vectorIssues.length>0}>{tx('PDF（矢量）', 'PDF (vector)')}</option>
        </select></label>
        {format === 'svg' && <fieldset disabled={busy}>
          <legend>{tx('SVG 矢量选项', 'SVG vector options')}</legend>
          <label>{tx('视口倍率', 'Viewport scale')} <input aria-label={tx('SVG 视口倍率', 'SVG viewport scale')} type="number" min="0.001" max="128" step="any" value={svgScale} onChange={e => setSvgScale(e.target.value)} /></label>
          <label>{tx('文字模式', 'Text mode')} <select aria-label={tx('SVG 文字模式', 'SVG text mode')} value={textMode} onChange={e => setTextMode(e.target.value as typeof textMode)}><option value="outlines">{tx('轮廓（保持外观）', 'Outlines (keep appearance)')}</option><option value="editable">{tx('可编辑文字（需要对应字体）', 'Editable text (needs the font)')}</option></select></label>
          {textMode === 'editable' && <label><input type="checkbox" checked={embedFonts} onChange={e => setEmbedFonts(e.target.checked)} />{tx('嵌入本地字体（我确认拥有可编辑再分发授权；TTF/OTF 含内置字体总计不超过 24 MiB；宿主可能忽略嵌入字体）', 'Embed local fonts (I confirm an editable redistribution license; TTF/OTF plus built-in fonts stay within 24 MiB; the host may ignore embedded fonts)')}</label>}
          {textMode === 'editable' && !embedFonts && <p>{tx('字体不会嵌入；缺失字体、回退和浏览器排版可能改变外观。高级文字样式需使用轮廓模式。', 'Fonts are not embedded. Missing fonts, fallback and browser layout can change the appearance. Advanced text styles need outline mode.')}</p>}
          <label>{tx('坐标精度', 'Coordinate precision')} <select aria-label={tx('SVG 坐标精度', 'SVG coordinate precision')} value={precision} onChange={e => setPrecision(e.target.value)}><option value="">{tx('保留原始精度', 'Keep original precision')}</option>{[0,1,2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{tx(`${n} 位小数（有损）`, `${n} decimal places (lossy)`)}</option>)}</select></label>
          <label>{tx('压缩', 'Compression')} <select aria-label={tx('SVG 压缩', 'SVG compression')} value={compression} onChange={e => setCompression(e.target.value as typeof compression)}><option value="none">{tx('无（.svg）', 'None (.svg)')}</option><option value="gzip">{tx('无损 gzip（.svgz）', 'Lossless gzip (.svgz)')}</option></select></label>
          <p>{tx('倍率仅改变矢量视口尺寸，不是像素分辨率。精度舍入会改变几何形状；无损 gzip 不改变解压后的 SVG。FD 和 Sketch 原生文件不使用这些矢量选项。', 'Scale changes the vector viewport, not pixel resolution. Precision rounding changes geometry; lossless gzip does not change the decompressed SVG. FD and Sketch files do not use these vector options.')}</p>
        </fieldset>}
        {format==='jpeg'&&<p>{tx('JPEG 为有损格式，使用质量 100，透明区域填充为白色，并写入 sRGB ICC 描述文件。', 'JPEG is lossy, uses quality 100, fills transparent areas with white, and embeds an sRGB ICC profile.')}</p>}
        {format==='pdf'&&<p>{tx('PDF 保留当前导出倍率的像素与透明度，页面按设计尺寸保存，并用 sRGB ICCBased 标记颜色。使用 futureox-desgin 文件继续编辑图层。', 'PDF keeps the pixels and transparency of the chosen scale, stores the page at the design size, and tags colors with an sRGB ICCBased space. Keep the futureox-desgin file to edit layers.')}</p>}
        {format==='pdf-vector'&&<p>{tx('矢量 PDF 把路径、渐变与文字轮廓写为原生 PDF 对象，按设计尺寸保存（1 设计单位 = 1 pt）。', 'Vector PDF writes paths, gradients and text outlines as native PDF objects at the design size (1 design unit = 1 pt).')}</p>}
        {format==='png'&&<p>{tx('PNG 使用 CPU 导出。8 位 sRGB 写入 sRGB 色彩块；显式色彩输出再写入 ICC 与 cICP。画布上的 HDR / 广色域数值仍留在文档里；未单独请求色彩输出时，像素按 sRGB 量化。', 'PNG is exported on the CPU. 8-bit sRGB writes an sRGB chunk; an explicit color output also writes ICC and cICP. HDR and wide-gamut values stay in the document; pixels are quantized to sRGB unless a separate color output is requested.')}</p>}
        {vectorIssues.length>0&&<p role="note">{tx(`当前导出内容包含${vectorIssues.join('、')}，矢量 PDF 暂不支持，该项已禁用；可导出 PDF（精确位图）。`, `This export includes ${vectorIssues.join(', ')}. Vector PDF cannot keep that yet, so the option is disabled. Exact bitmap PDF is available.`)}</p>}
        <fieldset disabled={busy}>
          <legend>{tx('导出目标', 'Export target')}</legend>
          <label>
            <input
              type="radio"
              name="export-target"
              checked={kind === 'page'}
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
              checked={kind === 'slice'}
              onChange={() => setKind('slice')}
            />
            {tx('自定义区域', 'Custom region')}
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
            {kind === 'selection'
              ? tx('按选中图层的几何边界裁切，保留内部效果与蒙版；不包含其他图层或祖先效果。', 'Crops to the selection bounds and keeps effects and masks inside it. Other layers and ancestor effects are excluded.')
              : kind === 'slice'
                ? tx('按页面坐标裁切，保留该区域的整页合成效果。', 'Crops in page coordinates and keeps the composited page in that region.')
                : tx('包含可见内容和效果，页面留白可设为 0。', 'Includes visible content and effects. Page padding can be 0.')}
          </p>
        </fieldset>
        <fieldset disabled={busy || format === 'pdf-vector' || format === 'svg'}>
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
        </fieldset>
        <p>
          {format === 'svg' ? tx('SVG 是分辨率无关的矢量输出；SVGZ 可下载后使用支持 gzip 的查看器打开。', 'SVG is resolution-independent. SVGZ opens in a viewer that supports gzip.') : format === 'pdf-vector'
            ? tx('矢量输出与倍率无关，文件按设计尺寸保存。', 'Vector output ignores scale and is stored at the design size.')
            : tx('像素尺寸向上取整，不拉伸内容；不受画布缩放或设备 DPR 影响。小数尾像素覆盖范围会向右、向下扩展。', 'Pixel size rounds up without stretching. Canvas zoom and device DPR do not apply. A fractional edge extends right and down.')}
        </p>
        <div className="feature-row">
          <button type="button" disabled={busy || (format !== 'pdf-vector' && format !== 'svg' && !scales.length)} onClick={() => void generate()}>
            {tx(`生成 ${format === 'pdf-vector' ? 'PDF（矢量）' : format.toUpperCase()}`, `Export ${format === 'pdf-vector' ? 'vector PDF' : format.toUpperCase()}`)}
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
        </div>
        <p role="status" aria-live="polite">
          {status}
        </p>
        <div className="export-assets">
          {assets.map((asset) => (
            <figure key={asset.scale}>
              {asset.name.endsWith('.svgz') ? <span>{tx('SVGZ · 矢量', 'SVGZ · vector')}</span> : asset.pdf ? <span>{asset.pdfVector ? tx('PDF · 矢量', 'PDF · vector') : tx('PDF · 精确位图', 'PDF · exact bitmap')}</span> : <img src={asset.url} alt={tx(`${asset.scale}x 切图预览`, `${asset.scale}x export preview`)} />}
              <figcaption>
                {asset.width} × {asset.height} {asset.pdfVector ? 'pt' : 'px'}
              </figcaption>
              <a href={asset.url} download={asset.name}>
                {tx('下载', 'Download')} {asset.name}
              </a>
            </figure>
          ))}
        </div>
      </section>
    </div>
  )
}
