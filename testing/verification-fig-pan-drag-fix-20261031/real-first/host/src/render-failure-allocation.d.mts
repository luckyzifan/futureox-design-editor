export function sanitizeFailureAllocation(value: unknown): Record<string, number>
export function markFailureAllocation<T>(error: T, fields: unknown): T
export function failureAllocationFields(error: unknown): Record<string, number>
export function inheritFailureAllocation<T>(source: unknown, target: T): T
