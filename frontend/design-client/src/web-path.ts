/** The Electron protocol serves public assets at the origin root. A relative
 * Vite base applies to bundle imports, while a worker starts in /assets/. */
export function webPath(path: `/${string}`) {
  const base = import.meta.env?.BASE_URL
  if (!base || base === './') return path
  return base.replace(/\/$/, '') + path
}
