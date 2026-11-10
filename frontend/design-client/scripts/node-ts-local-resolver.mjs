// Node strip-only TypeScript does not resolve extensionless relative imports.
// This was recorded for Node 24 and is verified on Node v22.23.4.
// test:render-diagnostics and test:render-contracts preload this module with
// --import. When default resolution throws ERR_MODULE_NOT_FOUND, a relative
// specifier is mapped onto an existing .ts file and handed back to Node's own
// loader. This does not rewrite implementations, mock browser globals,
// intercept bare specifiers, or transform TypeScript parameter properties.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) }
  catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL ||
      !specifier.startsWith('.') || extname(specifier)) throw error
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (url.protocol !== 'file:' || !existsSync(url)) throw error
    return nextResolve(url.href, context)
  }
} })
