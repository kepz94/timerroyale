// King of the Hill (TR-12). Host-only module.
// Repeating target-time rounds; round winner earns a win;
// first player to N wins is crowned King. All-DNF rounds award nothing.
import { ref, set, serverTimestamp } from 'firebase/database';
import { createRound, randomTarget } from './round.js';
import { classicOutcome } from './resolve.js';
import { createHardRound, randomHardTarget } from './hardclassic.js';
import { createGuessRound, randomGuessTarget } from './guess.js';

// Hard KOTH uses a fast, reactive band (0.5-3.5s) to balance exact-hit difficulty.
function kothTarget(hard) {
  return hard ? Math.round((500 + Math.random() * 3000) / 100) * 100 : randomTarget();
}
import { logTransition } from './session.js';

// deadHeatVoid / deadlineMs (TR-52, optional, default OFF): when the caller opts
// in (party Classic tournaments), a round whose two closest contenders share the
// exact same absolute deviation is VOIDED and rerun with a fresh target, and the
// live ticker is capped by deadlineMs. Omitting both preserves the original PvE
// KOTH behavior exactly.
// hardLoop (TR-52 §5, optional, default OFF): for a 2-player match, each round
// runs the Hard Classic 13-attempt retry loop instead of a simultaneous round.
export function createKoth({ db, room, players, n, hard = false, onTv, onMatch, deadHeatVoid = false, deadlineMs, hardLoop = false, guessLoop = false, roundKindFn, onMoment, targetFn, perPlayerStopMs, matchExtra, initialWins }) {
  // initialWins (resume): seed each player's game score from a persisted tally.
  const wins = new Map(players.map((p) => [p.playerId, { playerId: p.playerId, name: p.name, wins: (initialWins && initialWins[p.playerId]) || 0 }]));
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
      updatedAt: serverTimestamp(),
      // Carry the tournament snapshot so a mid-game TV reload can still RESUME
      // (koth owns the match node during a PvP game). No-op for PvE.
      ...(matchExtra || {})
    };
  }

  function publish() {
    return set(ref(db, `sessions/${room}/match`), matchState());
  }

  function applyResult(roundState) {
    // TR-52 Dead-Heat Tie-Breaker (opt-in): identical absolute deviations void
    // the round — no win is awarded and a fresh target reruns automatically.
    if (deadHeatVoid) {
      // Contenders by deviation — Classic uses 'stopped'/deviationMs, Guess uses
      // 'guessed'/deltaMs. The old stopped-only filter let Guess ties fall
      // through to insertion order, silently handing player 1 the win (TR-54).
      const stopped = Object.values(roundState.players || {})
        .map((s) => s.state === 'stopped'
          ? { playerId: s.playerId, deviationMs: s.deviationMs }
          : s.state === 'guessed' && s.deltaMs != null
            ? { playerId: s.playerId, deviationMs: s.deltaMs }
            : null)
        .filter(Boolean);
      if (classicOutcome(stopped).deadHeat) {
        status = 'between';
        logTransition('koth', 'round', 'tie-void', `round ${roundNum}: dead-heat, rerunning`);
        publish();
        onMatch?.({ ...matchState(), tieVoid: true }, roundState);
        setTimeout(() => { if (status === 'between') nextRound(); }, 2600);
        return;
      }
    }
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

  // Award a Hard round's dot (winnerId from createHardRound; null = washout tie).
  function applyHardResult(winnerId) {
    if (winnerId) {
      const w = wins.get(winnerId); w.wins += 1;
      logTransition('koth', 'round', 'win-awarded', `hard round ${roundNum}: ${w.name} -> ${w.wins}/${n}`);
      status = w.wins >= n ? 'king' : 'between';
    } else {
      status = 'between';
      logTransition('koth', 'round', 'no-win', `hard round ${roundNum}: void`);
      // Stage 1: an exact tie restarts the round with a fresh target.
      publish();
      onMatch?.({ ...matchState(), tieVoid: true }, null);
      setTimeout(() => { if (status === 'between') nextRound(); }, 2600);
      return;
    }
    publish();
    onMatch?.(matchState(), null);
  }

  // Per-round mode pick: roundKindFn (mixed pools) wins; else the single-loop flags.
  function pickKind() {
    if (roundKindFn) return roundKindFn();
    if (guessLoop) return 'guess';
    if (hardLoop) return 'hard';
    return 'classic';
  }

  function nextRound() {
    if (status !== 'between') return;
    roundNum += 1;
    status = 'round';
    publish();
    onMatch?.(matchState(), null);
    const kind = pickKind();
    if (kind === 'guess') {
      currentRound = createGuessRound({
        db, room, players, targetMs: randomGuessTarget(),
        onTv: { state: (g) => { onTv?.state(g); if (g.status === 'over') applyResult(g); } },
        onMoment: (m) => onMoment?.(m),
      });
    } else if (kind === 'hard' && players.length === 2) {
      currentRound = createHardRound({
        db, room, repA: players[0], repB: players[1], targetMs: randomHardTarget(),
        onTv: { state: (g) => onTv?.state(g) },
        onResult: (winnerId) => applyHardResult(winnerId),
      });
    } else {
      const isHard = kind === 'hard';
      currentRound = createRound({
        db, room, players, hard: isHard, deadlineMs, perPlayerStopMs,
        targetMs: (!isHard && targetFn) ? targetFn() : kothTarget(isHard),
        onTv: { state: (g) => { onTv?.state(g); if (g.status === 'over') applyResult(g); } }
      });
    }
    currentRound.begin();
    logTransition('koth', 'between', 'round', `round ${roundNum} (${kind}), first to ${n}`);
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
