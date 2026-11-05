import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Only runnable, dependency-free adapter code and its local user guide cross the
// distribution boundary. No example, test, generated config or credential.
export const guide = 'docs/ELECTRON_LOCAL_MCP.zh-CN.md'
async function inventory(core) {
  const src = path.join(core, 'frontend/design-mcp/src')
  const entries = await readdir(src, { withFileTypes: true })
  return new Map([
    ...entries.filter(e => e.isFile() && e.name.endsWith('.mjs')).map(e => ['src/' + e.name, path.join(src, e.name)]),
    ['README.zh-CN.md', path.join(core, guide)],
  ])
}
export async function stageMcp(core, destination) {
  const files = await inventory(core)
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.join(destination, 'src'), { recursive: true })
  for (const [name, source] of files) await writeFile(path.join(destination, name), await readFile(source))
}
export async function verifyMcp(core, destination) {
  const files = await inventory(core)
  assert.deepEqual((await readdir(destination)).sort(), ['README.zh-CN.md', 'src'])
  assert.deepEqual((await readdir(path.join(destination, 'src'))).sort(), [...files.keys()].filter(n => n.startsWith('src/')).map(n => n.slice(4)).sort())
  for (const [name, source] of files) assert.ok((await readFile(path.join(destination, name))).equals(await readFile(source)), 'Stale packaged MCP file: ' + name)
}
