// Captain draft (TR-50). PURE draft-state engine — captains draft players in a
// snake order with a pick clock; /tv owns the clock + Firebase publish, /play
// sends 'draft-pick'/'team-name'/'team-emoji' events. Random captains for v1
// (manual selection is a later refinement).

// Stage 3a (TR-57): the curated logo pool — in-app icons only, never uploads
// (keeps the $0 architecture, ADR-005). play.html's picker buttons mirror this
// list; keep the two in sync.
export const LOGOS = ['🦅', '⚡', '🐉', '🦈', '👑', '🚀', '🌟', '💀', '🔥', '🐺', '🎯', '🧊'];

/** Build the initial draft. `captains` (Stage 3a): the wheel-chosen captain
 *  ids IN DRAFT ORDER — omitted, captains fall back to a plain shuffle. */
export function createDraftState(players, numTeams, rng = Math.random, captains = null) {
  const shuffled = [...players].sort(() => rng() - 0.5);
  const t = Math.max(2, Math.min(numTeams, players.length));
  const capIds = (captains && captains.length === t)
    ? captains
    : shuffled.slice(0, t).map((p) => p.playerId);
  const teams = capIds.map((cid, i) => ({
    id: `t${i + 1}`, captainId: cid, name: `Team ${i + 1}`, emoji: null,
    members: [cid], logoPickerId: null,
  }));
  const pool = players.map((p) => p.playerId).filter((id) => !capIds.includes(id));
  const state = { type: 'draft', status: pool.length ? 'drafting' : 'naming', teams, pool, turn: 0, dir: 1 };
  if (state.status === 'naming') assignLogoPickers(state, rng);
  return state;
}

// Split-role customization (spec A6): the captain names the team; ONE RANDOM
// non-captain member picks the logo (the captain only if the team is solo).
export function assignLogoPickers(state, rng = Math.random) {
  state.teams.forEach((t) => {
    if (t.logoPickerId) return;
    const others = t.members.filter((id) => id !== t.captainId);
    t.logoPickerId = others.length ? others[Math.floor(rng() * others.length)] : t.captainId;
  });
  return state;
}

/** The logo picker claims an icon. Curated pool only; taken icons are locked. */
export function applyLogo(state, playerId, emoji) {
  if (state.status !== 'naming') return { ok: false, reason: 'not naming' };
  const team = state.teams.find((t) => t.logoPickerId === playerId);
  if (!team) return { ok: false, reason: 'not a logo picker' };
  if (!LOGOS.includes(emoji)) return { ok: false, reason: 'not in the pool' };
  if (state.teams.some((t) => t.emoji === emoji)) return { ok: false, reason: 'taken' };
  team.emoji = emoji;
  return { ok: true };
}

/** 2-minute cap expiry (spec A6): default name "Team {Captain}" + a random
 *  unused logo for every team still missing either. */
export function autoFillCustomization(state, nameOf, rng = Math.random) {
  const unused = () => LOGOS.filter((l) => !state.teams.some((t) => t.emoji === l));
  state.teams.forEach((t, i) => {
    if (!t.name || t.name === `Team ${i + 1}`) t.name = `Team ${nameOf(t.captainId)}`.slice(0, 16);
    if (!t.emoji) { const u = unused(); t.emoji = u[Math.floor(rng() * u.length)] || '⭐'; }
  });
  return state;
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
  if (!state.pool.length) { state.status = 'naming'; assignLogoPickers(state); }
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
  return state.teams.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji || '⭐', members: t.members.map((pid) => ({ playerId: pid, name: nameOf(pid) })) }));
}
