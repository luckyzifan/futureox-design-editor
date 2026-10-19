/**
 * Measurement overlay types for distance display (Figma-style).
 * Generated from Rust kernel `measurement.rs`.
 */

export interface Measurement {
  nodeId: string
  direction: 'horizontal' | 'vertical'
  distance: number
  start: { x: number; y: number }
  end: { x: number; y: number }
  relatedNode?: string
}

/**
 * Calculate measurements for a target node.
 * Returns measurements to parent edges and sibling nodes,
 * sorted by distance (closest first), limited to 8 measurements.
 *
 * @param targetId - Node ID to measure from
 * @returns Promise<Measurement[]> - List of measurements
 *
 * TODO: Wire this to the Rust kernel export function:
 * `calculate_node_measurements` in design-kernel/src/export.rs
 */
export async function calculateNodeMeasurements(
  targetId: string,
): Promise<Measurement[]> {
  // TODO: Call Rust kernel via worker
  // For now, return empty array (no-op)
  console.warn('[Measurement] Rust kernel binding not yet wired')
  return []
}
