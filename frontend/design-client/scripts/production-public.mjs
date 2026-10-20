import { cp, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

// Reference fixtures remain available to development/test tooling, but must not
// silently become distributed product assets through Vite's public-directory copy.
export async function copyProductionPublic(source, destination) {
  const from = path.resolve(source), to = path.resolve(destination)
  if (to === from || to.startsWith(from + path.sep) || from.startsWith(to + path.sep))
    throw new Error('Production output and public sources must be separate directories')
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from)) {
    if (entry === 'fidelity' || entry === 'figma-blur-verify.html') continue
    await cp(path.join(from, entry), path.join(to, entry), { recursive: true })
  }
}

export function productionPublicAssets() {
  let config
  return {
    name: 'futureox-production-public-assets',
    apply: 'build',
    config: () => ({ build: { copyPublicDir: false } }),
    configResolved(value) { config = value },
    async writeBundle() {
      if (config.publicDir) await copyProductionPublic(config.publicDir, path.resolve(config.root, config.build.outDir))
    },
  }
}
