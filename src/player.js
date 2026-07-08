// Player (phone) entry point — a dumb remote that only sends button-press events.
import { initFirebase } from './firebase.js';

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();

const db = initFirebase();
const status = document.getElementById('status');

if (!room) {
  status.textContent = 'No room code — scan the QR on the TV to join.';
} else if (db) {
  // Full join flow lands in TR-3; TR-2 confirms the QR routes here with the room.
  status.textContent = `Room ${room} found — joining arrives in the next update.`;
  document.getElementById('room-banner').textContent = `Room ${room}`;
} else {
  status.textContent = 'Firebase not configured.';
}
