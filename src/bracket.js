// Single-elimination tournament engine (TR-46 Branch B — PvP & Teams brackets).
// PURE + deterministic, no Firebase. Seeding + byes come from
// hostconfig.singleElimSeed (byes go to the top seeds and auto-advance). A
// "match" is Best-of-N GAMES (first to gamesToWin); each game is a first-to-K
// round series played on the existing round engine and reported here with
// reportGameWin(). The UI (TV bracket render, draft, wheel-spin) consumes this.
import { singleElimSeed } from './hostconfig.js';

/**
 * entrants: [{ id, name }] seeded in array order (seed 1 = index 0).
 * Returns a bracket: { entrants, gamesToWin, rounds:[[match,...],...], champion }.
 * match: { id, round, index, a, b, gamesA, gamesB, winner, bye } where a/b are
 * entrant objects (or null until fed by a prior round / a bye).
 */
export function createBracket(entrants, { gamesToWin = 3 } = {}) {
  const seed = singleElimSeed(entrants);
  if (!seed.ok) throw new Error(seed.reason);
  const totalRounds = seed.rounds;
  const rounds = [];
  let mid = 0;
  rounds[0] = seed.pairings.map((p, i) => ({
    id: mid++, round: 0, index: i,
    a: p.a ? p.a.player : null,
    b: p.b ? p.b.player : null,
    gamesA: 0, gamesB: 0, winner: null, bye: !p.a || !p.b
  }));
  for (let r = 1; r < totalRounds; r++) {
    rounds[r] = Array.from({ length: rounds[r - 1].length / 2 }, (_, i) => ({
      id: mid++, round: r, index: i, a: null, b: null, gamesA: 0, gamesB: 0, winner: null, bye: false
    }));
  }
  const bracket = { entrants, gamesToWin, rounds, champion: null };
  // Auto-advance round-0 byes (a top seed with no opponent).
  rounds[0].forEach((m) => { if (m.bye && (m.a || m.b)) advance(bracket, m, m.a || m.b); });
  return bracket;
}

function findMatch(bracket, matchId) {
  for (const round of bracket.rounds) for (const m of round) if (m.id === matchId) return m;
  return null;
}

function advance(bracket, match, winner) {
  match.winner = winner;
  const { round, index } = match;
  if (round + 1 >= bracket.rounds.length) { bracket.champion = winner; return; }
  const next = bracket.rounds[round + 1][Math.floor(index / 2)];
  if (index % 2 === 0) next.a = winner; else next.b = winner;
}

/** Report one GAME win inside a match. When a side reaches gamesToWin, it advances. */
export function reportGameWin(bracket, matchId, winnerEntrantId) {
  const m = findMatch(bracket, matchId);
  if (!m || m.winner || !m.a || !m.b) return { ok: false, reason: 'match not playable' };
  if (winnerEntrantId === m.a.id) m.gamesA += 1;
  else if (winnerEntrantId === m.b.id) m.gamesB += 1;
  else return { ok: false, reason: 'entrant not in match' };
  if (m.gamesA >= bracket.gamesToWin) advance(bracket, m, m.a);
  else if (m.gamesB >= bracket.gamesToWin) advance(bracket, m, m.b);
  return { ok: true, decided: !!m.winner, match: m, champion: bracket.champion };
}

/** Matches ready to play now: both sides filled, not yet decided. */
export function activeMatches(bracket) {
  return bracket.rounds.flat().filter((m) => !m.winner && m.a && m.b);
}

/** True once a champion is crowned. */
export function isComplete(bracket) {
  return bracket.champion != null;
}

/** Round label helper for the TV, e.g. "Final", "Semifinal", "Round 1". */
export function roundLabel(bracket, roundIndex) {
  const fromEnd = bracket.rounds.length - 1 - roundIndex;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinal';
  if (fromEnd === 2) return 'Quarterfinal';
  return `Round ${roundIndex + 1}`;
}
