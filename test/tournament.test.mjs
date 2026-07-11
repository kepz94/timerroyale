import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTournament, ROUNDS_TO_WIN_GAME, GAMES_TO_WIN_MATCH } from '../src/tournament.js';

const four = () => createTournament([
  { id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }, { id: 'D', name: 'D' },
]);

// Win one full game (ROUNDS_TO_WIN_GAME dots) for `side` on the current match.
function winGame(T, side) {
  let res;
  for (let i = 0; i < ROUNDS_TO_WIN_GAME; i++) res = T.reportRoundWin(T.current().id, side);
  return res;
}
// Drive a specific match to a match win (GAMES_TO_WIN_MATCH games) for `side`,
// respecting the rotation loop (only play when that match is current).
function driveMatch(T, matchId, side) {
  let guard = 0;
  while (guard++ < 40) {
    const m = T.bracket.rounds.flat().find((x) => x.id === matchId);
    if (!m || m.winner) break;
    if (T.current() && T.current().id === matchId) winGame(T, side);
    else winGame(T, 'a'); // advance the other live match to rotate back
  }
}

test('constants match the Stage 1 rulebook (game=4 rounds, match=Bo3 first-to-2)', () => {
  assert.equal(ROUNDS_TO_WIN_GAME, 4);
  assert.equal(GAMES_TO_WIN_MATCH, 2);
});

test('starts on a semifinal', () => {
  const T = four();
  assert.ok(T.current());
  assert.equal(T.current().round, 0);
});

test('a game requires ROUNDS_TO_WIN_GAME ledger dots', () => {
  const T = four();
  const id = T.current().id;
  for (let i = 0; i < ROUNDS_TO_WIN_GAME - 1; i++) {
    const r = T.reportRoundWin(id, 'a');
    assert.equal(r.gameDecided, false);
  }
  const r = T.reportRoundWin(id, 'a');
  assert.equal(r.gameDecided, true);
});

test('semifinals alternate after each completed game', () => {
  const T = four();
  const m0 = T.current().id;
  winGame(T, 'a');                 // finish a game on M0
  assert.notEqual(T.current().id, m0, 'rotated to the other semi');
  const m1 = T.current().id;
  winGame(T, 'a');                 // finish a game on M1
  assert.equal(T.current().id, m0, 'rotated back to M0');
  assert.notEqual(m0, m1);
});

test('sweep locks the loop onto the remaining match, finals = Grand Finals, champion crowned', () => {
  const T = four();
  const [s0, s1] = T.bracket.rounds[0].map((m) => m.id);
  driveMatch(T, s0, 'a');
  assert.ok(T.bracket.rounds.flat().find((m) => m.id === s0).winner, 'semi 0 decided');
  driveMatch(T, s1, 'a');
  assert.ok(T.bracket.rounds[0].every((m) => m.winner), 'both semis decided');
  assert.equal(T.isGrandFinals(), true, 'finals is the single live match');
  const finalId = T.bracket.rounds[1][0].id;
  driveMatch(T, finalId, 'a');
  assert.equal(T.isComplete(), true);
  assert.ok(T.bracket.champion);
});
