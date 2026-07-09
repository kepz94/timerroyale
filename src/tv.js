// TV gameboard (ADR-004). Route: /tv (creates a lobby, redirects to /tv/CODE)
// or /tv/CODE (shows the board + QR to /play/CODE). Passive display; the host's
// phone (a controller at /play/CODE) drives it. Game menu/cursor + phases land
// in the follow-up TR-47 slice.
import QRCode from 'qrcode';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { createSession, logTransition } from './session.js';
import { watchPlayers } from './players.js';

const el = (id) => document.getElementById(id);
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean); // ['tv'] or ['tv','CODE']
const lobbyId = parts[1] ? parts[1].toUpperCase() : null;

async function boot() {
  if (!lobbyId) {
    const { code } = await createSession(db);
    logTransition('tv', 'boot', 'created', `room ${code}`);
    location.replace(`/tv/${code}`);
    return;
  }
  el('room-code').textContent = lobbyId;
  const joinUrl = `${location.origin}/play/${lobbyId}`;
  el('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  await QRCode.toCanvas(el('qr'), joinUrl, {
    width: 320, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0d0f14', light: '#ffffff' }
  });
  el('status').textContent = 'Waiting for players…';
  logTransition('tv', 'boot', 'lobby', `room ${lobbyId}`);
  watchPlayers(db, lobbyId, (players) => {
    const list = el('player-list');
    list.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = (p.uid ? '⭐ ' : '') + (p.connected === false ? `⚠ ${p.name}` : p.name);
      li.classList.toggle('offline', p.connected === false);
      list.appendChild(li);
    });
    el('players-empty').hidden = players.length > 0;
    el('status').textContent = players.length
      ? `${players.length} in the lobby${players.some((p) => p.uid) ? '' : ' — waiting for a signed-in host'}`
      : 'Waiting for players…';
  });
}
boot();
