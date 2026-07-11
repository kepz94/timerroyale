// Buzzer + haptics (TR-27). Synthesized with Web Audio — no files, offline-safe.
// Start press: short high blip. Stop press: lower, longer buzz.
let ctx = null;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function beep({ freq, durationMs, type = 'square', gain = 0.12 }) {
  const c = ensureCtx();
  window.__sfxLog = window.__sfxLog || [];
  window.__sfxLog.push({ freq, durationMs, at: Date.now(), ctxState: c?.state ?? 'none' });
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + durationMs / 1000);
  osc.connect(g).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + durationMs / 1000);
}

function vibrate(ms) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

/** Timer started: bright, short. */
export function sfxStart() {
  beep({ freq: 880, durationMs: 110 });
  vibrate(50);
}

/** Timer stopped: lower, longer — the "locked in" buzz. */
export function sfxStop() {
  beep({ freq: 392, durationMs: 220 });
  vibrate([40, 30, 40]);
}

/* ---- Guess the Clock whole-screen signal (TR-56 Stage 2, spec B4) ----
   The signal IS the game: near-black waiting screen, a full-screen GREEN slam
   (~300ms decay) with a LONG sustained start beep (~0.5s), a motionless dark
   counting state, then a RED slam with a shorter, lower stop beep. Shared by
   the party phone controller and solo mode so solo trains the party reflex. */

/** Long sustained start beep (~0.5s). */
export function guessStartCue() {
  beep({ freq: 780, durationMs: 500, gain: 0.16 });
  vibrate(60);
}

/** Shorter, lower stop beep. */
export function guessStopCue() {
  beep({ freq: 330, durationMs: 240, gain: 0.16 });
  vibrate([50, 40, 50]);
}

/** Full-screen color slam with ~300ms decay. kind: 'start' (green) | 'stop' (red). */
export function slamFlash(kind) {
  let f = document.getElementById('guess-slam');
  if (!f) {
    f = document.createElement('div');
    f.id = 'guess-slam';
    f.style.cssText = 'position:fixed;inset:0;z-index:999;pointer-events:none;opacity:0;';
    document.body.appendChild(f);
  }
  f.style.transition = 'none';
  f.style.background = kind === 'start' ? '#22c55e' : '#ef4444';
  f.style.opacity = '1';
  void f.offsetWidth; // restart the transition
  f.style.transition = 'opacity 300ms ease-out';
  f.style.opacity = '0';
}
