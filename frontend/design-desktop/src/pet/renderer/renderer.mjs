import { boundedDpr, createScheduler } from './scheduler.mjs';

const canvas = document.getElementById('pet');
const context = canvas.getContext('2d', { alpha: true });
const artwork = new Image();
const media = matchMedia('(prefers-reduced-motion: reduce)');
let ready = false;
let disposed = false;
let width = 1;
let height = 1;
let dpr = 1;

function clear() {
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

function draw({ state, elapsed, staticFrame }) {
  if (!context || !ready || disposed) return;
  clear();
  const t = elapsed / 1000;
  // These are intentionally simple whole-image transforms, not Nomi's 43-action rig.
  const action = staticFrame ? 'idle' : (t > 1.8 && state.action !== 'work' ? 'idle' : state.action);
  let x = 0, y = 0, angle = 0, scaleX = 1, scaleY = 1;
  if (!staticFrame) {
    y = Math.sin(t * 2) * 1.5;
    if (action === 'work') { angle = Math.sin(t * 5) * 0.015; y = Math.sin(t * 5) * 2; }
    if (action === 'nod') { scaleY = 1 - Math.max(0, Math.sin(t * 9)) * 0.045; y = 3 * Math.sin(t * 9); }
    if (action === 'celebrate') { y = -Math.abs(Math.sin(t * 8)) * 14; angle = Math.sin(t * 8) * 0.035; }
    if (action === 'puzzled') angle = Math.sin(Math.min(t, 1) * Math.PI / 2) * 0.07;
    if (action === 'wave') { angle = Math.sin(t * 10) * 0.05; x = Math.sin(t * 10) * 3; }
  }
  const scale = Math.min(width / 480, height / 560) * 0.86;
  const imageWidth = 480 * scale;
  const imageHeight = 560 * scale;
  context.save();
  context.scale(dpr, dpr);
  context.translate(width / 2 + x, height * 0.95 + y);
  context.rotate(angle);
  context.scale(scaleX, scaleY);
  context.drawImage(artwork, -imageWidth / 2, -imageHeight, imageWidth, imageHeight);
  context.restore();
}

const scheduler = createScheduler({
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: handle => cancelAnimationFrame(handle),
  draw, clear,
});
function resize() {
  // Bound backing-store dimensions as well as DPR, even if a host resizes unexpectedly.
  width = Math.max(1, Math.min(640, window.innerWidth));
  height = Math.max(1, Math.min(720, window.innerHeight));
  dpr = boundedDpr(window.devicePixelRatio);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  scheduler.invalidate();
}
function visibility() {
  scheduler.setVisible(ready && !document.hidden);
}
function motion() { scheduler.setReducedMotion(media.matches); }
function dispose() {
  if (disposed) return;
  disposed = true;
  scheduler.dispose();
  unsubscribe?.();
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', visibility);
  media.removeEventListener('change', motion);
  window.removeEventListener('pagehide', dispose);
  artwork.onload = null;
  artwork.onerror = null;
  clear();
}
const unsubscribe = window.nomiPet?.onState(state => scheduler.setState(state));
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', visibility);
media.addEventListener('change', motion);
window.addEventListener('pagehide', dispose);
motion();
resize();
artwork.onload = () => {
  if (disposed) return;
  if (!context) {
    scheduler.dispose();
    canvas.setAttribute('aria-label', 'Companion canvas unavailable');
    return;
  }
  ready = true;
  visibility();
  window.nomiPet?.ready();
};
artwork.onerror = () => {
  // Fail closed: do not create a busy retry loop or fetch a replacement.
  scheduler.dispose();
  canvas.setAttribute('aria-label', 'Companion artwork unavailable');
};
artwork.src = './assets/neutral.png';
