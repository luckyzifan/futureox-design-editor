export const RUNTIME_CONFIGURATION_LIMITS: Readonly<Record<string, number>>
export function sanitizeRuntimeConfiguration(value: unknown): Record<string, number>
export function markRuntimeConfiguration<T>(error: T, snapshot: unknown): T
export function runtimeConfigurationFields(error: unknown): Record<string, number>
export function inheritRuntimeConfiguration<T>(source: unknown, target: T): T
