// Casual Play (TR-53). One button, 5 rounds, a random mix of Classic
// (tap-to-time) and Guess (feel-the-gap) rounds. Fully client-side — no Firebase.
// Score = total milliseconds off across all 5 rounds (lower is better),
// which is the SAME scale both existing solo modes already use, so a mixed
// game tallies cleanly.
//
// Isolated on purpose: this composes the existing pure primitives
// (classic timing + guess interval) into a per-round plan without touching
// solo.js / guesssolo.js. Extend by adding modes to ROUND_MODES + a branch
// in press()/arm(); never renumber.
import { logTransition } from './session.js';
import { randomGuessTarget } from './guess.js';

export const CASUAL_ROUNDS = 5;
export const ROUND_MODES = ['classic', 'guess'];

// Classic targets stay snappy for casual (0.5–8.0s, rounded to 0.1s).
function rollClassicTarget(taken) {
  let ms;
  do {
    ms = Math.round((500 + Math.random() * 7500) / 100) * 100;
  } while (taken.has(ms));
  taken.add(ms);
  return ms;
}

// Build a 5-round plan with a guaranteed mix (>=1 classic AND >=1 guess),
// then Fisher-Yates shuffle so the modes land in an unpredictable order.
export function rollCasualPlan(rounds = CASUAL_ROUNDS) {
  const modes = [];
  modes.push('classic', 'guess'); // guarantee the mix
  for (let i = modes.length; i < rounds; i++) {
    modes.push(ROUND_MODES[Math.floor(Math.random() * ROUND_MODES.length)]);
  }
  for (let i = modes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [modes[i], modes[j]] = [modes[j], modes[i]];
  }
  const taken = new Set();
  return modes.map((mode) =>
    mode === 'classic'
      ? { mode: 'classic', targetMs: rollClassicTarget(taken) }
      : { mode: 'guess', targetMs: randomGuessTarget() }
  );
}

// attempts entries are normalized to the shared shape the UI already renders:
//   { mode, targetMs, elapsedMs, deviationMs }
// (for guess rounds: targetMs = the actual hidden interval, elapsedMs = the guess)
export function createCasualGame({ plan = rollCasualPlan(), onMoment } = {}) {
  let round = 0;                 // 0-based index into plan
  let state = 'ready';           // ready | running | get-ready | interval | guessing | done
  let startTs = null;            // classic timing anchor
  let actualMs = null;           // guess hidden interval, once revealed
  let armT0 = null;
  const attempts = [];

  const cur = () => plan[round];

  function finishRound(attempt) {
    attempts.push(attempt);
    round += 1;
    if (round >= plan.length) {
      state = 'done';
      logTransition('casual', 'round', 'done', `total ${totalMs()}ms off`);
      return { type: 'finished', attempt, totalMs: totalMs() };
    }
    state = 'ready';
    return { type: 'stopped', attempt };
  }

  // Classic rounds: tap to start, tap to stop.
  function press() {
    if (cur().mode !== 'classic') return { type: 'ignored' };
    if (state === 'ready') {
      state = 'running';
      startTs = performance.now();
      logTransition('casual', 'ready', 'running', `R${round + 1} classic target ${cur().targetMs}ms`);
      return { type: 'started' };
    }
    if (state === 'running') {
      const elapsedMs = Math.round(performance.now() - startTs);
      const deviationMs = Math.abs(elapsedMs - cur().targetMs);
      return finishRound({ mode: 'classic', targetMs: cur().targetMs, elapsedMs, deviationMs });
    }
    return { type: 'ignored' };
  }

  // Guess rounds: arm the hidden interval; onGuessPhase fires when it's time to guess.
  function arm(onGuessPhase) {
    if (cur().mode !== 'guess' || state !== 'ready') return false;
    state = 'get-ready';
    logTransition('casual', 'ready', 'get-ready', `R${round + 1} guess hidden ${cur().targetMs}ms`);
    setTimeout(() => {
      state = 'interval';
      armT0 = performance.now();
      onMoment?.('start');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - armT0);
        onMoment?.('stop');
        state = 'guessing';
        logTransition('casual', 'interval', 'guessing', `stop cue, actual ${actualMs}ms`);
        onGuessPhase?.();
      }, cur().targetMs);
    }, 1500);
    return true;
  }

  function submitGuess(guessMs) {
    if (cur().mode !== 'guess' || state !== 'guessing') return null;
    const deviationMs = Math.abs(guessMs - actualMs);
    return finishRound({ mode: 'guess', targetMs: actualMs, elapsedMs: guessMs, deviationMs });
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deviationMs, 0);
  }

  return {
    press, arm, submitGuess, totalMs,
    plan: () => plan.map((p) => ({ ...p })),
    rounds: () => plan.length,
    currentRound: () => round + 1,
    currentMode: () => (state === 'done' ? null : cur().mode),
    currentTargetMs: () => (cur().mode === 'classic' ? cur().targetMs : null),
    getState: () => state,
    attempts: () => [...attempts]
  };
}
