export const FIG_WARNINGS_TRUNCATED = 'FIG compatibility warnings truncated; see droppedOccurrences.'
export const FIG_WARNING_LIMITS = { count: 128, messageBytes: 1024, totalBytes: 32 * 1024 } as const
export type ImportWarningSink = { add(message: string): unknown }

/** Retains only bounded messages and a bounded seen set. Oversized/new messages
 * beyond the budget count as dropped occurrences, never as silently cut text.
 * Reserve room for a single explicit truncation notice from the outset. */
export function boundedImportWarnings() {
  const messages: string[] = [], seen = new Set<string>(), encoder = new TextEncoder()
  const reserve = encoder.encode(FIG_WARNINGS_TRUNCATED).length
  let total = 0, dropped = 0
  const sink = {
    add(message: string) {
      if (seen.has(message)) return sink
      // UTF-16 length is a cheap lower bound before allocating encoded bytes.
      const size = message.length > FIG_WARNING_LIMITS.messageBytes
        ? FIG_WARNING_LIMITS.messageBytes + 1 : encoder.encode(message).length
      if (messages.length >= FIG_WARNING_LIMITS.count - 1 || size > FIG_WARNING_LIMITS.messageBytes ||
          total + size > FIG_WARNING_LIMITS.totalBytes - reserve) {
        dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1)
        return sink
      }
      seen.add(message); messages.push(message); total += size
      return sink
    },
    result() {
      return { warnings: dropped ? [...messages, FIG_WARNINGS_TRUNCATED] : [...messages],
        ...(dropped ? { droppedOccurrences: dropped } : {}) }
    },
  }
  return sink
}
