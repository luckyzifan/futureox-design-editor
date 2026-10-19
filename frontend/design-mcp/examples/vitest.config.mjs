// Run from frontend/design-client so its existing real WASM/font setup is used.
export default {
  test: {
    setupFiles: ['./src/test-setup.ts'],
    include: ['../design-mcp/examples/generate-example.test.ts'],
    testTimeout: 180000,
  },
}
