import { expect, test } from 'vitest'
import { blank } from './model'
import { nativeDesignJson } from './native-design-json'
import { sourceErrorSummary, unwrapSourceError } from './source-error-text'

test('native design content accepts a string, a parsed document, or utf-8 bytes', () => {
  const document = blank('topology')
  const json = JSON.stringify(document)
  expect(nativeDesignJson(json)).toBe(json)
  expect(JSON.parse(nativeDesignJson(document)).name).toBe('topology')
  expect(JSON.parse(nativeDesignJson({ document })).name).toBe('topology')
  expect(nativeDesignJson(new TextEncoder().encode(json))).toBe(json)
  expect(nativeDesignJson(new TextEncoder().encode(json).buffer)).toBe(json)
  expect(nativeDesignJson({ type: 'Buffer', data: [...new TextEncoder().encode(json)] })).toBe(json)
  expect(nativeDesignJson('\ufeff' + json)).toBe(json)
})

test('a native response without design content keeps the Chinese reason', () => {
  for (const value of [undefined, null, '', 1, [], { hello: true }])
    expect(() => nativeDesignJson(value)).toThrow('原生文件响应缺少设计内容')
  expect(() => nativeDesignJson(new Uint8Array([0xff, 0xfe]))).toThrow('UTF-8')
  expect(() => nativeDesignJson({ type: 'Buffer', data: [0xff] })).toThrow('UTF-8')
})

test('an English wrapper does not hide a Chinese or useful failure', () => {
  expect(unwrapSourceError('Error: 原生文件响应缺少设计内容')).toBe('原生文件响应缺少设计内容')
  expect(unwrapSourceError('操作失败，当前画布已保留：Error: 原生文件响应缺少设计内容')).toBe('原生文件响应缺少设计内容')
  expect(sourceErrorSummary('Error: 原生文件响应缺少设计内容')).toBe('原生文件响应缺少设计内容')
  expect(sourceErrorSummary('操作失败，当前画布已保留：Error: 原生文件响应缺少设计内容')).toBe('原生文件响应缺少设计内容')
  expect(sourceErrorSummary('Error: Large document operation is busy')).toBe('Large document operation is busy')
  expect(sourceErrorSummary('unsupported imported document')).toContain('技术详情')
})
