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

export function isExact(elapsedMs, targetMs) {
  return Math.round(elapsedMs / 100) === Math.round(targetMs / 100);
}

// perPlayerStopMs (TR-52, optional): when set, the DNF clock is PER PLAYER and
// starts when that player taps START — each player gets perPlayerStopMs to STOP
// (e.g. 30s), and a player who never starts is DNF'd perPlayerStopMs after the
// round begins. When omitted the round keeps the original single grace window
// (targetMs + DNF_GRACE_MS), so single-player and PvE are unaffected.
// deadlineMs is still honored (absolute cap from begin) when perPlayerStopMs is
// not given.
export function createRound({ db, room, players, targetMs, hard = false, onTv, deadlineMs, perPlayerStopMs }) {
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
  let dnfTimer = null;       // legacy single-deadline timer
  let startDeadline = null;  // per-player mode: DNF players who never start
  const stopTimers = new Map(); // per-player mode: playerId -> stop timeout
  const dnfDelayMs = deadlineMs != null ? deadlineMs : targetMs + DNF_GRACE_MS;

  function clearTimers() {
    clearTimeout(dnfTimer);
    clearTimeout(startDeadline);
    for (const t of stopTimers.values()) clearTimeout(t);
    stopTimers.clear();
  }

  function snapshotPlayers() {
    return Object.fromEntries([...slots.values()].map((s) => [s.playerId, { ...s }]));
  }

  function results() {
    const stopped = [...slots.values()].filter((s) => s.state === 'stopped');
    return stopped.sort((a, b) => a.deviationMs - b.deviationMs);
  }

  function roundWinner() {
    const best = results()[0] ?? null;
    if (!best) return null;
    if (hard && !isExact(best.elapsedMs, targetMs)) return null; // exact hit or nothing
    return best;
  }

  function publish(extra = {}) {
    return set(ref(db, `sessions/${room}/game`), {
      mode: 'target',
      status,
      targetMs,
      players: snapshotPlayers(),
      ranking: status === 'over' ? results().map((s) => s.playerId) : null,
      winner: status === 'over' ? roundWinner() : null,
      hard,
      updatedAt: serverTimestamp(),
      ...extra
    });
  }

  function maybeFinish(trigger) {
    const open = [...slots.values()].some((s) => s.state === 'waiting' || s.state === 'running');
    if (open || status !== 'running') return;
    status = 'over';
    clearTimers();
    publish();
    onTv?.state(getPublicState());
    const w = results()[0];
    logTransition('round', 'running', 'over',
      `${trigger} — winner ${w ? `${w.name} (Δ${w.deviationMs}ms)` : 'none (all DNF)'}`);
  }

  function getPublicState() {
    return { mode: 'target', status, targetMs, hard, players: snapshotPlayers(), ranking: status === 'over' ? results().map((s) => s.playerId) : null, winner: status === 'over' ? roundWinner() : null };
  }

  function begin() {
    publish();
    onTv?.state(getPublicState());
    logTransition('round', 'ready', 'running', `target ${targetMs}ms, ${players.length} players`);
    if (perPlayerStopMs != null) {
      // A player who never even STARTS within the window is DNF'd (AFK guard).
      startDeadline = setTimeout(() => {
        for (const s of slots.values()) {
          if (s.state === 'waiting') {
            logTransition('round', 'waiting', 'dnf', `${s.name}: never started (${perPlayerStopMs}ms)`);
            s.state = 'dnf';
          }
        }
        maybeFinish('start deadline');
      }, perPlayerStopMs);
    } else {
      dnfTimer = setTimeout(() => {
        for (const s of slots.values()) {
          if (s.state === 'waiting' || s.state === 'running') {
            logTransition('round', s.state, 'dnf', `${s.name}: deadline (${dnfDelayMs}ms from start)`);
            s.state = 'dnf';
          }
        }
        maybeFinish('DNF deadline');
      }, dnfDelayMs);
    }
  }

  function handleEvent(ev) {
    if (status !== 'running' || ev.type !== 'press') return;
    const s = slots.get(ev.playerId);
    if (!s) { logTransition('round', 'running', 'press-ignored', `event ${ev.eventId}: unknown player`); return; }
    if (s.state === 'waiting') {
      s.state = 'running';
      s.startClientTs = ev.clientTs;
      s.startHostTs = Date.now();
      if (perPlayerStopMs != null) {
        // This player now has perPlayerStopMs to STOP before a DNF.
        stopTimers.set(s.playerId, setTimeout(() => {
          if (s.state === 'running') {
            logTransition('round', 'running', 'dnf', `${s.name}: stop timeout (${perPlayerStopMs}ms from start)`);
            s.state = 'dnf';
            maybeFinish(`${s.name} stop timeout`);
          }
        }, perPlayerStopMs));
      }
      publish();
      onTv?.state(getPublicState());
      logTransition('round', 'waiting', 'running', `event ${ev.eventId}: ${s.name} started`);
    } else if (s.state === 'running') {
      s.state = 'stopped';
      s.elapsedMs = ev.clientTs - s.startClientTs; // same-device clock: fair
      s.deviationMs = Math.abs(s.elapsedMs - targetMs);
      const t = stopTimers.get(s.playerId);
      if (t) { clearTimeout(t); stopTimers.delete(s.playerId); }
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
