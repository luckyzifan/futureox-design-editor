import {SketchDisplayPreview} from './SketchDisplayPreview'
import { useEffect, useRef, useState } from 'react'
import { admitSketchPreview } from '../../design-desktop/src/sketch-preview-contract.mjs'
import type { SketchInspection } from './sketch-inspection'
import type { GpuRenderer } from './kernel/gpu/renderer'
import { sketchViewportDescription, useProfessionalDialogText } from './professional-dialog-messages'

/** Detached native scene only; never opens or mutates the active Figma editor. */
export function SketchReadOnlyPreview({ result, revision = 0, firstPage = true }: { result: Pick<SketchInspection, 'owner' | 'preview' | 'pageCount'>; revision?: number; firstPage?: boolean }) {
  const { locale, tr } = useProfessionalDialogText()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState('待实际 WebGPU 渲染')
  useEffect(() => {
    let current = true
    let gpu: GpuRenderer | undefined
    const target = canvas.current
    setStatus('待实际 WebGPU 渲染')
    void (async () => {
      if (result.preview.status !== 'ready') return
      try {
        const policy = window.coreDesktop?.renderPolicy
        if (policy?.cpuOnly !== false) throw new Error('桌面 GPU 策略未启用 WebGPU')
        const gpuWorkingBudgetMiB = policy.gpuWorkingBudgetMiB
        const frame = admitSketchPreview(result.preview.frameJson, result.owner, revision)
        if (frame.page_id !== result.preview.pageId) throw new Error('页面身份不匹配')
        const { createGpu } = await import('./kernel/gpu/factory')
        if (!current) return
        gpu = await createGpu('webgpu', true, true, frame.scene.colorManagement, undefined, false,
          !!frame.scene.colorManagement, false, false, false, gpuWorkingBudgetMiB)
        if (!current) return
        const rendered = await gpu.render(frame.scene)
        try {
          if (!current) return
          if (!rendered.bitmap || gpu.driver.lost || !target) throw new Error('WebGPU 未返回有效预览')
          const context = target.getContext('2d')
          if (!context) throw new Error('预览画布不可用')
          target.width = 512; target.height = 384
          context.drawImage(rendered.bitmap, 0, 0)
          setStatus('已完成当前页视口的只读 WebGPU 绘制')
        } finally { rendered.bitmap?.close() }
      } catch (error) {
        if (current) setStatus(`不可预览：${error instanceof Error ? error.message : String(error)}`)
      } finally { gpu?.dispose(); gpu = undefined }
    })()
    return () => {
      current = false
      gpu?.dispose(); gpu = undefined
      if (target) { target.width = 0; target.height = 0 }
    }
  }, [result, revision])
  if(result.preview.status==='display')return <SketchDisplayPreview snapshot={result.preview.snapshot}/>
  if (result.preview.status !== 'ready') return <p role="status">{tr(`不可预览：${result.preview.reason}`)}</p>
  return <div>
    <p>{sketchViewportDescription(firstPage, result.preview.pageName, result.preview.pageId, result.pageCount, locale)}</p>
    <p role="status">{tr(status)}</p>
    <canvas ref={canvas} width={512} height={384} style={{ width: 512, height: 384, maxWidth: 'none' }} aria-label={tr('Sketch 当前选页只读视口')} />
  </div>
}
