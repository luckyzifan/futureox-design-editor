import { expect, test } from 'vitest'
// @ts-expect-error Actual desktop .mjs runtime is tested below; it has no TypeScript declaration.
import { NativePreparationFrame } from '../../../design-desktop/src/preparation-frame.mjs'
import { connectNativePreparation } from './native-preparation'
import { PreparationChannel } from './preparation-channel'
import { renderFailureFields, withRenderFailureStage } from './render-failure-telemetry'

// Actual native bridge adapter + MessageChannel + preparation queue. Only the
// external native process reply is controlled; this is not a Rust/GPU run.
const fixed = [["GPU transform exceeds precision budget", 5, 119], ["Render options must be an object", 5, 120], ["Invalid GPU painter support policy", 5, 121], ["Invalid GPU painter capture-read policy", 5, 122], ["GPU painter capture reads require painter support", 5, 123], ["Ambiguous GPU region", 5, 124], ["Invalid prepare viewport bounds", 5, 125], ["Native capture is a canvas operation", 6, 126], ["Pixel preview uses complete-frame presentation", 6, 127], ["Load document first", 6, 128], ["Missing page", 5, 129], ["GPU effect support exceeds coordinate budget", 5, 130], ["Scene path budget exceeded", 3, 131], ["Composed transform exceeds precision budget", 5, 132], ["Effect expansion exceeds device coordinate budget", 5, 133], ["Nested effect expansion exceeds device coordinate budget", 5, 134], ["Scene sequence exhausted", 6, 135]] as const
for (const [message, category, code] of fixed) {
  test(`fixed native compiler code ${code} survives transport and compile tagging`, async () => {
    const pair = new MessageChannel(), channel = new PreparationChannel(pair.port2)
    const bridge = { open: async () => 'owned-native', close: async () => {},
      request: async () => {
        const metadata=Buffer.from(JSON.stringify({id:999,error:message}),'utf8'), header=Buffer.alloc(12)
        header.write('FPR1'); header.writeUInt32LE(metadata.length,4)
        const wire=Buffer.concat([header,metadata]), frame=new NativePreparationFrame()
        expect(frame.append(wire.subarray(0,3))).toBe(false)
        expect(frame.append(wire.subarray(3,13))).toBe(false)
        expect(frame.append(wire.subarray(13))).toBe(true)
        return frame.decode(999).reply
      } }
    const connection = connectNativePreparation(bridge, pair.port1)
    try {
      let caught: unknown
      try { await withRenderFailureStage(5, () => channel.request('canvas', 'compile_gpu_packet', ['{}'])) }
      catch (error) { caught = error }
      const fields = renderFailureFields(caught)
      expect(fields).toMatchObject({failureCategory:category, failureCode:code, failureStage:5, errorClassCode:1})
      expect(Object.values(fields).every(value => typeof value === 'number')).toBe(true)
      expect(JSON.stringify(fields)).not.toContain(message)
    } finally { connection.close(); channel.close() }
  })
}
test('unknown messages and data appended to known literals stay private and unknown', () => {
  for (const [message] of fixed) {
    for (const value of [message + ': PRIVATE_DOCUMENT_NAME', 'PRIVATE:' + message, message.toLowerCase()]) {
      const fields=renderFailureFields(new Error(value))
      expect(fields.failureCode).toBe(0)
      expect(fields.failureCategory).toBe(0)
      expect(JSON.stringify(fields)).not.toContain('PRIVATE')
    }
  }
})
test('fixed literal strings classify without coercing arbitrary thrown objects', () => {
  for (const [message,category,code] of fixed) expect(renderFailureFields(message)).toMatchObject({failureCategory:category,failureCode:code})
  let read=0
  const arbitrary={get message(){read++;throw Error('PRIVATE')},toString(){read++;throw Error('PRIVATE')}}
  expect(renderFailureFields(arbitrary)).toMatchObject({failureCategory:0,failureCode:0})
  expect(read).toBe(0)
})
