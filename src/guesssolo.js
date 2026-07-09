// Solo Guess Timer (TR-29). Fully client-side.
// The PHONE plays the start/stop cues over a hidden interval (1.0–8.0s);
// the player types how long it felt. 3 rounds; score = total seconds off.
import { logTransition } from './session.js';
import { randomGuessTarget } from './guess.js';

export const GUESS_SOLO_ROUNDS = 3;

export function createGuessSoloGame({ rounds = GUESS_SOLO_ROUNDS, onMoment, targets: seeded } = {}) {
  const targets = (seeded && seeded.length) ? seeded.slice(0, rounds) : Array.from({ length: rounds }, randomGuessTarget);
  let round = 0;
  let state = 'ready'; // ready | get-ready | interval | guessing | done
  let actualMs = null;
  let t0 = null;
  const attempts = []; // [{actualMs, guessMs, deltaMs}]

  function arm(onGuessPhase) {
    if (state !== 'ready') return false;
    state = 'get-ready';
    logTransition('guess-solo', 'ready', 'get-ready', `round ${round + 1}, hidden ${targets[round]}ms`);
    setTimeout(() => {
      state = 'interval';
      t0 = performance.now();
      onMoment?.('start');
      logTransition('guess-solo', 'get-ready', 'interval', 'start cue');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - t0);
        onMoment?.('stop');
        state = 'guessing';
        logTransition('guess-solo', 'interval', 'guessing', `stop cue, actual ${actualMs}ms`);
        onGuessPhase?.();
      }, targets[round]);
    }, 1500);
    return true;
  }

  function submitGuess(guessMs) {
    if (state !== 'guessing') return null;
    const deltaMs = Math.abs(guessMs - actualMs);
    attempts.push({ actualMs, guessMs, deltaMs });
    logTransition('guess-solo', 'guessing', 'scored', `round ${round + 1}: guessed ${guessMs}ms vs ${actualMs}ms (Δ${deltaMs}ms)`);
    round += 1;
    state = round >= rounds ? 'done' : 'ready';
    if (state === 'done') logTransition('guess-solo', 'scored', 'done', `total ${totalMs()}ms`);
    return attempts[attempts.length - 1];
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deltaMs, 0);
  }

  return {
    arm, submitGuess, totalMs,
    rounds: () => rounds,
    currentRound: () => round + 1,
    getState: () => state,
    attempts: () => [...attempts]
  };
}
// Solo Guess Timer (TR-29). Fully client-side.
// The PHONE plays the start/stop cues over a hidden interval (1.0–8.0s);
// the player types how long it felt. 3 rounds; score = total seconds off.
import { logTransition } from './session.js';
import { randomGuessTarget } from './guess.js';

export const GUESS_SOLO_ROUNDS = 3;

export function createGuessSoloGame({ rounds = GUESS_SOLO_ROUNDS, onMoment, targets: seeded } = {}) {
  const targets = (seeded && seeded.length) ? seeded.slice(0, rounds) : Array.from({ length: rounds }, randomGuessTarget);
  let round = 0;
  let state = 'ready'; // ready | get-ready | interval | guessing | done
  let actualMs = null;
  let t0 = null;
  const attempts = []; // [{actualMs, guessMs, deltaMs}]

  function arm(onGuessPhase) {
    if (state !== 'ready') return false;
    state = 'get-ready';
    logTransition('guess-solo', 'ready', 'get-ready', `round ${round + 1}, hidden ${targets[round]}ms`);
    setTimeout(() => {
      state = 'interval';
      t0 = performance.now();
      onMoment?.('start');
      logTransition('guess-solo', 'get-ready', 'interval', 'start cue');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - t0);
        onMoment?.('stop');
        state = 'guessing';
        logTransition('guess-solo', 'interval', 'guessing', `stop cue, actual ${actualMs}ms`);
        onGuessPhase?.();
      }, targets[round]);
    }, 1500);
    return true;
  }

  function submitGuess(guessMs) {
    if (state !== 'guessing') return null;
    const deltaMs = Math.abs(guessMs - actualMs);
    attempts.push({ actualMs, guessMs, deltaMs });
    logTransition('guess-solo', 'guessing', 'scored', `round ${round + 1}: guessed ${guessMs}ms vs ${actualMs}ms (Δ${deltaMs}ms)`);
    round += 1;
    state = round >= rounds ? 'done' : 'ready';
    if (state === 'done') logTransition('guess-solo', 'scored', 'done', `total ${totalMs()}ms`);
    return attempts[attempts.length - 1];
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deltaMs, 0);
  }

  return {
    arm, submitGuess, totalMs,
    rounds: () => rounds,
    currentRound: () => round + 1,
    getState: () => state,
    attempts: () => [...attempts]
  };
}
// Solo Guess Timer (TR-29). Fully client-side.
// The PHONE plays the start/stop cues over a hidden interval (1.0–8.0s);
// the player types how long it felt. 3 rounds; score = total seconds off.
import { logTransition } from './session.js';
import { randomGuessTarget } from './guess.js';

export const GUESS_SOLO_ROUNDS = 3;

export function createGuessSoloGame({ rounds = GUESS_SOLO_ROUNDS, onMoment, targets: seeded } = {}) {
  const targets = (seeded && seeded.length) ? seeded.slice(0, rounds) : Array.from({ length: rounds }, randomGuessTarget);
  let round = 0;
  let state = 'ready'; // ready | get-ready | interval | guessing | done
  let actualMs = null;
  let t0 = null;
  const attempts = []; // [{actualMs, guessMs, deltaMs}]

  function arm(onGuessPhase) {
    if (state !== 'ready') return false;
    state = 'get-ready';
    logTransition('guess-solo', 'ready', 'get-ready', `round ${round + 1}, hidden ${targets[round]}ms`);
    setTimeout(() => {
      state = 'interval';
      t0 = performance.now();
      onMoment?.('start');
      logTransition('guess-solo', 'get-ready', 'interval', 'start cue');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - t0);
        onMoment?.('stop');
        state = 'guessing';
        logTransition('guess-solo', 'interval', 'guessing', `stop cue, actual ${actualMs}ms`);
        onGuessPhase?.();
      }, targets[round]);
    }, 1500);
    return true;
  }

  function submitGuess(guessMs) {
    if (state !== 'guessing') return null;
    const deltaMs = Math.abs(guessMs - actualMs);
    attempts.push({ actualMs, guessMs, deltaMs });
    logTransition('guess-solo', 'guessing', 'scored', `round ${round + 1}: guessed ${guessMs}ms vs ${actualMs}ms (Δ${deltaMs}ms)`);
    round += 1;
    state = round >= rounds ? 'done' : 'ready';
    if (state === 'done') logTransition('guess-solo', 'scored', 'done', `total ${totalMs()}ms`);
    return attempts[attempts.length - 1];
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deltaMs, 0);
  }

  return {
    arm, submitGuess, totalMs,
    rounds: () => rounds,
    currentRound: () => round + 1,
    getState: () => state,
    attempts: () => [...attempts]
  };
}
// Solo Guess Timer (TR-29). Fully client-side.
// The PHONE plays the start/stop cues over a hidden interval (1.0–8.0s);
// the player types how long it felt. 3 rounds; score = total seconds off.
import { logTransition } from './session.js';
import { randomGuessTarget } from './guess.js';

export const GUESS_SOLO_ROUNDS = 3;

export function createGuessSoloGame({ rounds = GUESS_SOLO_ROUNDS, onMoment, targets: seeded } = {}) {
  const targets = (seeded && seeded.length) ? seeded.slice(0, rounds) : Array.from({ length: rounds }, randomGuessTarget);
  let round = 0;
  let state = 'ready'; // ready | get-ready | interval | guessing | done
  let actualMs = null;
  let t0 = null;
  const attempts = []; // [{actualMs, guessMs, deltaMs}]

  function arm(onGuessPhase) {
    if (state !== 'ready') return false;
    state = 'get-ready';
    logTransition('guess-solo', 'ready', 'get-ready', `round ${round + 1}, hidden ${targets[round]}ms`);
    setTimeout(() => {
      state = 'interval';
      t0 = performance.now();
      onMoment?.('start');
      logTransition('guess-solo', 'get-ready', 'interval', 'start cue');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - t0);
        onMoment?.('stop');
        state = 'guessing';
        logTransition('guess-solo', 'interval', 'guessing', `stop cue, actual ${actualMs}ms`);
        onGuessPhase?.();
      }, targets[round]);
    }, 1500);
    return true;
  }

  function submitGuess(guessMs) {
    if (state !== 'guessing') return null;
    const deltaMs = Math.abs(guessMs - actualMs);
    attempts.push({ actualMs, guessMs, deltaMs });
    logTransition('guess-solo', 'guessing', 'scored', `round ${round + 1}: guessed ${guessMs}ms vs ${actualMs}ms (Δ${deltaMs}ms)`);
    round += 1;
    state = round >= rounds ? 'done' : 'ready';
    if (state === 'done') logTransition('guess-solo', 'scored', 'done', `total ${totalMs()}ms`);
    return attempts[attempts.length - 1];
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deltaMs, 0);
  }

  return {
    arm, submitGuess, totalMs,
    rounds: () => rounds,
    currentRound: () => round + 1,
    getState: () => state,
    attempts: () => [...attempts]
  };
}
// Solo Guess Timer (TR-29). Fully client-side.
// The PHONE plays the start/stop cues over a hidden interval (1.0–8.0s);
// the player types how long it felt. 3 rounds; score = total seconds off.
import { logTransition } from './session.js';
import { randomGuessTarget } from './guess.js';

export const GUESS_SOLO_ROUNDS = 3;

export function createGuessSoloGame({ rounds = GUESS_SOLO_ROUNDS, onMoment } = {}) {
  const targets = Array.from({ length: rounds }, randomGuessTarget);
  let round = 0;
  let state = 'ready'; // ready | get-ready | interval | guessing | done
  let actualMs = null;
  let t0 = null;
  const attempts = []; // [{actualMs, guessMs, deltaMs}]

  function arm(onGuessPhase) {
    if (state !== 'ready') return false;
    state = 'get-ready';
    logTransition('guess-solo', 'ready', 'get-ready', `round ${round + 1}, hidden ${targets[round]}ms`);
    setTimeout(() => {
      state = 'interval';
      t0 = performance.now();
      onMoment?.('start');
      logTransition('guess-solo', 'get-ready', 'interval', 'start cue');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - t0);
        onMoment?.('stop');
        state = 'guessing';
        logTransition('guess-solo', 'interval', 'guessing', `stop cue, actual ${actualMs}ms`);
        onGuessPhase?.();
      }, targets[round]);
    }, 1500);
    return true;
  }

  function submitGuess(guessMs) {
    if (state !== 'guessing') return null;
    const deltaMs = Math.abs(guessMs - actualMs);
    attempts.push({ actualMs, guessMs, deltaMs });
    logTransition('guess-solo', 'guessing', 'scored', `round ${round + 1}: guessed ${guessMs}ms vs ${actualMs}ms (Δ${deltaMs}ms)`);
    round += 1;
    state = round >= rounds ? 'done' : 'ready';
    if (state === 'done') logTransition('guess-solo', 'scored', 'done', `total ${totalMs()}ms`);
    return attempts[attempts.length - 1];
  }

  function totalMs() {
    return attempts.reduce((sum, a) => sum + a.deltaMs, 0);
  }

  return {
    arm, submitGuess, totalMs,
    rounds: () => rounds,
    currentRound: () => round + 1,
    getState: () => state,
    attempts: () => [...attempts]
  };
}
