import { useLayoutEffect, useRef, useState } from 'react'
import type { NativeSketchContentProps } from './NativeSketchDialog'
import { SketchEditDialog } from './SketchEditDialog'
import { SketchInspectionDialog } from './SketchInspectionDialog'
import { admitSketchInspection, type SketchInspection } from './sketch-inspection'
import { nativeSketchCapabilities } from './native-sketch-capabilities'

/** Loaded only after the user chooses a native Sketch workflow. */
export function NativeSketchDialogContent({ bridge, mode, onClose }: NativeSketchContentProps) {
  const [result, setResult] = useState<SketchInspection | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('')
  const alive = useRef(true), reading = useRef(false), generation = useRef(0)
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  const inspect = async () => {
    if (reading.current || !bridge.inspectSketch) return
    reading.current = true; setPending(true); setError('')
    const request = ++generation.current
    try {
      const value = await bridge.inspectSketch()
      if (!alive.current || request !== generation.current) return
      if (value.status === 'ok') setResult(admitSketchInspection(value))
      else if (value.status !== 'cancelled') setError(value.message)
    } catch (failure) { if (alive.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { reading.current = false; if (alive.current && request === generation.current) setPending(false) }
  }
  const capabilities = nativeSketchCapabilities(bridge)
  return mode === 'edit' && capabilities.edit ? <SketchEditDialog bridge={bridge.sketchSession!} onClose={onClose} /> :
    <SketchInspectionDialog result={result} onClose={onClose} onChoose={capabilities.inspect ? () => void inspect() : undefined} pending={pending}
      error={capabilities.inspect ? error : '当前宿主未提供原生 Sketch 预览。请使用兼容格式导入。'} />
}
