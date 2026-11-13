import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  activeKernelClients,
  latestRendererMemory,
  subscribeRendererMemory,
  type GpuDriverMemoryStats,
  type GpuMemorySnapshot,
} from './kernel/client'
import { modalOwnsKeyboard } from './modal-keyboard'
import { useProfessionalDialogText } from './professional-dialog-messages'

/** Mirrors design-kernel memory.rs DEFAULT_GPU_MEMORY_LIMIT_BYTES; the
 * kernel breakdown carries its own limitBytes, which wins when present. */
const KERNEL_POLICY_LIMIT_BYTES = 512 * 1024 * 1024
const POLL_MS = 1000

/** VectorEngine.gpu_memory_breakdown() JSON shape (serde camelCase). */
type KernelBreakdown = {
  textureBytes: number
  bufferBytes: number
  fixedArrayBytes: number
  blobBytes: number
  peakTextureBytes: number
  peakBufferBytes: number
  peakFixedArrayBytes: number
  peakBlobBytes: number
  peakTotalBytes: number
  totalBytes: number
  limitBytes: number
  needsFree: boolean
  freeEvents: number
  rejections: number
}
function parseBreakdown(json: string | null | undefined): KernelBreakdown | undefined {
  if (!json) return undefined
  try {
    const value = JSON.parse(json)
    if (!value || typeof value !== 'object' || typeof value.totalBytes !== 'number') return undefined
    return value as KernelBreakdown
  } catch {
    return undefined
  }
}

/** Forward-compatible Electron hook: the native render bridge reports the
 * same breakdown JSON with real Metal-fed numbers. Absent on web — silent. */
type NativeRenderStats = () => Promise<string | null>
function nativeRenderStats(): NativeRenderStats | undefined {
  const host = (window as { coreDesktop?: { nativeRenderStats?: NativeRenderStats } }).coreDesktop
  return typeof host?.nativeRenderStats === 'function' ? host.nativeRenderStats.bind(host) : undefined
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB']
  let scaled = value
  let unit = 'B'
  for (const next of units) {
    if (scaled < 1024) break
    scaled /= 1024
    unit = next
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit}`
}
function formatShare(used: number | undefined, budget: number, english: boolean): string {
  if (used === undefined) return ''
  const percent = ((used / budget) * 100).toFixed(1)
  return english ? ` (${percent}%)` : `（${percent}%）`
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 12,
  zIndex: 1000,
  width: 380,
  maxHeight: '70vh',
  overflowY: 'auto',
  background: '#ffffff',
  border: '1px solid #d8dbe3',
  borderRadius: 8,
  boxShadow: '0 8px 28px rgba(20, 24, 40, 0.18)',
  padding: '10px 12px',
  fontSize: 11,
  lineHeight: 1.5,
  color: '#3a3f4d',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const headingStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 12,
  fontWeight: 600,
  color: '#1d2230',
  marginBottom: 6,
}
const sectionStyle: React.CSSProperties = { borderTop: '1px solid #eceef3', paddingTop: 6, marginTop: 6 }
const sectionTitleStyle: React.CSSProperties = { fontWeight: 600, color: '#1d2230', marginBottom: 2 }
const noteStyle: React.CSSProperties = { color: '#777c8e' }
const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const labelStyle: React.CSSProperties = { color: '#5a6070' }
const valueStyle: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap' }

function Row({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  const { tr } = useProfessionalDialogText()
  return (
    <div style={rowStyle} title={title}>
      <span style={labelStyle}>{tr(label)}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  )
}

function BreakdownTable({ breakdown }: { breakdown: KernelBreakdown }) {
  const { tr } = useProfessionalDialogText()
  const buckets: { label: string; live: number; peak: number }[] = [
    { label: '纹理 Texture', live: breakdown.textureBytes, peak: breakdown.peakTextureBytes },
    { label: '缓冲 Buffer', live: breakdown.bufferBytes, peak: breakdown.peakBufferBytes },
    { label: '定长数组 FixedArray', live: breakdown.fixedArrayBytes, peak: breakdown.peakFixedArrayBytes },
    { label: '数据块 Blob', live: breakdown.blobBytes, peak: breakdown.peakBlobBytes },
  ]
  return (
    <>
      <div style={{ ...rowStyle, fontWeight: 600 }}>
        <span style={labelStyle}>{tr('桶')}</span>
        <span style={valueStyle}>{tr('当前 / 峰值')}</span>
      </div>
      {buckets.map((bucket) => (
        <Row
          key={bucket.label}
          label={bucket.label}
          value={`${formatBytes(bucket.live)} / ${formatBytes(bucket.peak)}`}
        />
      ))}
      <Row label="合计" value={`${formatBytes(breakdown.totalBytes)} / ${formatBytes(breakdown.peakTotalBytes)}`} />
      <Row label="策略上限" value={formatBytes(breakdown.limitBytes || KERNEL_POLICY_LIMIT_BYTES)} />
      <Row label="释放事件 freeEvents" value={breakdown.freeEvents} />
      <Row label="准入拒绝 rejections" value={breakdown.rejections} />
      {breakdown.needsFree && <div style={{ color: '#bd3b54' }}>{tr('needsFree：内核请求释放缓存数据')}</div>}
    </>
  )
}

function DriverStatsTable({ stats }: { stats: GpuDriverMemoryStats }) {
  const { tr } = useProfessionalDialogText()
  return (
    <>
      <Row label="纹理 texture（含显示驻留）" value={formatBytes(stats.textureBytes)} />
      <Row label="显示驻留" value={formatBytes(stats.displayTextureBytes)} />
      <Row label="瞬态 transient" value={formatBytes(stats.transientBytes)} />
      <Row label="完成瞬态 finishTransient" value={formatBytes(stats.finishTransientBytes)} />
      <Row label="帧暂存 frameScratch" value={formatBytes(stats.frameScratchBytes)} />
      <Row label="暂存 scratch" value={formatBytes(stats.scratchBytes)} />
      <Row label="顶点缓冲 vertex" value={formatBytes(stats.vertexBufferBytes)} />
      <Row label="曲线缓冲 curve" value={formatBytes(stats.curveBufferBytes)} />
      <Row label="实例缓冲 solid" value={formatBytes(stats.solidBufferBytes)} />
      <Row label="Uniform 缓冲" value={formatBytes(stats.uniformBufferBytes)} />
      {stats.deviceLost && <div style={{ color: '#bd3b54' }}>{tr('GPU 设备已丢失')}</div>}
    </>
  )
}

/** 应用内 GPU 内存调试面板。⌘/Ctrl+Shift+G 切换；仅在打开时轮询，关闭时不
 * 保留任何定时器或订阅之外的运行状态。 */
export function GpuMemoryPanel() {
  const { locale, tr } = useProfessionalDialogText()
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<GpuMemorySnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [nativeJson, setNativeJson] = useState<string | null>(null)
  const rendererSample = useSyncExternalStore(subscribeRendererMemory, latestRendererMemory)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'g') return
      if (modalOwnsKeyboard(event.target)) return
      event.preventDefault()
      setOpen((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    let alive = true
    const poll = async () => {
      const client = activeKernelClients()[0]
      const native = nativeRenderStats()
      const [worker, metal] = await Promise.allSettled([
        client ? client.gpuMemorySnapshot() : Promise.resolve(null),
        native ? native() : Promise.resolve(null),
      ])
      if (!alive) return
      if (worker.status === 'fulfilled') {
        setSnapshot(worker.value)
        setSnapshotError(null)
      } else {
        setSnapshotError(String(worker.reason))
      }
      if (metal.status === 'fulfilled') setNativeJson(metal.value)
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open])

  if (!open) return null

  const kernel = parseBreakdown(snapshot?.kernelBreakdown)
  const kernelAllZero = !!kernel && kernel.totalBytes === 0 && kernel.peakTotalBytes === 0
  const metal = parseBreakdown(nativeJson)
  const backend = snapshot?.backend ?? rendererSample?.backend
  const workingBudget = snapshot?.rendererPolicy?.workingBudgetBytes

  return (
    <aside aria-label={tr('GPU 内存调试面板')} style={panelStyle}>
      <div style={headingStyle}>
        <span>{tr('GPU 内存调试')}</span>
        <button
          type="button"
          aria-label={tr('关闭 GPU 内存调试面板')}
          onClick={() => setOpen(false)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#777c8e', fontSize: 13 }}
        >
          ×
        </button>
      </div>
      <div style={noteStyle}>
        {tr('工作集预算')} {formatBytes(workingBudget)} · ⌘⇧G · {POLL_MS / 1000}s
        <div>{tr('预算是本程序准入策略；WebGPU 不提供剩余显存查询。')}</div>
        <div>{tr('交互驻留预算')} {formatBytes(snapshot?.rendererPolicy?.interactionBudgetBytes)}</div>
      </div>

      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>{tr('渲染器（浏览器，实时）')}</div>
        <Row label="后端" value={backend ?? tr('尚未渲染')} />
        {rendererSample ? (
          <>
            <Row
              label="工作纹理 working"
              value={`${formatBytes(rendererSample.workingTextureBytes)}${workingBudget ? formatShare(rendererSample.workingTextureBytes, workingBudget, locale === 'en') : ''}`}
            />
            <Row
              label="峰值纹理 peak"
              value={formatBytes(rendererSample.peakTextureBytes)}
            />
            <Row label="完成瞬态 finishTransient" value={formatBytes(rendererSample.finishTransientBytes)} />
            <Row label="瓦片缓存 tileCache" value={formatBytes(rendererSample.tileCacheBytes)} />
          </>
        ) : (
          <div style={noteStyle}>{tr('尚无渲染结果。')}</div>
        )}
        {snapshot?.driverStats ? (
          <>
            <div style={{ ...noteStyle, marginTop: 4 }}>{tr('WebGPU 驱动台账：')}</div>
            <DriverStatsTable stats={snapshot.driverStats} />
          </>
        ) : backend === 'webgl2' ? (
          <div style={noteStyle}>{tr('WebGL2 驱动未实现 stats() 台账。')}</div>
        ) : null}
        {snapshotError && <div style={{ color: '#bd3b54' }}>{tr('渲染线程查询失败：')}{snapshotError}</div>}
        {!snapshot && !snapshotError && !rendererSample && (
          <div style={noteStyle}>{tr('等待渲染线程…')}</div>
        )}
      </section>

      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>{tr('内核台账（原生供给；Web 端为零）')}</div>
        {kernel ? (
          <>
            <BreakdownTable breakdown={kernel} />
            {kernelAllZero && (
              <div style={noteStyle}>{tr('全部为零：浏览器端内核不持有 GPU 资源，真实占用见上方渲染器数据。')}</div>
            )}
          </>
        ) : (
          <div style={noteStyle}>{tr(snapshot ? '内核引擎尚未就绪。' : '等待渲染线程…')}</div>
        )}
      </section>

      {nativeRenderStats() && (
        <section style={sectionStyle}>
          <div style={sectionTitleStyle}>{tr('原生（Metal）')}</div>
          {metal ? <BreakdownTable breakdown={metal} /> : <div style={noteStyle}>{tr('原生桥尚未返回数据。')}</div>}
        </section>
      )}
    </aside>
  )
}
