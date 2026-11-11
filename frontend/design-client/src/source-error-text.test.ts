import { expect, test } from 'vitest'
import { sourceErrorKind, sourceErrorSummary } from './source-error-text'

const WINDOW = '大型文档：Source subtree exceeds the bounded conversion window; select a smaller subtree'
const ALLOCATION = '本次处理未能分配所需内存。当前内容已保留，可释放其他应用的内存后重试。'

test('a fixed conversion window is not described as an allocation failure', () => {
  for (const error of [
    WINDOW,
    'Source subtree exceeds the bounded conversion window; select a smaller subtree',
    'Source batch exceeds conversion window',
    'Thumbnail conversion window exceeded',
    'Encoded Sketch image exceeds the conversion window',
    'Source conversion window exceeds its memory allowance',
  ]) {
    expect(sourceErrorKind(error)).toBe('window')
    const summary = sourceErrorSummary(error)
    expect(summary).toContain('固定转换窗口')
    expect(summary).toContain('选择较小页面、素材或子树')
    expect(summary).toContain('无需退出其他应用')
    expect(summary).not.toBe(ALLOCATION)
    expect(summary).not.toContain('可释放其他应用的内存后重试')
  }
})

test('capacity policy, allocation failure, corrupt input and unsupported semantics stay distinct', () => {
  const capacity = sourceErrorSummary('DOCUMENT_RESOURCE_LIMIT: allowance 2147483648-byte working-memory budget')
  const allocation = sourceErrorSummary('memory allocation failed')
  const corrupt = sourceErrorSummary('Truncated source window')
  const unsupported = sourceErrorSummary('unsupported imported document')
  expect(sourceErrorKind('DOCUMENT_RESOURCE_LIMIT: allowance 2147483648-byte working-memory budget')).toBe('capacity')
  expect(sourceErrorKind('Choose a smaller component dependency working set')).toBe('capacity')
  expect(sourceErrorKind('This document needs more working memory than this session can safely admit.')).toBe('capacity')
  expect(capacity).toContain('固定容量')
  expect(capacity).toContain('内存')
  expect(capacity).not.toContain('固定转换窗口')
  expect(capacity).not.toContain('可释放其他应用的内存后重试')
  expect(sourceErrorKind('out of memory')).toBe('allocation')
  expect(sourceErrorKind('memory allocation of 4096 bytes failed')).toBe('allocation')
  expect(allocation).toBe(ALLOCATION)
  expect(sourceErrorKind('Truncated source window')).toBe('corrupt')
  expect(sourceErrorKind('malformed sketch checksum')).toBe('corrupt')
  expect(corrupt).toContain('损坏')
  expect(corrupt).not.toContain('固定转换窗口')
  expect(corrupt).not.toBe(ALLOCATION)
  expect(sourceErrorKind('unsupported imported document')).toBe('unsupported')
  expect(unsupported).toContain('不支持')
  expect(unsupported).toContain('技术详情')
  expect(new Set([capacity, allocation, corrupt, unsupported, sourceErrorSummary(WINDOW)]).size).toBe(5)
})

test('a low startup budget and an already-Chinese repair stay specific', () => {
  const low = "invalid imported document: DOCUMENT_RESOURCE_LIMIT: document structure exceeds this session's allowance (256 nodes, 1024 pages; 1048576-byte working-memory budget)"
  expect(sourceErrorSummary(low)).toContain('1 MiB')
  expect(sourceErrorSummary(low)).toContain('启动配置')
  expect(sourceErrorSummary(low)).not.toContain('可释放其他应用的内存后重试')
  const repair = 'unsupported lossless conversion: Sketch instance requires an embedded symbol master: 6F0139C2-C417-4447-8E8B-5926F071C14F。不会发明主组件。'
  expect(sourceErrorSummary(repair)).toContain('不会发明主组件')
  expect(sourceErrorSummary(repair)).toContain('6F0139C2')
  expect(sourceErrorSummary('Error: Large document operation is busy')).toBe('Large document operation is busy')
  expect(sourceErrorSummary('操作已取消')).toBe('操作已取消，可以重新选择页面继续。')
})
