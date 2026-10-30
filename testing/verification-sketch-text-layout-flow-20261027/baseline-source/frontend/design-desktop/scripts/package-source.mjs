import path from 'node:path'

// These paths belong to the removed sprite backend. Keep the current host and
// companion policy, plus all unrelated resources, even in a reused working tree.
const retired = [path.join('pet', 'renderer'), path.join('pet', 'controller.mjs'), path.join('pet', 'preload.cjs')]

export function packageSourceFilter(sourceRoot) {
  const root = path.resolve(sourceRoot)
  return source => {
    const relative = path.relative(root, source)
    return !retired.some(entry => relative === entry || relative.startsWith(entry + path.sep))
  }
}
