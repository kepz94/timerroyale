import test from 'node:test';
import assert from 'node:assert/strict';
import { createBracket, reportGameWin, activeMatches, isComplete, roundLabel } from '../src/bracket.js';

const ents = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
function winMatch(b, m, winnerId) { // report gamesToWin wins for winnerId
  let r;
  for (let i = 0; i < b.gamesToWin; i++) r = reportGameWin(b, m.id, winnerId);
  return r;
}

test('2 entrants: one final, first-to-gamesToWin decides champion', () => {
  const b = createBracket(ents(2), { gamesToWin: 3 });
  assert.equal(b.rounds.length, 1);
  const active = activeMatches(b);
  assert.equal(active.length, 1);
  reportGameWin(b, active[0].id, 'p1'); reportGameWin(b, active[0].id, 'p1');
  assert.equal(isComplete(b), false, 'not decided at 2 games');
  const r = reportGameWin(b, active[0].id, 'p1');
  assert.equal(r.decided, true);
  assert.equal(b.champion.id, 'p1');
});

test('4 entrants: two semis then final', () => {
  const b = createBracket(ents(4), { gamesToWin: 2 });
  assert.equal(b.rounds.length, 2);
  let active = activeMatches(b);
  assert.equal(active.length, 2, 'two semifinals live');
  winMatch(b, active[0], active[0].a.id);
  winMatch(b, active[1], active[1].b.id);
  active = activeMatches(b);
  assert.equal(active.length, 1, 'final is now live');
  assert.equal(isComplete(b), false);
  const champId = active[0].a.id;
  winMatch(b, active[0], champId);
  assert.equal(isComplete(b), true);
  assert.equal(b.champion.id, champId);
});

test('3 entrants: top seed byes into the final, P2 vs P3 play first', () => {
  const b = createBracket(ents(3), { gamesToWin: 2 });
  // round 0: P1 has a bye (auto-advanced); P2 vs P3 live
  const active = activeMatches(b);
  assert.equal(active.length, 1);
  const ids = [active[0].a.id, active[0].b.id].sort();
  assert.deepEqual(ids, ['p2', 'p3']);
  winMatch(b, active[0], 'p2');
  const finals = activeMatches(b);
  assert.equal(finals.length, 1, 'final live after semwinner joins P1');
  const finalIds = [finals[0].a.id, finals[0].b.id].sort();
  assert.deepEqual(finalIds, ['p1', 'p2'], 'P1 (bye) vs P2 (semi winner)');
  winMatch(b, finals[0], 'p1');
  assert.equal(b.champion.id, 'p1');
});

test('5 entrants: 3 byes, still resolves to a single champion', () => {
  const b = createBracket(ents(5), { gamesToWin: 1 });
  // 8-slot bracket, 3 byes. Only P4 vs P5 is contested in round 0.
  let guard = 0;
  while (!isComplete(b) && guard++ < 20) {
    const active = activeMatches(b);
    assert.ok(active.length >= 1, 'always a playable match until complete');
    winMatch(b, active[0], active[0].a.id); // top-side always wins
  }
  assert.equal(isComplete(b), true);
  assert.equal(b.champion.id, 'p1', 'seed 1 wins every game it plays');
});

test('reportGameWin rejects unknown entrant / decided match', () => {
  const b = createBracket(ents(2), { gamesToWin: 1 });
  const m = activeMatches(b)[0];
  assert.equal(reportGameWin(b, m.id, 'nobody').ok, false);
  reportGameWin(b, m.id, m.a.id); // decides it
  assert.equal(reportGameWin(b, m.id, m.b.id).ok, false, 'cannot report after decided');
});

test('roundLabel names finals correctly', () => {
  const b = createBracket(ents(8), { gamesToWin: 1 });
  assert.equal(roundLabel(b, 2), 'Final');
  assert.equal(roundLabel(b, 1), 'Semifinal');
  assert.equal(roundLabel(b, 0), 'Quarterfinal');
});
