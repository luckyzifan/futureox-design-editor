/** Encoded input-file business cap only. Not decompressed/parsed/decoded memory,
 * image pixels, GPU budget, exported bytes, or a promise that 1 GiB fits memory. */
export const IMPORT_INPUT_MAX_BYTES = 1024 ** 3
export const IMPORT_INPUT_LIMIT_MESSAGE = '导入文件超过 1 GiB（1,073,741,824 字节）上限'
export const IMPORT_INPUT_INVALID_MESSAGE = '导入文件字节数无效'
export class ImportInputError extends Error {
  constructor(readonly code: 'IMPORT_INPUT_LIMIT' | 'IMPORT_INPUT_INVALID') {
    super(code === 'IMPORT_INPUT_LIMIT' ? IMPORT_INPUT_LIMIT_MESSAGE : IMPORT_INPUT_INVALID_MESSAGE)
    this.name = 'ImportInputError'
  }
}
export function assertImportInputBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ImportInputError('IMPORT_INPUT_INVALID')
  if (bytes > IMPORT_INPUT_MAX_BYTES) throw new ImportInputError('IMPORT_INPUT_LIMIT')
}
export function importInputStatus(error: unknown): { key: 'importInputTooLarge' | 'importInputInvalid' } | undefined {
  const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined
  if (message === IMPORT_INPUT_LIMIT_MESSAGE) return { key: 'importInputTooLarge' }
  if (message === IMPORT_INPUT_INVALID_MESSAGE) return { key: 'importInputInvalid' }
}
