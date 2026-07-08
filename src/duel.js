// Classic duel (TR-5). Host-only module.
// One shared countdown. Active player presses to pass. Holder at 0 loses.
import { ref, set, serverTimestamp } from 'firebase/database';
import { Countdown } from './engine.js';
import { logTransition } from './session.js';

export const DUEL_DURATION_MS = 30000;

/**
 * duelists: [{playerId, name}, {playerId, name}]
 * onTv: { tick(remainingMs), state(gameState) } — host-local render hooks.
 */
export function createDuel({ db, room, duelists, durationMs = DUEL_DURATION_MS, startIdx = 0, onTv }) {
  let activeIdx = startIdx;
  let status = 'playing';
  let winner = null;
  let loser = null;

  const countdown = new Countdown({
    durationMs,
    tickMs: 100,
    onTick: (left) => onTv?.tick(left),
    onExpire: () => end('countdown expired')
  });

  function gameState() {
    return {
      mode: 'duel',
      status,
      duelists,
      activePlayerId: status === 'playing' ? duelists[activeIdx].playerId : null,
      winner,
      loser,
      updatedAt: serverTimestamp()
    };
  }

  function publish() {
    // set (not update): each publish is the complete authoritative state.
    return set(ref(db, `sessions/${room}/game`), gameState());
  }

  function begin() {
    countdown.start();
    publish();
    onTv?.state(gameState());
    logTransition('duel', 'ready', 'playing', `${duelists[activeIdx].name} starts, ${durationMs}ms on the clock`);
  }

  function end(trigger) {
    if (status !== 'playing') return;
    status = 'over';
    loser = duelists[activeIdx];
    winner = duelists[1 - activeIdx];
    countdown.stop(trigger);
    publish();
    onTv?.state(gameState());
    logTransition('duel', 'playing', 'over', `${trigger} — ${loser.name} loses, ${winner.name} wins`);
  }

  function handleEvent(ev) {
    if (status !== 'playing' || ev.type !== 'press') return;
    if (ev.playerId !== duelists[activeIdx].playerId) {
      logTransition('duel', 'playing', 'press-ignored', `event ${ev.eventId}: not active player`);
      return;
    }
    activeIdx = 1 - activeIdx;
    publish();
    onTv?.state(gameState());
    logTransition('duel', 'playing', 'turn-passed', `event ${ev.eventId} -> ${duelists[activeIdx].name} active`);
  }

  return {
    begin,
    handleEvent,
    isOver: () => status === 'over',
    getStartIdx: () => startIdx,
    remainingMs: () => countdown.remainingMs
  };
}
