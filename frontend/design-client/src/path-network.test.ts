import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { SVGPathData } from 'svg-pathdata'
import { afterEach, expect, test, vi } from 'vitest'
import { pathNetwork } from './path-network'
import { pathNetwork as compatibilityPathNetwork } from './import-svg'
import { uid, type Network } from './model'

// Execute the actual pre-extraction implementation, retained with its complete
// source and hash. This is not a second implementation of the SVG algorithm.
const frozen = readFileSync(new URL('../../../testing/verification-startup-imports/import-svg.before.ts', import.meta.url), 'utf8')
const oldFunction = frozen.slice(frozen.indexOf('export function pathNetwork('), frozen.indexOf('export function svgTransform('))
const oldPathNetwork = new Function('SVGPathData', 'uid', `"use strict";\n${stripTypeScriptTypes(oldFunction.replace('export function', 'function'))}\nreturn pathNetwork`)(SVGPathData, uid) as typeof pathNetwork
const functionHash = 'de128cda4c183d418c4641b2ea51fef040dc294091953a4b5e4250e93035ae49'
const sourceHash = '1c00e9d6b5b3c0c556dcc1da364c459f85545dec612bb99aff5cb8719e5fc556'
afterEach(() => vi.restoreAllMocks())

function capture(parse: typeof pathNetwork, data: string) {
  let ids = 0
  const randomUUID = vi.spyOn(crypto, 'randomUUID').mockImplementation(() =>
    `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID>)
  try { return { network: parse(data), ids } }
  catch (error) { return { error: { name: (error as Error).name, message: (error as Error).message }, ids } }
  finally { randomUUID.mockRestore() }
}

function compare(data: string) {
  const oldResult = capture(oldPathNetwork, data)
  const currentResult = capture(pathNetwork, data)
  // Exact IDs, topology, float values, control handles, error names/messages and
  // ID-allocation counts; no rounding, tolerance or canonicalization is used.
  expect(currentResult, data.slice(0, 160)).toStrictEqual(oldResult)
  return currentResult
}

test('the retained parser and the extracted function are byte-identical to the recorded baseline', () => {
  expect(createHash('sha256').update(frozen).digest('hex')).toBe(sourceHash)
  expect(createHash('sha256').update(oldFunction).digest('hex')).toBe(functionHash)
  const current = readFileSync(new URL('./path-network.ts', import.meta.url), 'utf8')
  expect(current.slice(current.indexOf('export function pathNetwork('))).toBe(oldFunction)
})

test('the existing SVG importer export is the same synchronous parser function', () => {
  expect(compatibilityPathNetwork).toBe(pathNetwork)
  const result = pathNetwork('M1 2 L3 4')
  expect(result).not.toBeInstanceOf(Promise)
  expect(result.vertices).toHaveLength(2)
  expect(result.edges).toHaveLength(1)
  expect(result.fillRule).toBe('nonzero')
})

const edgeCases = [
  '', ' \t\r\n ', 'M0 0', 'm-0 -0', 'M.25-.5L1e-7 -2E+3',
  'M0 0 10 10 20 0z', 'M0,0h10v10h-10z', 'M0 0Z', 'M0 0ZZ',
  'M0 0L10 0L0 0Z', 'M0 0H10V10H0Z M2 2v6h6v-6z',
  'M1 2C3 4 5 6 7 8S9 10 11 12s-3 -4 -5 -6z',
  'M1 2Q3 4 5 6T7 8t-2 -3Z', 'M1 2q3 4 5 6t7 8',
  'M1 2A3 4 30 0 1 7 8a5 6 -45 1 0 -9 -10Z',
  'M0 0A0 10 0 0 1 20 30', 'M0 0A10 0 0 1 0 20 30',
  'M0 0L10 20Zl5 6', 'M0 0zM10 10z',
  'M1e-200 2e-200C-1e-200 3e-200 4e-200 -5e-200 6e-200 7e-200',
  'M1e100 -1e100L2e100 3e100',
]

test.each(edgeCases.map((data, index) => [index, data] as const))('old/new parser preserves exact output for edge case %i', (_index, data) => {
  expect(compare(data).network).toBeDefined()
})

const malformed = [
  // Preserve these existing svg-pathdata rejections; extraction is not a parser fix.
  'M0 0A10 10 0 1 1 0 0', 'M0 0A-10 -20 45 1 0 5 6',
  'L1 2', 'H2', 'C1 2 3 4 5 6', 'Z', 'M', 'M0', 'M0 0 L',
  'M0 0L1', 'M0 0C1 2 3 4 5', 'M0 0Q1 2 3', 'M0 0S1 2 3',
  'M0 0A1 2 3 0 1 4', 'M0 0A1 2 3 2 1 4 5', 'M0 0A1 2 3 0 2 4 5',
  'M0 0X1 2', 'M0 0NaN', 'MInfinity 0', 'M0 0L1e 2', 'M0 0L1..2 3',
  'M0 0L--1 2', 'M0 0L1 2#', 'M0 0L1 2\u0000',
]

test.each(malformed.map((data, index) => [index, data] as const))('old/new parser preserves exact rejection for malformed case %i', (_index, data) => {
  expect(compare(data).error).toBeDefined()
})

function corpus(seed: number, count: number) {
  let state = seed >>> 0
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000 }
  const coordinate = () => ((random() - .5) * 2048).toFixed(6)
  return Array.from({ length: count }, () => {
    const pieces = [`M${coordinate()} ${coordinate()}`]
    for (let i = 0; i < 24; i++) {
      const relative = random() < .5
      const command = (upper: string) => relative ? upper.toLowerCase() : upper
      switch (i % 9) {
        case 0: pieces.push(`${command('L')}${coordinate()} ${coordinate()}`); break
        case 1: pieces.push(`${command('H')}${coordinate()}`); break
        case 2: pieces.push(`${command('V')}${coordinate()}`); break
        case 3: pieces.push(`${command('C')}${Array.from({ length: 6 }, coordinate).join(' ')}`); break
        case 4: pieces.push(`${command('S')}${Array.from({ length: 4 }, coordinate).join(' ')}`); break
        case 5: pieces.push(`${command('Q')}${Array.from({ length: 4 }, coordinate).join(' ')}`); break
        case 6: pieces.push(`${command('T')}${coordinate()} ${coordinate()}`); break
        case 7: pieces.push(`${command('A')}${(random() * 120 + .01).toFixed(6)} ${(random() * 90 + .01).toFixed(6)} ${coordinate()} ${random() < .5 ? 0 : 1} ${random() < .5 ? 0 : 1} ${coordinate()} ${coordinate()}`); break
        case 8: pieces.push(`z M${coordinate()} ${coordinate()}`); break
      }
    }
    return pieces.join(' ')
  })
}

test('512 seeded valid and malformed paths preserve old/new values and errors exactly', () => {
  const cases = corpus(0x51a7c0de, 256)
  expect(new Set(cases).size).toBe(256)
  for (const data of cases) {
    expect(compare(data).network).toBeDefined()
    expect(compare(data + ' A1 2 3 0 2 4 5').error).toBeDefined()
  }
})

test('the normalized 20000-command admission boundary and allocation timing are unchanged', () => {
  const atLimit = 'M0 0' + 'L1 2'.repeat(19999)
  const accepted = compare(atLimit)
  expect(accepted.network?.vertices).toHaveLength(20000)
  expect(accepted.network?.edges).toHaveLength(19999)
  expect(accepted.ids).toBe(39999)
  const rejected = compare(atLimit + 'L3 4')
  expect(rejected).toStrictEqual({ error: { name: 'Error', message: 'SVG 路径超过 20000 段' }, ids: 0 })
  // Each half-circle arc expands into multiple cubics before the same check.
  const expanded = compare('M0 0' + 'A1 1 0 1 1 2 0A1 1 0 1 1 0 0'.repeat(6000))
  expect(expanded.error?.message).toBe('SVG 路径超过 20000 段')
  expect(expanded.ids).toBe(0)
})

test('the comparison detects changed geometry, topology, IDs and thrown error text', () => {
  const data = 'M1 2C3 4 5 6 7 8Z'
  const baseline = capture(oldPathNetwork, data)
  const mutate = (update: (network: Network) => void) => (source: string) => {
    const network = pathNetwork(source); update(network); return network
  }
  for (const parse of [
    mutate(network => { network.vertices[0].x += Number.EPSILON }),
    mutate(network => { network.edges[0].c1!.y += 1 }),
    mutate(network => { network.edges.pop() }),
    mutate(network => { network.vertices[0].id = 'incorrect-id' }),
  ]) expect(capture(parse, data)).not.toStrictEqual(baseline)
  expect(capture(() => { throw new Error('changed error') }, 'M')).not.toStrictEqual(capture(oldPathNetwork, 'M'))
})

test('synchronous consumers no longer statically import the full SVG document importer', () => {
  for (const file of ['engine.ts', 'editable-network.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(source).toContain("import { pathNetwork } from './path-network'")
    expect(source).not.toMatch(/import\s+[^\n]*\s+from\s+['"]\.\/import-svg['"]/)
  }
  const source = readFileSync(new URL('./path-network.ts', import.meta.url), 'utf8')
  expect([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])).toEqual(['svg-pathdata', './model'])
  expect(source).not.toMatch(/\b(?:DOMParser|kernelBounds)\b|\bdocument\s*\./)
})
