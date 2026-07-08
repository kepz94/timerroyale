// Relay round (TR-7). Host-only module.
// Each unit (team or solo) shares one phone; every member attempts back-to-back.
// Unit score = AVERAGE deviation across members. Unfinished at deadline = DNF.
import { ref, set, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export const RELAY_MEMBER_GRACE_MS = 15000;

export function createRelayRound({ db, room, units, targetMs, onTv }) {
  // units: [{unitId, name, members: [names]}]
  let status = 'running'; // running | over
  const slots = new Map(units.map((u) => [u.unitId, {
    unitId: u.unitId,
    name: u.name,
    members: u.members,
    current: 0,               // index of member now attempting
    state: 'waiting',          // waiting | running | between | done | dnf
    startClientTs: null,
    attempts: [],              // [{member, elapsedMs, deviationMs}]
    avgDeviationMs: null
  }]));
  let dnfTimer = null;

  const maxMembers = Math.max(...units.map((u) => u.members.length));

  function snapshot() {
    return Object.fromEntries([...slots.values()].map((s) => [s.unitId, {
      ...s,
      attempts: s.attempts.map((a) => ({ ...a }))
    }]));
  }

  function ranking() {
    return [...slots.values()].filter((s) => s.state === 'done')
      .sort((a, b) => a.avgDeviationMs - b.avgDeviationMs);
  }

  function publicState() {
    return {
      mode: 'relay',
      status,
      targetMs,
      units: snapshot(),
      ranking: status === 'over' ? ranking().map((s) => s.unitId) : null,
      roundWinner: status === 'over' ? (ranking()[0] ?? null) : null
    };
  }

  function publish() {
    return set(ref(db, `sessions/${room}/game`), { ...publicState(), updatedAt: serverTimestamp() });
  }

  function maybeFinish(trigger) {
    const open = [...slots.values()].some((s) => !['done', 'dnf'].includes(s.state));
    if (open || status !== 'running') return;
    status = 'over';
    clearTimeout(dnfTimer);
    publish();
    onTv?.state(publicState());
    const w = ranking()[0];
    logTransition('relay', 'running', 'over',
      `${trigger} — best ${w ? `${w.name} (avg Δ${Math.round(w.avgDeviationMs)}ms)` : 'none'}`);
  }

  function begin() {
    publish();
    onTv?.state(publicState());
    logTransition('relay', 'ready', 'running', `target ${targetMs}ms, ${units.length} units, maxMembers ${maxMembers}`);
    dnfTimer = setTimeout(() => {
      for (const s of slots.values()) {
        if (!['done', 'dnf'].includes(s.state)) {
          logTransition('relay', s.state, 'dnf', `${s.name}: relay deadline`);
          s.state = 'dnf';
        }
      }
      maybeFinish('relay deadline');
    }, maxMembers * (targetMs + RELAY_MEMBER_GRACE_MS));
  }

  function handleEvent(ev) {
    if (status !== 'running' || ev.type !== 'press') return;
    const s = slots.get(ev.playerId); // unit's phone joins as one player record
    if (!s) { logTransition('relay', 'running', 'press-ignored', `event ${ev.eventId}: unknown unit`); return; }
    if (s.state === 'waiting' || s.state === 'between') {
      s.state = 'running';
      s.startClientTs = ev.clientTs;
      s.startHostTs = Date.now();
      publish();
      onTv?.state(publicState());
      logTransition('relay', 'idle', 'member-running', `event ${ev.eventId}: ${s.name}/${s.members[s.current]} started`);
    } else if (s.state === 'running') {
      const elapsedMs = ev.clientTs - s.startClientTs;
      const deviationMs = Math.abs(elapsedMs - targetMs);
      s.attempts.push({ member: s.members[s.current], elapsedMs, deviationMs });
      logTransition('relay', 'member-running', 'member-stopped',
        `event ${ev.eventId}: ${s.name}/${s.members[s.current]} at ${elapsedMs}ms (Δ${deviationMs}ms)`);
      s.current += 1;
      if (s.current >= s.members.length) {
        s.state = 'done';
        s.avgDeviationMs = s.attempts.reduce((sum, a) => sum + a.deviationMs, 0) / s.attempts.length;
        logTransition('relay', 'member-stopped', 'unit-done', `${s.name} avg Δ${Math.round(s.avgDeviationMs)}ms`);
      } else {
        s.state = 'between';
      }
      publish();
      onTv?.state(publicState());
      maybeFinish(`${s.name} finished`);
    } else {
      logTransition('relay', s.state, 'press-ignored', `event ${ev.eventId}: ${s.name} already ${s.state}`);
    }
  }

  return { begin, handleEvent, isOver: () => status === 'over', publicState };
}
