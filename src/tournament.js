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
import { createBracket, reportGameWin, activeMatches, isComplete } from './bracket.js';

export const ROUNDS_TO_WIN_GAME = 5; // a GAME = first to 5 ledger dots
export const GAMES_TO_WIN_MATCH = 3; // a MATCH = Best of 5 games (first to 3)

export function createTournament(entrants, {
  roundsToWinGame = ROUNDS_TO_WIN_GAME,
  gamesToWinMatch = GAMES_TO_WIN_MATCH,
} = {}) {
  const bracket = createBracket(entrants, { gamesToWin: gamesToWinMatch });
  const dots = new Map(); // matchId -> { a, b } ledger dots for the IN-PROGRESS game
  const dotsFor = (id) => { if (!dots.has(id)) dots.set(id, { a: 0, b: 0 }); return dots.get(id); };
  let current = activeMatches(bracket)[0] || null;

  const finalRound = () => bracket.rounds.length - 1;
  const findMatch = (id) => bracket.rounds.flat().find((m) => m.id === id);

  function isGrandFinals() {
    const act = activeMatches(bracket);
    return act.length === 1 && act[0].round === finalRound();
  }

  // Which match hosts the next GAME. justId still live -> alternate to the next
  // live match; justId decided (-1) -> lock onto the remaining live match.
  function nextToPlay(justId) {
    const act = activeMatches(bracket);
    if (act.length === 0) return null;
    if (act.length === 1) return act[0];
    const i = act.findIndex((m) => m.id === justId);
    return act[(i + 1) % act.length];
  }

  /**
   * Award one ledger dot in the current game of `matchId`.
   * @param {number} matchId bracket match id
   * @param {'a'|'b'} side the match's a/b entrant that won the round
   */
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
      dots.set(matchId, { a: 0, b: 0 }); // reset for this match's next game
      current = nextToPlay(matchId);
    }
    return {
      ok: true, gameDecided, gameWinner, matchDecided,
      current, grandFinals: isGrandFinals(), champion: bracket.champion,
    };
  }

  return {
    bracket,
    current: () => current,
    setCurrent: (m) => { current = m; },
    gameScore: (id) => ({ ...dotsFor(id) }),
    reportRoundWin,
    isGrandFinals,
    isComplete: () => isComplete(bracket),
  };
}
