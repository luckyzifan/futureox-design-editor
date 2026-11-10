import { expect, test } from 'vitest'
import type { Definition, Schema } from 'kiwi-schema'
import { decodeKiwi } from './import-fig'

const SEGMENT = 2_000_000

function definition(name: string, kind: Definition['kind'], fields: Definition['fields']): Definition {
  return { name, kind, line: 0, column: 0, fields }
}
function field(name: string, type: string, value: number, isArray = false): Definition['fields'][number] {
  return { name, type, value, isArray, isDeprecated: false, line: 0, column: 0 }
}
function schema(definitions: Definition[]): Schema {
  return { package: null, definitions }
}

function writer(capacity: number) {
  const bytes = new Uint8Array(capacity)
  let at = 0
  const reserve = (extra: number) => {
    if (at + extra <= bytes.length) return
    throw new Error('fixture writer overflow')
  }
  return {
    uvar(value: number) {
      reserve(10)
      let rest = value >>> 0
      while (rest > 0x7f) {
        bytes[at++] = (rest & 0x7f) | 0x80
        rest >>>= 7
      }
      bytes[at++] = rest
    },
    fill(count: number, value: number) {
      reserve(count)
      bytes.fill(value, at, at + count)
      at += count
    },
    finish() {
      return bytes.subarray(0, at)
    },
  }
}

test('a message array past one segment keeps every element and the following field', () => {
  const items = 2_900
  const values = 700
  const decodedSchema = schema([
    definition('Item', 'MESSAGE', [field('values', 'uint', 1, true)]),
    definition('Message', 'MESSAGE', [field('items', 'Item', 1, true), field('tail', 'uint', 2, true)]),
  ])
  // Worst case two bytes per uint, plus tags. The combined read count is over one segment.
  const out = writer(items * (8 + values * 2) + 32)
  out.uvar(1)
  out.uvar(items)
  for (let index = 0; index < items; index++) {
    out.uvar(1)
    out.uvar(values)
    for (let value = 0; value < values; value++) out.uvar((index + value) & 0x7f)
    out.uvar(0)
  }
  out.uvar(2)
  out.uvar(3)
  out.uvar(9)
  out.uvar(8)
  out.uvar(7)
  out.uvar(0)
  expect(1 + items * (1 + values)).toBeGreaterThan(SEGMENT)
  const data = decodeKiwi(decodedSchema, out.finish())
  expect(data.items).toHaveLength(items)
  expect(data.items[0].values).toHaveLength(values)
  expect(data.items[0].values[0]).toBe(0)
  expect(data.items[items - 1].values).toHaveLength(values)
  expect(data.items[items - 1].values[0]).toBe((items - 1) & 0x7f)
  expect(data.tail).toEqual([9, 8, 7])
}, 60_000)

test('one struct that cannot fit in an empty segment still rejects without raising the budget', () => {
  const columns = 11
  const length = 190_000
  const decodedSchema = schema([
    definition('Heavy', 'STRUCT', Array.from({ length: columns }, (_, index) => field(`column${index}`, 'uint', index, true))),
    definition('Item', 'MESSAGE', [field('payload', 'Heavy', 1)]),
    definition('Message', 'MESSAGE', [field('items', 'Item', 1, true)]),
  ])
  const out = writer(columns * (length + 8) + 32)
  out.uvar(1)
  out.uvar(1)
  out.uvar(1)
  for (let column = 0; column < columns; column++) {
    out.uvar(length)
    out.fill(length, 1)
  }
  out.uvar(0)
  out.uvar(0)
  expect(columns * length).toBeGreaterThan(SEGMENT)
  expect(() => decodeKiwi(decodedSchema, out.finish())).toThrow('FIG 解码预算超限')
}, 60_000)

test('depth 128 still decodes and depth 129 still rejects', () => {
  const decodedSchema = schema([
    definition('Message', 'MESSAGE', [field('child', 'Message', 1)]),
  ])
  const allowed = new Uint8Array(128 + 129)
  allowed.fill(1, 0, 128)
  expect(decodeKiwi(decodedSchema, allowed).child).toBeTypeOf('object')
  const tooDeep = new Uint8Array(130)
  tooDeep.fill(1, 0, 129)
  expect(() => decodeKiwi(decodedSchema, tooDeep)).toThrow('FIG 解码预算超限')
})

test('byte arrays stay inside the byte ceiling and non-byte arrays keep the 200000 guard', () => {
  const blob = schema([definition('Message', 'MESSAGE', [field('blob', 'byte', 1, true)])])
  const count = SEGMENT + 1
  const out = writer(count + 16)
  out.uvar(1)
  out.uvar(count)
  out.fill(count, 7)
  out.uvar(0)
  const decoded = decodeKiwi(blob, out.finish())
  expect(decoded.blob).toBeInstanceOf(Uint8Array)
  expect(decoded.blob.length).toBe(count)
  expect(decoded.blob[0]).toBe(7)
  expect(decoded.blob[count - 1]).toBe(7)
  const values = schema([definition('Message', 'MESSAGE', [field('values', 'uint', 1, true)])])
  const tooMany = writer(16)
  tooMany.uvar(1)
  tooMany.uvar(200_001)
  expect(() => decodeKiwi(values, tooMany.finish())).toThrow('FIG 数组过大')
})
