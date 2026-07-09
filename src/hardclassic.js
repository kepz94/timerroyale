// Hard Classic retry-loop round (TR-52 §5). Worth ONE ledger dot. Two
// representatives take the hot seat in turn: the active rep retries (up to
// HARD_ATTEMPT_CAP) to land inside the target's 0.1s truncation window. First
// clean hit wins; if rep A washes out all 13, rep B gets 13; if BOTH wash out,
// the closest single attempt across both logs takes the dot (an exact tie voids).
// Publishes to sessions/room/game with the SAME shape the existing phone
// controller reads (players[activeId].state cycles waiting->running->waiting),
// so the start/stop button re-arms itself after every miss with no phone change.
import { ref, set, serverTimestamp } from 'firebase/database';
import { isHardHit, resolveHard, HARD_ATTEMPT_CAP } from './resolve.js';
import { logTransition } from './session.js';

/** Single-decimal target between 0.5s and 3.0s (e.g. 1.5s, 2.5s). */
export function randomHardTarget() {
  return Math.round((500 + Math.random() * 2500) / 100) * 100;
}

export function createHardRound({ db, room, repA, repB, targetMs, onTv, onResult }) {
  const ids = [repA.playerId, repB.playerId];
  const nameById = { [repA.playerId]: repA.name, [repB.playerId]: repB.name };
  const attempts = { [repA.playerId]: [], [repB.playerId]: [] };
  let activeId = repA.playerId;
  let phase = 'waiting'; // waiting | running (of the active rep's current attempt)
  let startTs = null;
  let startHostTs = null; // host-clock baseline for the live TV clock
  let status = 'running'; // running | over
  let winnerId = null;

  function publicState() {
    // Only the ACTIVE rep is in `players` while running, so the other rep's
    // phone shows "watching / you're up soon". On over, both are listed.
    const players = {};
    if (status === 'running') {
      players[activeId] = { playerId: activeId, name: nameById[activeId], state: phase, startHostTs: phase === 'running' ? startHostTs : null };
    } else {
      for (const id of ids) players[id] = { playerId: id, name: nameById[id], state: id === winnerId ? 'stopped' : 'dnf' };
    }
    return {
      mode: 'hard', status, targetMs, hard: true,
      activeId: status === 'running' ? activeId : null,
      activeName: status === 'running' ? nameById[activeId] : null,
      attempts: {
        [repA.playerId]: attempts[repA.playerId].map((a) => ({ ...a })),
        [repB.playerId]: attempts[repB.playerId].map((a) => ({ ...a })),
      },
      repA: { playerId: repA.playerId, name: repA.name },
      repB: { playerId: repB.playerId, name: repB.name },
      players,
      winner: status === 'over' && winnerId ? { playerId: winnerId, name: nameById[winnerId] } : null,
    };
  }

  function emit() {
    set(ref(db, `sessions/${room}/game`), { ...publicState(), updatedAt: serverTimestamp() });
    onTv?.state(publicState());
  }

  function finish(wid) {
    status = 'over'; winnerId = wid;
    logTransition('hard', 'running', 'over', `winner ${wid ? nameById[wid] : 'none (void)'}`);
    emit();
    onResult?.(wid, publicState());
  }

  function begin() {
    logTransition('hard', 'ready', 'running', `target ${targetMs}ms, ${repA.name} first`);
    emit();
  }

  function handleEvent(ev) {
    if (status !== 'running' || ev.type !== 'press' || ev.playerId !== activeId) return;
    if (phase === 'waiting') {
      phase = 'running'; startTs = ev.clientTs; startHostTs = Date.now(); emit();
      logTransition('hard', 'waiting', 'running', `${nameById[activeId]} attempt ${attempts[activeId].length + 1} started`);
    } else if (phase === 'running') {
      const elapsedMs = ev.clientTs - startTs;
      const hit = isHardHit(elapsedMs, targetMs);
      attempts[activeId].push({ elapsedMs, hit, early: elapsedMs < targetMs });
      phase = 'waiting';
      logTransition('hard', 'running', hit ? 'hit' : 'miss', `${nameById[activeId]} ${elapsedMs}ms (attempt ${attempts[activeId].length})`);
      if (hit) { finish(activeId); return; }
      if (attempts[activeId].length >= HARD_ATTEMPT_CAP) {
        if (activeId === repA.playerId) {
          activeId = repB.playerId; phase = 'waiting';
          logTransition('hard', 'washout', 'switch', `${repA.name} washed ${HARD_ATTEMPT_CAP} -> ${repB.name}`);
          emit();
        } else {
          const r = resolveHard({
            target: targetMs,
            aAttempts: attempts[repA.playerId].map((a) => a.elapsedMs),
            bAttempts: attempts[repB.playerId].map((a) => a.elapsedMs),
            aId: repA.playerId, bId: repB.playerId,
          });
          finish(r.winnerId); // null on an exact washout tie -> caller treats as void
        }
      } else { emit(); }
    }
  }

  return { begin, handleEvent, isOver: () => status === 'over', publicState };
}
