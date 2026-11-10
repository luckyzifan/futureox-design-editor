import { expect, test } from 'vitest'
import { boundedImportWarnings, finalizeFigWarnings, FIG_WARNING_LIMITS, FIG_WARNINGS_TRUNCATED } from './import-warnings'
test('warning collection deduplicates retained notices and counts dropped occurrences', () => {
  const sink = boundedImportWarnings()
  sink.add('same'); sink.add('same')
  expect(sink.result()).toEqual({ warnings: ['same'] })
  for (let i = 0; i < 1000; i++) sink.add(`warning ${i}`)
  const result = sink.result()
  expect(result.warnings).toHaveLength(128)
  expect(result.warnings.at(-1)).toBe(FIG_WARNINGS_TRUNCATED)
  expect(result.droppedOccurrences).toBe(874)
})
test('UTF-8 message and aggregate limits include the reserved truncation notice', () => {
  const sink = boundedImportWarnings(), encoder = new TextEncoder()
  sink.add('字'.repeat(400)); sink.add('字'.repeat(400))
  for (let i = 0; i < 200; i++) sink.add(`${i}:` + '字'.repeat(330))
  const result = sink.result()
  expect(result.droppedOccurrences).toBeGreaterThanOrEqual(2)
  expect(result.warnings.every(s => encoder.encode(s).length <= FIG_WARNING_LIMITS.messageBytes)).toBe(true)
  expect(result.warnings.reduce((n, s) => n + encoder.encode(s).length, 0)).toBeLessThanOrEqual(FIG_WARNING_LIMITS.totalBytes)
})
test('final FIG warnings stay inside the worker contract after extra notices', () => {
  const messages = Array.from({ length: 200 }, (_, index) => `字体 Family ${index} 未捆绑，文字已保留，显示用当前回退。`)
  const report = finalizeFigWarnings(messages, 3)
  expect(report.warnings).toHaveLength(FIG_WARNING_LIMITS.count)
  expect(report.warnings.at(-1)).toBe(FIG_WARNINGS_TRUNCATED)
  expect(report.droppedOccurrences).toBeGreaterThan(3)
  expect(report.warnings.includes(FIG_WARNINGS_TRUNCATED)).toBe(true)
})
