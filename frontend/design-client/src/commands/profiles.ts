/** Internal adapter contracts, not a caller permission, auth claim or public API version.
 * Stage one shares planning mechanics, deliberately not output parity. */
export type CommandProfile = 'ui-selection-v1' | 'automation-v1'
export const UI_SELECTION_PROFILE: CommandProfile = 'ui-selection-v1'
export const AUTOMATION_PROFILE: CommandProfile = 'automation-v1'
