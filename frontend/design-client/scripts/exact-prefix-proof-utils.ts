/** Test-only isolation and evidence utilities. No production imports or writes. */
import { chromium, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const project = fileURLToPath(new URL('..', import.meta.url))
export const repository = fileURLToPath(new URL('../../..', import.meta.url))
export const shaderRoot = join(repository, 'design-studio/crates/design-kernel/shaders')
export const sha256 = (input: string | Uint8Array) =>
  createHash('sha256').update(input).digest('hex')

export async function command(command: string, args: string[]) {
  const child = spawn(command, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (value) => {
    stdout += value
  })
  child.stderr.on('data', (value) => {
    stderr += value
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error(`${command} exited ${code}: ${stderr || stdout}`)),
    )
  })
  return { stdout, stderr }
}

type Proof = {
  output: string
  prepareOnly: boolean
  write(name: string, value: unknown): Promise<void>
  browser<T>(work: (page: Page) => Promise<T>): Promise<T>
}

export async function runProof(
  name: string,
  extraInputs: string[],
  work: (proof: Proof) => Promise<unknown>,
) {
  const requested = process.env.DESIGN_TEST_OUTPUT || join(tmpdir(), `${name}-${randomUUID()}`)
  let output = requested,
    owned = false
  let before: Record<string, string> | undefined, after: Record<string, string> | undefined
  const errors: { type: string; message: string }[] = []
  const write = (file: string, value: unknown) =>
    writeFile(join(output, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  async function hashes() {
    const values: Record<string, string> = {}
    async function tree(directory: string, label: string) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const file = join(directory, entry.name),
          key = `${label}/${entry.name}`
        if (entry.isDirectory()) await tree(file, key)
        else if (entry.isFile()) values[key] = sha256(await readFile(file))
        else throw Error(`Unsupported input entry: ${file}`)
      }
    }
    await tree(join(project, 'src'), 'src')
    await tree(join(project, 'public/kernel'), 'public/kernel')
    await tree(shaderRoot, 'shaders')
    for (const file of [
      fileURLToPath(import.meta.url),
      process.argv[1],
      join(project, 'vite.config.ts'),
      join(project, 'gpu-check.html'),
      join(project, 'package.json'),
      join(project, 'public/fonts/NotoSansSC.ttf'),
      ...extraInputs,
    ])
      values[relative(repository, file)] = sha256(await readFile(file))
    return values
  }
  try {
    await mkdir(output, { recursive: true })
    if ((await readdir(output)).length)
      throw Error(`Refusing non-empty evidence directory: ${output}`)
    await write('owner.json', { pid: process.pid, startedAt: new Date().toISOString() })
    owned = true
    before = await hashes()
    await write('inputs-before.json', before)
    const result = await work({
      output,
      prepareOnly: process.argv.includes('--prepare-only'),
      write,
      async browser(work) {
        const server = spawn(
          'bun',
          ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
          {
            cwd: project,
            env: { ...process.env, VITE_DESIGN_EXACT_PREFIX: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
        try {
          const base = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20_000)
            server.once('error', (error) => {
              clearTimeout(timer)
              reject(error)
            })
            server.once('exit', (code) => {
              clearTimeout(timer)
              reject(Error(`Vite exited ${code}`))
            })
            server.stdout.on('data', (chunk) => {
              const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
              if (match) {
                clearTimeout(timer)
                resolve(match[0])
              }
            })
          })
          browser = await chromium.launch({
            headless: true,
            chromiumSandbox: true,
            args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
          })
          const page = await browser.newPage()
          page.on('pageerror', (error) =>
            errors.push({ type: 'pageerror', message: error.stack || error.message }),
          )
          page.on('console', (message) => {
            if (message.type() === 'error')
              errors.push({ type: 'console.error', message: message.text() })
          })
          await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }))
          await page.goto(base + '/gpu-check.html')
          return await work(page)
        } finally {
          await browser?.close()
          server.kill('SIGTERM')
        }
      },
    })
    after = await hashes()
    await write('inputs-after.json', after)
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => before![key] !== after![key],
    )
    if (changed.length) throw Error(`Inputs changed during proof: ${changed.join(', ')}`)
    if (errors.length) throw Error(`${errors.length} browser errors occurred`)
    await write('results.json', {
      status: process.argv.includes('--prepare-only') ? 'prepared-no-gpu' : 'passed',
      result,
      errors,
    })
    console.log(
      JSON.stringify({
        output,
        status: process.argv.includes('--prepare-only') ? 'prepared-no-gpu' : 'passed',
        result,
      }),
    )
  } catch (error) {
    if (!owned) {
      output = join(tmpdir(), `${name}-failure-${randomUUID()}`)
      await mkdir(output)
    }
    let hashError: string | undefined
    if (before && !after) {
      try {
        after = await hashes()
      } catch (failure) {
        hashError = String(failure)
      }
    }
    await write('failure.json', {
      status: 'failed',
      requestedOutput: requested,
      error:
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      errors,
      before,
      after,
      hashError,
    })
    console.error(JSON.stringify({ output, status: 'failed', error: String(error) }))
    process.exitCode = 1
  }
}
