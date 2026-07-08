// Single player mode v1 (TR-13). Fully client-side — no Firebase.
// 5 rounds, random distinct targets 1.0–25.0s, blind timing,
// score = total milliseconds off across all 5 attempts (lower is better).
import { logTransition } from './session.js';

export const SOLO_ROUNDS = 5;
export const SOLO_TARGET_MIN_MS = 1000;
export const SOLO_TARGET_MAX_MS = 25000;

export function rollTargets() {
  const targets = new Set();
  while (targets.size < SOLO_ROUNDS) {
    const ms = SOLO_TARGET_MIN_MS + Math.random() * (SOLO_TARGET_MAX_MS - SOLO_TARGET_MIN_MS);
    targets.add(Math.round(ms / 100) * 100);
  }
  return [...targets];
}

export function createSoloGame() {
  const targets = rollTargets();
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
      if (round >= SOLO_ROUNDS) {
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
    currentRound: () => round + 1,
    currentTargetMs: () => targets[round],
    getState: () => state,
    attempts: () => [...attempts],
    totalMs
  };
}
