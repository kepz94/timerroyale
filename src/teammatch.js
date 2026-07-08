// Team match (TR-7). Host-only module.
// A fixed-length series of relay rounds. Points by rank per round
// (N units: 1st = N pts … last finisher = 1 pt, DNF = 0).
// Winner = most points; tie broken by lowest cumulative deviation.
import { ref, set, serverTimestamp } from 'firebase/database';
import { createRelayRound } from './relay.js';
import { randomTarget } from './round.js';
import { logTransition } from './session.js';

export const DEFAULT_SERIES_ROUNDS = 3;

export function createTeamMatch({ db, room, units, rounds = DEFAULT_SERIES_ROUNDS, onTv, onMatch }) {
  const totals = new Map(units.map((u) => [u.unitId, { unitId: u.unitId, name: u.name, points: 0, cumDevMs: 0 }]));
  let roundNum = 0;
  let status = 'between'; // between | round | final
  let currentRound = null;

  function leaderboard() {
    return [...totals.values()].sort((a, b) => b.points - a.points || a.cumDevMs - b.cumDevMs);
  }

  function matchState() {
    return {
      type: 'teams',
      status,
      roundNum,
      rounds,
      units: Object.fromEntries(units.map((u) => [u.unitId, { name: u.name, members: u.members }])),
      leaderboard: leaderboard(),
      winner: status === 'final' ? leaderboard()[0] : null,
      updatedAt: serverTimestamp()
    };
  }

  function publish() {
    return set(ref(db, `sessions/${room}/match`), matchState());
  }

  function applyScores(roundState) {
    const ranked = (roundState.ranking || []).map((id) => roundState.units[id]);
    ranked.forEach((slot, idx) => {
      const t = totals.get(slot.unitId);
      t.points += units.length - idx;
      t.cumDevMs += slot.avgDeviationMs;
    });
    for (const s of Object.values(roundState.units)) {
      if (s.state === 'dnf') logTransition('teammatch', 'round', 'dnf-zero-points', `${s.name} round ${roundNum}`);
    }
    status = roundNum >= rounds ? 'final' : 'between';
    publish();
    onMatch?.(matchState(), roundState);
    logTransition('teammatch', 'round', status,
      `round ${roundNum}/${rounds} scored — leader ${leaderboard()[0].name} (${leaderboard()[0].points} pts)`);
  }

  function nextRound() {
    if (status !== 'between') return;
    roundNum += 1;
    status = 'round';
    publish();
    onMatch?.(matchState(), null);
    currentRound = createRelayRound({
      db, room, units,
      targetMs: randomTarget(),
      onTv: {
        state: (g) => {
          onTv?.state(g);
          if (g.status === 'over') applyScores(g);
        }
      }
    });
    currentRound.begin();
    logTransition('teammatch', 'between', 'round', `round ${roundNum}/${rounds}`);
  }

  function handleEvent(ev) {
    currentRound?.handleEvent(ev);
  }

  return {
    nextRound,
    handleEvent,
    isBetween: () => status === 'between',
    isFinal: () => status === 'final',
    getState: matchState
  };
}
