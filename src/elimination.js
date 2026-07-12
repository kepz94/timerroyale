// Last-man-standing match (TR-6). Host-only module.
// Composes rounds from the host's game pool (roundKindFn — classic, hard =
// classic mechanics on the fast target band, guess); after each round the
// worst performer is out. Elimination rule: all DNFs (or, in guess rounds,
// everyone who never locked a guess) are eliminated; otherwise the single
// worst deviation is. If EVERYONE missed, nobody is out (replay).
// Last player alive is the champion.
import { ref, set, serverTimestamp } from 'firebase/database';
import { createRound, randomTarget } from './round.js';
import { createGuessRound, randomGuessTarget } from './guess.js';
import { logTransition } from './session.js';

// Hard band mirrors koth: fast, reactive targets (0.5-3.5s) at tenths.
const hardTarget = () => Math.round((500 + Math.random() * 3000) / 100) * 100;

export function createMatch({ db, room, players, onTv, onMatch, roundKindFn, onMoment, initialEliminated = [], initialRoundNum = 0 }) {
  let alive = players.map(({ playerId, name }) => ({ playerId, name }));
  const eliminated = [...initialEliminated]; // [{playerId, name, round, reason}] — seeded on resume
  let roundNum = initialRoundNum;
  let status = 'between'; // between | round | champion
  let currentRound = null;

  function matchState() {
    return {
      type: 'elim',
      status,
      roundNum,
      alive: Object.fromEntries(alive.map((p) => [p.playerId, p.name])),
      eliminated,
      champion: status === 'champion' ? alive[0] : null,
      updatedAt: serverTimestamp()
    };
  }

  function publish() {
    return set(ref(db, `sessions/${room}/match`), matchState());
  }

  function applyElimination(roundState) {
    const slots = Object.values(roundState.players);
    // Guess rounds score by deltaMs; a never-locked guess is the DNF analogue.
    const isGuess = roundState.actualMs != null || slots.some((s) => s.state === 'guessed');
    const missed = isGuess
      ? slots.filter((s) => s.guessMs == null)
      : slots.filter((s) => s.state === 'dnf');
    const scored = (isGuess
      ? slots.filter((s) => s.guessMs != null).map((s) => ({ ...s, _dev: Math.abs(s.deltaMs) }))
      : slots.filter((s) => s.state === 'stopped').map((s) => ({ ...s, _dev: s.deviationMs })))
      .sort((a, b) => a._dev - b._dev);

    let out = [];
    let reasonFor = () => '';
    if (missed.length === slots.length) {
      logTransition('match', 'round', 'no-elimination', `round ${roundNum}: everyone missed — replay`);
    } else if (missed.length > 0) {
      out = missed;
      reasonFor = () => (isGuess ? 'no guess' : 'DNF');
    } else {
      out = [scored[scored.length - 1]];
      reasonFor = (s) => `worst deviation (${s._dev}ms)`;
    }

    for (const s of out) {
      alive = alive.filter((p) => p.playerId !== s.playerId);
      eliminated.push({ playerId: s.playerId, name: s.name, round: roundNum, reason: reasonFor(s) });
      logTransition('match', 'round', 'eliminated', `round ${roundNum}: ${s.name} — ${reasonFor(s)}`);
    }

    if (alive.length === 1) {
      status = 'champion';
      logTransition('match', 'between', 'champion', `${alive[0].name} after round ${roundNum}`);
    } else {
      status = 'between';
    }
    publish();
    onMatch?.(matchState(), out);
  }

  function nextRound() {
    if (status === 'champion' || status === 'round') return;
    roundNum += 1;
    status = 'round';
    publish();
    onMatch?.(matchState(), []);
    const kind = roundKindFn ? roundKindFn() : 'classic';
    const settle = {
      state: (g) => {
        onTv?.state(g);
        if (g.status === 'over') applyElimination(g);
      }
    };
    if (kind === 'guess') {
      currentRound = createGuessRound({
        db, room, players: alive, targetMs: randomGuessTarget(),
        onTv: settle, onMoment: (m) => onMoment?.(m),
      });
    } else {
      const isHard = kind === 'hard';
      currentRound = createRound({
        db, room, players: alive, hard: isHard,
        targetMs: isHard ? hardTarget() : randomTarget(),
        onTv: settle,
      });
    }
    currentRound.begin();
    logTransition('match', 'between', 'round', `round ${roundNum} (${kind}): ${alive.length} players`);
  }

  function handleEvent(ev) {
    currentRound?.handleEvent(ev);
  }

  return {
    nextRound,
    handleEvent,
    isBetween: () => status === 'between',
    isChampion: () => status === 'champion',
    getState: matchState
  };
}

/** Clears any match state from a previous game. */
export function clearMatch(db, room) {
  return set(ref(db, `sessions/${room}/match`), null);
}
