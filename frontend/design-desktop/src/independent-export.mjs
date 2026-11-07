import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'

const existing = async (read, file) => {
  try { return await read(file) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** An imported file is an immutable input. Export may update a separate
 * output, but selecting the input (including a link to it) never grants a
 * write back to it. The native writer still owns CAS and atomic publication. */
export async function assertIndependentExport(destination, original) {
  if (!original) return
  const reject = () => { throw Error('原文件保持不变，请为导出副本选择其他文件名。') }
  if (path.resolve(destination) === path.resolve(original)) reject()
  const [source, target] = await Promise.all([existing(realpath, original), existing(realpath, destination)])
  if (source && source === target) reject()
  if (!source || !target) return
  const [a, b] = await Promise.all([stat(source), stat(target)])
  if (a.dev === b.dev && a.ino === b.ino) reject()
}
