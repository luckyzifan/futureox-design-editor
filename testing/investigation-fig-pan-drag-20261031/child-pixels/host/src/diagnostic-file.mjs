import { mkdir, open, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { DIAGNOSTIC_BYTES, parseDiagnostics } from './diagnostic-store.mjs'
/** Fixed app-owned path, never a renderer-provided filesystem path. */
export function diagnosticFileAdapter(directory) {
  const filename = path.join(directory, 'local-errors-v1.json')
  return {
    async read() {
      try {
        if ((await stat(filename)).size > DIAGNOSTIC_BYTES) throw new Error('Oversized diagnostic file')
        const file = await open(filename, 'r')
        try { const buffer = Buffer.alloc(DIAGNOSTIC_BYTES + 1); const {bytesRead} = await file.read(buffer, 0, buffer.length, 0); if (bytesRead > DIAGNOSTIC_BYTES) throw new Error('Oversized diagnostic file'); return buffer.subarray(0,bytesRead).toString('utf8') } finally { await file.close() }
      } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    },
    async write(raw) {
      const safe = JSON.stringify(parseDiagnostics(raw))
      await mkdir(directory, {recursive:true})
      const file = await open(`${filename}.tmp`, 'w', 0o600)
      try { await file.writeFile(safe); await file.sync() } finally { await file.close() }
      await rename(`${filename}.tmp`, filename)
    },
  }
}
