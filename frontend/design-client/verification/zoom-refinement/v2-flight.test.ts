
import { expect, test, vi } from 'vitest'
import { navigationCoverageFlight } from '../../src/kernel/navigation-coverage'
const source = (cancel = vi.fn()) => ({ zoom: 32, bounds: { x:0,y:0,width:10,height:10 }, cancel })
test('cancellation is once-only, does not settle flight early, and never erases delivered history', async () => {
  const capture=source(), flight=navigationCoverageFlight<object>({},1,capture), history={}
  let done=false; void flight.done.then(()=>{done=true}); flight.tile=history
  expect(flight.cancellationRequested).toBe(false)
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:1},100,100)).toBe(true)
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:1},100,100)).toBe(false)
  expect(capture.cancel).toHaveBeenCalledOnce(); expect(flight.cancellationRequested).toBe(true); await Promise.resolve()
  expect(done).toBe(false); expect(flight.tile).toBe(history)
  flight.finish(); flight.finish(); await flight.done; expect(done).toBe(true); expect(flight.cancellationRequested).toBe(true)
})
test('finished and unowned coverage flights cannot cancel any request', () => {
  const capture=source(), finished=navigationCoverageFlight({},1,capture)
  finished.finish()
  expect(finished.cancelObsoleteZoomOut({x:0,y:0,zoom:1},100,100)).toBe(false)
  expect(navigationCoverageFlight({},1).cancelObsoleteZoomOut({x:0,y:0,zoom:1},100,100)).toBe(false)
  expect(capture.cancel).not.toHaveBeenCalled()
})
test('same zoom, zoom-in, and genuinely covering captures remain owned', () => {
  for (const zoom of [32,64]) {
    const capture=source(), flight=navigationCoverageFlight({},1,capture)
    expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom},100,100)).toBe(false)
    expect(capture.cancel).not.toHaveBeenCalled()
  }
  const capture=source(), flight=navigationCoverageFlight({},1,{...capture,bounds:{x:0,y:0,width:200,height:200}})
  expect(flight.cancelObsoleteZoomOut({x:0,y:0,zoom:1},100,100)).toBe(false)
  expect(capture.cancel).not.toHaveBeenCalled()
})
