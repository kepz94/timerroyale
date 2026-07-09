// TR-52 party-mode round-resolution rules (PURE, no Firebase). Encodes the
// rulebook that the /tv orchestration composes on top of the existing
// round/koth/guess engines WITHOUT modifying them:
//   - the Dead-Heat Tie-Breaker (identical absolute deviations void the round),
//   - Classic's 20-second hard cutoff (hostage prevention -> DNF),
//   - Guess the Clock's 15-second submission window (a miss defaults to 0.00s),
//   - Hard Classic's 13-attempt cap with the 0.1s truncation win window and the
//     closest-single-attempt-on-washout tie-break.
// Every function here is a standalone predicate/resolver; state lives in the
// callers (round.js / koth.js / tv.js), so these rules stay isolated + testable.

export const CLASSIC_CUTOFF_MS = 20000; // Classic ticker terminates at 20.00s -> DNF
export const GUESS_WINDOW_MS = 15000;   // Guess submission window; late = default 0.00s
export const HARD_ATTEMPT_CAP = 13;     // Hard Classic attempts per representative per round

/**
 * The Dead-Heat Tie-Breaker. Given the STOPPED contenders' absolute deviations,
 * a round in which the two closest share the EXACT same absolute deviation is
 * voided (no ledger dot, "TIE GAME — RESETTING", a fresh target is rerun).
 * @param {{playerId:string, deviationMs:number}[]} results stopped players, any order
 * @returns {{deadHeat:true, tied:[string,string]} | {deadHeat:false, winnerId:string|null}}
 */
export function classicOutcome(results) {
  const stopped = results
    .filter((r) => Number.isFinite(r.deviationMs))
    .sort((a, b) => a.deviationMs - b.deviationMs);
  if (stopped.length === 0) return { deadHeat: false, winnerId: null };
  if (stopped.length >= 2 && stopped[0].deviationMs === stopped[1].deviationMs) {
    return { deadHeat: true, tied: [stopped[0].playerId, stopped[1].playerId] };
  }
  return { deadHeat: false, winnerId: stopped[0].playerId };
}

/** Classic 20s hard cutoff: a never-stopped or >= 20.00s clock is a DNF. */
export function isCutoffDnf(elapsedMs) {
  return elapsedMs == null || elapsedMs >= CLASSIC_CUTOFF_MS;
}

/** Guess default when the 15s window expires with no submission (guarantees a loss). */
export function guessDefaultMs() {
  return 0;
}

/**
 * Hard Classic truncation win window: the target is a single-decimal number
 * (e.g. 2.5s = 2500ms) and any recorded time whose tenths match is a hit
 * (2500..2599ms all "hit" 2.5s). Mirrors floor(t*10)/10 === target.
 */
export function isHardHit(elapsedMs, targetMs) {
  return Math.floor(elapsedMs / 100) === Math.floor(targetMs / 100);
}

/**
 * Hard Classic 13-attempt resolution across the two representatives' attempt
 * logs (each the ordered list of that rep's recorded times for the round):
 *   Scenario A — the first rep hits inside their 13 attempts -> instant win.
 *   otherwise  — the second rep hits inside their 13 -> win.
 *   Scenario B — the Endurance Washout: both fail all 13; the single closest
 *                attempt across both logs takes the dot; an exact tie voids.
 * @returns {{winnerId:string, reason:string} | {winnerId:null, deadHeat:true, reason:string}}
 */
export function resolveHard({ target, aAttempts = [], bAttempts = [], aId = 'a', bId = 'b' }) {
  const a = aAttempts.slice(0, HARD_ATTEMPT_CAP);
  const b = bAttempts.slice(0, HARD_ATTEMPT_CAP);
  if (a.some((ms) => isHardHit(ms, target))) return { winnerId: aId, reason: 'hit' };
  if (b.some((ms) => isHardHit(ms, target))) return { winnerId: bId, reason: 'hit' };
  const closest = (arr) => (arr.length ? Math.min(...arr.map((ms) => Math.abs(ms - target))) : Infinity);
  const da = closest(a), dbv = closest(b);
  if (da === dbv) return { winnerId: null, deadHeat: true, reason: 'washout-tie' };
  return { winnerId: da < dbv ? aId : bId, reason: 'washout-closest', devA: da, devB: dbv };
}
