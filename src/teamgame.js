// Team match engine (TR-50). A bracket match between two TEAMS. Each round the
// ACTIVE member of each team inputs (members alternate round-to-round; a solo
// team's one member plays every round — the 2v1 fairness rule). Round winner
// (lower deviation) scores a round for their team; first team to `n` round-wins
// takes the match. Reuses round.js. Exposes the koth-like interface so /tv's
// event router (press / next / isBetween) works unchanged.
import { createRound, randomTarget } from './round.js';
import { classicOutcome } from './resolve.js';
import { createHardRound, randomHardTarget } from './hardclassic.js';

/** Pure: round-robin players into `numTeams` teams (sizes within 1). */
export function distributeTeams(players, numTeams) {
  const t = Math.max(2, Math.min(numTeams, players.length));
  const teams = Array.from({ length: t }, (_, i) => ({ id: `t${i + 1}`, name: `Team ${i + 1}`, members: [] }));
  players.forEach((p, i) => teams[i % t].members.push({ playerId: p.playerId, name: p.name }));
  return teams.filter((tm) => tm.members.length > 0);
}

/** Pure: the member of `team` who is active on 0-based round `roundNum`. */
export function activeMember(team, roundNum) {
  return team.members[roundNum % team.members.length];
}

// deadHeatVoid / deadlineMs (TR-52, optional, default OFF): when opted in, a
// round whose two reps share the exact same absolute deviation is voided and
// rerun with a fresh target (same reps, no ledger dot), and the live ticker is
// capped by deadlineMs. Omitting both preserves the original behavior.
// hardLoop (TR-52 §5, optional, default OFF): when set, each round runs the Hard
// Classic 13-attempt retry loop (createHardRound) instead of a simultaneous
// target round. Classic behavior is untouched when off.
export function createTeamGame({ db, room, teamA, teamB, n = 3, hard = false, onTv, onGame, deadHeatVoid = false, deadlineMs, hardLoop = false, targetFn, perPlayerStopMs }) {
  let winsA = 0, winsB = 0, roundNum = 0, status = 'between';
  let currentRound = null, activeA = null, activeB = null;

  const ctx = () => ({ teamA, teamB, winsA, winsB, activeA, activeB, n });

  function nextRound() {
    if (status === 'over') return;
    activeA = activeMember(teamA, roundNum);
    activeB = activeMember(teamB, roundNum);
    status = 'round';
    if (hardLoop) {
      currentRound = createHardRound({
        db, room,
        repA: { playerId: activeA.playerId, name: activeA.name },
        repB: { playerId: activeB.playerId, name: activeB.name },
        targetMs: randomHardTarget(),
        onTv: { state: (g) => onTv?.state(g, ctx()) },
        onResult: (winnerId) => awardRound(winnerId),
      });
    } else {
      currentRound = createRound({
        db, room, hard, deadlineMs, perPlayerStopMs,
        players: [{ playerId: activeA.playerId, name: activeA.name }, { playerId: activeB.playerId, name: activeB.name }],
        targetMs: targetFn ? targetFn() : randomTarget(),
        onTv: { state: (g) => { onTv?.state(g, ctx()); if (g.status === 'over') resolve(g); } }
      });
    }
    currentRound.begin();
  }

  // Award a Hard round's dot (winnerId from createHardRound; null = washout tie).
  function awardRound(winnerId) {
    if (status !== 'round') return;
    if (!winnerId) { status = 'between'; onGame?.({ status: 'tie-void', winsA, winsB, roundNum }); return; }
    if (winnerId === activeA.playerId) winsA += 1; else if (winnerId === activeB.playerId) winsB += 1;
    roundNum += 1;
    if (winsA >= n || winsB >= n) { status = 'over'; onGame?.({ status: 'over', winner: winsA >= n ? teamA : teamB, winsA, winsB }); }
    else { status = 'between'; onGame?.({ status: 'between', winsA, winsB, roundNum }); }
  }

  function resolve(g) {
    if (status !== 'round') return; // resolve once per round
    // TR-52 Dead-Heat Tie-Breaker (opt-in): identical absolute deviations void
    // the round — no dot, rerun the same matchup with a fresh target.
    if (deadHeatVoid) {
      const stopped = Object.values(g.players || {})
        .filter((s) => s.state === 'stopped')
        .map((s) => ({ playerId: s.playerId, deviationMs: s.deviationMs }));
      if (classicOutcome(stopped).deadHeat) {
        status = 'between';
        onGame?.({ status: 'tie-void', winsA, winsB, roundNum });
        setTimeout(() => { if (status === 'between') nextRound(); }, 2600);
        return;
      }
    }
    const w = g.ranking && g.ranking[0];
    if (w === activeA.playerId) winsA += 1; else if (w === activeB.playerId) winsB += 1;
    roundNum += 1;
    if (winsA >= n || winsB >= n) { status = 'over'; onGame?.({ status: 'over', winner: winsA >= n ? teamA : teamB, winsA, winsB }); }
    else { status = 'between'; onGame?.({ status: 'between', winsA, winsB, roundNum }); }
  }

  return {
    nextRound,
    handleEvent: (ev) => currentRound?.handleEvent(ev),
    isBetween: () => status === 'between',
    isOver: () => status === 'over'
  };
}
