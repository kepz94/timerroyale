import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENTS, GAME_MODES, CATEGORIES, KOTH_THRESHOLDS,
  allowedPool, validatePool, resolveMode, roundHint,
  validateCategory, teamsFormat, kothConfig,
  seedOrder, singleElimSeed, oneVoneChallengeMode,
  KOTH_HARD_TARGET_MS, DEFAULT_TARGET_MS
} from '../src/hostconfig.js';

test('allowedPool: Hard hidden in 1v1, all three in party', () => {
  assert.deepEqual(allowedPool(ENVIRONMENTS.ONEVONE), ['classic', 'guess']);
  assert.deepEqual(allowedPool(ENVIRONMENTS.PARTY), ['classic', 'hard', 'guess']);
  assert.ok(!allowedPool(ENVIRONMENTS.ONEVONE).includes(GAME_MODES.HARD));
});

test('validatePool: rejects empty and out-of-pool, dedups valid', () => {
  assert.equal(validatePool(ENVIRONMENTS.ONEVONE, []).ok, false);
  assert.equal(validatePool(ENVIRONMENTS.ONEVONE, ['hard']).ok, false, 'hard illegal in 1v1');
  assert.deepEqual(validatePool(ENVIRONMENTS.PARTY, ['classic', 'classic', 'hard']).pool, ['classic', 'hard']);
});

test('resolveMode: single->that; multiple->rng pick; empty->throw', () => {
  assert.equal(resolveMode(['guess']), 'guess');
  assert.equal(resolveMode(['classic', 'guess'], () => 0), 'classic');
  assert.equal(resolveMode(['classic', 'guess'], () => 0.99), 'guess');
  assert.throws(() => resolveMode([]));
});

test('roundHint: blueprint copy per mode', () => {
  assert.equal(roundHint('classic'), 'Get close!');
  assert.equal(roundHint('hard'), 'Hit EXACTLY!');
  assert.equal(roundHint('guess'), 'Trust your clock!');
});

test('validateCategory gates: teams>=3, pvp>=2, pve>=1', () => {
  assert.equal(validateCategory(CATEGORIES.TEAMS, 2).ok, false);
  assert.equal(validateCategory(CATEGORIES.TEAMS, 3).ok, true);
  assert.equal(validateCategory(CATEGORIES.PVP, 1).ok, false);
  assert.equal(validateCategory(CATEGORIES.PVP, 2).ok, true);
  assert.equal(validateCategory(CATEGORIES.PVE, 1).ok, true);
  assert.equal(validateCategory('bogus', 9).ok, false);
});

test('teamsFormat: exactly 3 = asymmetric 2v1; 4+ = standard draft', () => {
  const three = teamsFormat(3);
  assert.equal(three.format, 'asymmetric-2v1');
  assert.equal(three.captains, 2);
  assert.equal(three.freeAgents, 1);
  assert.equal(teamsFormat(4).format, 'standard');
  assert.equal(teamsFormat(2).ok, false);
});

test('kothConfig: threshold gate + hard target restriction 0.5-3.5s', () => {
  assert.equal(kothConfig(6).ok, false, 'only 5/7/10 allowed');
  assert.deepEqual(kothConfig(7, true).targetRangeMs, KOTH_HARD_TARGET_MS);
  assert.deepEqual(kothConfig(7, false).targetRangeMs, DEFAULT_TARGET_MS);
  assert.equal(kothConfig(10, false).n, 10);
  assert.deepEqual([...KOTH_THRESHOLDS], [5, 7, 10]);
});

test('seedOrder: standard bracket ordering', () => {
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('singleElimSeed: byes to top seeds for odd/short fields', () => {
  const p = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

  const two = singleElimSeed(p(2));
  assert.equal(two.size, 2); assert.equal(two.byes, 0);
  assert.equal(two.pairings.length, 1);
  assert.equal(two.pairings[0].a.player, 'P1');
  assert.equal(two.pairings[0].b.player, 'P2');

  const three = singleElimSeed(p(3));
  assert.equal(three.size, 4); assert.equal(three.byes, 1);
  // top seed P1 draws the bye (opponent null); P2 vs P3 play
  const p1pair = three.pairings.find((m) => m.a?.player === 'P1');
  assert.equal(p1pair.b, null, 'P1 gets the bye');
  const contested = three.pairings.find((m) => m.a?.player === 'P2');
  assert.equal(contested.b.player, 'P3');

  const five = singleElimSeed(p(5));
  assert.equal(five.size, 8); assert.equal(five.byes, 3);
  const byeCount = five.pairings.filter((m) => m.a === null || m.b === null).length;
  assert.equal(byeCount, 3);

  assert.equal(singleElimSeed(p(1)).ok, false);
});

test('oneVoneChallengeMode: never returns hard; honors single pick', () => {
  for (let i = 0; i < 20; i++) {
    const m = oneVoneChallengeMode(['classic', 'guess'], Math.random);
    assert.ok(m === 'classic' || m === 'guess');
  }
  assert.equal(oneVoneChallengeMode(['guess']), 'guess');
  assert.throws(() => oneVoneChallengeMode(['hard']), /Not allowed/);
});
