// Player join + roster (TR-3). Phones write only their own player record.
import { ref, get, set, update, onValue, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

const NAME_MAX = 16;

function storageKey(room) {
  return `tr-player-${room}`;
}

export function validateName(raw, existingNames) {
  const name = (raw || '').trim();
  if (!name) return { ok: false, error: 'Enter a name first.' };
  if (name.length > NAME_MAX) return { ok: false, error: `Keep it under ${NAME_MAX} characters.` };
  const taken = existingNames.some((n) => n.toLowerCase() === name.toLowerCase());
  if (taken) return { ok: false, error: `"${name}" is taken in this room — pick another.` };
  return { ok: true, name };
}

export async function getSession(db, room) {
  const snap = await get(ref(db, `sessions/${room}`));
  return snap.exists() ? snap.val() : null;
}

/** Attempts to restore a previous slot after a page refresh. */
export async function restorePlayer(db, room) {
  const stored = localStorage.getItem(storageKey(room));
  if (!stored) return null;
  const { playerId } = JSON.parse(stored);
  const snap = await get(ref(db, `sessions/${room}/players/${playerId}`));
  if (!snap.exists()) {
    localStorage.removeItem(storageKey(room));
    return null;
  }
  await update(ref(db, `sessions/${room}/players/${playerId}`), { connected: true });
  logTransition('player', 'refreshed', 'restored', `playerId ${playerId} rejoined ${room}`);
  return { playerId, ...snap.val() };
}

/** Joins the room. Caller must have validated the name. */
export async function joinRoom(db, room, name, members = null) {
  const playerId = crypto.randomUUID();
  await set(ref(db, `sessions/${room}/players/${playerId}`), {
    name,
    ...(members && members.length ? { members } : {}),
    joinedAt: serverTimestamp(),
    connected: true,
    state: 'lobby'
  });
  localStorage.setItem(storageKey(room), JSON.stringify({ playerId, name }));
  logTransition('player', 'form', 'joined', `${name} (${playerId}) joined ${room}`);
  return { playerId, name };
}

/** Live roster subscription. cb receives [{playerId, name, ...}] ordered by joinedAt. */
export function watchPlayers(db, room, cb) {
  return onValue(ref(db, `sessions/${room}/players`), (snap) => {
    const val = snap.val() || {};
    const players = Object.entries(val)
      .map(([playerId, p]) => ({ playerId, ...p }))
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    cb(players);
  });
}
