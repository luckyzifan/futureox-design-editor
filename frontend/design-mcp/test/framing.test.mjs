import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonLineReader } from '../src/framing.mjs'

function fixture(maxBytes = 256) {
  const lines = [], errors = []
  const reader = new JsonLineReader({ maxBytes, onLine: line => lines.push(line), onError: (error, kind) => errors.push({ message: error.message, kind }) })
  return { reader, lines, errors }
}
test('framing handles split UTF-8 and multiple lines', () => {
  const { reader, lines, errors } = fixture()
  const bytes = Buffer.from('{"text":"设计"}\n{}\r\n')
  for (const byte of bytes) reader.push(Buffer.from([byte]))
  assert.deepEqual(lines, ['{"text":"设计"}', '{}\r'])
  assert.deepEqual(errors, [])
})
test('oversized message is discarded through newline, then framing recovers', () => {
  const { reader, lines, errors } = fixture()
  reader.push(Buffer.alloc(200, 97)); reader.push(Buffer.alloc(200, 97)); reader.push(Buffer.from('\n{}\n'))
  assert.deepEqual(lines, ['{}'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].kind, 'size')
  assert(reader.buffer.length <= 256)
})
test('invalid UTF-8 rejected and unfinished EOF rejected', () => {
  const { reader, lines, errors } = fixture()
  reader.push(Buffer.from([0xff, 10])); reader.push(Buffer.from('{')); reader.end()
  assert.deepEqual(lines, [])
  assert.equal(errors.length, 2)
})
