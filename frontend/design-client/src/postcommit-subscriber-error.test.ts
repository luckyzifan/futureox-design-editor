import { afterEach, expect, test, vi } from 'vitest'
import { reportPostcommitSubscriberError } from './postcommit-subscriber-error'
afterEach(()=>vi.unstubAllGlobals())
test.each(['absent','throwing'] as const)('host reporting fallback rethrows original error once when reportError is %s',mode=>{
 const tasks:(()=>void)[]=[],failure=new Error('original'),secondary=new Error('reporter')
 vi.stubGlobal('queueMicrotask',(task:()=>void)=>tasks.push(task));vi.stubGlobal('reportError',mode==='absent'?undefined:()=>{throw secondary})
 reportPostcommitSubscriberError(failure);expect(tasks).toHaveLength(1);expect(()=>tasks[0]()).toThrow(failure);expect(tasks).toHaveLength(1)
})
test('host reportError observes original error asynchronously without a second throw',()=>{
 const tasks:(()=>void)[]=[],failure=new Error('original'),report=vi.fn()
 vi.stubGlobal('queueMicrotask',(task:()=>void)=>tasks.push(task));vi.stubGlobal('reportError',report)
 reportPostcommitSubscriberError(failure);expect(report).not.toHaveBeenCalled();expect(()=>tasks[0]()).not.toThrow();expect(report).toHaveBeenCalledExactlyOnceWith(failure)
})
