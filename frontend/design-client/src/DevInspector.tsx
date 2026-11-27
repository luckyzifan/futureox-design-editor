import { useState } from 'react'
import { exportDesignCode } from './automation/export'
import type { DesignDocument } from './model'

export function DevInspector({ document, page, selection, locale }: {
  document: DesignDocument; page: string; selection: string[]; locale: string
}) {
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const en = locale === 'en'
  const formatNumber = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 3 })
  const layers = selection.flatMap(id => document.nodes[id] ?? [])
  if (!layers.length) return <div className="dev-inspector">
    <p>{en ? 'Select a layer to inspect its properties.' : '选择图层以检查属性。'}</p>
  </div>
  return <div className="dev-inspector">
    {layers.map(layer => <section key={layer.id} aria-label={layer.name}>
      <h3>{layer.name}</h3>
      <dl>
        {[
          ['X', layer.transform[4]], ['Y', layer.transform[5]],
          [en ? 'Width' : '宽度', layer.width], [en ? 'Height' : '高度', layer.height],
          [en ? 'Opacity' : '不透明度', `${formatNumber(layer.opacity * 100)}%`],
          ...(layer.layout ? [[en ? 'Gap' : '间距', layer.layout.gap]] : []),
          ...(layer.kind === 'text' ? [
            [en ? 'Font' : '字体', document.fonts?.[layer.textStyle?.fontId ?? 'default']?.family ?? 'Inter'],
            [en ? 'Font size' : '字号', layer.fontSize],
          ] : []),
          ...layer.fills.flatMap(fill => fill.visible && fill.kind === 'solid' && fill.color
            ? [[en ? 'Fill' : '填充', fill.color]] : []),
        ].map(([label, value], index) => <div key={`${label}:${index}`}><dt>{label}</dt>
          <dd>{typeof value === 'number' ? formatNumber(value) : value}</dd></div>)}
      </dl>
    </section>)}
    <section aria-label="CSS">
      <h3>CSS</h3>
      <button type="button" onClick={() => {
        try { setCode(exportDesignCode(document, { pageId: page, nodeIds: selection }).css); setMessage('') }
        catch (error) { setCode(''); setMessage(error instanceof Error ? error.message : String(error)) }
      }}>{en ? 'Generate CSS' : '生成 CSS'}</button>
      {code && <>
        <pre aria-label={en ? 'Generated CSS' : '生成的 CSS'}>{code}</pre>
        <button type="button" onClick={async () => {
          try {
            await navigator.clipboard.writeText(code)
            setMessage(en ? 'CSS copied' : '已复制 CSS')
          } catch {
            setMessage(en ? 'Clipboard unavailable' : '无法访问剪贴板')
          }
        }}>{en ? 'Copy CSS' : '复制 CSS'}</button>
      </>}
      {message && <p role="status">{message}</p>}
    </section>
  </div>
}
