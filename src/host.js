// Host (TV) entry point — owns all game state and timing.
import QRCode from 'qrcode';
import { initFirebase } from './firebase.js';
import { createSession, playerJoinUrl, logTransition } from './session.js';
import { watchPlayers } from './players.js';

const el = (id) => document.getElementById(id);

function renderPlayers(players) {
  const list = el('player-list');
  list.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.dataset.playerId = p.playerId;
    list.appendChild(li);
  }
  el('players-empty').hidden = players.length > 0;
  el('status').textContent = players.length > 0
    ? `${players.length} player${players.length === 1 ? '' : 's'} in the lobby`
    : 'Waiting for players…';
}

async function startLobby() {
  const db = initFirebase();
  if (!db) {
    el('status').textContent = 'Firebase not configured.';
    return;
  }
  try {
    const { code } = await createSession(db);
    const url = playerJoinUrl(code);

    el('room-code').textContent = code;
    el('join-url').textContent = url.replace(/^https?:\/\//, '');
    await QRCode.toCanvas(el('qr'), url, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0d0f14', light: '#ffffff' }
    });
    el('status').textContent = 'Waiting for players…';
    logTransition('host-ui', 'creating', 'lobby-open', `room ${code} displayed`);

    watchPlayers(db, code, renderPlayers);
  } catch (err) {
    el('status').textContent = `Could not create room: ${err.message}`;
    logTransition('host-ui', 'creating', 'error', err.message);
  }
}

startLobby();
