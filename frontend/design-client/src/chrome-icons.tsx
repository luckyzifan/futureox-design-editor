import type { ComponentType, ReactNode } from 'react'
import { isImportedRasterFile } from './image-import'

export type GlyphIcon = ComponentType<{ size?: number }>
export type FileKind = 'fd' | 'sketch' | 'fig' | 'svg' | 'pdf' | 'image'

const fileLabel: Record<FileKind, string> = { fd: 'FD', sketch: 'SK', fig: 'FIG', svg: 'SVG', pdf: 'PDF', image: 'IMG' }

export function fileKind(name: string): FileKind {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'sketch') return 'sketch'
  if (ext === 'fig') return 'fig'
  if (ext === 'svg' || ext === 'svgz') return 'svg'
  if (ext === 'pdf') return 'pdf'
  if (isImportedRasterFile(name)) return 'image'
  return 'fd'
}

export function FileMark({ name, kind, size = 28 }: { name?: string; kind?: FileKind; size?: number }) {
  const resolved = kind ?? fileKind(name ?? '')
  const label = fileLabel[resolved]
  return <svg className="file-mark" width={size} height={Math.round(size * 1.25)} viewBox="0 0 32 40" aria-hidden="true" style={{ color: 'var(--workspace-accent, #3459d4)' }}>
    <path d="M7 2.2h12.2L26.2 9.2V35.2a2.2 2.2 0 0 1-2.2 2.2H7a2.2 2.2 0 0 1-2.2-2.2V4.4A2.2 2.2 0 0 1 7 2.2Z" fill="#fff" stroke="currentColor" strokeWidth="1.6" />
    <path d="M19.2 2.6V9.2h6.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M4.8 24.2h22.4V35a2.2 2.2 0 0 1-2.2 2.2H7a2.2 2.2 0 0 1-2.2-2.2v-10.8Z" fill="currentColor" />
    <text x="16" y="33.2" textAnchor="middle" fill="#fff" fontSize={label.length > 2 ? 6.2 : 7.4} fontFamily="Inter, sans-serif" fontWeight={700}>{label}</text>
  </svg>
}

function Icon({ size = 18, filled = false, children }: { size?: number; filled?: boolean; children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
}

const stroke: Record<string, string[]> = {
  hand: ['M8 11.2V7.2a1.35 1.35 0 0 1 2.7 0v4', 'M10.7 10.6V5.4a1.35 1.35 0 0 1 2.7 0V12', 'M13.4 10.8V7a1.35 1.35 0 0 1 2.7 0v5.4', 'M7.2 11.4 6.2 9.8a1.25 1.25 0 0 0-2.2 1.1c.3 1.8 1.2 3.5 2.8 4.6 1.7 1.1 3.5 1.4 5.4.8 2.1-.6 3.5-2.2 4-4.4'],
  zoom: ['M11 11m-5.2 0a5.2 5.2 0 1 0 10.4 0a5.2 5.2 0 1 0-10.4 0', 'M15.2 15.2 19.2 19.2'],
  scale: ['M9 4H4v5', 'M15 20h5v-5', 'M4 4l6.2 6.2', 'M20 20l-6.2-6.2'],
  frame: ['M8 4H5.5A1.5 1.5 0 0 0 4 5.5V8', 'M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8', 'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16', 'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16', 'M8 8h8v8H8z'],
  section: ['M5 7.5h14v11H5z', 'M5 11h14'],
  slice: ['M8 4v2.5', 'M4 8h2.5', 'M16 4v2.5', 'M20 8h-2.5', 'M8 20v-2.5', 'M4 16h2.5', 'M16 20v-2.5', 'M20 16h-2.5', 'M8.5 8.5h7v7h-7z'],
  rectangle: ['M6.5 5.5h11a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17V7a1.5 1.5 0 0 1 1.5-1.5z'],
  ellipse: ['M12 5.2c4.2 0 7.2 3 7.2 6.8s-3 6.8-7.2 6.8-7.2-3-7.2-6.8 3-6.8 7.2-6.8z'],
  polygon: ['M12 3.8 19.2 8.8 16.6 18.8H7.4L4.8 8.8 12 3.8z'],
  star: ['M12 3.6 14.4 9l5.8.5-4.4 3.8 1.4 5.6L12 16.2 6.8 18.9 8.2 13.3 3.8 9.5 9.6 9 12 3.6z'],
  line: ['M5 19 19 5'],
  arrow: ['M6 18 18 6', 'M10 6h8v8'],
  pen: ['M14.2 4.2 19.8 9.8 9 20.6H3.4V15L14.2 4.2z', 'M12.6 5.8 18.2 11.4'],
  pencil: ['M4 20.2 5.4 15.6 15.6 5.4l3.2 3.2L8.6 18.8 4 20.2z', 'M13.8 7.2 16.8 10.2'],
  brush: ['M14.8 3.8c2.2 1.6 2.6 4.2 1.2 6.2L9.2 16.8c-.7.8-1.9 1.1-2.9.6L4.2 19.6l2.4-2.2c.5-1.1.1-2.3.8-3L14.2 7.6c.8-1 1.2-2.4.6-3.8z'],
  marker: ['M14 4.2 19.8 10 8.8 21H3.8v-5L14 4.2z', 'M12.4 5.8 18.2 11.6'],
  'washi-tape': ['M4.2 10.2 14.2 4.2 20 12.2 10 18.2 4.2 10.2z', 'M7.2 11.4 15.4 7.4', 'M8.4 13.6 16.6 9.6'],
  text: ['M6 6.5h12', 'M12 6.5V19', 'M8.5 19h7'],
  eraser: ['M14.8 4.2 20 9.4 11.2 18.2H6.4L3.8 14.2 12.6 5.4l2.2-1.2z', 'M8.6 15.6 12.6 11.6'],
  eyedropper: ['M14.6 4.2 19.8 9.4', 'M13.2 5.6 8.4 10.4a2.8 2.8 0 0 0 0 4l.6.6-3.6 3.6', 'M11.2 12.8 15.4 8.6'],
  'paint-bucket': ['M7.6 13.2 13.8 7a2 2 0 0 1 2.8 2.8l-6.2 6.2H7.2L5.6 14.6l2-1.4z', 'M16.8 16.2c.9.7 1.4 1.5 1.4 2.2a1.5 1.5 0 0 1-2.8.7'],
  measure: ['M4.5 16.8 16.8 4.5', 'M7.2 14.1 9.2 16.1', 'M10.2 11.1 12.2 13.1', 'M13.2 8.1 15.2 10.1'],
  crop: ['M7 3.5V17h13.5', 'M17 20.5V7H3.5'],
  comments: ['M6 6.2h12a1.8 1.8 0 0 1 1.8 1.8v6.2a1.8 1.8 0 0 1-1.8 1.8H11l-3.6 2.8v-2.8H6a1.8 1.8 0 0 1-1.8-1.8V8a1.8 1.8 0 0 1 1.8-1.8z'],
  undo: ['M8 7H4.2V10.8', 'M5 8.4a7.2 7.2 0 1 1-1.2 6.4'],
  redo: ['M16 7h3.8V10.8', 'M19 8.4a7.2 7.2 0 1 0 1.2 6.4'],
}

function ToolGlyph({ name, size }: { name: string; size?: number }) {
  if (name === 'select') return <Icon size={size} filled><path d="M5.4 3.2 5.6 16.6 9.6 12.8 14 19.6 16.6 18.4 12.2 11.6 17.2 11 5.4 3.2Z" /></Icon>
  const paths = stroke[name] ?? stroke.rectangle
  return <Icon size={size}>{paths.map(d => <path key={d} d={d} />)}</Icon>
}

function makeGlyph(name: string): GlyphIcon {
  function Glyph({ size }: { size?: number }) { return <ToolGlyph name={name} size={size} /> }
  return Glyph
}

export const toolGlyph = {
  select: makeGlyph('select'),
  hand: makeGlyph('hand'),
  zoom: makeGlyph('zoom'),
  scale: makeGlyph('scale'),
  frame: makeGlyph('frame'),
  section: makeGlyph('section'),
  slice: makeGlyph('slice'),
  rectangle: makeGlyph('rectangle'),
  ellipse: makeGlyph('ellipse'),
  polygon: makeGlyph('polygon'),
  star: makeGlyph('star'),
  line: makeGlyph('line'),
  arrow: makeGlyph('arrow'),
  pen: makeGlyph('pen'),
  pencil: makeGlyph('pencil'),
  brush: makeGlyph('brush'),
  marker: makeGlyph('marker'),
  'washi-tape': makeGlyph('washi-tape'),
  text: makeGlyph('text'),
  eraser: makeGlyph('eraser'),
  eyedropper: makeGlyph('eyedropper'),
  'paint-bucket': makeGlyph('paint-bucket'),
  measure: makeGlyph('measure'),
  crop: makeGlyph('crop'),
  comments: makeGlyph('comments'),
  undo: makeGlyph('undo'),
  redo: makeGlyph('redo'),
} as const
