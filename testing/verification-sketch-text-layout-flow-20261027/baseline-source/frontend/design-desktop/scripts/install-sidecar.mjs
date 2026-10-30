import { copyFile, chmod, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// macOS caches executable signatures by vnode. Never overwrite an executable
// that a running or previously launched process may still reference.
export async function installSidecar(source, destination) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}-${randomUUID()}`)
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    if (process.platform !== 'win32') await chmod(temporary, 0o755)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}
