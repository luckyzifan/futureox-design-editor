// Original Futureox scheduler. No upstream Nomi runtime is imported.
export const ACTIONS = Object.freeze(['idle', 'work', 'nod', 'celebrate', 'puzzled', 'wave']);
export const FRAME_INTERVAL_MS = 1000 / 30;
export const MAX_DPR = 1.5;

export function normalizeState(value) {
  if (!value || !['active', 'quiet', 'off'].includes(value.mode)
      || typeof value.paused !== 'boolean'
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  return {
    mode: value.mode, paused: value.paused, sequence: value.sequence,
    action: ACTIONS.includes(value.action) ? value.action : 'idle',
  };
}

export function boundedDpr(value) {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_DPR, value)) : 1;
}

// Injected frame APIs keep lifecycle behavior testable without Electron or a GPU.
// At most one rAF is pending; paint frequency is strictly bounded to 30 FPS.
export function createScheduler({ requestFrame, cancelFrame, draw, clear }) {
  let state = { mode: 'off', paused: false, action: 'idle', sequence: -1 };
  let visible = false;
  let reducedMotion = false;
  let disposed = false;
  let pending = null;
  let lastPaint = -Infinity;
  let origin = null;
  const animated = () => visible && state.mode === 'active' && !state.paused && !reducedMotion;
  function stop() {
    if (pending !== null) cancelFrame(pending);
    pending = null;
    origin = null;
  }
  function frame(now) {
    pending = null;
    if (disposed || !animated()) return;
    if (origin === null) origin = now;
    if (now - lastPaint >= FRAME_INTERVAL_MS) {
      draw({ state, elapsed: now - origin, staticFrame: false });
      lastPaint = now;
    }
    pending = requestFrame(frame);
  }
  function reconcile() {
    if (disposed) return;
    stop();
    if (!visible) return;
    if (state.mode === 'off') { clear(); return; }
    if (animated()) pending = requestFrame(frame);
    else draw({ state, elapsed: 0, staticFrame: true });
  }
  return {
    setState(value) {
      if (disposed) return false;
      const next = normalizeState(value);
      if (!next || next.sequence <= state.sequence) return false;
      state = next;
      reconcile();
      return true;
    },
    setVisible(value) {
      if (visible === Boolean(value)) return;
      visible = Boolean(value);
      reconcile();
    },
    setReducedMotion(value) {
      if (reducedMotion === Boolean(value)) return;
      reducedMotion = Boolean(value);
      reconcile();
    },
    invalidate() { reconcile(); },
    dispose() { disposed = true; stop(); },
  };
}
