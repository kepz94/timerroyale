// Player (phone) entry point — a dumb remote that only sends button-press events.
import { initFirebase } from './firebase.js';
import { getSession, restorePlayer, joinRoom, validateName, watchPlayers } from './players.js';
import { logTransition } from './session.js';

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();

let currentPlayers = [];

function showJoined(name) {
  el('join-form').hidden = true;
  el('joined-panel').hidden = false;
  el('joined-name').textContent = name;
  el('status').textContent = 'Waiting for the game to start…';
}

async function start() {
  const db = initFirebase();
  if (!room) {
    el('status').textContent = 'No room code — scan the QR on the TV to join.';
    return;
  }
  if (!db) {
    el('status').textContent = 'Firebase not configured.';
    return;
  }
  el('room-banner').textContent = `Room ${room}`;

  const session = await getSession(db, room);
  if (!session) {
    el('status').textContent = `Room ${room} doesn't exist — check the TV and rescan.`;
    logTransition('player-ui', 'loading', 'room-not-found', room);
    return;
  }

  // Refresh restore path
  const restored = await restorePlayer(db, room);
  if (restored) {
    showJoined(restored.name);
    return;
  }

  // Fresh join path
  watchPlayers(db, room, (players) => { currentPlayers = players; });
  el('join-form').hidden = false;
  el('status').textContent = '';
  el('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const check = validateName(el('name-input').value, currentPlayers.map((p) => p.name));
    if (!check.ok) {
      el('join-error').textContent = check.error;
      logTransition('player-ui', 'form', 'rejected', check.error);
      return;
    }
    el('join-error').textContent = '';
    el('join-btn').disabled = true;
    try {
      const { name } = await joinRoom(db, room, check.name);
      showJoined(name);
    } catch (err) {
      el('join-btn').disabled = false;
      el('join-error').textContent = `Couldn't join: ${err.message}`;
    }
  });
}

start();
