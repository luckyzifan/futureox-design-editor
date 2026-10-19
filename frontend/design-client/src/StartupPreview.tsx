import { useEffect, useState } from 'react'
import type { CanvasCamera } from './canvas-camera'
import type { StartupPreview as Preview } from './startup-preview'

export function StartupPreview({ preview, view, loading, width, height }:
  { preview: Preview; view: CanvasCamera; loading: boolean; width: number; height: number }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const value = URL.createObjectURL(preview.image); setUrl(value)
    return () => URL.revokeObjectURL(value)
  }, [preview])
  const scale = loading ? 1 : view.zoom / preview.view.zoom
  const x = loading ? (width - preview.width) / 2 : view.x - preview.view.x * scale
  const y = loading ? (height - preview.height) / 2 : view.y - preview.view.y * scale
  return <div data-testid="startup-preview" data-preview-revision={preview.revision}
    style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', background: preview.background }}>
    {url && <img alt="上次保存的画布预览" src={url} draggable={false}
      onLoad={event => {
        const host = event.currentTarget.closest<HTMLElement>('[data-testid=canvas]')
        if (host) host.dataset.startupPreviewMs = performance.now().toFixed(2)
      }}
      style={{ position: 'absolute', width: preview.width, height: preview.height, maxWidth: 'none',
        transformOrigin: '0 0', transform: `translate(${x}px, ${y}px) scale(${scale})` }}/>} 
  </div>
}
