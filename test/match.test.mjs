import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seededTargets, tally, outcomeFor, lifecycle, deriveRecord,
  MATCH_EXPIRY_MS, CLASSIC_ROUNDS, GUESS_ROUNDS, roundsFor, MATCH_MODES
} from '../src/match.js';

test('seeded targets are deterministic for a given id', () => {
  assert.deepEqual(seededTargets('classic', 'abc123'), seededTargets('classic', 'abc123'));
  assert.deepEqual(seededTargets('guess', 'zzz999'), seededTargets('guess', 'zzz999'));
});

test('both players (same id) face identical sequences; different ids differ', () => {
  const host = seededTargets('classic', 'match-42');
  const challenger = seededTargets('classic', 'match-42'); // replayed later, same id
  assert.deepEqual(host, challenger);
  assert.notDeepEqual(seededTargets('classic', 'match-42'), seededTargets('classic', 'match-43'));
});

test('classic = 5 distinct targets; exactly one long (10-15s) round; rest 0.5-10s', () => {
  const t = seededTargets('classic', 'shape-check-1');
  assert.equal(t.length, CLASSIC_ROUNDS);
  assert.equal(new Set(t).size, CLASSIC_ROUNDS, 'targets distinct');
  const long = t.filter((ms) => ms >= 10000 && ms <= 15000);
  const short = t.filter((ms) => ms >= 500 && ms <= 10000);
  assert.equal(long.length, 1);
  assert.equal(short.length, 4);
  assert.ok(t.every((ms) => ms % 100 === 0), '0.1s resolution');
});

test('guess = 3 targets within 1.0-8.0s', () => {
  const t = seededTargets('guess', 'guess-shape');
  assert.equal(t.length, GUESS_ROUNDS);
  assert.ok(t.every((ms) => ms >= 1000 && ms <= 8000 && ms % 100 === 0));
});

test('roundsFor maps modes', () => {
  assert.equal(roundsFor(MATCH_MODES.classic), 5);
  assert.equal(roundsFor(MATCH_MODES.guess), 3);
});

test('tally: lower total deviation wins', () => {
  const m = { host: { uid: 'H', score: 1200 }, challenger: { uid: 'C', score: 1500 } };
  assert.deepEqual(tally(m), { decided: true, winnerUid: 'H', draw: false });
  const m2 = { host: { uid: 'H', score: 1800 }, challenger: { uid: 'C', score: 1500 } };
  assert.equal(tally(m2).winnerUid, 'C');
});

test('tally: equal scores = draw; missing score = undecided', () => {
  assert.deepEqual(tally({ host: { uid: 'H', score: 900 }, challenger: { uid: 'C', score: 900 } }),
    { decided: true, winnerUid: null, draw: true });
  assert.equal(tally({ host: { uid: 'H', score: 900 }, challenger: null }).decided, false);
  assert.equal(tally({ host: { uid: 'H', score: 900 }, challenger: { uid: 'C', score: null } }).decided, false);
});

test('outcomeFor: w / l / d', () => {
  assert.equal(outcomeFor({ winnerUid: 'H', draw: false }, 'H'), 'w');
  assert.equal(outcomeFor({ winnerUid: 'H', draw: false }, 'C'), 'l');
  assert.equal(outcomeFor({ winnerUid: null, draw: true }, 'H'), 'd');
});

test('lifecycle: pending / complete / expired via 48h window', () => {
  const now = 1_000_000_000_000;
  assert.equal(lifecycle({ status: 'pending', challenger: null, expiresAt: now + 1000 }, now), 'pending');
  assert.equal(lifecycle({ status: 'pending', challenger: null, expiresAt: now - 1000 }, now), 'expired');
  assert.equal(lifecycle({ status: 'pending', challenger: { uid: 'C' }, expiresAt: now - 1000 }, now), 'pending');
  assert.equal(lifecycle({ status: 'complete' }, now), 'complete');
  assert.equal(MATCH_EXPIRY_MS, 48 * 60 * 60 * 1000);
});

test('deriveRecord: counts w/l/d, orders recent, caps at 5, names opponent', () => {
  const uid = 'me';
  const mk = (id, winner, draw, at, hostIsMe = true) => ({
    id, mode: 'classic', status: 'complete', winnerUid: winner, draw, completedAt: at,
    host: hostIsMe ? { uid, name: 'Me' } : { uid: 'op', name: 'Opp' },
    challenger: hostIsMe ? { uid: 'op', name: 'Opp' } : { uid, name: 'Me' }
  });
  const matches = [
    mk('a', uid, false, 100),        // win
    mk('b', 'op', false, 200),       // loss
    mk('c', null, true, 300),        // draw
    mk('d', uid, false, 400, false), // win (I'm challenger)
    mk('e', uid, false, 500),        // win
    mk('f', uid, false, 600),        // win
    { id: 'g', status: 'pending', host: { uid, name: 'Me' }, challenger: null } // ignored
  ];
  const { record, recent } = deriveRecord(matches, uid);
  assert.deepEqual(record, { w: 4, l: 1, d: 1 });
  assert.equal(recent.length, 5, 'capped at last 5');
  assert.equal(recent[0].matchId, 'f', 'most recent first');
  assert.equal(recent[0].opponent, 'Opp');
  assert.equal(recent.find((r) => r.matchId === 'd').opponent, 'Opp'); // opponent resolved when I'm challenger
});
