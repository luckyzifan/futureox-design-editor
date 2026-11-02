/**
 * Measurement overlay component for Figma-style distance display.
 * Activated with Alt key, shows distances to parent edges and sibling nodes.
 */

import React from 'react'
import { measurementTicks, SPACING_RED } from '../canvas-measurements'

export interface Measurement {
  nodeId: string
  direction: 'horizontal' | 'vertical'
  distance: number
  start: { x: number; y: number }
  end: { x: number; y: number }
  relatedNode?: string
}

interface MeasurementOverlayProps {
  measurements: Measurement[]
  zoom: number
  dpr: number
}

export function MeasurementOverlay({ measurements, zoom }: MeasurementOverlayProps) {
  if (measurements.length === 0) return null

  const lineStyle: React.CSSProperties = {
    stroke: SPACING_RED,
    strokeWidth: 1 / zoom,
    fill: 'none',
    vectorEffect: 'non-scaling-stroke',
  }

  const textStyle: React.CSSProperties = {
    fill: SPACING_RED,
    stroke: '#fff',
    strokeWidth: 2 / zoom,
    paintOrder: 'stroke',
    fontSize: `${11 / zoom}px`,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontWeight: 500,
    textAnchor: 'middle',
    dominantBaseline: 'middle',
  }

  return (
    <svg
      className="measurement-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 10000,
      }}
    >
      {measurements.map((m, idx) => {
        const { start, end, distance, direction } = m
        const midX = (start.x + end.x) / 2
        const midY = (start.y + end.y) / 2
        const labelText = String(Number(distance.toFixed(2)))

        return (
          <g key={`${m.nodeId}-${idx}`}>
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} style={lineStyle} />
            {measurementTicks({ from: start, to: end, axis: direction === 'vertical' ? 'vertical' : 'horizontal' }, zoom).map(([from, to], tick) =>
              <line key={tick} x1={from.x} y1={from.y} x2={to.x} y2={to.y} style={lineStyle} />)}
            <text x={midX} y={midY - 6 / zoom} style={textStyle}>{labelText}</text>
          </g>
        )
      })}
    </svg>
  )
}
