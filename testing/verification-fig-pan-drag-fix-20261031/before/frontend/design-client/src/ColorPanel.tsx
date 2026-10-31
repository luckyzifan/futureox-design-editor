import { DraftInput } from './DraftInput'
import { NumberField } from './fields'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { commitExportEdits, type ExportOwner, type ExportRequest } from './export-ownership'
import {
  colorSpaces,
  defaultColorSettings,
  validColor,
  type ColorOutput,
  type ColorSpace,
} from './color'
export function ColorPanel({
  editor,
  onClose,
  exports,
}: {
  editor: Editor
  onClose: () => void
  exports: ExportOwner
}) {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot),
    settings = s.doc.colorManagement
  const selected = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : undefined
  const paint = selected?.fills[0]
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [sdrToneMap, setSdrToneMap] = useState<'clip' | 'reinhard'>('clip')
  const dialog = useRef<HTMLElement>(null)
  const exportRequest = useRef<ExportRequest | null>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement
    dialog.current?.focus()
    return () => {
      if (exportRequest.current) exports.cancel(exportRequest.current)
      exportRequest.current = null
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [exports])
  const change = (
    key: 'documentSpace' | 'referenceWhiteNits' | 'peakLuminanceNits',
    value: string | number,
  ) => {
    try {
      editor.change('修改色彩管理', (d) => {
        d.colorManagement = { ...(d.colorManagement || defaultColorSettings()), [key]: value }
        d.schemaVersion = Math.max(d.schemaVersion, 3) as 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
      })
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }
  function closePanel() {
    if (exportRequest.current) exports.cancel(exportRequest.current)
    exportRequest.current = null
    onClose()
  }
  async function output(space: ColorSpace) {
    let request: ExportRequest | null = null
    try {
      if (!commitExportEdits(editor)) return
      request = exports.begin(editor, `color:${space}:${sdrToneMap}`)
      if (!request) return
      exportRequest.current = request
      setBusy(true)
      const out: ColorOutput = {
        space,
        toneMap: ['rec2100-pq', 'rec2100-hlg'].includes(space) ? 'none' : sdrToneMap,
      }
      const { exportImage } = await import('./export')
      if (!request.isCurrent()) return
      const asset = await exportImage(request.document, request.page, 'png', 1, out, request.signal)
      if (!exports.publish(request, asset)) return
      onClose()
    } catch (error) {
      if (!request || request.isCurrent()) setError(String(error))
    } finally {
      if (request) exports.finish(request)
      if (request && exportRequest.current === request) {
        exportRequest.current = null
        setBusy(false)
      }
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="色彩与 HDR"
        tabIndex={-1}
        className="remote-modal color-modal"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') closePanel()
          if (e.key === 'Tab') {
            const items = [
              ...(dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input,select,a[href]',
              ) || []),
            ]
            const first = items[0],
              last = items.at(-1)
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              e.preventDefault()
              last?.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <h2>
          色彩与 HDR{' '}
          <button type="button" aria-label="关闭色彩面板" onClick={closePanel}>
            ×
          </button>
        </h2>
        {!settings ? (
          <>
            <p>
              启用后使用线性光混合与渐变，并保留广色域及 HDR
              高光。现有重叠、渐变的外观可能改变，可通过撤销恢复。
            </p>
            <button
              type="button"
              onClick={() =>
                editor.change('启用色彩管理', (d) => {
                  d.schemaVersion = Math.max(d.schemaVersion, 3) as 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
                  d.rasterProfile = 'figma'
                  d.colorManagement = defaultColorSettings()
                })
              }
            >
              启用广色域 / HDR
            </button>
          </>
        ) : (
          <>
            <label>
              默认颜色空间{' '}
              <select
                aria-label="默认颜色空间"
                value={settings.documentSpace}
                onChange={(e) => change('documentSpace', e.target.value)}
              >
                {colorSpaces.map((space) => (
                  <option key={space}>{space}</option>
                ))}
              </select>
            </label>
            <p>Hex 颜色按默认空间解释；带 color() 标记的颜色保持自身空间。</p>
            <NumberField
              label="参考白 nits"
              value={settings.referenceWhiteNits}
              min={1}
              max={Math.min(1000, settings.peakLuminanceNits)}
              onChange={(v) => change('referenceWhiteNits', v)}
            />
            <NumberField
              label="峰值亮度 nits"
              value={settings.peakLuminanceNits}
              min={Math.max(2, settings.referenceWhiteNits)}
              max={10000}
              onChange={(v) => change('peakLuminanceNits', v)}
            />
            {paint && selected ? (
              <>
                <h3>{selected.name} · 填充 1</h3>
                <DraftInput aria-label="扩展颜色" value={paint.color} editor={editor}
                  validate={(value) => validColor(value, true)}
                  onCommit={(value) => editor.update([selected.id], (n) => { n.fills[0].color = value }, '修改扩展颜色')} />
                <p>
                  例如 color(display-p3 1 0 0)，或 color(srgb-linear 4 1 0 / 0.8)。线性值 1
                  表示参考白，4 表示四倍参考白。
                </p>
              </>
            ) : (
              <p>选择一个带填充的图层可编辑扩展颜色。</p>
            )}
            <h3>导出 16 位 PNG</h3>
            <label>
              SDR 高光映射{' '}
              <select
                aria-label="SDR 高光映射"
                value={sdrToneMap}
                onChange={(e) => setSdrToneMap(e.target.value as 'clip' | 'reinhard')}
              >
                <option value="clip">裁剪到目标范围</option>
                <option value="reinhard">Reinhard 亮度压缩</option>
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(
                [
                  'srgb',
                  'display-p3',
                  'a98-rgb',
                  'prophoto-rgb',
                  'rec2100-pq',
                  'rec2100-hlg',
                ] as ColorSpace[]
              ).map((space) => (
                <button
                  type="button"
                  key={space}
                  disabled={busy}
                  onClick={() => void output(space)}
                >
                  {space}
                </button>
              ))}
            </div>
            <p>
              HDR 显示取决于浏览器与屏幕能力；不支持时保留浮点内容并显示 SDR 预览。PQ / HLG 文件包含
              BT.2020 与传递函数标记。
            </p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  )
}
