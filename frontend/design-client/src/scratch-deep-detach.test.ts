/// <reference types="node" />
import { beforeAll, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking } from './kernel/picking'
import { componentFixture, originNode } from './component-fixtures'
import { Editor } from './engine'

beforeAll(async () => {
  await initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  })
})

test('scratch: what survives detach inside a nested instance', () => {
  const { doc, ids } = componentFixture()
  const e = new Editor(doc)
  const slotKey = e.state.doc.nodes[ids.slot].componentKey!
  const before = originNode(e.state.doc, ids.a, slotKey)
  console.log('generated slot before:', JSON.stringify({ instance: !!before.instance, origin: before.instanceOrigin }))
  e.detachInstance(ids.a)
  const after = e.state.doc.nodes[before.id]
  console.log('generated slot after:', JSON.stringify({ exists: !!after, instance: !!after?.instance, origin: after?.instanceOrigin }))
  const live = Object.values(e.state.doc.nodes).filter((n) => n.instance)
  console.log('live instances after detach:', live.map((n) => n.id))
  expect(true).toBe(true)
})
