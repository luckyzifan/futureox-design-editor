import readline from 'node:readline'
process.on('SIGTERM', () => {
  /* Owned test fixture deliberately exercises bounded escalation. */
})
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'health') {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { ready: true, pid: process.pid } })}\n`,
    )
  }
})
setInterval(() => {}, 10_000)
