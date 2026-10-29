/** Ordinals use the transport's exact integer range, not fixed digit quotas. */
export function validSourceObjectKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  return parts.length === 2 && parts.every(part =>
    /^(0|[1-9][0-9]*)$/.test(part) && Number.isSafeInteger(Number(part)) && String(Number(part)) === part)
}
