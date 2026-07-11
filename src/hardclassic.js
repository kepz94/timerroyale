// Hard Classic RACE round (PLAN-TR-TEAMS-v1 Stage 1, ADR-005). Worth ONE ledger
// dot. Both representatives attempt SIMULTANEOUSLY: first to land inside the
// target's 0.1s truncation window wins INSTANTLY, regardless of the opponent's
// attempt state. Each rep has HARD_ATTEMPT_CAP attempts; one washout does NOT
// end the race (the other keeps trying); a double washout goes to the closest
// single attempt across both logs (an exact tie voids -> caller reruns).
// 30s of inactivity is an idle DNF: the opponent takes the dot instantly.
// Publishes to sessions/room/game with BOTH reps in `players` (each cycles
// waiting -> running -> waiting), so both phones keep a live start/stop button.
import { ref, set, serverTimestamp } from 'firebase/database';
import { isHardHit, resolveHard, HARD_ATTEMPT_CAP } from './resolve.js';
import { logTransition } from './session.js';

export const HARD_IDLE_MS = 30000; // the Stage 1 universal idle rule

/** Single-decimal target between 0.5s and 3.0s (e.g. 1.5s, 2.5s). */
export function randomHardTarget() {
  return Math.round((500 + Math.random() * 2500) / 100) * 100;
}

export function createHardRound({ db, room, repA, repB, targetMs, onTv, onResult, idleMs = HARD_IDLE_MS }) {
  const ids = [repA.playerId, repB.playerId];
  const nameById = { [repA.playerId]: repA.name, [repB.playerId]: repB.name };
  const attempts = { [repA.playerId]: [], [repB.playerId]: [] };
  const phase = { [repA.playerId]: 'waiting', [repB.playerId]: 'waiting' }; // waiting | running | washed
  const startTs = {};
  const startHostTs = {};
  const idleTimers = {};
  let status = 'running'; // running | over
  let winnerId = null;

  const otherId = (id) => (id === ids[0] ? ids[1] : ids[0]);

  function armIdle(id) {
    clearTimeout(idleTimers[id]);
    idleTimers[id] = setTimeout(() => {
      if (status !== 'running' || phase[id] === 'washed') return;
      logTransition('hard', phase[id], 'idle-dnf', `${nameById[id]}: idle ${idleMs}ms -> ${nameById[otherId(id)]} wins`);
      finish(otherId(id));
    }, idleMs);
  }

  function clearIdle() {
    for (const id of ids) clearTimeout(idleTimers[id]);
  }

  function publicState() {
    const players = {};
    for (const id of ids) {
      const st = status === 'over'
        ? (id === winnerId ? 'stopped' : 'dnf')
        : (phase[id] === 'washed' ? 'dnf' : phase[id]);
      players[id] = {
        playerId: id, name: nameById[id], state: st,
        startHostTs: status === 'running' && phase[id] === 'running' ? startHostTs[id] : null,
      };
    }
    return {
      mode: 'hard', status, targetMs, hard: true, race: true,
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
    if (status !== 'running') return;
    status = 'over'; winnerId = wid;
    clearIdle();
    logTransition('hard', 'running', 'over', `winner ${wid ? nameById[wid] : 'none (void)'}`);
    emit();
    onResult?.(wid, publicState());
  }

  function begin() {
    logTransition('hard', 'ready', 'running', `RACE target ${targetMs}ms: ${repA.name} vs ${repB.name}`);
    emit();
    for (const id of ids) armIdle(id);
  }

  function handleEvent(ev) {
    if (status !== 'running' || ev.type !== 'press') return;
    const id = ev.playerId;
    if (!ids.includes(id) || phase[id] === 'washed') return;
    armIdle(id);
    if (phase[id] === 'waiting') {
      phase[id] = 'running'; startTs[id] = ev.clientTs; startHostTs[id] = Date.now();
      logTransition('hard', 'waiting', 'running', `${nameById[id]} attempt ${attempts[id].length + 1} started`);
      emit();
    } else if (phase[id] === 'running') {
      const elapsedMs = ev.clientTs - startTs[id];
      const hit = isHardHit(elapsedMs, targetMs);
      attempts[id].push({ elapsedMs, hit, early: elapsedMs < targetMs });
      phase[id] = 'waiting';
      logTransition('hard', 'running', hit ? 'hit' : 'miss', `${nameById[id]} ${elapsedMs}ms (attempt ${attempts[id].length})`);
      if (hit) { finish(id); return; } // first clean hit wins the race instantly
      if (attempts[id].length >= HARD_ATTEMPT_CAP) {
        phase[id] = 'washed';
        clearTimeout(idleTimers[id]);
        logTransition('hard', 'miss', 'washout', `${nameById[id]} washed ${HARD_ATTEMPT_CAP} attempts`);
        if (ids.every((x) => phase[x] === 'washed')) {
          // Double washout: closest single attempt across both logs; tie voids.
          const r = resolveHard({
            target: targetMs,
            aAttempts: attempts[repA.playerId].map((a) => a.elapsedMs),
            bAttempts: attempts[repB.playerId].map((a) => a.elapsedMs),
            aId: repA.playerId, bId: repB.playerId,
          });
          finish(r.winnerId); // null on an exact washout tie -> caller reruns
          return;
        }
      }
      emit();
    }
  }

  return { begin, handleEvent, isOver: () => status === 'over', publicState };
}
