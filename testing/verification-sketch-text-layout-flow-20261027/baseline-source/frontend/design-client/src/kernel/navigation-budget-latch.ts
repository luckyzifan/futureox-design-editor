import { renderFailureFields } from './render-failure-telemetry'

/** One failed optional preview, never a cache of failed documents or tiles. */
export class NavigationBudgetLatch {
  private current?: { contract: object; intent: string; retry: number }
  private failed = false
  blocked(contract: object, intent: string, retry: number) {
    const old = this.current
    if (!old || old.contract !== contract || old.intent !== intent || old.retry !== retry) {
      this.current = { contract, intent, retry }; this.failed = false
    }
    return this.failed
  }
  reject(contract: object, intent: string, retry: number, error: unknown) {
    const old = this.current, tag = renderFailureFields(error)
    if (!old || old.contract !== contract || old.intent !== intent || old.retry !== retry) return
    if (tag.failureCategory === 3 &&
      ((tag.failureCode === 64 && tag.failureStage === 5) || (tag.failureCode === 20 && tag.failureStage === 13))) this.failed = true
  }
  clear() { this.current = undefined; this.failed = false }
}
