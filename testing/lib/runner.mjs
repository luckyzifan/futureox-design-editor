import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { writeSync } from 'node:fs'

/** Run one child, capture both streams and honor exit/signal/timeout.
 * Success-looking output never overrides a failing process. */
export async function execute(command, args, { cwd, env = process.env, log, timeoutMs = 600000, killGraceMs = 1000 } = {}) {
  const file = await open(log, 'w')
  const started = Date.now()
  let output = '', error, signal, code, timedOut = false, forceKillAttempted = false
  try {
    await new Promise(resolve => {
      const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      const consume = chunk => { output += chunk.toString(); writeSync(file.fd, chunk) }
      child.stdout.on('data', consume); child.stderr.on('data', consume)
      let forceTimer
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        // A child may intercept SIGTERM. Bound the grace period and address
        // only this owned child; never kill a process group or unrelated PID.
        forceTimer = setTimeout(() => { forceKillAttempted = true; child.kill('SIGKILL') }, killGraceMs)
      }, timeoutMs)
      child.on('error', value => { error = String(value) })
      child.on('close', (value, reason) => { code = value; signal = reason; clearTimeout(timer); clearTimeout(forceTimer); resolve() })
    })
  } finally { await file.close() }
  return { status: code === 0 && !error && !signal && !timedOut ? 'passed' : 'failed',
    exitCode: code, signal, error, timedOut, forceKillAttempted, durationMs: Date.now() - started, output }
}

/** Reports are gates, not an inferred quality score. A vacuous test run fails. */
export function executedAssertions(output, format) {
  if (format === 'tap') {
    const total = [...output.matchAll(/^# tests (\d+)$/gm)].at(-1)
    const passed = [...output.matchAll(/^# pass (\d+)$/gm)].at(-1)
    return !!total && Number(total[1]) > 0 && !!passed && Number(passed[1]) > 0
  }
  if (format === 'python') {
    // unittest counts skipped cases in "Ran N tests" and exits zero even when
    // every case is skipped. Require its actual success summary and at least
    // one non-skipped case, not just a positive discovered-case total.
    const normalized = output.replaceAll('\r\n', '\n')
    const total = [...normalized.matchAll(/^Ran (\d+) tests? in .+$/gm)].at(-1)
    const summary = [...normalized.matchAll(/^OK(?: \(([^)]*)\))?$/gm)].at(-1)
    if (!total || !summary) return false
    let excluded = 0
    const seen = new Set()
    for (const field of summary[1]?.split(', ') || []) {
      const count = /^(skipped|expected failures)=(\d+)$/.exec(field)
      if (!count || seen.has(count[1]) || !Number.isSafeInteger(Number(count[2]))) return false
      seen.add(count[1]); excluded += Number(count[2])
    }
    // Expected failures remain explicitly pending, never successful evidence.
    const count = Number(total[1])
    return Number.isSafeInteger(count) && count > excluded
  }
  if (format === 'bun') return /\b[1-9]\d* pass\b/.test(output)
  if (format === 'rust') return /test result: ok\. [1-9]\d* passed;/.test(output)
  return true
}
