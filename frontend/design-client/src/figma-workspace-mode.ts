import { useSyncExternalStore } from 'react'

/** Figma Design / Draw is editor chrome. It is not document, selection, or camera state. */
export type FigmaWorkspaceMode = 'design' | 'draw'

let mode: FigmaWorkspaceMode = 'design'
const listeners = new Set<() => void>()

export function figmaWorkspaceMode(): FigmaWorkspaceMode {
  return mode
}

export function setFigmaWorkspaceMode(next: FigmaWorkspaceMode): void {
  if (next !== 'design' && next !== 'draw') return
  if (next === mode) return
  mode = next
  for (const listener of listeners) listener()
}

export function subscribeFigmaWorkspaceMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function resetFigmaWorkspaceMode(): void {
  setFigmaWorkspaceMode('design')
}

export function useFigmaWorkspaceMode(): FigmaWorkspaceMode {
  return useSyncExternalStore(subscribeFigmaWorkspaceMode, figmaWorkspaceMode, () => 'design')
}
