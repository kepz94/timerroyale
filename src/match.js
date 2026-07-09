// Async 1v1 match engine (TR-34 / TR-32b, per ADR-002).
//
// FAIR LIFECYCLE (send-invite-first, host plays LAST):
//   open          host created + sent the invite; NOBODY has played yet
//   open+claimed  a challenger claimed the link (challenger != null, score null)
//   awaiting_host the challenger has played their locked attempt (score in)
//   complete      the host has played their half → tally → winner
//   expired       48h elapsed without completing
// The host commits to the match before playing and submits exactly once, AFTER
// the challenger's score is locked — so neither side can re-roll for a good
// score and then send. Both replay IDENTICAL seeded targets; lower total
// deviation wins; equal = draw.
//
// Pure core (seededTargets, tally, lifecycle, deriveRecord) has no Firebase
// dependency and is unit-tested in test/match.test.mjs.

import { ref, get, set, runTransaction, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export const MATCH_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48h invite window (ADR-002)
export const CLASSIC_ROUNDS = 5;
export const GUESS_ROUNDS = 3;
export const RECENT_LIMIT = 5;
export const MATCH_MODES = { classic: 'classic', guess: 'guess' };

/* ============================ deterministic core ============================ */

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

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSIC_BANDS = [[10000, 15000], [500, 10000], [500, 10000], [500, 10000], [500, 10000]];
const GUESS_MIN_MS = 1000;
const GUESS_MAX_MS = 8000;

function rollInBand(rng, [min, max], taken) {
  let ms;
  do { ms = Math.round((min + rng() * (max - min)) / 100) * 100; } while (taken.has(ms));
  taken.add(ms);
  return ms;
}

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

export function outcomeFor(match, uid) {
  if (match.draw) return 'd';
  return match.winnerUid === uid ? 'w' : 'l';
}

/** Effective state, applying the 48h expiry to anything not yet complete. */
export function lifecycle(match, now = Date.now()) {
  if (!match) return 'none';
  if (match.status === 'complete') return 'complete';
  if (match.status === 'expired') return 'expired';
  if (now > match.expiresAt) return 'expired';
  return match.status; // 'open' | 'awaiting_host'
}

/** True when it is the host's turn to play their half. */
export function awaitingHost(match) {
  return match?.status === 'awaiting_host' && match?.host?.score == null;
}

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

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
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
 * STEP 1 — Host creates + sends the invite. NO score yet (the host plays last).
 * Writes matches/{id} = open, host{uid,name,score:null}, challenger:null, seeded
 * targets, 48h expiry, and the host's own match index. Returns the invite link.
 */
export async function createMatch(db, { mode = 'classic', hard = false, host }) {
  if (!MATCH_MODES[mode]) throw new Error(`unknown mode: ${mode}`);
  if (!host?.uid) throw new Error('host uid required');
  const matchId = await allocateMatchId(db);
  const targets = seededTargets(mode, matchId);
  const expiresAt = Date.now() + MATCH_EXPIRY_MS;
  await set(ref(db, `matches/${matchId}`), {
    mode, hard, seed: matchId, targets, rounds: roundsFor(mode),
    host: { uid: host.uid, name: host.name ?? 'Host', score: null, playedAt: null },
    challenger: null,
    status: 'open', winnerUid: null, draw: false,
    createdAt: serverTimestamp(), expiresAt
  });
  await set(ref(db, `userMatches/${host.uid}/${matchId}`), { role: 'host', at: serverTimestamp() });
  logTransition('match', 'none', 'open', `created ${matchId} (${mode}${hard ? '/hard' : ''}) by host ${host.uid}`);
  return { matchId, targets, mode, hard, link: inviteLink(matchId), expiresAt };
}

export async function getMatch(db, matchId) {
  const snap = await get(ref(db, `matches/${matchId}`));
  return snap.exists() ? { id: matchId, ...snap.val() } : null;
}

/**
 * STEP 2 — First authenticated taker claims the invite (challenger writable only
 * when null; not the host; not expired). Returns the identical seeded targets.
 */
export async function claimMatch(db, matchId, challenger) {
  if (!challenger?.uid) throw new Error('challenger uid required');
  const mref = ref(db, `matches/${matchId}`);
  const res = await runTransaction(mref, (m) => {
    if (m == null) return m;
    if (m.status !== 'open') return;
    if (m.challenger != null) return;
    if (m.host?.uid === challenger.uid) return;
    if (Date.now() > m.expiresAt) return;
    m.challenger = { uid: challenger.uid, name: challenger.name ?? 'Challenger', score: null, playedAt: null, claimedAt: Date.now() };
    return m;
  });
  if (!res.committed) {
    const cur = res.snapshot.val();
    const reason = cur == null ? 'no-such-match'
      : cur.status !== 'open' ? `already-${cur.status}`
      : cur.host?.uid === challenger.uid ? 'own-match'
      : cur.challenger?.uid === challenger.uid ? 'already-claimed-by-you'
      : cur.challenger != null ? 'already-claimed'
      : Date.now() > cur.expiresAt ? 'expired' : 'unknown';
    logTransition('match', 'open', 'claim-rejected', `${matchId}: ${reason}`);
    return { ok: false, reason, match: cur ? { id: matchId, ...cur } : null };
  }
  const m = res.snapshot.val();
  await set(ref(db, `userMatches/${challenger.uid}/${matchId}`), { role: 'challenger', at: serverTimestamp() });
  logTransition('match', 'open', 'claimed', `${matchId}: ${challenger.uid}`);
  return { ok: true, match: { id: matchId, ...m }, targets: m.targets, mode: m.mode, hard: m.hard };
}

/**
 * STEP 3 — Challenger submits their locked score (one attempt). Match -> awaiting_host.
 */
export async function submitChallengerScore(db, matchId, challengerUid, score) {
  if (score == null) throw new Error('challenger score required');
  const res = await runTransaction(ref(db, `matches/${matchId}`), (m) => {
    if (m == null) return m;
    if (m.status !== 'open') return;                      // must be claimed & unplayed
    if (m.challenger?.uid !== challengerUid) return;      // only the claimant
    if (m.challenger.score != null) return;               // one attempt only
    m.challenger.score = score;
    m.challenger.playedAt = Date.now();
    m.status = 'awaiting_host';
    return m;
  });
  if (!res.committed) {
    const cur = res.snapshot.val();
    logTransition('match', 'open', 'challenger-rejected', `${matchId}: ${cur ? cur.status : 'no-match'}`);
    return { ok: false, match: cur ? { id: matchId, ...cur } : null };
  }
  const m = res.snapshot.val();
  logTransition('match', 'open', 'awaiting_host', `${matchId}: challenger ${challengerUid} @${score}ms`);
  return { ok: true, match: { id: matchId, ...m } };
}

/**
 * STEP 4 — Host plays their half LAST and submits (one attempt), only once the
 * challenger's score is locked. Tally + winner are written; match -> complete.
 */
export async function submitHostScore(db, matchId, hostUid, score) {
  if (score == null) throw new Error('host score required');
  const res = await runTransaction(ref(db, `matches/${matchId}`), (m) => {
    if (m == null) return m;
    if (m.status !== 'awaiting_host') return;             // challenger must have played
    if (m.host?.uid !== hostUid) return;                  // only the host
    if (m.host.score != null) return;                      // one attempt only
    m.host.score = score;
    m.host.playedAt = Date.now();
    const t = tally(m);
    m.status = 'complete';
    m.winnerUid = t.winnerUid;
    m.draw = t.draw;
    m.completedAt = Date.now();
    return m;
  });
  if (!res.committed) {
    const cur = res.snapshot.val();
    logTransition('match', 'awaiting_host', 'host-rejected', `${matchId}: ${cur ? cur.status : 'no-match'}`);
    return { ok: false, match: cur ? { id: matchId, ...cur } : null };
  }
  const m = res.snapshot.val();
  logTransition('match', 'awaiting_host', 'complete', `${matchId}: winner ${m.winnerUid ?? (m.draw ? 'draw' : 'none')}`);
  return { ok: true, match: { id: matchId, ...m }, winnerUid: m.winnerUid, draw: m.draw };
}

/**
 * Recompute the caller's own record + last-5 from their completed matches and
 * persist to users/{uid} (rule-safe: writes only own node). Idempotent.
 */
export async function reconcileRecord(db, uid) {
  const idxSnap = await get(ref(db, `userMatches/${uid}`));
  if (!idxSnap.exists()) return { record: { w: 0, l: 0, d: 0 }, recent: [] };
  const ids = Object.keys(idxSnap.val());
  const matches = await Promise.all(ids.map((id) => getMatch(db, id)));
  const derived = deriveRecord(matches.filter(Boolean), uid);
  await runTransaction(ref(db, `users/${uid}`), (u) => {
    if (u == null) return u;
    u.record = derived.record;
    u.recent = derived.recent;
    return u;
  });
  logTransition('match', 'record', 'reconciled', `${uid}: ${derived.record.w}-${derived.record.l}-${derived.record.d}`);
  return derived;
}
