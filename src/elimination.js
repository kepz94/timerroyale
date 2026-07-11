// Last-man-standing match (TR-6). Host-only module.
// Composes target-time rounds; after each round the worst performer is out.
// Elimination rule: all DNFs are eliminated; if nobody DNF'd, the single worst
// deviation is eliminated. If EVERYONE DNF'd, nobody is eliminated (replay).
// Last player alive is the champion.
import { ref, set, serverTimestamp } from 'firebase/database';
import { createRound, randomTarget } from './round.js';
import { logTransition } from './session.js';

export function createMatch({ db, room, players, onTv, onMatch, initialEliminated = [], initialRoundNum = 0 }) {
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
    const dnfs = slots.filter((s) => s.state === 'dnf');
    const stopped = slots.filter((s) => s.state === 'stopped')
      .sort((a, b) => a.deviationMs - b.deviationMs);

    let out = [];
    let reasonFor = () => '';
    if (dnfs.length === slots.length) {
      logTransition('match', 'round', 'no-elimination', `round ${roundNum}: everyone DNF — replay`);
    } else if (dnfs.length > 0) {
      out = dnfs;
      reasonFor = () => 'DNF';
    } else {
      out = [stopped[stopped.length - 1]];
      reasonFor = (s) => `worst deviation (${s.deviationMs}ms)`;
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
    currentRound = createRound({
      db, room,
      players: alive,
      targetMs: randomTarget(),
      onTv: {
        state: (g) => {
          onTv?.state(g);
          if (g.status === 'over') applyElimination(g);
        }
      }
    });
    currentRound.begin();
    logTransition('match', 'between', 'round', `round ${roundNum}: ${alive.length} players`);
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
