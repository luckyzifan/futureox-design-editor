/**
 * Measurement overlay component for Figma-style distance display.
 * Activated with Alt key, shows distances to parent edges and sibling nodes.
 */

import React from 'react'

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

export function MeasurementOverlay({ measurements, zoom, dpr }: MeasurementOverlayProps) {
  if (measurements.length === 0) return null

  // CSS properties for measurement overlay
  const lineStyle: React.CSSProperties = {
    stroke: '#f24822',
    strokeWidth: 1 / zoom,
    fill: 'none',
    vectorEffect: 'non-scaling-stroke',
  }

  const labelBgStyle: React.CSSProperties = {
    fill: 'white',
    stroke: '#f24822',
    strokeWidth: 0.5 / zoom,
    vectorEffect: 'non-scaling-stroke',
  }

  const textStyle: React.CSSProperties = {
    fill: '#000',
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

        // Label dimensions
        const labelText = Math.round(distance).toString()
        const labelWidth = Math.max(30, labelText.length * 7) / zoom
        const labelHeight = 18 / zoom
        const padding = 4 / zoom

        // Arrow endpoints (shortened to make room for label)
        const isVertical = direction === 'vertical'
        const arrowStart = isVertical
          ? { x: start.x, y: start.y + labelHeight / 2 + padding }
          : { x: start.x + labelWidth / 2 + padding, y: start.y }
        const arrowEnd = isVertical
          ? { x: end.x, y: end.y - labelHeight / 2 - padding }
          : { x: end.x - labelWidth / 2 - padding, y: end.y }

        return (
          <g key={`${m.nodeId}-${idx}`}>
            {/* Measurement line */}
            <line
              x1={arrowStart.x}
              y1={arrowStart.y}
              x2={arrowEnd.x}
              y2={arrowEnd.y}
              style={lineStyle}
            />

            {/* Arrowheads */}
            {distance > 20 && (
              <>
                <circle cx={start.x} cy={start.y} r={2 / zoom} fill="#f24822" />
                <circle cx={end.x} cy={end.y} r={2 / zoom} fill="#f24822" />
              </>
            )}

            {/* Distance label */}
            <g transform={`translate(${midX}, ${midY})`}>
              <rect
                x={-labelWidth / 2}
                y={-labelHeight / 2}
                width={labelWidth}
                height={labelHeight}
                rx={2 / zoom}
                style={labelBgStyle}
              />
              <text style={textStyle}>{labelText}</text>
            </g>
          </g>
        )
      })}
    </svg>
  )
}
