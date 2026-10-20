import { desktopPet } from './desktop-pet'
import { validateSvgOptions, svgFileBytes } from './export-options'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { pdfVectorIssues, type ExportTarget } from './export-metadata'
import { scene, unionBounds } from './geometry'
import { commitExportEdits } from './export-ownership'

type Asset = { name: string; url: string; width: number; height: number; scale: number; pdf: boolean; pdfVector: boolean }

export function ExportPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot)
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
    if (request.current) return
    if (!commitExportEdits(editor)) return
    const committed = editor.state
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setStatus(`正在生成 ${format.toUpperCase()}…`)
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
        throw new Error('请填写完整的切片坐标和尺寸')
      if (kind === 'page' && !padding.trim()) throw new Error('请填写页面留白')
      if (format === 'svg') {
        if (!svgScale.trim()) throw new Error('请填写 SVG 视口倍率')
        const options = validateSvgOptions({ scale: Number(svgScale), precision: precision === '' ? undefined : Number(precision), compression, textMode, fontMode: textMode === 'editable' && embedFonts ? 'embed' : 'references', ...(embedFonts && textMode === 'editable' ? {fontEmbeddingAllowed: true} : {}) })
        const { svgSource, filename } = await import('./export')
        if (options.fontMode === 'embed') {
          const { createSvgArtifact } = await import('./svg-artifact')
          const artifact = await createSvgArtifact(document, page, target, options, controller.signal)
          if (controller.signal.aborted || request.current !== controller) return
          const url=URL.createObjectURL(artifact.blob); urls.current.push(url)
          desktopPet.event('export')
          setAssets([{name:`${filename(document.name)}.${options.compression === 'gzip' ? 'svgz' : 'svg'}`,url,width:artifact.bounds.width*options.scale,height:artifact.bounds.height*options.scale,scale:options.scale,pdf:false,pdfVector:false}])
          setStatus('已生成含完整字体的 SVG；宿主可能忽略字体，外部显示仍可能不同。大型文件通过受限 SVG 字体文件通道导入。')
          return
        }
        const result = svgSource(document, page, target, options.scale, options.precision, options.textMode, options.fontMode, options.fontEmbeddingAllowed)
        if (result.issues.length) throw new Error(`SVG 无法保留这些效果：${result.issues.join('、')}；请选择原生文件或位图导出`)
        const bytes = svgFileBytes(result.source, options.compression)
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'image/svg+xml' }))
        urls.current.push(url)
        desktopPet.event('export')
        setAssets([{ name: `${filename(document.name)}.${options.compression === 'gzip' ? 'svgz' : 'svg'}`, url, width: result.box.width * options.scale, height: result.box.height * options.scale, scale: options.scale, pdf: false, pdfVector: false }])
        setStatus(`已生成 SVG${options.compression === 'gzip' ? 'Z（无损 gzip 压缩）' : ''}${options.precision === undefined ? '' : '；坐标已按所选精度进行有损舍入'}`)
        return
      }
      if (format === 'pdf-vector') {
        // Vector PDF is resolution-independent; one file covers every scale.
        const { exportPdfVector } = await import('./export')
        const asset = await exportPdfVector(document, page, target, controller.signal)
        if (controller.signal.aborted || request.current !== controller) return
        const url = URL.createObjectURL(asset.blob)
        urls.current.push(url)
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
            ? '内容包含矢量 PDF 暂不支持的效果，已生成位图 PDF'
            : '已生成 1 个矢量 PDF 文件',
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
      if (controller.signal.aborted || request.current !== controller) return
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
      desktopPet.event('export')
      setAssets(next)
      setStatus(`已生成 ${next.length} 个 ${format.toUpperCase()} 文件`)
    } catch (error) {
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
  }
  return (
    <div className="feature-backdrop">
      <section
        className="design-tools export-panel"
        role="dialog"
        aria-modal="true"
        aria-label="导出图像"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>导出图像</strong>
          <button type="button" onClick={onClose} aria-label="关闭切图">
            关闭
          </button>
        </header>
        <label>格式 <select aria-label="导出图像格式" value={format} disabled={busy} onChange={e=>setFormat(e.target.value as typeof format)}>
          <option value="svg">SVG / SVGZ（矢量）</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP（无损）</option><option value="pdf">PDF（精确位图）</option><option value="pdf-vector" disabled={vectorIssues.length>0}>PDF（矢量）</option>
        </select></label>
        {format === 'svg' && <fieldset disabled={busy}>
          <legend>SVG 矢量选项</legend>
          <label>视口倍率 <input aria-label="SVG 视口倍率" type="number" min="0.001" max="128" step="any" value={svgScale} onChange={e => setSvgScale(e.target.value)} /></label>
          <label>文字模式 <select aria-label="SVG 文字模式" value={textMode} onChange={e => setTextMode(e.target.value as typeof textMode)}><option value="outlines">轮廓（保持外观）</option><option value="editable">可编辑文字（需要对应字体）</option></select></label>
          {textMode === 'editable' && <label><input type="checkbox" checked={embedFonts} onChange={e => setEmbedFonts(e.target.checked)} />嵌入本地字体（我确认拥有可编辑再分发授权；TTF/OTF 含内置字体总计不超过 24 MiB；宿主可能忽略嵌入字体）</label>}
          {textMode === 'editable' && !embedFonts && <p>字体不会嵌入；缺失字体、回退和浏览器排版可能改变外观。高级文字样式需使用轮廓模式。</p>}
          <label>坐标精度 <select aria-label="SVG 坐标精度" value={precision} onChange={e => setPrecision(e.target.value)}><option value="">保留原始精度</option>{[0,1,2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n} 位小数（有损）</option>)}</select></label>
          <label>压缩 <select aria-label="SVG 压缩" value={compression} onChange={e => setCompression(e.target.value as typeof compression)}><option value="none">无（.svg）</option><option value="gzip">无损 gzip（.svgz）</option></select></label>
          <p>倍率仅改变矢量视口尺寸，不是像素分辨率。精度舍入会改变几何形状；无损 gzip 不改变解压后的 SVG。FD 和 Sketch 原生文件不使用这些矢量选项。</p>
        </fieldset>}
        {format==='jpeg'&&<p>JPEG 为有损格式，使用质量 100，透明区域填充为白色。</p>}
        {format==='pdf'&&<p>PDF 保留当前导出倍率的像素与透明度，页面按设计尺寸保存；使用 futureox-desgin 文件继续编辑图层。</p>}
        {format==='pdf-vector'&&<p>矢量 PDF 把路径、渐变与文字轮廓写为原生 PDF 对象，按设计尺寸保存（1 设计单位 = 1 pt）。</p>}
        {vectorIssues.length>0&&<p role="note">当前导出内容包含{vectorIssues.join('、')}，矢量 PDF 暂不支持，该项已禁用；可导出 PDF（精确位图）。</p>}
        <fieldset disabled={busy}>
          <legend>导出目标</legend>
          <label>
            <input
              type="radio"
              name="export-target"
              checked={kind === 'page'}
              onChange={() => setKind('page')}
            />
            整页
          </label>
          <label>
            <input
              type="radio"
              name="export-target"
              checked={kind === 'selection'}
              disabled={!s.selection.length}
              onChange={() => setKind('selection')}
            />
            选中图层 / Frame
          </label>
          <label>
            <input
              type="radio"
              name="export-target"
              checked={kind === 'slice'}
              onChange={() => setKind('slice')}
            />
            自定义区域
          </label>
          {kind === 'page' && (
            <label>
              页面留白
              <input
                aria-label="页面留白"
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
                  {{ x: 'X', y: 'Y', width: '宽', height: '高' }[key]}
                  <input
                    aria-label={`切片 ${key}`}
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
              ? '按选中图层的几何边界裁切，保留内部效果与蒙版；不包含其他图层或祖先效果。'
              : kind === 'slice'
                ? '按页面坐标裁切，保留该区域的整页合成效果。'
                : '包含可见内容和效果，页面留白可设为 0。'}
          </p>
        </fieldset>
        <fieldset disabled={busy || format === 'pdf-vector' || format === 'svg'}>
          <legend>倍率</legend>
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
          <label>自定义倍率 <input aria-label="自定义导出倍率" type="number" min="0.001" max="128" step="any" value={customScale} onChange={e => setCustomScale(e.target.value)} /></label>
          <button type="button" onClick={() => {
            const value = Number(customScale)
            if (!customScale.trim() || !Number.isFinite(value) || value < .001 || value > 128) { setStatus('自定义倍率必须在 0.001–128 之间'); return }
            if (!scales.includes(value) && scales.length >= 16) { setStatus('最多选择 16 个导出倍率'); return }
            setScales([...new Set([...scales, value])]); setCustomScale(''); setStatus('')
          }}>添加倍率</button>
        </fieldset>
        <p>
          {format === 'svg' ? 'SVG 是分辨率无关的矢量输出；SVGZ 可下载后使用支持 gzip 的查看器打开。' : format === 'pdf-vector'
            ? '矢量输出与倍率无关，文件按设计尺寸保存。'
            : '像素尺寸向上取整，不拉伸内容；不受画布缩放或设备 DPR 影响。小数尾像素覆盖范围会向右、向下扩展。'}
        </p>
        <div className="feature-row">
          <button type="button" disabled={busy || (format !== 'pdf-vector' && format !== 'svg' && !scales.length)} onClick={() => void generate()}>
            生成 {format === 'pdf-vector' ? 'PDF（矢量）' : format.toUpperCase()}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                request.current?.abort()
                request.current = null
                setBusy(false)
                setStatus('已取消导出')
              }}
            >
              取消导出
            </button>
          )}
        </div>
        <p role="status" aria-live="polite">
          {status}
        </p>
        <div className="export-assets">
          {assets.map((asset) => (
            <figure key={asset.scale}>
              {asset.name.endsWith('.svgz') ? <span>SVGZ · 矢量</span> : asset.pdf ? <span>{asset.pdfVector ? 'PDF · 矢量' : 'PDF · 精确位图'}</span> : <img src={asset.url} alt={`${asset.scale}x 切图预览`} />}
              <figcaption>
                {asset.width} × {asset.height} {asset.pdfVector ? 'pt' : 'px'}
              </figcaption>
              <a href={asset.url} download={asset.name}>
                下载 {asset.name}
              </a>
            </figure>
          ))}
        </div>
      </section>
    </div>
  )
}
