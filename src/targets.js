// TR-52 §3 Classic target pacing (PURE). The old uniform 4–15s random made
// nearly every round a 10s+ marathon. This deals a per-GAME plan so a 5-round
// game has EXACTLY ONE "long" round (7.0–13.0s) and every other round is a
// "sprint" (0.5–6.99s). Rounds beyond 5 (deuce) are sprints. Each game gets a
// fresh sequencer; call next() once per round.

const round100 = (ms) => Math.round(ms / 100) * 100; // one decimal of seconds

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** A sprint target in [0.50, 6.90]s (stays under the 7s "long" floor after rounding). */
export function sprintTarget() { return round100(500 + Math.random() * 6400); }
/** A long target in [7.00, 13.00]s. */
export function longTarget() { return round100(7000 + Math.random() * 6000); }

/**
 * Per-game classic sequencer. Returns next() -> targetMs. Exactly one long round
 * per 5-round game; the rest (and any deuce rounds) are sprints.
 */
export function createClassicTargets() {
  const plan = shuffle([true, false, false, false, false]); // one long slot in the first 5 rounds
  let i = 0;
  return function next() {
    const long = plan[i++] === true; // beyond the plan -> undefined -> sprint
    return long ? longTarget() : sprintTarget();
  };
}
