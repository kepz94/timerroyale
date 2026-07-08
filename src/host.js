// Host (TV) entry point — owns all game state and timing.
import QRCode from 'qrcode';
import { initFirebase } from './firebase.js';
import { createSession, playerJoinUrl, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';

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

    // TR-4: react to phone button presses (lobby demo = flash the presser's chip)
    window.__pressLog = [];
    consumeEvents(db, code, (ev) => {
      if (ev.type !== 'press') return;
      logTransition('host-ui', 'lobby-open', 'press-received',
        `event ${ev.eventId} from ${ev.playerId} (latency ${ev.latencyMs}ms)`);
      window.__pressLog.push({ eventId: ev.eventId, playerId: ev.playerId, latencyMs: ev.latencyMs });
      const chip = document.querySelector(`#player-list li[data-player-id="${ev.playerId}"]`);
      if (chip) {
        chip.classList.remove('flash');
        void chip.offsetWidth; // restart animation
        chip.classList.add('flash');
      }
    });
  } catch (err) {
    el('status').textContent = `Could not create room: ${err.message}`;
    logTransition('host-ui', 'creating', 'error', err.message);
  }
}

startLobby();
