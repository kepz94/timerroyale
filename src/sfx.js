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
