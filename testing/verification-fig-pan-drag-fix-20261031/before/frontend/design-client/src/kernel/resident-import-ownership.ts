/** A transferred bitmap may finish importing after its surface/session or tile
 * has gone away. The returned texture belongs either to the current tile or to
 * this completion, which must release it; it must never become an orphan. */
export async function settleResidentImport(
  pending: Promise<number>, owns: () => boolean, publish: (id: number) => void,
  release: (id: number) => void, failed: (error: unknown) => void, finish: () => void,
) {
  let id: number
  try { id = await pending }
  catch (error) { finish(); if (owns()) failed(error); return }
  finish()
  if (!owns()) { release(id); return }
  publish(id)
}
