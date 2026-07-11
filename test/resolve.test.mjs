import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classicOutcome, isCutoffDnf, guessDefaultMs, isHardHit, resolveHard,
  CLASSIC_CUTOFF_MS, GUESS_WINDOW_MS, HARD_ATTEMPT_CAP,
} from '../src/resolve.js';

test('dead-heat: identical absolute deviations void the round', () => {
  const o = classicOutcome([{ playerId: 'p1', deviationMs: 40 }, { playerId: 'p2', deviationMs: 40 }]);
  assert.equal(o.deadHeat, true);
  assert.deepEqual(o.tied.sort(), ['p1', 'p2']);
});

test('classic outcome: clear closest wins', () => {
  const o = classicOutcome([{ playerId: 'p1', deviationMs: 20 }, { playerId: 'p2', deviationMs: 380 }]);
  assert.equal(o.deadHeat, false);
  assert.equal(o.winnerId, 'p1');
});

test('classic outcome: single stopped wins, none = null', () => {
  assert.equal(classicOutcome([{ playerId: 'p1', deviationMs: 380 }]).winnerId, 'p1');
  assert.equal(classicOutcome([]).winnerId, null);
});

test('30s idle cutoff classifies DNF (Stage 1: 30.00s in all modes)', () => {
  assert.equal(CLASSIC_CUTOFF_MS, 30000);
  assert.equal(isCutoffDnf(30000), true);
  assert.equal(isCutoffDnf(30500), true);
  assert.equal(isCutoffDnf(29990), false);
  assert.equal(isCutoffDnf(null), true);
});

test('guess window + default', () => {
  assert.equal(GUESS_WINDOW_MS, 30000);
  assert.equal(guessDefaultMs(), 0);
});

test('hard truncation window: 2.5s accepts 2500..2599', () => {
  assert.equal(isHardHit(2500, 2500), true);
  assert.equal(isHardHit(2599, 2500), true);
  assert.equal(isHardHit(2499, 2500), false);
  assert.equal(isHardHit(2600, 2500), false);
});

test('resolveHard: first rep instant hit', () => {
  const r = resolveHard({ target: 2500, aAttempts: [2340, 2610, 1980, 2540], bAttempts: [] });
  assert.equal(r.winnerId, 'a');
  assert.equal(r.reason, 'hit');
});

test('resolveHard: first rep washes 13, second hits', () => {
  const r = resolveHard({ target: 2500, aAttempts: Array(13).fill(2000), bAttempts: [2550] });
  assert.equal(r.winnerId, 'b');
  assert.equal(r.reason, 'hit');
});

test('resolveHard: both washout -> closest single attempt', () => {
  const r = resolveHard({ target: 2500, aAttempts: Array(12).fill(2000).concat([2450]), bAttempts: Array(13).fill(2300) });
  assert.equal(r.winnerId, 'a');
  assert.equal(r.reason, 'washout-closest');
});

test('resolveHard: washout exact tie voids (dead-heat)', () => {
  const r = resolveHard({ target: 2500, aAttempts: [2400], bAttempts: [2600] });
  assert.equal(r.deadHeat, true);
  assert.equal(r.winnerId, null);
});

test('resolveHard: 14th attempt beyond the cap is ignored', () => {
  assert.equal(HARD_ATTEMPT_CAP, 13);
  const r = resolveHard({ target: 2500, aAttempts: Array(13).fill(2000).concat([2500]), bAttempts: Array(13).fill(2100) });
  assert.notEqual(r.reason, 'hit'); // the 14th (a hit) must not count
});
