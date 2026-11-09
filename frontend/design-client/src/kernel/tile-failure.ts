type FailedRenderer = { driver: { lost?: boolean; abortFrameAndReleaseFilterScratch?():Promise<void> }; dispose(): void }

/** Working-surface pressure may be retried in smaller regions. A resident
 * display still owns textures on this device: retire only the failed frame's
 * commands/scratch, never the device containing the last complete picture. */
export async function recoverFailedTileRenderer(error:unknown, renderer:FailedRenderer|undefined,
  invalidate:()=>void, hasResidentDisplay:boolean):Promise<boolean> {
  const message=String(error)
  const lost=renderer?.driver.lost||/device lost|GPU device|has been lost|设备已丢失/i.test(message)
  const allocation=/^(?:Error: )?(?:GPU 表面内存预算超限|GPU surface budget exceeded)(?:$|\s|\()/.test(message)
  if(hasResidentDisplay&&renderer?.driver.abortFrameAndReleaseFilterScratch&&!lost&&allocation){
    try {await renderer.driver.abortFrameAndReleaseFilterScratch();return true}
    catch(abortError){invalidate();renderer.dispose();throw new Error('Resident GPU frame recovery failed',{cause:abortError})}
  }
  retireFailedTileRenderer(error,renderer,invalidate)
  return false
}

/** These allocation failures are retried by smaller crops with unchanged
 * document/options/math. Completed CPU pixel payloads and their witnesses do
 * not borrow the failed renderer's GPU resources. Device loss and every other
 * failure still revoke the cache; even a mixed budget/loss message is loss. */
export function retireFailedTileRenderer(
  error: unknown,
  renderer: FailedRenderer | undefined,
  invalidate: () => void,
) {
  const message = String(error)
  const deviceLost = renderer?.driver.lost || /device lost|GPU device|has been lost|设备已丢失/i.test(message)
  const allocation = /^(?:Error: )?(?:GPU 表面内存预算超限|GPU surface budget exceeded)(?:$|\s|\()/.test(message)
  if (deviceLost || !allocation) invalidate()
  renderer?.dispose()
}
