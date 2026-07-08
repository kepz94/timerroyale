// Game engine primitives (TR-4).
// Rule: the HOST is the single authority for game state and time.
// Phones only append events to sessions/{room}/events; they never run timers.
import { ref, push, onChildAdded, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

const STALE_EVENT_MS = 5000;

/** Phone side: append an event. Fire-and-forget. */
export function sendEvent(db, room, playerId, type) {
  return push(ref(db, `sessions/${room}/events`), {
    type,
    playerId,
    clientTs: Date.now(),
    serverTs: serverTimestamp()
  });
}

/** Phone side: append a button-press event. Fire-and-forget. */
export function sendPress(db, room, playerId) {
  return sendEvent(db, room, playerId, 'press');
}

/**
 * Host side: consume events in arrival order.
 * handler receives ({ eventId, type, playerId, clientTs, latencyMs }).
 * Events older than engine start are ignored (protects against replays on host refresh).
 */
export function consumeEvents(db, room, handler) {
  const startedAt = Date.now();
  logTransition('engine', 'idle', 'consuming', `room ${room} @ ${startedAt}`);
  return onChildAdded(ref(db, `sessions/${room}/events`), (snap) => {
    const ev = snap.val() || {};
    const receivedAt = Date.now();
    if ((ev.clientTs || 0) < startedAt - STALE_EVENT_MS) {
      logTransition('engine', 'consuming', 'ignored-stale', snap.key);
      return;
    }
    const latencyMs = ev.clientTs ? receivedAt - ev.clientTs : null;
    handler({ eventId: snap.key, ...ev, receivedAt, latencyMs });
  });
}

/**
 * Host-local authoritative countdown. Not synced to DB by itself —
 * game modes (TR-5+) decide what derived state to publish.
 */
export class Countdown {
  constructor({ durationMs, onTick, onExpire, tickMs = 100 }) {
    this.durationMs = durationMs;
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.tickMs = tickMs;
    this.remainingMs = durationMs;
    this._deadline = null;
    this._interval = null;
    this.state = 'ready'; // ready | running | paused | expired | stopped
  }

  _transition(to, trigger) {
    logTransition('countdown', this.state, to, trigger);
    this.state = to;
  }

  start() {
    if (this.state === 'running') return;
    this._deadline = performance.now() + this.remainingMs;
    this._transition('running', 'start()');
    this._interval = setInterval(() => {
      const left = Math.max(0, this._deadline - performance.now());
      this.remainingMs = left;
      this.onTick?.(left);
      if (left <= 0) {
        clearInterval(this._interval);
        this._transition('expired', 'deadline reached');
        this.onExpire?.();
      }
    }, this.tickMs);
  }

  pause(trigger = 'pause()') {
    if (this.state !== 'running') return;
    clearInterval(this._interval);
    this.remainingMs = Math.max(0, this._deadline - performance.now());
    this._transition('paused', trigger);
  }

  reset(durationMs = this.durationMs, trigger = 'reset()') {
    clearInterval(this._interval);
    this.durationMs = durationMs;
    this.remainingMs = durationMs;
    this._transition('ready', trigger);
  }

  stop(trigger = 'stop()') {
    clearInterval(this._interval);
    this._transition('stopped', trigger);
  }
}
