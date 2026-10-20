/** Explicit software-completion marker. None of these counters identify authored content. */
export type TerminalQuality = { qualitySequence: number; qualityRevision: number; pageToken: number;
  documentRevision?: number; generation?: number; fillGeneration?: number }
const fields = ['qualitySequence','qualityRevision','pageToken','documentRevision','generation','fillGeneration'] as const
export function terminalQualityMessage(input: unknown): TerminalQuality | undefined {
  if (!input || typeof input !== 'object') return
  const source = input as Record<string, unknown>, result: Record<string, number> = {}
  for (const key of fields) {
    const value = source[key]
    if (value === undefined && ['documentRevision','generation','fillGeneration'].includes(key)) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return
    result[key] = value
  }
  if (!result.qualitySequence) return
  return result as TerminalQuality
}
/** One bounded CPU probe per new completed frame marker, only after actual submit.
 * Monotonic UI sequence also prevents repeated repaint calls from flooding logs. */
export class TerminalQualityGate {
  private sequence = 0
  claim(input: unknown, enabled: boolean) {
    if (!enabled) return undefined
    const marker = terminalQualityMessage(input)
    if (!marker || marker.qualitySequence <= this.sequence) return undefined
    this.sequence = marker.qualitySequence
    return marker
  }
}
