export interface Measurement {
  nodeId: string
  direction: 'horizontal' | 'vertical'
  distance: number
  start: { x: number; y: number }
  end: { x: number; y: number }
  relatedNode?: string
}

export async function calculateNodeMeasurements(
  targetId: string,
): Promise<Measurement[]> {
  // TODO: Call Rust kernel via worker
  // For now, return empty array (no-op)
  console.warn('[Measurement] Rust kernel binding not yet wired')
  return []
}
