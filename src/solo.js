// Single player mode v1 (TR-13). Fully client-side — no Firebase.
// 5 rounds, random distinct targets 1.0–25.0s, blind timing,
// score = total milliseconds off across all 5 attempts (lower is better).
import { logTransition } from './session.js';

export const SOLO_ROUNDS = 5;

// TR-31 (supersedes TR-19): four quick rounds (0.5-10s) and exactly one
// 10-15s round, shuffled — keeps games snappy.
const BANDS = [
  [10000, 15000],
  [500, 10000],
  [500, 10000],
  [500, 10000],
  [500, 10000]
];

function rollInBand([min, max], taken) {
  let ms;
  do {
    ms = Math.round((min + Math.random() * (max - min)) / 100) * 100;
  } while (taken.has(ms));
  taken.add(ms);
  return ms;
}

export function rollTargets() {
  const taken = new Set();
  const targets = BANDS.map((band) => rollInBand(band, taken));
  // Fisher-Yates shuffle so the long round can land anywhere
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  return targets;
}

export function createSoloGame({ targets = rollTargets() } = {}) {
  let round = 0;              // 0-based index into targets
  let state = 'ready';        // ready | running | done
  let startTs = null;
  const attempts = [];        // [{targetMs, elapsedMs, deviationMs}]

  function press() {
    if (state === 'ready') {
      state = 'running';
      startTs = performance.now();
      logTransition('solo', 'ready', 'running', `round ${round + 1} target ${targets[round]}ms`);
      return { type: 'started' };
    }
    if (state === 'running') {
      const elapsedMs = Math.round(performance.now() - startTs);
      const deviationMs = Math.abs(elapsedMs - targets[round]);
      attempts.push({ targetMs: targets[round], elapsedMs, deviationMs });
      logTransition('solo', 'running', 'stopped', `round ${round + 1}: ${elapsedMs}ms (off by ${deviationMs}ms)`);
      round += 1;
      if (round >= targets.length) {
        state = 'done';
        logTransition('solo', 'stopped', 'done', `total ${totalMs()}ms off`);
        return { type: 'finished', attempt: attempts[attempts.length - 1], totalMs: totalMs() };
      }
      state = 'ready';
      return { type: 'stopped', attempt: attempts[attempts.length - 1] };
    }
    return { type: 'ignored' };
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deviationMs, 0);
  }

  return {
    press,
    rounds: () => targets.length,
    currentRound: () => round + 1,
    currentTargetMs: () => targets[round],
    getState: () => state,
    attempts: () => [...attempts],
    totalMs
  };
}
