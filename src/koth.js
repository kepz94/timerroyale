// King of the Hill (TR-12). Host-only module.
// Repeating target-time rounds; round winner earns a win;
// first player to N wins is crowned King. All-DNF rounds award nothing.
import { ref, set, serverTimestamp } from 'firebase/database';
import { createRound, randomTarget } from './round.js';
import { logTransition } from './session.js';

export function createKoth({ db, room, players, n, hard = false, onTv, onMatch }) {
  const wins = new Map(players.map((p) => [p.playerId, { playerId: p.playerId, name: p.name, wins: 0 }]));
  let roundNum = 0;
  let status = 'between'; // between | round | king
  let currentRound = null;

  function tally() {
    return [...wins.values()].sort((a, b) => b.wins - a.wins);
  }

  function matchState() {
    return {
      type: 'koth',
      status,
      n,
      hard,
      roundNum,
      tally: tally(),
      king: status === 'king' ? tally()[0] : null,
      updatedAt: serverTimestamp()
    };
  }

  function publish() {
    return set(ref(db, `sessions/${room}/match`), matchState());
  }

  function applyResult(roundState) {
    // In hard mode roundState.winner is null unless the best hit was exact.
    const winnerId = roundState.winner?.playerId ?? null;
    if (winnerId) {
      const w = wins.get(winnerId);
      w.wins += 1;
      logTransition('koth', 'round', 'win-awarded', `round ${roundNum}: ${w.name} -> ${w.wins}/${n}`);
      if (w.wins >= n) {
        status = 'king';
        logTransition('koth', 'between', 'king', `${w.name} crowned after round ${roundNum}`);
      } else {
        status = 'between';
      }
    } else {
      status = 'between';
      logTransition('koth', 'round', 'no-win', `round ${roundNum}: all DNF`);
    }
    publish();
    onMatch?.(matchState(), roundState);
  }

  function nextRound() {
    if (status !== 'between') return;
    roundNum += 1;
    status = 'round';
    publish();
    onMatch?.(matchState(), null);
    currentRound = createRound({
      db, room, players, hard,
      targetMs: randomTarget(),
      onTv: {
        state: (g) => {
          onTv?.state(g);
          if (g.status === 'over') applyResult(g);
        }
      }
    });
    currentRound.begin();
    logTransition('koth', 'between', 'round', `round ${roundNum}, first to ${n}`);
  }

  function handleEvent(ev) {
    currentRound?.handleEvent(ev);
  }

  return {
    nextRound,
    handleEvent,
    isBetween: () => status === 'between',
    isKing: () => status === 'king',
    getState: matchState
  };
}
