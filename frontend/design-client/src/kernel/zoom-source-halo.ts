/** Kernel messages from `zoom_support`. Matching is textual because the worker
 * wraps the same literal with a backend prefix. */
export function zoomSourceHaloRejection(error: unknown) {
  const message = String(error)
  return message.includes('Zoom source filter halo exceeds 2048 device pixels')
    || message.includes('Combined zoom source dependency halo exceeds 2048 device pixels')
}
