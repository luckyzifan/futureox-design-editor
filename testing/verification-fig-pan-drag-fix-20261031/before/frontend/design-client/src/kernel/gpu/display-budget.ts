export const DISPLAY_TEXTURE_BUDGET = 512 * 1024 * 1024
export function isDisplayBudgetError(error: unknown) {
  return /^(?:Error: )?GPU (?:display resident|linear display) budget exceeded(?:$|\s)/.test(String(error))
}
