// Guess Timer mode (TR-28). Host-only module.
// The TV plays a start cue and a stop cue over a hidden interval (1.0–8.0s);
// players type how much time they think passed. Closest guess wins.
// Guesses stay masked until the reveal so nobody can copy.
import { ref, set, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export const GUESS_MIN_MS = 1000;
export const GUESS_MAX_MS = 8000;
export const GET_READY_MS = 2500;
export const GUESS_WINDOW_MS = 20000;

export function randomGuessTarget() {
  const ms = GUESS_MIN_MS + Math.random() * (GUESS_MAX_MS - GUESS_MIN_MS);
  return Math.round(ms / 100) * 100;
}

export function createGuessRound({ db, room, players, targetMs, onTv, onMoment }) {
  let status = 'ready'; // ready | get-ready | interval | guessing | over
  let actualMs = null;
  let deadlineTimer = null;
  const slots = new Map(players.map((p) => [p.playerId, {
    playerId: p.playerId, name: p.name,
    state: 'waiting', // waiting | guessed | dnf
    guessMs: null, deltaMs: null
  }]));

  function snapshot(revealed) {
    return Object.fromEntries([...slots.values()].map((s) => [s.playerId, revealed
      ? { ...s }
      : { playerId: s.playerId, name: s.name, state: s.state }]));
  }

  function ranking() {
    return [...slots.values()].filter((s) => s.state === 'guessed')
      .sort((a, b) => a.deltaMs - b.deltaMs);
  }

  function publicState() {
    const revealed = status === 'over';
    return {
      mode: 'guess',
      status,
      actualMs: revealed ? actualMs : null,
      players: snapshot(revealed),
      ranking: revealed ? ranking().map((s) => s.playerId) : null,
      winner: revealed ? (ranking()[0] ?? null) : null
    };
  }

  function publish() {
    return set(ref(db, `sessions/${room}/game`), { ...publicState(), updatedAt: serverTimestamp() });
  }

  function finalize(trigger) {
    if (status !== 'guessing') return;
    status = 'over';
    clearTimeout(deadlineTimer);
    for (const s of slots.values()) {
      if (s.state === 'waiting') {
        s.state = 'dnf';
        logTransition('guess', 'waiting', 'dnf', `${s.name}: no guess by deadline`);
      }
    }
    publish();
    onTv?.state(publicState());
    const w = ranking()[0];
    logTransition('guess', 'guessing', 'over',
      `${trigger} — actual ${actualMs}ms, winner ${w ? `${w.name} (Δ${w.deltaMs}ms)` : 'none'}`);
  }

  function begin() {
    status = 'get-ready';
    publish();
    onTv?.state(publicState());
    logTransition('guess', 'ready', 'get-ready', `target ${targetMs}ms hidden`);
    setTimeout(() => {
      status = 'interval';
      const t0 = performance.now();
      onMoment?.('start'); // beep + flash on the TV
      publish();
      onTv?.state(publicState());
      logTransition('guess', 'get-ready', 'interval', 'start cue fired');
      setTimeout(() => {
        actualMs = Math.round(performance.now() - t0); // measured truth, not intent
        onMoment?.('stop');
        status = 'guessing';
        publish();
        onTv?.state(publicState());
        logTransition('guess', 'interval', 'guessing', `stop cue fired, actual ${actualMs}ms`);
        deadlineTimer = setTimeout(() => finalize('guess window expired'), GUESS_WINDOW_MS);
      }, targetMs);
    }, GET_READY_MS);
  }

  function handleEvent(ev) {
    if (ev.type !== 'guess' || status !== 'guessing') return;
    const s = slots.get(ev.playerId);
    if (!s || s.state !== 'waiting') {
      logTransition('guess', status, 'guess-ignored', `event ${ev.eventId}`);
      return;
    }
    const value = Number(ev.value);
    if (!Number.isFinite(value) || value <= 0 || value > 99000) {
      logTransition('guess', status, 'guess-invalid', `event ${ev.eventId}: ${ev.value}`);
      return;
    }
    s.guessMs = Math.round(value);
    s.deltaMs = Math.abs(s.guessMs - actualMs);
    s.state = 'guessed';
    publish();
    onTv?.state(publicState());
    logTransition('guess', 'guessing', 'guess-locked', `event ${ev.eventId}: ${s.name} ${s.guessMs}ms`);
    if ([...slots.values()].every((x) => x.state !== 'waiting')) finalize('all guesses in');
  }

  return { begin, handleEvent, isOver: () => status === 'over', publicState };
}
