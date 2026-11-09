// Cloud checklist for external AI clients against a packaged MCP adapter.
// This process does not launch Claude, Codex, Kimi, or DSH, and it does not
// treat a development tools/list as an installed-package pass.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeExternalClients } from '../test/runtime/external-mcp-clients.mjs'

export function buildReport({ env = process.env, lookup, platform = process.platform, arch = process.arch } = {}) {
  const executable = env.FUTUREOX_RELEASE_EXECUTABLE || ''
  return {
    schema: 1,
    issue: 84,
    classification: 'acceptance_gap',
    confirmedRuntimeFault: false,
    platform,
    arch,
    packagedInstaller: executable
      ? { status: 'path_supplied_not_launched', evidence: 'this cloud script does not start the installer or an external client' }
      : { status: 'missing_environment', evidence: 'FUTUREOX_RELEASE_EXECUTABLE is unset' },
    steps: [
      'handshake',
      'read',
      'edit',
      'screenshot',
      'undo',
      'revoke_rejects_old_resource',
    ].map(id => ({ id, status: 'not_run', scope: 'external_client' })),
    clients: probeExternalClients({ env, lookup }),
    note: 'A tools/list from frontend/design-desktop or a dev checkout is not packaged-client acceptance. Tokens are not written here.',
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = buildReport()
  console.log(JSON.stringify(report, null, 2))
  const failed = report.clients.some(client => client.status === 'failed')
  process.exit(failed ? 1 : 0)
}
