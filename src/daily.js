// Daily Royale (TR-23). Wordle-style: everyone gets the same 3-round challenge
// each day (deterministically seeded from the date — no server needed),
// one attempt, locked until local midnight.
// Rounds: 0.5–7s, 7–15s, 15–25s; every target ends in a nonzero tenth (6.7, 12.3…).
export const DAILY_ROUNDS = 3;
const BANDS_TENTHS = [
  [5, 69],     // 0.5–6.9s in tenths
  [70, 149],   // 7.0–14.9s
  [150, 249]   // 15.0–24.9s
];

function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dailyTargets(key = dateKey()) {
  const rand = mulberry32(seedFrom('timerroyale-daily-' + key));
  return BANDS_TENTHS.map(([min, max]) => {
    const opts = [];
    for (let v = min; v <= max; v++) if (v % 10 !== 0) opts.push(v * 100); // never a whole second
    return opts[Math.floor(rand() * opts.length)];
  });
}

const storageKey = () => 'tr-daily-' + dateKey();

export function todayResult() {
  try { return JSON.parse(localStorage.getItem(storageKey())); } catch { return null; }
}

export function saveResult(result) {
  localStorage.setItem(storageKey(), JSON.stringify({ ...result, dateKey: dateKey(), playedAt: Date.now() }));
}

export function msToMidnight(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}

/** Wordle-flavored rating per attempt: green <0.1s off, yellow <0.5s, red otherwise. */
export function ratingColor(deviationMs) {
  return deviationMs < 100 ? '#22c55e' : deviationMs < 500 ? '#f59e0b' : '#ef4444';
}
