import { useLayoutEffect, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { apply, worldMatrix, type SceneEntry } from './geometry'
import { SELECTION_BLUE } from './selection-blue'

export function ArrangementPreview({ editor, entries, zoom, enabled }: {
  editor: Editor; entries: readonly SceneEntry[]; zoom: number; enabled: boolean
}) {
  const preview = useSyncExternalStore(editor.subscribeLiveArrangement, () => editor.liveArrangement)
  const { doc, page, selection, busy } = editor.state
  const current = preview && enabled && !busy && !editor.interactionActive && preview.document === doc &&
    preview.page === page && preview.session === editor.sessionGeneration && preview.selection === selection
  useLayoutEffect(() => {
    if (preview && !current && editor.liveArrangement === preview) editor.setLiveArrangement(null)
  }, [current, editor, preview])
  if (!preview || !current) return null
  const parents = editor.parentMap(doc)
  return <g data-testid="arrangement-preview" aria-hidden="true" pointerEvents="none">
    {entries.map(entry => {
      const patch = preview.patches[entry.id]
      if (!patch) return null
      const original = doc.nodes[entry.id].transform
      const parent = worldMatrix(doc, entry.parent, parents)
      const from = apply(parent, { x: original[4], y: original[5] })
      const to = apply(parent, { x: patch.transform[4], y: patch.transform[5] })
      const { x, y, width, height } = entry.bounds
      return <rect key={entry.id} data-node-id={entry.id} x={x + to.x - from.x} y={y + to.y - from.y} width={width} height={height}
        fill={SELECTION_BLUE} fillOpacity={0.08} stroke={SELECTION_BLUE} strokeWidth={1.5 / zoom}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`} />
    })}
  </g>
}
