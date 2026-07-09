import test from 'node:test';
import assert from 'node:assert/strict';
import { distributeTeams, activeMember } from '../src/teamgame.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, name: `P${i + 1}` }));

test('distributeTeams: 3 players / 2 teams = 2v1 (sizes 2 and 1)', () => {
  const teams = distributeTeams(players(3), 2);
  assert.equal(teams.length, 2);
  const sizes = teams.map((t) => t.members.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('distributeTeams: round-robin keeps sizes within 1', () => {
  const teams = distributeTeams(players(7), 3);
  assert.equal(teams.length, 3);
  assert.deepEqual(teams.map((t) => t.members.length).sort(), [2, 2, 3]);
  // all 7 players placed exactly once
  const all = teams.flatMap((t) => t.members.map((m) => m.playerId));
  assert.equal(new Set(all).size, 7);
});

test('distributeTeams: clamps team count to >=2 and <=players', () => {
  assert.equal(distributeTeams(players(3), 1).length, 2);   // min 2
  assert.equal(distributeTeams(players(3), 9).length, 3);   // max = players
});

test('activeMember: solo plays every round; pair alternates', () => {
  const solo = { members: [{ playerId: 's1' }] };
  const pair = { members: [{ playerId: 'a1' }, { playerId: 'a2' }] };
  assert.equal(activeMember(solo, 0).playerId, 's1');
  assert.equal(activeMember(solo, 5).playerId, 's1');
  assert.equal(activeMember(pair, 0).playerId, 'a1');
  assert.equal(activeMember(pair, 1).playerId, 'a2');
  assert.equal(activeMember(pair, 2).playerId, 'a1');
});
