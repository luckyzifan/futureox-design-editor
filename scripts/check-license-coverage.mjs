// Audit the project MIT text, workspace crate metadata, frontend packages,
// and the licenses already written on vendored crates. This does not relicense
// third-party code or change repository visibility.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function crateLicense(root, member) {
  const text = readFileSync(path.join(root, 'design-studio', member, 'Cargo.toml'), 'utf8')
  return {
    crate: member,
    license: text.match(/^license\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    workspace: /^license\.workspace\s*=\s*true/m.test(text),
  }
}

function quotedLicense(root, relative) {
  const text = readFileSync(path.join(root, relative), 'utf8')
  return text.match(/^license\s*=\s*"([^"]+)"/m)?.[1] ?? null
}

export function inspectLicenseCoverage(root) {
  const license = readFileSync(path.join(root, 'LICENSE'), 'utf8')
  const workspace = readFileSync(path.join(root, 'design-studio/Cargo.toml'), 'utf8')
  const members = (workspace.match(/^members\s*=\s*\[([^\]]+)\]/m)?.[1] ?? '')
    .split(',')
    .map(item => item.trim().replaceAll('"', ''))
    .filter(Boolean)
  const crates = members.map(member => crateLicense(root, member))
  const packages = [
    'frontend/design-client/package.json',
    'frontend/design-desktop/package.json',
    'frontend/design-mcp/package.json',
  ].map(relative => ({
    package: relative,
    license: JSON.parse(readFileSync(path.join(root, relative), 'utf8')).license ?? null,
  }))
  const vendors = [
    { crate: 'vendor/moxcms', license: quotedLicense(root, 'vendor/moxcms/Cargo.toml') },
    { crate: 'vendor/flo_curves', license: quotedLicense(root, 'vendor/flo_curves/Cargo.toml') },
  ]
  const problems = []
  if (!license.startsWith('MIT License\n')) problems.push('root LICENSE is not the MIT text')
  if (!license.includes('Copyright (c) 2026 Cookieboty and contributors')) problems.push('root copyright line changed')
  if (!/^license\s*=\s*"MIT"$/m.test(workspace)) problems.push('workspace license is not MIT')
  if (crates.length !== 5) problems.push(`expected 5 workspace crates, found ${crates.length}`)
  for (const crate of crates) {
    if (!crate.workspace || crate.license) problems.push(`${crate.crate} must inherit workspace MIT and not set another license`)
  }
  for (const item of packages) {
    if (item.license !== 'MIT') problems.push(`${item.package} license is not MIT`)
  }
  for (const vendor of vendors) {
    if (!vendor.license || vendor.license === 'MIT') problems.push(`${vendor.crate} must keep its own non-MIT license`)
  }
  return {
    schema: 1,
    issue: 87,
    classification: 'opensource_prep',
    confirmedRuntimeFault: false,
    projectLicense: 'MIT',
    copyright: 'Copyright (c) 2026 Cookieboty and contributors',
    appliesTo: 'Original Futureox Design code covered by the root LICENSE. Vendored crates, fonts, FFmpeg, and reference assets stay under their own texts.',
    crates,
    packages,
    vendors,
    thirdPartyNotRelicensed: true,
    problems,
    visibilityUnchanged: true,
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = inspectLicenseCoverage(repo)
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.problems.length ? 1 : 0)
}
