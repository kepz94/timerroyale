import test from 'node:test';
import assert from 'node:assert/strict';
import { blankNight, recordRound, roundEntries, tonightLine } from '../src/stats.js';

test('records wins, losses, streaks, clutch and best deviation', () => {
  const n = blankNight();
  recordRound(n, { winnerId: 'a', entries: [
    { playerId: 'a', name: 'Ana', deviationMs: 40, early: true, late: false, dnf: false },
    { playerId: 'b', name: 'Ben', deviationMs: 300, early: false, late: true, dnf: false },
  ] });
  recordRound(n, { winnerId: 'a', entries: [
    { playerId: 'a', name: 'Ana', deviationMs: 120, early: false, late: true, dnf: false },
    { playerId: 'b', name: 'Ben', deviationMs: null, dnf: true, early: false, late: false },
  ] });
  const a = n.players.a, b = n.players.b;
  assert.equal(a.wins, 2); assert.equal(a.bestStreak, 2); assert.equal(a.clutchWins, 1);
  assert.equal(a.bestDevMs, 40); assert.equal(a.early, 1); assert.equal(a.late, 1);
  assert.equal(b.losses, 2); assert.equal(b.dnfs, 1); assert.equal(b.streak, 0);
  assert.equal(tonightLine(n, 'a'), '2–0 tonight · best Δ0.04s');
  assert.equal(tonightLine(n, 'zzz'), null);
});

test('roundEntries maps classic, flags dead-heats as null', () => {
  const g = { mode: 'target', targetMs: 5000, winner: { playerId: 'a' }, players: {
    a: { playerId: 'a', name: 'Ana', state: 'stopped', elapsedMs: 4900, deviationMs: 100 },
    b: { playerId: 'b', name: 'Ben', state: 'dnf' },
  } };
  const r = roundEntries(g);
  assert.equal(r.winnerId, 'a');
  assert.equal(r.entries.find((e) => e.playerId === 'a').early, true);
  assert.equal(r.entries.find((e) => e.playerId === 'b').dnf, true);
  g.players.b = { playerId: 'b', name: 'Ben', state: 'stopped', elapsedMs: 5100, deviationMs: 100 };
  assert.equal(roundEntries(g), null); // identical deviations = void
});

test('roundEntries maps guess deltas and hard attempt logs', () => {
  const guess = { mode: 'guess', actualMs: 4000, winner: { playerId: 'a' }, players: {
    a: { playerId: 'a', name: 'Ana', state: 'guessed', guessMs: 3900, deltaMs: 100 },
    b: { playerId: 'b', name: 'Ben', state: 'guessed', guessMs: 4500, deltaMs: 500 },
  } };
  const rg = roundEntries(guess);
  assert.equal(rg.entries.find((e) => e.playerId === 'a').early, true);
  const hard = { mode: 'hard', targetMs: 2500, winner: { playerId: 'a' }, attempts: {
    a: [{ elapsedMs: 2550, hit: true, early: false }],
    b: [],
  }, players: {
    a: { playerId: 'a', name: 'Ana', state: 'stopped' },
    b: { playerId: 'b', name: 'Ben', state: 'dnf' },
  } };
  const rh = roundEntries(hard);
  assert.equal(rh.entries.find((e) => e.playerId === 'a').deviationMs, 50);
  assert.equal(rh.entries.find((e) => e.playerId === 'b').dnf, true);
});
