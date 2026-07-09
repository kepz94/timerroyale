// Team match engine (TR-50). A bracket match between two TEAMS. Each round the
// ACTIVE member of each team inputs (members alternate round-to-round; a solo
// team's one member plays every round — the 2v1 fairness rule). Round winner
// (lower deviation) scores a round for their team; first team to `n` round-wins
// takes the match. Reuses round.js. Exposes the koth-like interface so /tv's
// event router (press / next / isBetween) works unchanged.
import { createRound, randomTarget } from './round.js';

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

export function createTeamGame({ db, room, teamA, teamB, n = 3, hard = false, onTv, onGame }) {
  let winsA = 0, winsB = 0, roundNum = 0, status = 'between';
  let currentRound = null, activeA = null, activeB = null;

  function nextRound() {
    if (status === 'over') return;
    activeA = activeMember(teamA, roundNum);
    activeB = activeMember(teamB, roundNum);
    status = 'round';
    currentRound = createRound({
      db, room,
      players: [{ playerId: activeA.playerId, name: activeA.name }, { playerId: activeB.playerId, name: activeB.name }],
      targetMs: randomTarget(), hard,
      onTv: { state: (g) => { onTv?.state(g, { teamA, teamB, winsA, winsB, activeA, activeB, n }); if (g.status === 'over') resolve(g); } }
    });
    currentRound.begin();
  }

  function resolve(g) {
    if (status !== 'round') return; // resolve once per round
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
