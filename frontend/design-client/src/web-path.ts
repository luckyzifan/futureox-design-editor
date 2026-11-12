/** Vite's public root also scopes runtime requests when hosted under a path. */
export function webPath(path: `/${string}`) {
  return (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '') + path
}
