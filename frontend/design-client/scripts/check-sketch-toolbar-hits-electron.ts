/** Run the same toolbar hit and click checks in Electron. */
process.argv.push('--electron')
await import('./check-sketch-toolbar-hits')
