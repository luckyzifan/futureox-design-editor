import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer} from './renderer'
import type {Driver} from './types'
afterEach(()=>vi.unstubAllEnvs())
test.each([false,true])('encoding yield keeps ordered cancellation and one submission, before=%s',async before=>{
  vi.stubEnv('VITE_DESIGN_SUBMIT_BEFORE_YIELD',before?'1':'0')
  const submit=vi.fn(),renderer=new GpuRenderer({submitPending:submit} as unknown as Driver) as any
  let resume!:()=>void,current=true
  renderer.frameCurrent=()=>current
  renderer.encodeYield.checkpoint=()=>new Promise<void>(resolve=>{resume=resolve})
  const first=renderer.yieldEncoding();expect(submit).toHaveBeenCalledTimes(before?1:0)
  resume();await first;expect(submit).toHaveBeenCalledTimes(1)
  const second=renderer.yieldEncoding(),rejected=expect(second).rejects.toThrow('PREVIEW_CANCELLED')
  current=false;resume();await rejected
  expect(submit).toHaveBeenCalledTimes(before?2:1)
  // No extra resource retirement or stale post-yield submission occurs.
})
test('disabled submission and an encoding slice without a yield keep their old behavior',()=>{
  vi.stubEnv('VITE_DESIGN_SUBMIT_BEFORE_YIELD','1');vi.stubEnv('VITE_DESIGN_ENCODE_SUBMIT','0')
  const submit=vi.fn(),renderer=new GpuRenderer({submitPending:submit} as unknown as Driver) as any
  renderer.encodeYield.checkpoint=()=>undefined
  expect(renderer.yieldEncoding()).toBeUndefined();expect(submit).not.toHaveBeenCalled()
})
