// Node 24 strips TypeScript but does not resolve extensionless TS imports.
// This test-only loader resolves existing relative .ts files without replacing
// implementations, mocking browser globals or intercepting bare packages.
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
