import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftState, applyPick, autoPick, currentCaptain, isCaptain, draftTeams, LOGOS, applyLogo, autoFillCustomization } from '../src/draft.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, name: `P${i + 1}` }));
const noShuffle = () => 0.5; // stable order (Array.sort with constant comparator keeps order-ish)

test('createDraftState: captains seeded, rest in pool, sizes', () => {
  const s = createDraftState(players(5), 2, noShuffle);
  assert.equal(s.teams.length, 2);
  assert.equal(s.status, 'drafting');
  assert.equal(s.pool.length, 3); // 5 - 2 captains
  assert.ok(s.teams.every((t) => t.members.length === 1 && t.captainId === t.members[0]));
  assert.equal(s.teams[0].emoji, null); // Stage 3a: logos are PICKED, not defaulted
});

test('createDraftState: no pool => straight to naming', () => {
  const s = createDraftState(players(2), 2, noShuffle);
  assert.equal(s.status, 'naming');
  assert.equal(s.pool.length, 0);
});

test('applyPick: only the current captain can pick a pool player', () => {
  const s = createDraftState(players(4), 2, noShuffle);
  const cap0 = s.teams[0].captainId, cap1 = s.teams[1].captainId;
  const poolPlayer = s.pool[0];
  assert.equal(applyPick(s, cap1, poolPlayer).ok, false, 'not team1 turn');
  assert.equal(applyPick(s, cap0, 'nobody').ok, false, 'not in pool');
  assert.equal(applyPick(s, cap0, poolPlayer).ok, true);
  assert.ok(s.teams[0].members.includes(poolPlayer));
  assert.ok(!s.pool.includes(poolPlayer));
  assert.equal(s.turn, 1, 'advanced to team 1');
});

test('snake order: last team picks twice at the turn', () => {
  const s = createDraftState(players(8), 2, noShuffle); // 2 caps, 6 pool
  const order = [];
  let guard = 0;
  while (s.status === 'drafting' && guard++ < 20) { order.push(s.turn); autoPick(s, () => 0); }
  // 6 picks, snake with 2 teams: 0,1,1,0,0,1
  assert.deepEqual(order, [0, 1, 1, 0, 0, 1]);
  assert.equal(s.status, 'naming');
});

test('helpers: currentCaptain / isCaptain / draftTeams', () => {
  const s = createDraftState(players(3), 2, noShuffle);
  assert.equal(isCaptain(s, s.teams[0].captainId), true);
  assert.equal(isCaptain(s, 'p99'), false);
  assert.equal(currentCaptain(s), s.teams[0].captainId);
  const teams = draftTeams(s, (pid) => pid.toUpperCase());
  assert.ok(teams[0].members.every((m) => m.name === m.playerId.toUpperCase()));
});

/* ---- Stage 3a (TR-57): wheels, split-role customization, auto-fill ---- */

test('wheel-chosen captains seed teams in draft order', () => {
  const s = createDraftState(players(5), 2, noShuffle, ['p4', 'p2']);
  assert.equal(s.teams[0].captainId, 'p4');
  assert.equal(s.teams[1].captainId, 'p2');
  assert.deepEqual(s.pool.sort(), ['p1', 'p3', 'p5']);
});

test('logo picker is a random NON-captain; solo team falls back to captain', () => {
  const s = createDraftState(players(4), 2, noShuffle);
  while (s.status === 'drafting') autoPick(s, () => 0);
  s.teams.forEach((t) => {
    assert.ok(t.logoPickerId);
    if (t.members.length > 1) assert.notEqual(t.logoPickerId, t.captainId);
  });
});

test('applyLogo: pool-only, picker-only, uniqueness enforced', () => {
  const s = createDraftState(players(4), 2, noShuffle);
  while (s.status === 'drafting') autoPick(s, () => 0);
  const [a, b] = s.teams;
  assert.equal(applyLogo(s, a.captainId === a.logoPickerId ? 'zzz' : a.captainId, LOGOS[0]).ok, false); // not the picker
  assert.equal(applyLogo(s, a.logoPickerId, 'not-an-icon').ok, false);
  assert.equal(applyLogo(s, a.logoPickerId, LOGOS[0]).ok, true);
  assert.equal(applyLogo(s, b.logoPickerId, LOGOS[0]).ok, false); // taken
  assert.equal(applyLogo(s, b.logoPickerId, LOGOS[1]).ok, true);
});

test('autoFillCustomization: Team {Captain} + random unused logo', () => {
  const s = createDraftState(players(4), 2, noShuffle);
  while (s.status === 'drafting') autoPick(s, () => 0);
  applyLogo(s, s.teams[0].logoPickerId, LOGOS[2]);
  autoFillCustomization(s, (id) => id.toUpperCase(), () => 0);
  assert.ok(s.teams[0].name.startsWith('Team '));
  assert.equal(s.teams[0].emoji, LOGOS[2]); // kept
  assert.ok(LOGOS.includes(s.teams[1].emoji));
  assert.notEqual(s.teams[1].emoji, LOGOS[2]); // unused only
  assert.ok(LOGOS.length >= 10);
});
