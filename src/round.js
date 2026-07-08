// Target-time round (TR-5, corrected rules).
// TV announces a random target. Each player taps once to START their own
// hidden timer and again to STOP it, trying to land exactly on the target.
// Phones stay blind; the TV reveals ranked results when everyone has stopped.
// Scoring uses the phone's own clock (stopClientTs - startClientTs), so
// network latency cannot make a result unfair.
import { ref, set, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export const TARGET_MIN_MS = 4000;
export const TARGET_MAX_MS = 15000;
export const DNF_GRACE_MS = 15000; // after target, before a non-stopped player is DNF'd

export function randomTarget() {
  const ms = TARGET_MIN_MS + Math.random() * (TARGET_MAX_MS - TARGET_MIN_MS);
  return Math.round(ms / 100) * 100; // one decimal of seconds
}

export function createRound({ db, room, players, targetMs, onTv }) {
  // players: [{playerId, name}] — everyone in the lobby plays every round.
  let status = 'running'; // running | over
  const slots = new Map(players.map((p) => [p.playerId, {
    playerId: p.playerId,
    name: p.name,
    state: 'waiting', // waiting | running | stopped | dnf
    startClientTs: null,
    startHostTs: null,  // display baseline for the TV's live timers
    elapsedMs: null,
    deviationMs: null
  }]));
  let dnfTimer = null;

  function snapshotPlayers() {
    return Object.fromEntries([...slots.values()].map((s) => [s.playerId, { ...s }]));
  }

  function results() {
    const stopped = [...slots.values()].filter((s) => s.state === 'stopped');
    return stopped.sort((a, b) => a.deviationMs - b.deviationMs);
  }

  function publish(extra = {}) {
    return set(ref(db, `sessions/${room}/game`), {
      mode: 'target',
      status,
      targetMs,
      players: snapshotPlayers(),
      ranking: status === 'over' ? results().map((s) => s.playerId) : null,
      winner: status === 'over' ? (results()[0] ?? null) : null,
      updatedAt: serverTimestamp(),
      ...extra
    });
  }

  function maybeFinish(trigger) {
    const open = [...slots.values()].some((s) => s.state === 'waiting' || s.state === 'running');
    if (open || status !== 'running') return;
    status = 'over';
    clearTimeout(dnfTimer);
    publish();
    onTv?.state(getPublicState());
    const w = results()[0];
    logTransition('round', 'running', 'over',
      `${trigger} — winner ${w ? `${w.name} (Δ${w.deviationMs}ms)` : 'none (all DNF)'}`);
  }

  function getPublicState() {
    return { mode: 'target', status, targetMs, players: snapshotPlayers(), ranking: status === 'over' ? results().map((s) => s.playerId) : null, winner: status === 'over' ? (results()[0] ?? null) : null };
  }

  function begin() {
    publish();
    onTv?.state(getPublicState());
    logTransition('round', 'ready', 'running', `target ${targetMs}ms, ${players.length} players`);
    dnfTimer = setTimeout(() => {
      for (const s of slots.values()) {
        if (s.state === 'waiting' || s.state === 'running') {
          logTransition('round', s.state, 'dnf', `${s.name}: deadline (target+${DNF_GRACE_MS}ms)`);
          s.state = 'dnf';
        }
      }
      maybeFinish('DNF deadline');
    }, targetMs + DNF_GRACE_MS);
  }

  function handleEvent(ev) {
    if (status !== 'running' || ev.type !== 'press') return;
    const s = slots.get(ev.playerId);
    if (!s) { logTransition('round', 'running', 'press-ignored', `event ${ev.eventId}: unknown player`); return; }
    if (s.state === 'waiting') {
      s.state = 'running';
      s.startClientTs = ev.clientTs;
      s.startHostTs = Date.now();
      publish();
      onTv?.state(getPublicState());
      logTransition('round', 'waiting', 'running', `event ${ev.eventId}: ${s.name} started`);
    } else if (s.state === 'running') {
      s.state = 'stopped';
      s.elapsedMs = ev.clientTs - s.startClientTs; // same-device clock: fair
      s.deviationMs = Math.abs(s.elapsedMs - targetMs);
      publish();
      onTv?.state(getPublicState());
      logTransition('round', 'running', 'stopped',
        `event ${ev.eventId}: ${s.name} at ${s.elapsedMs}ms (Δ${s.deviationMs}ms)`);
      maybeFinish(`${s.name} stopped last`);
    } else {
      logTransition('round', s.state, 'press-ignored', `event ${ev.eventId}: ${s.name} already ${s.state}`);
    }
  }

  return { begin, handleEvent, isOver: () => status === 'over', getPublicState };
}
