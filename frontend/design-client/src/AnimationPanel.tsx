import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import {
  clampKeyframeTime,
  createClip,
  recordKeyframe,
  easeInOut,
  spring,
  PlaybackClock,
  moveKeyframeTime,
  removeKeyframeAt,
  timelineRatio,
  timelineTimeAt,
  timelineTickLabel,
  timelineTickStepMs,
  type AnimationClip,
  type Easing,
  type NamedEasing,
} from './animation'
import {
  startOrchestratedPlayback,
  type OrchestratedPlaybackStart,
} from './animation-orchestrator'
import type { DesignDocument } from './model'
import { KernelSurface } from './kernel/Surface'
import { KernelClient, type KernelOptions } from './kernel/client'
import { kernelModuleReady } from './kernel/module'
import { scene, unionBounds } from './geometry'
import { fitBounds } from './canvas-camera'
import { desktopBridge } from './desktop'
import {
  encodeDesktopFrames,
  motionFileName,
  motionPreviewTimes,
  MOTION_PREVIEW_FPS,
  useVideoEncodeAvailable,
} from './motion-video'
import './animation.css'

function EasingControls({ value, onChange }: { value: Easing; onChange: (value: Easing) => void }) {
  const field = (key: string, label: string, v: number, min: number, max: number) => (
    <label key={key}>
      {label}
      <input
        type="number"
        aria-label={label}
        value={v}
        min={min}
        max={max}
        step="any"
        onChange={(e) => {
          const n = e.currentTarget.valueAsNumber
          if (Number.isFinite(n)) onChange({ ...value, [key]: n } as Easing)
        }}
      />
    </label>
  )
  return (
    <div className="animation-easing">
      <label>
        缓动
        <select
          aria-label="动画缓动"
          value={value.kind === 'named' ? `named:${value.name}` : value.kind}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('named:')) {
              onChange({ kind: 'named', name: v.slice(6) as NamedEasing })
            } else if (v === 'cubic') {
              onChange(structuredClone(easeInOut))
            } else if (v === 'spring') {
              onChange(structuredClone(spring))
            } else {
              onChange({ kind: v as 'linear' | 'hold' })
            }
          }}
        >
          <option value="linear">线性</option>
          <option value="cubic">贝塞尔</option>
          <option value="spring">弹簧</option>
          <option value="hold">保持到下一帧</option>
          <optgroup label="Figma 缓动预设">
            <option value="named:ease-in-sine">Sine 入</option>
            <option value="named:ease-out-sine">Sine 出</option>
            <option value="named:ease-in-out-sine">Sine 入出</option>
            <option value="named:ease-in-quad">Quad 入</option>
            <option value="named:ease-out-quad">Quad 出</option>
            <option value="named:ease-in-out-quad">Quad 入出</option>
            <option value="named:ease-in-cubic">Cubic 入</option>
            <option value="named:ease-out-cubic">Cubic 出</option>
            <option value="named:ease-in-out-cubic">Cubic 入出</option>
            <option value="named:ease-in-quart">Quart 入</option>
            <option value="named:ease-out-quart">Quart 出</option>
            <option value="named:ease-in-out-quart">Quart 入出</option>
            <option value="named:ease-in-quint">Quint 入</option>
            <option value="named:ease-out-quint">Quint 出</option>
            <option value="named:ease-in-out-quint">Quint 入出</option>
            <option value="named:ease-in-expo">Expo 入</option>
            <option value="named:ease-out-expo">Expo 出</option>
            <option value="named:ease-in-out-expo">Expo 入出</option>
            <option value="named:ease-in-circ">Circ 入</option>
            <option value="named:ease-out-circ">Circ 出</option>
            <option value="named:ease-in-out-circ">Circ 入出</option>
          </optgroup>
        </select>
      </label>
      {value.kind === 'cubic' && (
        <>
          {field('x1', '控制点 X1', value.x1, 0, 1)}
          {field('y1', '控制点 Y1', value.y1, -10, 10)}
          {field('x2', '控制点 X2', value.x2, 0, 1)}
          {field('y2', '控制点 Y2', value.y2, -10, 10)}
        </>
      )}
      {value.kind === 'spring' && (
        <>
          {field('mass', '质量', value.mass, 0.0001, 1000)}
          {field('stiffness', '刚度', value.stiffness, 0.01, 1e6)}
          {field('damping', '阻尼', value.damping, 0, 1e5)}
          {field('velocity', '初速度', value.velocity, -10000, 10000)}
        </>
      )}
    </div>
  )
}

const easingGlyphs: Record<Easing['kind'], string> = {
  named: '∿',
  linear: '→',
  cubic: '∿',
  spring: '≈',
  hold: '┤',
}
const easingNames: Record<Easing['kind'], string> = {
  named: '预设',
  linear: '线性',
  cubic: '贝塞尔',
  spring: '弹簧',
  hold: '保持',
}

/**
 * Visual keyframe timeline replacing the flat time-button list. One row per
 * track: node name plus easing glyph on the left, lane on the right. The lane
 * auto-fits the clip duration (ratio positioning) so every keyframe stays
 * visible without a zoom ladder; 10ms drag precision survives because the
 * pixel→time math reads the live lane rect. Interactions: click selects a
 * keyframe, Delete/Backspace removes it, horizontal drag moves timeMs (one
 * editor.change commit per drag, clamped between neighboring keyframes — the
 * kernel validator requires strictly increasing times, so stacking is blocked
 * at the boundary instead of allowed), double-click on empty lane space
 * records a keyframe of the current pose at the clicked time.
 */
export function Timeline({
  clip,
  editor,
  easing,
  time,
  onTime,
  playheadMs,
}: {
  clip: AnimationClip
  editor: Editor
  easing: Easing
  time: number
  onTime: (ms: number) => void
  playheadMs: number | null
}) {
  const [selectedKey, setSelectedKey] = useState<{ nodeId: string; timeMs: number } | null>(null),
    [drag, setDrag] = useState<{
      nodeId: string
      index: number
      timeMs: number
      laneLeft: number
      laneWidth: number
    } | null>(null)
  const dragMoved = useRef(false)
  const step = timelineTickStepMs(clip.durationMs)
  const ticks = useMemo(() => {
    const list: number[] = []
    for (let ms = 0; ms <= clip.durationMs; ms += step) list.push(ms)
    if (list[list.length - 1] !== clip.durationMs) list.push(clip.durationMs)
    return list
  }, [clip.durationMs, step])
  // The preview reports its slider time through a callback (cheapest option);
  // the panel stores the last value so the playhead keeps showing the last
  // known progress even after the modal closes.
  const playhead =
    playheadMs === null ? null : timelineRatio(Math.max(0, playheadMs - clip.delayMs), clip.durationMs)
  return (
    <div className="animation-timeline">
      <div className="animation-track animation-ruler">
        <span className="animation-track-label">时间轴</span>
        <div aria-hidden="true" className="animation-track-lane">
          {ticks.map((ms) => (
            <div
              className="animation-tick"
              key={ms}
              style={{ left: `${timelineRatio(ms, clip.durationMs) * 100}%` }}
            >
              <span>{timelineTickLabel(ms, step)}</span>
            </div>
          ))}
        </div>
      </div>
      {clip.tracks.map((track) => {
        const nodeName = editor.snapshot().doc.nodes[track.nodeId]?.name || track.nodeId,
          active =
            track.keyframes.filter((k) => k.timeMs <= time).at(-1) || track.keyframes[0]
        const kind = active?.easing.kind || 'linear'
        return (
          <div
            className="animation-track"
            key={track.nodeId}
            role="group"
            aria-label={`轨道 ${track.nodeId}`}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              const rect = (e.currentTarget as HTMLElement)
                .querySelector('.animation-track-lane')
                ?.getBoundingClientRect()
              if (!rect) return
              const ms = timelineTimeAt(e.clientX - rect.left, rect.width, clip.durationMs)
              editor.change('记录动画关键帧', (d) => {
                const c = d.animations?.find((x) => x.id === clip.id)
                if (c) recordKeyframe(d, c, [track.nodeId], ms, easing, false)
              })
              setSelectedKey({ nodeId: track.nodeId, timeMs: ms })
              onTime(ms)
            }}
          >
            <span
              className="animation-track-label"
              title={`${nodeName} · 缓动 ${easingNames[kind]}`}
            >
              <span aria-hidden="true">{easingGlyphs[kind]}</span>
              <span className="animation-track-name">{nodeName}</span>
            </span>
            <div className="animation-track-lane" data-testid={`lane-${track.nodeId}`}>
              {ticks.map((ms) => (
                <div
                  aria-hidden="true"
                  className="animation-tick"
                  key={ms}
                  style={{ left: `${timelineRatio(ms, clip.durationMs) * 100}%` }}
                />
              ))}
              {playhead !== null && (
                <div
                  aria-hidden="true"
                  className="animation-playhead"
                  style={{ left: `${playhead * 100}%` }}
                />
              )}
              {track.keyframes.map((keyframe, index) => {
                const liveTime =
                  drag && drag.nodeId === track.nodeId && drag.index === index
                    ? drag.timeMs
                    : keyframe.timeMs
                return (
                  <button
                    type="button"
                    aria-label={`${track.nodeId} ${Math.round(liveTime)}ms`}
                    aria-pressed={
                      (selectedKey?.nodeId === track.nodeId &&
                        selectedKey.timeMs === keyframe.timeMs) ||
                      keyframe.timeMs === time
                    }
                    className="animation-keyframe"
                    key={`${index}:${keyframe.timeMs}`}
                    style={{ left: `${timelineRatio(liveTime, clip.durationMs) * 100}%` }}
                    onClick={() => {
                      if (dragMoved.current) {
                        dragMoved.current = false
                        return
                      }
                      setSelectedKey({ nodeId: track.nodeId, timeMs: keyframe.timeMs })
                      onTime(keyframe.timeMs)
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Delete' && e.key !== 'Backspace') return
                      e.preventDefault()
                      editor.change('删除关键帧', (d) => {
                        const c = d.animations?.find((x) => x.id === clip.id),
                          target = c?.tracks.find((t) => t.nodeId === track.nodeId)
                        if (!c || !target || !target.keyframes[index]) return
                        target.keyframes = removeKeyframeAt(target.keyframes, index)
                        // Dropping the last keyframe drops the row as well.
                        if (!target.keyframes.length)
                          c.tracks = c.tracks.filter((t) => t !== target)
                      })
                      if (selectedKey?.nodeId === track.nodeId) setSelectedKey(null)
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== undefined && e.button !== 0) return
                      const rect = (e.currentTarget as HTMLElement)
                        .closest('.animation-track-lane')
                        ?.getBoundingClientRect()
                      if (!rect) return
                      e.currentTarget.setPointerCapture?.(e.pointerId)
                      dragMoved.current = false
                      setDrag({
                        nodeId: track.nodeId,
                        index,
                        timeMs: keyframe.timeMs,
                        laneLeft: rect.left,
                        laneWidth: rect.width,
                      })
                    }}
                    onPointerMove={(e) => {
                      if (!drag || drag.nodeId !== track.nodeId || drag.index !== index) return
                      const ms = clampKeyframeTime(
                        track.keyframes,
                        index,
                        timelineTimeAt(e.clientX - drag.laneLeft, drag.laneWidth, clip.durationMs),
                      )
                      if (ms !== drag.timeMs) {
                        dragMoved.current = true
                        setDrag({ ...drag, timeMs: ms })
                      }
                    }}
                    onPointerUp={() => {
                      if (!drag || drag.nodeId !== track.nodeId || drag.index !== index) return
                      const ms = drag.timeMs
                      setDrag(null)
                      if (!dragMoved.current) return
                      setSelectedKey({ nodeId: track.nodeId, timeMs: ms })
                      onTime(ms)
                      editor.change('移动关键帧', (d) => {
                        const target = d.animations
                          ?.find((c) => c.id === clip.id)
                          ?.tracks.find((t) => t.nodeId === track.nodeId)
                        if (target) target.keyframes = moveKeyframeTime(target.keyframes, index, ms)
                      })
                    }}
                    onPointerCancel={() => {
                      dragMoved.current = false
                      setDrag(null)
                    }}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function AnimationPreview({
  document,
  clip,
  onClose,
  onTime,
}: {
  document: DesignDocument
  clip: AnimationClip
  onClose: () => void
  onTime?: (ms: number) => void
}) {
  const clock = useRef(new PlaybackClock()),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [settling, setSettling] = useState(false),
    [speed, setSpeed] = useState(1),
    [error, setError] = useState(''),
    [asset, setAsset] = useState<{ url: string; name: string } | null>(null)
  // JIT-orchestration session (gate ladder + bake + playback state machine).
  // One session per play press; the machine survives across pauses because
  // pausing only freezes the external clock.
  const session = useRef<OrchestratedPlaybackStart | null>(null)
  const stopSession = () => {
    const p = session.current?.playback
    if (p && p.state !== 'IDLE' && p.state !== 'COMMITTED' && p.state !== 'ABORTED') p.abort()
  }
  const syncPlaybackToClock = () => {
    const p = session.current?.playback
    if (p) p.seek(clock.current.value(performance.now()))
  }
  const host = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 800, height: 450 })
  const [epoch, setEpoch] = useState(0),
    [exporting, setExporting] = useState(false)
  const exportClient = useRef<KernelClient | null>(null)
  const videoReady = useVideoEncodeAvailable()
  const modal = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = window.document.activeElement
    modal.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  useEffect(
    () => () => {
      stopSession()
      exportClient.current?.dispose()
      exportClient.current = null
    },
    [],
  )
  useEffect(() => {
    const el = host.current
    if (!el) return
    const resize = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({
        width: Math.max(64, Math.min(960, Math.floor(r.width))),
        height: Math.max(64, Math.min(540, Math.floor(r.height))),
      })
    })
    resize.observe(el)
    return () => resize.disconnect()
  }, [])
  useEffect(() => {
    const hide = () => {
      if (window.document.hidden) {
        clock.current.pause(performance.now())
        setTime(clock.current.value(performance.now()))
        setEpoch((v) => v + 1)
        setPlaying(false)
      }
    }
    window.document.addEventListener('visibilitychange', hide)
    return () => window.document.removeEventListener('visibilitychange', hide)
  }, [])
  // Frame driver: the orchestration session owns the transition semantics.
  // The JIT track advances from the caller-supplied absolute clock value
  // (wall-clock contract, no dt clamp); the legacy track accumulates dt from
  // clock deltas with the orchestrator's internal 1/30s clamp. SETTLING
  // frames interpolate on real time inside the machine. Frame samples emit
  // only on time changes, so an unchanged clock (paused tab, settle hold)
  // costs no kernel resampling (renderer prepare_animation skip path).
  useEffect(() => {
    if (!playing && !settling) return
    let raf = 0
    let lastClockValue: number | null = null
    const tick = (now: number) => {
      const active = session.current
      const playback = active?.playback
      if (!playback) return
      const t = clock.current.value(now)
      const frame =
        active && active.gate.implementation === 'jit'
          ? playback.tick(t)
          : playback.advance(lastClockValue === null ? 0 : (t - lastClockValue) / 1000)
      lastClockValue = t
      setTime(frame.timeMs)
      if (frame.ended === 'COMMIT' || frame.ended === 'ABORT') {
        // COMMIT lands on the end frame; an ABORT settle lands on its
        // reverted final frame (back to the source side of the drag).
        clock.current.seek(frame.timeMs, now)
        clock.current.pause(now)
        setEpoch((v) => v + 1)
        setPlaying(false)
        setSettling(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, settling])
  useEffect(
    () => () => {
      if (asset) URL.revokeObjectURL(asset.url)
    },
    [asset],
  )
  const bounds = useMemo(
    () => unionBounds(scene(document, clip.pageId).map((e) => e.bounds)),
    [document, clip.pageId],
  )
  const view = fitBounds(bounds, size, { padding: 24, maxZoom: 4 })
  const elapsed = Math.max(0, time - clip.delayMs),
    phase =
      clip.repeat === 'once'
        ? Math.min(elapsed, clip.durationMs)
        : clip.repeat === 'alternate' && Math.floor(elapsed / clip.durationMs) % 2
          ? clip.durationMs - (elapsed % clip.durationMs)
          : elapsed % clip.durationMs
  const display = Math.min(
    clip.delayMs + clip.durationMs,
    time < clip.delayMs ? time : clip.delayMs + phase,
  )
  // Shared preview progress: the panel timeline playhead subscribes to the
  // slider value through this callback. Cheapest option versus hoisting the
  // clock state into the panel; the panel keeps the last reported value as a
  // static playhead after the modal closes.
  useEffect(() => {
    onTime?.(display)
  }, [display, onTime])
  const seek = (t: number) => {
    setEpoch((v) => v + 1)
    clock.current.seek(t, performance.now())
    setTime(t)
    syncPlaybackToClock()
  }
  const pause = () => {
    setEpoch((v) => v + 1)
    clock.current.pause(performance.now())
    setTime(clock.current.value(performance.now()))
    setPlaying(false)
  }
  async function exportFrame() {
    const client = new KernelClient()
    exportClient.current = client
    setExporting(true)
    try {
      const options: KernelOptions = {
        ...size,
        pageId: clip.pageId,
        view,
        grid: false,
        transparent: false,
        rasterProfile: document.rasterProfile || 'analytic',
        animation: { clipId: clip.id, timeMs: time },
      }
      const frame = await client.render(document, options, true)
      if (exportClient.current !== client) return
      setAsset({
        url: URL.createObjectURL(new Blob([new Uint8Array(frame.bytes)], { type: 'image/png' })),
        name: `${clip.name}-${Math.round(time)}ms.png`,
      })
      setError('')
    } catch (e) {
      if (exportClient.current === client) setError(String(e))
    } finally {
      client.dispose()
      if (exportClient.current === client) {
        exportClient.current = null
        setExporting(false)
      }
    }
  }
  async function exportVideo(format: 'mp4' | 'webm') {
    const bridge = desktopBridge()?.videoEncode
    if (!bridge) {
      setError('桌面未提供 FFmpeg 编码')
      return
    }
    const client = new KernelClient()
    exportClient.current = client
    setExporting(true)
    try {
      const times = motionPreviewTimes(clip.delayMs + clip.durationMs)
      const frames: Uint8Array[] = []
      for (const timeMs of times) {
        if (exportClient.current !== client) return
        const frame = await client.render(document, {
          ...size,
          pageId: clip.pageId,
          view,
          grid: false,
          transparent: false,
          rasterProfile: document.rasterProfile || 'analytic',
          animation: { clipId: clip.id, timeMs },
        }, true)
        frames.push(frame.bytes)
      }
      if (exportClient.current !== client) return
      const encoded = await encodeDesktopFrames(bridge, { format, fps: MOTION_PREVIEW_FPS, frames })
      if (exportClient.current !== client) return
      setAsset({
        url: URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mime })),
        name: motionFileName(clip.name, format),
      })
      setError('')
    } catch (e) {
      if (exportClient.current === client) setError(String(e))
    } finally {
      client.dispose()
      if (exportClient.current === client) {
        exportClient.current = null
        setExporting(false)
      }
    }
  }
  return (
    <div
      className="animation-modal"
      ref={modal}
      tabIndex={-1}
      role="dialog"
      aria-label="动画预览"
      aria-modal="true"
      onKeyUpCapture={(e) => e.stopPropagation()}
      onKeyDownCapture={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          stopSession()
          onClose()
        }
        if (e.key === 'Tab') {
          const items = [
            ...(modal.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input,select,a[href]',
            ) || []),
          ]
          const first = items[0],
            last = items.at(-1)
          if (
            e.shiftKey &&
            (window.document.activeElement === first ||
              window.document.activeElement === modal.current)
          ) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && window.document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <div className="animation-player">
        <div className="animation-heading">
          <strong>{clip.name}</strong>
          <span>动画预览</span>
          <button
            type="button"
            onClick={() => {
              stopSession()
              onClose()
            }}
          >
            关闭预览
          </button>
        </div>
        <div className="animation-preview-host" ref={host}>
          <div style={{ width: size.width, height: size.height, position: 'relative' }}>
            <KernelSurface
              document={document}
              pageId={clip.pageId}
              {...size}
              view={view}
              grid={false}
              rasterProfile={document.rasterProfile || 'analytic'}
              maxPixelRatio={1}
              presentationEpoch={epoch}
              animation={{ clipId: clip.id, timeMs: time }}
            />
          </div>
        </div>
        <div className="animation-transport">
          <button
            type="button"
            onClick={() => {
              if (playing) pause()
              else {
                if (clip.repeat === 'once' && time >= clip.delayMs + clip.durationMs) seek(0)
                // Gate ladder + bake run once per play press, never per frame.
                // The gate outcome only picks the advance source (jit = wall
                // clock, legacy = dt-clamped); a fallback still plays.
                session.current = startOrchestratedPlayback(
                  document,
                  { clipId: clip.id, pageId: clip.pageId },
                  {
                    isKernelReady: kernelModuleReady,
                    // Per-frame dirty-node contract: the count of touched
                    // nodes lands on the host element for damage consumers.
                    onDirtyNodes: (ids) => {
                      host.current?.setAttribute('data-animation-dirty', String(ids.length))
                    },
                  },
                )
                session.current.playback?.start(clock.current.value(performance.now()))
                clock.current.play(performance.now())
                setPlaying(true)
              }
            }}
          >
            {playing ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            onClick={() => {
              stopSession()
              pause()
              seek(0)
            }}
          >
            回到开头
          </button>
          <input
            type="range"
            aria-label="预览时间"
            min="0"
            max={clip.delayMs + clip.durationMs}
            step="1"
            value={display}
            onPointerDown={() => {
              // External drag control (SCRUB): freeze the wall clock and let
              // the machine's drag phase own the time source. Releasing
              // settles — |target - progress| × duration — to the nearer end.
              const p = session.current?.playback
              if (p?.state === 'PLAYING') {
                clock.current.pause(performance.now())
                setPlaying(false)
                p.beginScrub()
                p.setScrubProgress(timelineRatio(display - clip.delayMs, clip.durationMs))
              }
            }}
            onChange={(e) => {
              const t = e.currentTarget.valueAsNumber
              const p = session.current?.playback
              if (p?.state === 'SCRUB') {
                p.setScrubProgress(timelineRatio(t - clip.delayMs, clip.durationMs))
                setTime(t)
              } else seek(t)
            }}
            onPointerUp={() => {
              const p = session.current?.playback
              if (p?.state === 'SCRUB') {
                p.releaseScrub(p.progress > 0.5)
                setSettling(true)
              }
            }}
          />
          <output aria-label="当前动画时间">{Math.round(time)} ms</output>
          <select
            aria-label="播放速度"
            value={speed}
            onChange={(e) => {
              const rate = Number(e.target.value)
              clock.current.speed(rate, performance.now())
              setSpeed(rate)
              syncPlaybackToClock()
            }}
          >
            {[0.25, 0.5, 1, 2, 4].map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
          <button type="button" disabled={exporting} onClick={() => void exportFrame()}>
            导出当前帧 PNG
          </button>
          {videoReady && (
            <>
              <button type="button" disabled={exporting} onClick={() => void exportVideo('mp4')}>
                导出 MP4
              </button>
              <button type="button" disabled={exporting} onClick={() => void exportVideo('webm')}>
                导出 WebM
              </button>
            </>
          )}
          {asset && (
            <a href={asset.url} download={asset.name}>
              下载 {asset.name}
            </a>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  )
}

export function AnimationPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot),
    clips = s.doc.animations?.filter((c) => c.pageId === s.page) || []
  const [selected, setSelected] = useState(''),
    [includeDescendants, setIncludeDescendants] = useState(false),
    [time, setTime] = useState(1000),
    [easing, setEasing] = useState<Easing>(structuredClone(easeInOut)),
    [preview, setPreview] = useState(false),
    [previewTime, setPreviewTime] = useState<number | null>(null)
  const clip = clips.find((c) => c.id === selected) || clips[0]
  const update = (label: string, fn: (clip: AnimationClip) => void) => {
    if (clip)
      editor.change(label, (d) => {
        const target = d.animations?.find((c) => c.id === clip.id)
        if (target) fn(target)
      })
  }
  const selectedTracks = clip?.tracks.filter((t) => s.selection.includes(t.nodeId)) || []
  const selectedNode = s.selection[0]
  useEffect(() => {
    const track = clip?.tracks.find((t) => t.nodeId === selectedNode) || clip?.tracks[0]
    const key = track?.keyframes.filter((k) => k.timeMs <= time).at(-1) || track?.keyframes[0]
    if (key) setEasing(structuredClone(key.easing))
  }, [clip?.id, selectedNode, time])
  return (
    <section className="animation-panel" aria-label="动画时间轴">
      <div className="animation-heading">
        <strong>动画</strong>
        <select
          aria-label="当前动画"
          value={clip?.id || ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          {!clips.length && <option value="">尚未创建动画</option>}
          {clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!s.selection.length}
          onClick={() => {
            try {
              const next = createClip(s.doc, s.page, s.selection, includeDescendants)
              editor.change('创建动画', (d) => {
                d.animations = [...(d.animations || []), next]
              })
              setSelected(next.id)
              setTime(1000)
            } catch (e) {
              editor.notify(String(e))
            }
          }}
        >
          从选区创建动画
        </button>
        <label><input type="checkbox" checked={includeDescendants} onChange={e => setIncludeDescendants(e.target.checked)}/>包含子图层轨道</label>
        <button type="button" onClick={onClose}>
          收起动画
        </button>
      </div>
      {!clip ? (
        <p>选择图层后创建动画；编辑画布上的位置、颜色或效果，再记录关键帧。</p>
      ) : (
        <>
          <div className="animation-properties">
            <label>
              名称
              <input
                aria-label="动画名称"
                value={clip.name}
                onChange={(e) =>
                  update('重命名动画', (c) => {
                    c.name = e.target.value
                  })
                }
              />
            </label>
            <label>
              时长 ms
              <input
                type="number"
                aria-label="动画时长"
                min="1"
                max="600000"
                value={clip.durationMs}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber
                  if (Number.isFinite(n) && n >= 1 && n <= 600000) {
                    update('修改动画时长', (c) => {
                      for (const t of c.tracks)
                        for (const k of t.keyframes) k.timeMs = (k.timeMs / c.durationMs) * n
                      c.durationMs = n
                    })
                    setTime(Math.min(time, n))
                  }
                }}
              />
            </label>
            <label>
              延迟 ms
              <input
                type="number"
                aria-label="动画延迟"
                min="0"
                max="600000"
                value={clip.delayMs}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber
                  if (Number.isFinite(n))
                    update('修改动画延迟', (c) => {
                      c.delayMs = n
                    })
                }}
              />
            </label>
            <label>
              重复
              <select
                aria-label="动画重复"
                value={clip.repeat}
                onChange={(e) =>
                  update('修改动画重复', (c) => {
                    c.repeat = e.target.value as AnimationClip['repeat']
                  })
                }
              >
                <option value="once">一次</option>
                <option value="loop">循环</option>
                <option value="alternate">往返</option>
              </select>
            </label>
            <button type="button" onClick={() => setPreview(true)}>
              预览动画
            </button>
            <button
              type="button"
              onClick={() =>
                editor.change('删除动画', (d) => {
                  d.animations = d.animations?.filter((c) => c.id !== clip.id)
                })
              }
            >
              删除动画
            </button>
          </div>
          <div className="animation-record">
            <label>
              记录时间 ms
              <input
                type="number"
                aria-label="关键帧时间"
                min="0"
                max={clip.durationMs}
                value={time}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber
                  if (Number.isFinite(n)) setTime(n)
                }}
              />
            </label>
            <button
              type="button"
              disabled={!s.selection.length}
              onClick={() =>
                editor.change('记录动画关键帧', (d) => {
                  const c = d.animations?.find((c) => c.id === clip.id)
                  if (c) recordKeyframe(d, c, s.selection, time, easing, includeDescendants)
                })
              }
            >
              记录选区当前状态
            </button>
            <button
              type="button"
              disabled={!selectedTracks.length}
              onClick={() =>
                update('修改关键帧缓动', (c) => {
                  for (const t of c.tracks)
                    if (s.selection.includes(t.nodeId))
                      for (const k of t.keyframes) k.easing = structuredClone(easing)
                })
              }
            >
              应用缓动到选中轨道
            </button>
            <span>{clip.tracks.length} 个图层轨道</span>
          </div>
          <EasingControls value={easing} onChange={setEasing} />
          <Timeline
            clip={clip}
            editor={editor}
            easing={easing}
            time={time}
            onTime={setTime}
            playheadMs={previewTime}
          />
        </>
      )}
      {preview && clip && (
        <AnimationPreview
          key={clip.id}
          document={s.doc}
          clip={clip}
          onClose={() => setPreview(false)}
          onTime={setPreviewTime}
        />
      )}
    </section>
  )
}
