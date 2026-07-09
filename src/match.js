// Async 1v1 match engine (TR-34 / TR-32b, per ADR-002). ADDITIVE module — no
// existing file is modified. Both players replay an IDENTICAL seeded target
// sequence; score = total deviation ms (lower wins; equal = draw).
//
// Design (ADR-002, faithfully):
//   - matches/{id} is the source of truth for a duel's lifecycle + winner.
//   - users/{uid} is writable ONLY by that uid, so a completion NEVER
//     cross-writes the opponent's record. Instead each participant indexes
//     their own match (userMatches/{uid}/{id}) and each user's w-l-d record is
//     DERIVED from their completed matches on load (reconcileRecord). This is
//     rule-safe and handles an offline host.
//   - No server-side functions: client tally, rules-validated transitions.
//
// The pure core (seeded targets, tally, lifecycle, deriveRecord) has no
// Firebase dependency and is unit-tested in test/match.test.mjs.

import { ref, get, set, runTransaction, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export const MATCH_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48h invite window (ADR-002)
export const CLASSIC_ROUNDS = 5;
export const GUESS_ROUNDS = 3;
export const RECENT_LIMIT = 5;                       // last-5 history (TR-36 consumes this)
export const MATCH_MODES = { classic: 'classic', guess: 'guess' };

/* ============================ deterministic core ============================ */
/* A match's targets are a pure function of its id, so both players — playing at
   different times — face the exact same sequence. */

// xmur3 string hash -> 32-bit seed
export function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// mulberry32 PRNG -> deterministic float in [0,1)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mirrors solo.js bands (TR-31): one 10-15s round + four 0.5-10s, distinct, shuffled.
const CLASSIC_BANDS = [[10000, 15000], [500, 10000], [500, 10000], [500, 10000], [500, 10000]];
// Mirrors guess.js window (TR-28): 1.0-8.0s.
const GUESS_MIN_MS = 1000;
const GUESS_MAX_MS = 8000;

function rollInBand(rng, [min, max], taken) {
  let ms;
  do { ms = Math.round((min + rng() * (max - min)) / 100) * 100; } while (taken.has(ms));
  taken.add(ms);
  return ms;
}

/** Deterministic target list for a match id. Same id -> same targets, always. */
export function seededTargets(mode, seed) {
  const rng = mulberry32(hashSeed(seed));
  if (mode === MATCH_MODES.guess) {
    return Array.from({ length: GUESS_ROUNDS }, () =>
      Math.round((GUESS_MIN_MS + rng() * (GUESS_MAX_MS - GUESS_MIN_MS)) / 100) * 100);
  }
  const taken = new Set();
  const targets = CLASSIC_BANDS.map((band) => rollInBand(rng, band, taken));
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  return targets;
}

export function roundsFor(mode) {
  return mode === MATCH_MODES.guess ? GUESS_ROUNDS : CLASSIC_ROUNDS;
}

/** Winner by lower total deviation. Both scores required; equal = draw. */
export function tally(match) {
  const hs = match?.host?.score;
  const cs = match?.challenger?.score;
  if (hs == null || cs == null) return { decided: false, winnerUid: null, draw: false };
  if (hs === cs) return { decided: true, winnerUid: null, draw: true };
  return { decided: true, winnerUid: hs < cs ? match.host.uid : match.challenger.uid, draw: false };
}

/** 'w' | 'l' | 'd' for a uid in a completed match. */
export function outcomeFor(match, uid) {
  if (match.draw) return 'd';
  return match.winnerUid === uid ? 'w' : 'l';
}

/** Effective lifecycle state, applying the 48h expiry to still-pending matches. */
export function lifecycle(match, now = Date.now()) {
  if (!match) return 'none';
  if (match.status === 'complete') return 'complete';
  if (match.status === 'expired') return 'expired';
  if (match.challenger == null && now > match.expiresAt) return 'expired';
  return 'pending';
}

/** Derive a user's record + last-5 history from their completed matches (pure). */
export function deriveRecord(matchesForUser, uid) {
  const record = { w: 0, l: 0, d: 0 };
  const completed = matchesForUser
    .filter((m) => m && m.status === 'complete')
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  for (const m of completed) record[outcomeFor(m, uid)] += 1;
  const recent = completed.slice(0, RECENT_LIMIT).map((m) => ({
    matchId: m.id,
    mode: m.mode,
    outcome: outcomeFor(m, uid),
    opponent: m.host.uid === uid ? (m.challenger?.name ?? '—') : m.host.name,
    at: m.completedAt ?? null
  }));
  return { record, recent };
}

/* ============================== id + linking =============================== */

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/i/l
export function generateMatchId(len = 8) {
  let id = '';
  const rand = new Uint32Array(len);
  (globalThis.crypto || crypto).getRandomValues(rand);
  for (let i = 0; i < len; i++) id += ID_ALPHABET[rand[i] % ID_ALPHABET.length];
  return id;
}

export function inviteLink(matchId) {
  const origin = (typeof location !== 'undefined' && location.origin) || 'https://timerroyale.web.app';
  return `${origin}/match.html?m=${matchId}`;
}

async function allocateMatchId(db, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    const id = generateMatchId();
    const snap = await get(ref(db, `matches/${id}`));
    if (!snap.exists()) return id;
    logTransition('match', 'allocating', 'collision', `id ${id} taken (attempt ${i})`);
  }
  throw new Error('could not allocate a unique match id');
}

/* ============================== firebase ops =============================== */

/**
 * Host creates the duel (they have already played the seeded targets, so their
 * score is known). Writes matches/{id} = pending and the host's own match index.
 * Returns { matchId, targets, mode, hard, link, expiresAt }.
 */
export async function createMatch(db, opts) {
  const matchId = await allocateMatchId(db);
  return createMatchWithId(db, matchId, opts);
}

/** Like createMatch but with a caller-supplied id: the host pre-seeds targets
 *  from generateMatchId(), plays them, then persists with the known score. */
export async function createMatchWithId(db, matchId, { mode = 'classic', hard = false, host }) {
  if (!MATCH_MODES[mode]) throw new Error(`unknown mode: ${mode}`);
  if (!host?.uid || host.score == null) throw new Error('host uid + score required');
  const targets = seededTargets(mode, matchId);
  const expiresAt = Date.now() + MATCH_EXPIRY_MS;
  await set(ref(db, `matches/${matchId}`), {
    mode, hard, seed: matchId, targets, rounds: roundsFor(mode),
    host: { uid: host.uid, name: host.name ?? 'Host', score: host.score, playedAt: serverTimestamp() },
    challenger: null,
    status: 'pending', winnerUid: null, draw: false,
    createdAt: serverTimestamp(), expiresAt
  });
  await set(ref(db, `userMatches/${host.uid}/${matchId}`), { role: 'host', at: serverTimestamp() });
  logTransition('match', 'none', 'pending',
    `created ${matchId} (${mode}${hard ? '/hard' : ''}) host ${host.uid} @${host.score}ms`);
  return { matchId, targets, mode, hard, link: inviteLink(matchId), expiresAt };
}

export async function getMatch(db, matchId) {
  const snap = await get(ref(db, `matches/${matchId}`));
  return snap.exists() ? { id: matchId, ...snap.val() } : null;
}

/**
 * First authenticated taker claims (challenger writable only when null).
 * Transaction guards every reject branch. On success the challenger indexes
 * their own match and receives the identical seeded targets to play.
 */
export async function claimMatch(db, matchId, challenger) {
  if (!challenger?.uid) throw new Error('challenger uid required');
  const mref = ref(db, `matches/${matchId}`);
  const res = await runTransaction(mref, (m) => {
    if (m == null) return m;                     // no such match
    if (m.status !== 'pending') return;          // abort: complete/expired
    if (m.host?.uid === challenger.uid) return;  // abort: cannot challenge yourself
    if (m.challenger != null) return;            // abort: already claimed
    if (Date.now() > m.expiresAt) return;        // abort: past 48h window
    m.challenger = { uid: challenger.uid, name: challenger.name ?? 'Challenger', score: null, playedAt: null, claimedAt: Date.now() };
    return m;
  });
  if (!res.committed) {
    const cur = res.snapshot.val();
    const reason = cur == null ? 'no-such-match'
      : cur.status !== 'pending' ? `already-${cur.status}`
      : cur.host?.uid === challenger.uid ? 'own-match'
      : cur.challenger?.uid === challenger.uid ? 'already-claimed-by-you'
      : cur.challenger != null ? 'already-claimed'
      : Date.now() > cur.expiresAt ? 'expired'
      : 'unknown';
    logTransition('match', 'pending', 'claim-rejected', `${matchId}: ${reason}`);
    return { ok: false, reason, match: cur ? { id: matchId, ...cur } : null };
  }
  const m = res.snapshot.val();
  await set(ref(db, `userMatches/${challenger.uid}/${matchId}`), { role: 'challenger', at: serverTimestamp() });
  logTransition('match', 'pending', 'claimed', `${matchId}: ${challenger.uid}`);
  return { ok: true, match: { id: matchId, ...m }, targets: m.targets, mode: m.mode, hard: m.hard };
}

/**
 * Challenger submits their score; tally + winner are written and the match is
 * completed. Records are NOT cross-written here (rules forbid it) — each user
 * reconciles their own record on load. Only the claiming challenger can complete.
 */
export async function completeMatch(db, matchId, challengerUid, challengerScore) {
  if (challengerScore == null) throw new Error('challenger score required');
  const mref = ref(db, `matches/${matchId}`);
  const res = await runTransaction(mref, (m) => {
    if (m == null) return m;                              // no such match
    if (m.status !== 'pending') return;                  // abort: already resolved
    if (m.challenger?.uid !== challengerUid) return;     // abort: not the claimant
    if (m.challenger.score != null) return;              // abort: already submitted
    m.challenger.score = challengerScore;
    m.challenger.playedAt = Date.now();
    const t = tally(m);
    m.status = 'complete';
    m.winnerUid = t.winnerUid;
    m.draw = t.draw;
    m.completedAt = Date.now();
    return m;
  });
  if (!res.committed) {
    const cur = res.snapshot.val();
    logTransition('match', 'pending', 'complete-rejected', `${matchId}: ${cur ? cur.status : 'no-match'}`);
    return { ok: false, match: cur ? { id: matchId, ...cur } : null };
  }
  const m = res.snapshot.val();
  logTransition('match', 'pending', 'complete',
    `${matchId}: winner ${m.winnerUid ?? (m.draw ? 'draw' : 'none')}`);
  return { ok: true, match: { id: matchId, ...m }, winnerUid: m.winnerUid, draw: m.draw };
}

/**
 * Recompute the caller's own record + last-5 history from their completed
 * matches and persist to users/{uid} (rule-safe: writes only own node).
 * Call on profile open / after completing a match. Idempotent.
 */
export async function reconcileRecord(db, uid) {
  const idxSnap = await get(ref(db, `userMatches/${uid}`));
  if (!idxSnap.exists()) return { record: { w: 0, l: 0, d: 0 }, recent: [] };
  const ids = Object.keys(idxSnap.val());
  const matches = await Promise.all(ids.map((id) => getMatch(db, id)));
  const derived = deriveRecord(matches.filter(Boolean), uid);
  await runTransaction(ref(db, `users/${uid}`), (u) => {
    if (u == null) return u;                 // no profile: nothing to write
    u.record = derived.record;
    u.recent = derived.recent;
    return u;
  });
  logTransition('match', 'record', 'reconciled',
    `${uid}: ${derived.record.w}-${derived.record.l}-${derived.record.d}`);
  return derived;
}
