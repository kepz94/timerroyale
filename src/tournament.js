// TR-52 unified tournament pacing (PURE) layered on the single-elim bracket.
// The rulebook hierarchy:
//   ROUND  — a single representative match-up; the winner earns 1 ledger dot.
//   GAME   — first to ROUNDS_TO_WIN_GAME ledger dots.
//   MATCH  — Best-of-5 games (first to GAMES_TO_WIN_MATCH game wins); advances
//            the winner up the bracket.
// Scheduling (the Match Rotation Loop): while a tier has 2+ live matches, the
// board ALTERNATES to the next live match after every completed GAME (not after
// every round). A clean sweep drops a match out and the loop locks onto the
// remainder. The moment only the final-round match remains live, Grand Finals
// Mode locks onto it for an uninterrupted series until a champion is crowned.
// Composes bracket.js; it does NOT modify the bracket engine.
//
// serialize/restore let the TV persist the whole tournament and RESUME it after
// a reload (see tv.js) instead of restarting to the menu.
import { createBracket, reportGameWin, activeMatches, isComplete } from './bracket.js';

// PLAN-TR-TEAMS-v1 Stage 1 (ADR-005): first-to-4 games, Best-of-3 matches —
// shortens an 8-team night by 15-40 rounds vs the old 5/Bo5 structure.
export const ROUNDS_TO_WIN_GAME = 4; // a GAME = first to 4 ledger dots
export const GAMES_TO_WIN_MATCH = 2; // a MATCH = Best of 3 games (first to 2)

// Internal: wrap a (fresh or restored) bracket in the scheduling API.
function schedulerFor(bracket, { roundsToWinGame = ROUNDS_TO_WIN_GAME } = {}) {
  const dots = new Map(); // matchId -> { a, b } ledger dots for the IN-PROGRESS game
  const dotsFor = (id) => { if (!dots.has(id)) dots.set(id, { a: 0, b: 0 }); return dots.get(id); };
  let current = activeMatches(bracket)[0] || null;

  const finalRound = () => bracket.rounds.length - 1;
  const findMatch = (id) => bracket.rounds.flat().find((m) => m.id === id);

  function isGrandFinals() {
    const act = activeMatches(bracket);
    return act.length === 1 && act[0].round === finalRound();
  }

  function nextToPlay(justId) {
    const act = activeMatches(bracket);
    if (act.length === 0) return null;
    if (act.length === 1) return act[0];
    const i = act.findIndex((m) => m.id === justId);
    return act[(i + 1) % act.length];
  }

  function reportRoundWin(matchId, side) {
    const m = findMatch(matchId);
    if (!m || m.winner || (side !== 'a' && side !== 'b')) return { ok: false };
    const g = dotsFor(matchId);
    g[side] += 1;
    let gameDecided = false, matchDecided = false, gameWinner = null;
    if (g.a >= roundsToWinGame || g.b >= roundsToWinGame) {
      gameDecided = true;
      gameWinner = g.a >= roundsToWinGame ? m.a : m.b;
      const res = reportGameWin(bracket, matchId, gameWinner.id);
      matchDecided = !!res.decided;
      dots.set(matchId, { a: 0, b: 0 });
      current = nextToPlay(matchId);
    }
    return { ok: true, gameDecided, gameWinner, matchDecided, current, grandFinals: isGrandFinals(), champion: bracket.champion };
  }

  function reportGame(matchId, entrantId) {
    const m = findMatch(matchId);
    if (!m || m.winner) return { ok: false };
    const res = reportGameWin(bracket, matchId, entrantId);
    if (!res.ok) return { ok: false };
    dots.set(matchId, { a: 0, b: 0 });
    current = nextToPlay(matchId);
    return { ok: true, matchDecided: !!res.decided, current, grandFinals: isGrandFinals(), champion: bracket.champion };
  }

  return {
    bracket,
    current: () => current,
    setCurrent: (m) => { current = m; },
    gameScore: (id) => ({ ...dotsFor(id) }),
    reportRoundWin,
    reportGame,
    isGrandFinals,
    isComplete: () => isComplete(bracket),
  };
}

export function createTournament(entrants, {
  roundsToWinGame = ROUNDS_TO_WIN_GAME,
  gamesToWinMatch = GAMES_TO_WIN_MATCH,
} = {}) {
  const bracket = createBracket(entrants, { gamesToWin: gamesToWinMatch });
  return schedulerFor(bracket, { roundsToWinGame });
}

/** Serialize a live tournament (+ the current match) to a plain snapshot. */
export function serializeTournament(bracket, curMatch) {
  return {
    gamesToWin: bracket.gamesToWin,
    entrants: bracket.entrants.map((e) => (e.members ? { id: e.id, name: e.name, members: e.members } : { id: e.id, name: e.name })),
    rounds: bracket.rounds.map((round) => round.map((m) => ({
      id: m.id, round: m.round, index: m.index,
      aId: m.a ? m.a.id : null, bId: m.b ? m.b.id : null,
      gamesA: m.gamesA, gamesB: m.gamesB,
      winnerId: m.winner ? m.winner.id : null, bye: !!m.bye,
    }))),
    championId: bracket.champion ? bracket.champion.id : null,
    curMatchId: curMatch ? curMatch.id : null,
  };
}

/** Rebuild a bracket object from a snapshot (entrant identity restored by id). */
export function deserializeBracket(snap) {
  const byId = new Map(snap.entrants.map((e) => [e.id, e]));
  const rounds = (snap.rounds || []).map((round) => (round || []).map((m) => ({
    id: m.id, round: m.round, index: m.index,
    a: m.aId != null ? byId.get(m.aId) : null,
    b: m.bId != null ? byId.get(m.bId) : null,
    gamesA: m.gamesA || 0, gamesB: m.gamesB || 0,
    winner: m.winnerId != null ? byId.get(m.winnerId) : null,
    bye: !!m.bye,
  })));
  return { entrants: snap.entrants, gamesToWin: snap.gamesToWin, rounds, champion: snap.championId != null ? byId.get(snap.championId) : null };
}

/** Restore a tournament scheduler from a snapshot, re-selecting the saved match. */
export function restoreTournament(snap, opts = {}) {
  const bracket = deserializeBracket(snap);
  const t = schedulerFor(bracket, opts);
  if (snap.curMatchId != null) {
    const m = bracket.rounds.flat().find((x) => x.id === snap.curMatchId);
    if (m && !m.winner) t.setCurrent(m);
  }
  return t;
}
