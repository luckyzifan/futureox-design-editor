import * as nodeModule from 'node:module'
import { Script } from 'node:vm'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

export const PLUGIN_SOURCE_BYTES = 256 * 1024
const PURPOSE = 'futureox-plugin-typescript'

if (!isMainThread && workerData?.purpose === PURPOSE) {
  try {
    // Both APIs only parse source. The compiled program is executed by QuickJS
    // after the normal plugin launch, never by the worker or the Node VM.
    // Transform mode also lowers enums and namespaces. The result is syntax
    // checked as a classic script; imports, decorators, and JSX still fail here,
    // which keeps this a type stripper rather than a module bundler.
    const script = nodeModule.stripTypeScriptTypes(workerData.source, { mode: 'transform' })
    new Script(script, { filename: 'plugin-entry.js' })
    parentPort.postMessage({ script })
  } catch {
    parentPort.postMessage({ error: true })
  }
}

let compiling = false
export async function compilePluginTypeScript(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > PLUGIN_SOURCE_BYTES)
    throw Object.assign(new Error('Plugin TypeScript entry exceeds the source limit'), { code: 'PLUGIN_SOURCE_LIMIT' })
  if (compiling) throw Object.assign(new Error('Another plugin source is being compiled'), { code: 'BUSY' })
  compiling = true
  let worker
  let timer
  const unsupported = () => Object.assign(new Error('TypeScript entry needs a built JavaScript bundle; JSX, runtime imports, decorators, and invalid syntax cannot be type-stripped'), { code: 'PLUGIN_SOURCE_UNSUPPORTED' })
  try {
    worker = new Worker(new URL(import.meta.url), {
      workerData: { purpose: PURPOSE, source },
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    })
    return await new Promise((resolve, reject) => {
      worker.once('message', value => {
        if (typeof value?.script === 'string' && Buffer.byteLength(value.script, 'utf8') <= PLUGIN_SOURCE_BYTES) resolve(value.script)
        else reject(unsupported())
      })
      worker.once('error', () => reject(unsupported()))
      worker.once('exit', () => reject(unsupported()))
      timer = setTimeout(() => reject(unsupported()), 3000)
    })
  } finally {
    clearTimeout(timer)
    await worker?.terminate()
    compiling = false
  }
}
