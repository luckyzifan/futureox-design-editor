import type { DesignNode } from './model'
import { layerPreviewSpec } from './layer-preview'

/** Draw-mode layer preview. Double-click asks the caller to zoom; it does not
 * change the document by itself. */
export function LayerThumbnail({ node, label, onZoom }: { node: DesignNode; label: string; onZoom: () => void }) {
  const spec = layerPreviewSpec(node)
  const color = spec.color
  return <button type="button" className="layer-thumb always" tabIndex={-1} data-layer-preview={spec.shape} aria-label={label}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onZoom() }}>
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      {spec.shape === 'ellipse' ? <ellipse cx="14" cy="14" rx="9" ry="7" fill={color} />
        : spec.shape === 'line' ? <line x1="4" y1="20" x2="24" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
        : spec.shape === 'text' ? <text x="8" y="19" fontSize="14" fill={color}>T</text>
        : spec.shape === 'vector' ? <path d="M5 20 C9 6 16 22 23 8" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
        : spec.shape === 'frame' ? <rect x="5" y="5" width="18" height="18" rx="2" fill="none" stroke={color} strokeWidth="1.6" />
        : <rect x="5" y="6" width="18" height="16" rx="2" fill={color} />}
    </svg>
  </button>
}
