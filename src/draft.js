// Captain draft (TR-50). PURE draft-state engine — captains draft players in a
// snake order with a pick clock; /tv owns the clock + Firebase publish, /play
// sends 'draft-pick'/'team-name'/'team-emoji' events. Random captains for v1
// (manual selection is a later refinement).

/** Build the initial draft: random captains, each team seeded with its captain. */
export function createDraftState(players, numTeams, rng = Math.random) {
  const shuffled = [...players].sort(() => rng() - 0.5);
  const t = Math.max(2, Math.min(numTeams, players.length));
  const teams = [];
  for (let i = 0; i < t; i++) {
    teams.push({ id: `t${i + 1}`, captainId: shuffled[i].playerId, name: `Team ${i + 1}`, emoji: '⭐', members: [shuffled[i].playerId] });
  }
  const pool = shuffled.slice(t).map((p) => p.playerId);
  return { type: 'draft', status: pool.length ? 'drafting' : 'naming', teams, pool, turn: 0, dir: 1 };
}

function advanceTurn(state) {
  const n = state.teams.length;
  let next = state.turn + state.dir;
  if (next >= n) { state.dir = -1; next = n - 1; }
  else if (next < 0) { state.dir = 1; next = 0; }
  state.turn = next;
}

function assign(state, playerId) {
  state.teams[state.turn].members.push(playerId);
  state.pool = state.pool.filter((id) => id !== playerId);
  advanceTurn(state);
  if (!state.pool.length) state.status = 'naming';
}

/** Current captain drafts a pool player. Returns {ok, reason?}. Mutates state. */
export function applyPick(state, captainId, playerId) {
  if (state.status !== 'drafting') return { ok: false, reason: 'not drafting' };
  const team = state.teams[state.turn];
  if (!team || team.captainId !== captainId) return { ok: false, reason: 'not your turn' };
  if (!state.pool.includes(playerId)) return { ok: false, reason: 'not in pool' };
  assign(state, playerId);
  return { ok: true };
}

/** Pick clock expired — auto-assign a random pool player to the current team. */
export function autoPick(state, rng = Math.random) {
  if (state.status !== 'drafting' || !state.pool.length) return { ok: false };
  const playerId = state.pool[Math.floor(rng() * state.pool.length)];
  assign(state, playerId);
  return { ok: true, playerId };
}

export function currentCaptain(state) {
  return state.status === 'drafting' ? state.teams[state.turn].captainId : null;
}

export function isCaptain(state, playerId) {
  return state.teams.some((t) => t.captainId === playerId);
}

/** Teams ready to seed into the bracket (map playerIds -> {playerId,name}). */
export function draftTeams(state, nameOf) {
  return state.teams.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, members: t.members.map((pid) => ({ playerId: pid, name: nameOf(pid) })) }));
}
