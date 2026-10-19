// Node contract suites import the same extensionless TS modules used by Vite.
// Resolve source files only; no aliases, product substitution or mocks are added.
import { registerHooks } from 'node:module'
import { existsSync, statSync } from 'node:fs'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const base = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(base.pathname)) {
        for (const extension of ['.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
          const candidate = new URL(base.href); candidate.pathname += extension
          if (existsSync(candidate) && statSync(candidate).isFile()) return { url: candidate.href, shortCircuit: true }
        }
      }
    }
    return next(specifier, context)
  },
})
