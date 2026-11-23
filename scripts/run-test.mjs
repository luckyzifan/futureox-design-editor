import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createTestScratch, detachedTestProcess, stopTestTree } from './lib/test-scratch.mjs'

const usage = 'Usage: node scripts/run-test.mjs [--worktree=<name>=<revision>]... -- <command> [args...]'
const git = promisify(execFile)
const args = process.argv.slice(2)

async function run() {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
    return 0
  }
  const separator = args.indexOf('--')
  if (separator < 0 || separator === args.length - 1) throw new Error(usage)
  const specs = new Map()
  for (const option of args.slice(0, separator)) {
    const match = /^--worktree=([A-Za-z0-9][A-Za-z0-9_-]*)=(.+)$/.exec(option)
    if (!match || match[1].toLowerCase() === 'tmp' || specs.has(match[1].toLowerCase()))
      throw new Error(`Invalid or duplicate test worktree option: ${option}`)
    specs.set(match[1].toLowerCase(), { name: match[1], revision: match[2] })
  }

  const caller = await realpath(process.cwd())
  const inRepo = (...gitArgs) => git('git', ['-C', caller, ...gitArgs])
  const checkouts = []
  let scratch, child, cancelled, stopping, status = 1
  const handlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      cancelled ??= signal
      if (!child?.pid || stopping) return
      stopping = stopTestTree(child, signal, 30_000)
      // The process exit and the result of group shutdown are both joined below.
      void stopping.catch(() => {})
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  try {
    scratch = await createTestScratch()
    for (const { name, revision } of specs.values()) {
      if (cancelled) break
      const { stdout } = await inRepo('rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`)
      const directory = join(scratch.root, name)
      checkouts.push(directory)
      await inRepo('worktree', 'add', '--detach', directory, stdout.trim())
    }
    if (!cancelled) {
      const [command, ...commandArgs] = args.slice(separator + 1)
      child = spawn(command, commandArgs, {
        cwd: checkouts[0] ?? caller, env: scratch.environment(),
        stdio: 'inherit', detached: detachedTestProcess,
      })
      const [code, signal] = await once(child, 'exit')
      status = code ?? (128 + (constants.signals[signal] ?? 0))
    }
  } catch (error) {
    console.error(error.message)
  } finally {
    try {
      await (stopping ?? stopTestTree(child))
      if (scratch) {
        // Remove exact Git registrations before deleting the enclosing copy.
        const exists = await scratch.assertOwned()
        if (checkouts.length) {
          const { stdout } = await inRepo('worktree', 'list', '--porcelain', '-z')
          const registered = new Set(stdout.split('\0').filter(line => line.startsWith('worktree '))
            .map(line => line.slice('worktree '.length)))
          for (const directory of checkouts.reverse()) {
            if (!registered.has(directory)) continue
            if (exists) {
              const item = await lstat(directory).catch(error => {
                if (error.code !== 'ENOENT') throw error
              })
              if (item && !item.isDirectory()) throw new Error(`Test worktree was replaced: ${directory}`)
            }
            await inRepo('worktree', 'remove', '--force', '--', directory)
          }
        }
        await scratch.remove()
      }
    } catch (error) {
      console.error(`Test cleanup failed (${scratch?.root ?? 'no scratch'}): ${error.message}`)
      if (status === 0) status = 1
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
  }
  return cancelled ? 128 + constants.signals[cancelled] : status
}

try {
  process.exitCode = await run()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
