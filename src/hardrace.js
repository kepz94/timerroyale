// Hard Classic RACE TO SAFETY (LMS variant, kepu spec Jul 11). All survivors
// attempt SIMULTANEOUSLY with NO attempt cap: land inside the target's 0.1s
// truncation window and you're SAFE — your spot locks in. The round ends the
// moment only ONE player hasn't hit (that player is the round's eliminee), or
// when every unsafe player has idled out. 30s of inactivity is an idle DNF.
// Publishes to sessions/room/game with every player cycling
// waiting -> running -> waiting (the phone controller works unchanged).
import { ref, set, serverTimestamp } from 'firebase/database';
import { isHardHit } from './resolve.js';
import { logTransition } from './session.js';
import { HARD_IDLE_MS } from './hardclassic.js';

export function createHardRace({ db, room, players, targetMs, onTv, idleMs = HARD_IDLE_MS }) {
  const ids = players.map((p) => p.playerId);
  const nameById = Object.fromEntries(players.map((p) => [p.playerId, p.name]));
  const attempts = Object.fromEntries(ids.map((id) => [id, []]));
  const phase = Object.fromEntries(ids.map((id) => [id, 'waiting'])); // waiting | running | safe | idle
  const startTs = {};
  const startHostTs = {};
  const idleTimers = {};
  const safe = []; // playerIds in hit order
  let status = 'running'; // running | over

  function armIdle(id) {
    clearTimeout(idleTimers[id]);
    idleTimers[id] = setTimeout(() => {
      if (status !== 'running' || phase[id] === 'safe' || phase[id] === 'idle') return;
      phase[id] = 'idle';
      logTransition('hardrace', 'racing', 'idle-dnf', `${nameById[id]}: idle ${idleMs}ms`);
      checkEnd();
      if (status === 'running') emit();
    }, idleMs);
  }
  function clearIdle() { for (const id of ids) clearTimeout(idleTimers[id]); }

  function publicState() {
    const playersOut = {};
    for (const id of ids) {
      const hit = safe.includes(id);
      let st;
      if (status === 'over') st = hit ? 'stopped' : (phase[id] === 'idle' ? 'dnf' : 'out');
      else st = phase[id] === 'safe' ? 'stopped' : phase[id] === 'idle' ? 'dnf' : phase[id];
      const hitAttempt = hit ? attempts[id].find((a) => a.hit) : null;
      playersOut[id] = {
        playerId: id, name: nameById[id], state: st, hit,
        elapsedMs: hitAttempt ? hitAttempt.elapsedMs : null,
        idle: phase[id] === 'idle' || undefined,
        startHostTs: status === 'running' && phase[id] === 'running' ? startHostTs[id] : null,
      };
    }
    return {
      mode: 'hardrace', status, targetMs, hard: true,
      attempts: Object.fromEntries(ids.map((id) => [id, attempts[id].map((a) => ({ ...a }))])),
      safe: [...safe],
      players: playersOut,
      winner: null, // the race has no single winner — it has one loser
    };
  }

  function emit() {
    set(ref(db, `sessions/${room}/game`), { ...publicState(), updatedAt: serverTimestamp() });
    onTv?.state(publicState());
  }

  function checkEnd() {
    if (status !== 'running') return;
    const unsafe = ids.filter((id) => !safe.includes(id));
    const stillRacing = unsafe.filter((id) => phase[id] !== 'idle');
    // Last one in is out — or everyone left has idled away.
    if (unsafe.length <= 1 || stillRacing.length === 0) {
      status = 'over';
      clearIdle();
      logTransition('hardrace', 'running', 'over', `${safe.length} safe, ${unsafe.length} out`);
      emit();
    }
  }

  function begin() {
    logTransition('hardrace', 'ready', 'running', `RACE TO SAFETY target ${targetMs}ms: ${ids.length} players`);
    emit();
    for (const id of ids) armIdle(id);
  }

  function handleEvent(ev) {
    if (status !== 'running' || ev.type !== 'press') return;
    const id = ev.playerId;
    if (!ids.includes(id) || phase[id] === 'safe' || phase[id] === 'idle') return;
    armIdle(id);
    if (phase[id] === 'waiting') {
      phase[id] = 'running'; startTs[id] = ev.clientTs; startHostTs[id] = Date.now();
      emit();
    } else if (phase[id] === 'running') {
      const elapsedMs = ev.clientTs - startTs[id];
      const hit = isHardHit(elapsedMs, targetMs);
      attempts[id].push({ elapsedMs, hit, early: elapsedMs < targetMs });
      phase[id] = hit ? 'safe' : 'waiting';
      if (hit) {
        safe.push(id);
        clearTimeout(idleTimers[id]);
        logTransition('hardrace', 'running', 'safe', `${nameById[id]} locks spot #${safe.length} (${elapsedMs}ms)`);
        checkEnd();
      }
      if (status === 'running') emit();
    }
  }

  return { begin, handleEvent, isOver: () => status === 'over', publicState };
}
