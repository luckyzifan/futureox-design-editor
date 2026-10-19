// Negative witness only: omit Canvas teardown in the test module's in-memory
// transform. Never edit the canonical test or any production module.
export default {
  root: process.cwd(),
  plugins: [{
    name: 'lifecycle-cleanup-negative-witness', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/editor-lifecycle.test.tsx')) return null
      const before = 'h.unmount(); modal.unmount()'
      if (code.split(before).length !== 2) throw new Error('Expected exactly one scoped Canvas teardown witness')
      return { code: code.replace(before, '/* Canvas cleanup deliberately omitted */ modal.unmount()'), map: null }
    },
  }],
  test: { setupFiles: ['./src/test-setup.ts'], include: ['src/editor-lifecycle.test.tsx'] },
}
