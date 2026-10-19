// Uses the real repository WASM and bundled font. No browser, server socket or GPU.
export default {
  test: {
    setupFiles: ['./src/test-setup.ts'],
    include: ['../design-mcp/examples/ai-generation.test.ts'],
    testTimeout: 180000,
  },
}
