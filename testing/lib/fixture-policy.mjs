import { statSync } from 'node:fs'

// A missing optional external corpus is a SKIP, never a successful assertion.
// An explicitly configured path (even in optional mode) is a contract and fails
// if unreadable. Nothing searches a user's Downloads or downloads private data.
export function externalFixture(name, environment = process.env) {
  const path = environment[name]
  if (!path) {
    const reason = `${name} is not configured; external corpus was not exercised`
    if (environment.DESIGN_REQUIRE_PRIVATE_FIXTURES === '1') throw new Error(reason)
    return { skip: reason }
  }
  const stat = statSync(path)
  if (!stat.isFile() || stat.size === 0) throw new Error(`${name} must identify a nonempty regular file`)
  return { path }
}
