// Host menu branching logic (TR-46). PURE, dependency-free module — encodes the
// "Host Menu Branch Logic Blueprint": Screen-1 environment split, game-pool
// resolution, per-round/per-challenge mode picking, category validation gates,
// and single-elim bracket seeding with byes. The UI layers (Screen-1 selector,
// host controller dashboard, TV bracket render) consume this; no gameplay
// engine (round/koth/elimination/teammatch) is modified.

/* ------------------------------- taxonomy -------------------------------- */

export const ENVIRONMENTS = { ONEVONE: '1v1', PARTY: 'party' };

export const GAME_MODES = { CLASSIC: 'classic', HARD: 'hard', GUESS: 'guess' };

// Branch A (1v1 remote) hides Hard Classic for casual accessibility.
export const POOL_1V1 = [GAME_MODES.CLASSIC, GAME_MODES.GUESS];
// Branch B (party) exposes all three.
export const POOL_PARTY = [GAME_MODES.CLASSIC, GAME_MODES.HARD, GAME_MODES.GUESS];

export const CATEGORIES = { TEAMS: 'teams', PVP: 'pvp', PVE: 'pve' };
export const PVE_OPTIONS = { KOTH: 'koth', LMS: 'lms' };

export const KOTH_THRESHOLDS = [5, 7, 10];

// Match/game structure (party tournaments) — Stage 1 (ADR-005): games are
// first to 4 rounds, matches Best of 3. tournament.js owns the live values.
export const TEAMS_MATCH = { gamesToWin: 2, roundsPerGame: 4 }; // Bo3, first to 4 rounds/game
export const PVP_MATCH = { gamesToWin: 2, roundsPerGame: 4 };
export const DRAFT_PICK_SECONDS = 20; // captain pick timeout before auto-assign

// Hard-KOTH restricts targets to a fast, reactive range to balance difficulty.
export const KOTH_HARD_TARGET_MS = [500, 3500];
// Default target band mirrors round.js (TARGET_MIN_MS..TARGET_MAX_MS).
export const DEFAULT_TARGET_MS = [4000, 15000];

const ROUND_HINTS = {
  [GAME_MODES.CLASSIC]: 'Get close!',
  [GAME_MODES.HARD]: 'Hit EXACTLY!',
  [GAME_MODES.GUESS]: 'Trust your clock!'
};

/* ----------------------------- pool + modes ------------------------------ */

/** Modes selectable for an environment. */
export function allowedPool(environment) {
  return environment === ENVIRONMENTS.ONEVONE ? [...POOL_1V1] : [...POOL_PARTY];
}

/** Validate a checkbox selection against an environment's allowed pool. */
export function validatePool(environment, selected) {
  const allowed = allowedPool(environment);
  const picks = [...new Set(selected || [])];
  if (picks.length === 0) return { ok: false, reason: 'Select at least one mode.' };
  const illegal = picks.filter((m) => !allowed.includes(m));
  if (illegal.length) return { ok: false, reason: `Not allowed here: ${illegal.join(', ')}` };
  return { ok: true, pool: picks };
}

/**
 * Resolve the active mode from a pool. One checked -> that mode for all
 * rounds/the whole challenge. Multiple checked -> random pick (per round in
 * party, per challenge in 1v1). rng() defaults to Math.random; inject a seeded
 * rng for deterministic/replayable sequences.
 */
export function resolveMode(pool, rng = Math.random) {
  const picks = [...new Set(pool || [])];
  if (picks.length === 0) throw new Error('empty pool');
  if (picks.length === 1) return picks[0];
  return picks[Math.floor(rng() * picks.length)];
}

export function roundHint(mode) {
  return ROUND_HINTS[mode] ?? '';
}

/* -------------------------- category validation -------------------------- */

/** Player-count gates per category (blueprint: teams>=3, pvp>=2, pve all-play). */
export function validateCategory(category, playerCount) {
  switch (category) {
    case CATEGORIES.TEAMS:
      return playerCount >= 3
        ? { ok: true }
        : { ok: false, reason: 'Teams Tournament needs at least 3 players.' };
    case CATEGORIES.PVP:
      return playerCount >= 2
        ? { ok: true }
        : { ok: false, reason: 'PvP Tournament needs at least 2 players.' };
    case CATEGORIES.PVE:
      return playerCount >= 1
        ? { ok: true }
        : { ok: false, reason: 'Need at least 1 player.' };
    default:
      return { ok: false, reason: `Unknown category: ${category}` };
  }
}

/** Teams structure by count: exactly 3 -> asymmetric 2v1; 4+ -> standard draft. */
export function teamsFormat(playerCount) {
  if (playerCount < 3) return { ok: false, reason: 'Teams Tournament needs at least 3 players.' };
  if (playerCount === 3) {
    return { ok: true, format: 'asymmetric-2v1', captains: 2, freeAgents: 1, soloAlternates: false };
  }
  return { ok: true, format: 'standard', captains: 2, draft: true, pickSeconds: DRAFT_PICK_SECONDS };
}

/** KOTH config, applying the hard-mode fast target restriction. */
export function kothConfig(threshold, hard = false) {
  if (!KOTH_THRESHOLDS.includes(threshold)) {
    return { ok: false, reason: `KOTH target must be one of ${KOTH_THRESHOLDS.join(', ')}.` };
  }
  return { ok: true, n: threshold, hard, targetRangeMs: hard ? [...KOTH_HARD_TARGET_MS] : [...DEFAULT_TARGET_MS] };
}

/* --------------------------- bracket seeding ----------------------------- */

const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** Standard 1-indexed seed order for a full bracket of `size` (power of 2). */
export function seedOrder(size) {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const sum = seeds.length * 2 + 1;
    const next = [];
    for (const s of seeds) { next.push(s); next.push(sum - s); }
    seeds = next;
  }
  return seeds;
}

/**
 * Single-elimination first-round pairings for `players` (seed = array order).
 * Odd/short fields get byes distributed to the top seeds (higher seed sits out
 * round 1). A bye is a pairing whose opponent is null (auto-advance).
 */
export function singleElimSeed(players) {
  const n = players.length;
  if (n < 2) return { ok: false, reason: 'Bracket needs at least 2 players.' };
  const size = nextPow2(n);
  const order = seedOrder(size);
  const seatFor = (seed) => (seed <= n ? { seed, player: players[seed - 1] } : null);
  const pairings = [];
  for (let i = 0; i < order.length; i += 2) {
    pairings.push({ a: seatFor(order[i]), b: seatFor(order[i + 1]) });
  }
  return { ok: true, size, byes: size - n, rounds: Math.log2(size), pairings };
}

/* ------------------------------ 1v1 helper ------------------------------- */

/** Branch A: resolve the challenge mode (classic|guess only) from a 1v1 pool. */
export function oneVoneChallengeMode(pool, rng = Math.random) {
  const check = validatePool(ENVIRONMENTS.ONEVONE, pool);
  if (!check.ok) throw new Error(check.reason);
  return resolveMode(check.pool, rng);
}
