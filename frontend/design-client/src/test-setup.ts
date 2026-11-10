import { URL as FileURL } from 'node:url'
import { beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { initializePicking } from './kernel/picking'

// cssstyle defines an own `constructor` with no value, which shadows the class.
// Chai's inspectClass then reads `undefined.name` and hides the assertion that
// was comparing a jsdom SVG node. Keep the class as the constructor value.
const defineProperties = Object.defineProperties
Object.defineProperties = function <T>(target: T, properties: PropertyDescriptorMap & ThisType<unknown>): T {
  const constructor = Object.getOwnPropertyDescriptor(properties, 'constructor')?.value as PropertyDescriptor | undefined
  if (properties && properties._values && constructor && !('value' in constructor) && !constructor.get && !constructor.set)
    properties = { ...properties, constructor: { ...constructor, value: (target as { constructor?: unknown }).constructor } }
  return defineProperties(target, properties)
}
beforeAll(async () => {
  const wasm = new Uint8Array(await readFile(new FileURL('../public/kernel/design_kernel_bg.wasm', import.meta.url)))
  const expected = process.env.FUTUREOX_EXPECT_KERNEL_SHA256
  if (expected && createHash('sha256').update(wasm).digest('hex') !== expected)
    throw new Error('Test kernel bytes do not match FUTUREOX_EXPECT_KERNEL_SHA256')
  await initializePicking({
    wasm,
    font: new Uint8Array(
      await readFile(new FileURL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  })
})
