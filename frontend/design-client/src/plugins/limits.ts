/** Bounds for one user-loaded plugin. These are host limits, not Figma's. */
export const PLUGIN_LIMITS = {
  mainBytes: 2 * 1024 * 1024,
  uiBytes: 512 * 1024,
  manifestBytes: 64 * 1024,
  runtimeMs: 8_000,
  hostCalls: 20_000,
  guestMemoryBytes: 64 * 1024 * 1024,
  guestStackBytes: 1024 * 1024,
  findNodes: 2_000,
  batchOps: 400,
  messageBytes: 256 * 1024,
  payloadBytes: 1_000_000,
  logLines: 80,
  logChars: 240,
  notifyChars: 500,
} as const
