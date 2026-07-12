// Tonight-stats ledger (TR-56 Stage 2, PURE — no Firebase). One night = one
// lobby's accumulated per-player record across every round, game, and rematch.
// Feeds the matchup cards' tonight-only record line now and the D1 awards
// ceremony (Sniper/Heartbreaker/Ice Veins/…) in Stage 3.
// The TV owns persistence (sessions/room/stats); this module only reduces.

export function blankNight() {
  return { players: {} };
}

function slot(night, id, name) {
  return night.players[id] || (night.players[id] = {
    playerId: id, name: name || id,
    rounds: 0, wins: 0, losses: 0, dnfs: 0, clutchWins: 0,
    early: 0, late: 0,
    bestDevMs: null, devSumMs: 0, devSumSqMs: 0, devCount: 0,
    streak: 0, bestStreak: 0,
    lockInSumMs: 0, lockInCount: 0,
  });
}

/** Record one resolved (non-void) round. entries: [{playerId, name,
 *  deviationMs|null, dnf, early, late, lockInMs?}], winnerId|null. */
export function recordRound(night, { entries, winnerId }) {
  (entries || []).forEach((p) => {
    const s = slot(night, p.playerId, p.name);
    if (p.name) s.name = p.name;
    s.rounds += 1;
    if (p.dnf) s.dnfs += 1;
    if (Number.isFinite(p.deviationMs)) {
      s.devSumMs += p.deviationMs;
      s.devSumSqMs += p.deviationMs * p.deviationMs;
      s.devCount += 1;
      if (s.bestDevMs == null || p.deviationMs < s.bestDevMs) s.bestDevMs = p.deviationMs;
    }
    if (p.early) s.early += 1;
    if (p.late) s.late += 1;
    if (Number.isFinite(p.lockInMs)) { s.lockInSumMs += p.lockInMs; s.lockInCount += 1; }
    if (winnerId && p.playerId === winnerId) {
      s.wins += 1;
      s.streak += 1;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
      if (Number.isFinite(p.deviationMs) && p.deviationMs <= 50) s.clutchWins += 1;
    } else {
      s.losses += 1;
      s.streak = 0;
    }
  });
  return night;
}

/** Map a finished game-state (classic 'target', 'guess', or 'hard') to ledger
 *  input. Returns null for a dead-heat (voided rounds must not count). */
export function roundEntries(g) {
  const winnerId = g.winner ? g.winner.playerId : null;
  const entries = [];
  Object.values(g.players || {}).forEach((p) => {
    if (g.mode === 'guess') {
      entries.push({
        playerId: p.playerId, name: p.name,
        deviationMs: Number.isFinite(p.deltaMs) ? p.deltaMs : null,
        dnf: false,
        early: Number.isFinite(p.guessMs) && Number.isFinite(g.actualMs) && p.guessMs < g.actualMs,
        late: Number.isFinite(p.guessMs) && Number.isFinite(g.actualMs) && p.guessMs > g.actualMs,
      });
    } else if (g.mode === 'hard' || g.mode === 'hardrace') {
      const att = (g.attempts && g.attempts[p.playerId]) || [];
      const best = att.length ? Math.min(...att.map((a) => Math.abs(a.elapsedMs - g.targetMs))) : null;
      entries.push({
        playerId: p.playerId, name: p.name,
        deviationMs: best,
        dnf: att.length === 0 && p.playerId !== winnerId,
        early: att.some((a) => a.early),
        late: att.some((a) => !a.early && !a.hit),
      });
    } else {
      const stopped = p.state === 'stopped';
      entries.push({
        playerId: p.playerId, name: p.name,
        deviationMs: stopped && Number.isFinite(p.deviationMs) ? p.deviationMs : null,
        dnf: p.state === 'dnf',
        early: stopped && p.elapsedMs < g.targetMs,
        late: stopped && p.elapsedMs > g.targetMs,
      });
    }
  });
  // Dead-heat guard: a round whose two closest deviations are identical is a
  // void (the engines rerun it) — recording it would fake a win/loss. The
  // race-to-safety is exempt: it settles by hit ORDER, ties never void it.
  const devs = entries.map((e) => e.deviationMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (g.mode !== 'hardrace' && devs.length >= 2 && devs[0] === devs[1]) return null;
  return { winnerId, entries };
}

/** The matchup card's tonight-only record line, or null before round one. */
export function tonightLine(night, playerId) {
  const s = night.players[playerId];
  if (!s || !s.rounds) return null;
  const best = s.bestDevMs != null ? ` · best Δ${(s.bestDevMs / 1000).toFixed(2)}s` : '';
  return `${s.wins}–${s.losses} tonight${best}`;
}

/* ---- Stage 3b (TR-58): the awards ceremony pool ----
   Ten titles computed from the night ledger. TOP 4 air, ranked by stat
   extremity (how far the winner stands from the runner-up), ONE title max
   per player with runner-up inheritance; champions stay eligible. */

const num = (v) => (Number.isFinite(v) ? v : null);

export const AWARD_DEFS = [
  { id: 'sniper', title: '🎯 THE SNIPER', dir: 'min',
    stat: (s) => num(s.bestDevMs),
    line: (v) => `best shot Δ${(v / 1000).toFixed(2)}s` },
  { id: 'iceveins', title: '🧊 ICE VEINS', dir: 'max',
    stat: (s) => (s.clutchWins > 0 ? s.clutchWins : null),
    line: (v) => `${v} clutch win${v === 1 ? '' : 's'} (≤0.05s)` },
  { id: 'heartbreaker', title: '💔 HEARTBREAKER', dir: 'max',
    stat: (s) => (s.losses > 0 ? s.losses : null),
    line: (v) => `${v} round losses — so close, so often` },
  { id: 'dnfking', title: '⏰ DNF KING', dir: 'max',
    stat: (s) => (s.dnfs > 0 ? s.dnfs : null),
    line: (v) => `${v} DNF${v === 1 ? '' : 's'} — the clock won` },
  { id: 'heater', title: '🔥 THE HEATER', dir: 'max',
    stat: (s) => (s.bestStreak >= 2 ? s.bestStreak : null),
    line: (v) => `${v} round wins in a row` },
  { id: 'triggerhappy', title: '⚡ TRIGGER HAPPY', dir: 'max',
    stat: (s) => (s.early > 0 ? s.early : null),
    line: (v) => `${v} early stops` },
  { id: 'late', title: '🕰️ FASHIONABLY LATE', dir: 'max',
    stat: (s) => (s.late > 0 ? s.late : null),
    line: (v) => `${v} late stops` },
  { id: 'speedrunner', title: '🏃 SPEEDRUNNER', dir: 'min',
    stat: (s) => (s.lockInCount > 0 ? s.lockInSumMs / s.lockInCount : null),
    line: (v) => `${(v / 1000).toFixed(2)}s average lock-in` },
  { id: 'wildcard', title: '🃏 WILDCARD', dir: 'max',
    stat: (s) => (s.devCount >= 2
      ? Math.max(0, s.devSumSqMs / s.devCount - (s.devSumMs / s.devCount) ** 2)
      : null),
    line: () => 'highest chaos factor tonight' },
  { id: 'workhorse', title: '🐴 WORKHORSE', dir: 'max',
    stat: (s) => (s.rounds > 0 ? s.rounds : null),
    line: (v) => `${v} rounds played` },
];

/** Top-`cap` awards: [{id, title, playerId, name, statLine}]. */
export function computeAwards(night, cap = 4) {
  const players = Object.values(night.players || {});
  if (!players.length) return [];
  // Per title: rank eligible players best-first, with the extremity margin.
  const ranked = AWARD_DEFS.map((def) => {
    const entries = players
      .map((s) => ({ s, v: def.stat(s) }))
      .filter((e) => e.v != null)
      .sort((a, b) => (def.dir === 'min' ? a.v - b.v : b.v - a.v));
    if (!entries.length) return null;
    const [best, second] = entries;
    const extremity = second
      ? Math.abs(best.v - second.v) / (Math.abs(second.v) + 1)
      : 1; // unchallenged = maximally extreme
    return { def, entries, extremity };
  }).filter(Boolean).sort((a, b) => b.extremity - a.extremity);
  // Greedy: one title per player; a taken player passes the title down.
  const takenPlayers = new Set();
  const out = [];
  for (const r of ranked) {
    if (out.length >= cap) break;
    const heir = r.entries.find((e) => !takenPlayers.has(e.s.playerId));
    if (!heir) continue;
    takenPlayers.add(heir.s.playerId);
    out.push({
      id: r.def.id, title: r.def.title,
      playerId: heir.s.playerId, name: heir.s.name,
      statLine: r.def.line(heir.v),
    });
  }
  return out;
}
