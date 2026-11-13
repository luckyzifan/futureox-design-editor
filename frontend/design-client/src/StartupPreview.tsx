import { useEffect, useState } from 'react'
import type { CanvasCamera } from './canvas-camera'
import type { StartupPreview as Preview } from './startup-preview'
import { useProfessionalDialogText } from './professional-dialog-messages'

export function StartupPreview({ preview, view, loading, width, height }:
  { preview: Preview; view: CanvasCamera; loading: boolean; width: number; height: number }) {
  const { tr } = useProfessionalDialogText()
  const [image, setImage] = useState<{ preview: Preview; url: string } | null>(null)
  useEffect(() => {
    const value = URL.createObjectURL(preview.image); setImage({ preview, url: value })
    return () => URL.revokeObjectURL(value)
  }, [preview])
  // Passive URL replacement must never show another document's old image for
  // the intervening render, even if the component instance is reused.
  const url = image?.preview === preview ? image.url : ''
  const scale = loading ? 1 : view.zoom / preview.view.zoom
  const x = loading ? (width - preview.width) / 2 : view.x - preview.view.x * scale
  const y = loading ? (height - preview.height) / 2 : view.y - preview.view.y * scale
  return <div data-testid="startup-preview" data-preview-revision={preview.revision}
    style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', background: preview.background }}>
    {url && <img alt={tr('上次保存的画布预览')} src={url} draggable={false}
      onLoad={event => {
        const host = event.currentTarget.closest<HTMLElement>('[data-testid=canvas]')
        if (host) host.dataset.startupPreviewMs = performance.now().toFixed(2)
      }}
      style={{ position: 'absolute', width: preview.width, height: preview.height, maxWidth: 'none',
        transformOrigin: '0 0', transform: `translate(${x}px, ${y}px) scale(${scale})` }}/>} 
  </div>
}
