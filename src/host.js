// Host (TV) entry point — owns all game state and timing.
import QRCode from 'qrcode';
import { initFirebase } from './firebase.js';
import { createSession, playerJoinUrl, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';
import { createDuel } from './duel.js';

const el = (id) => document.getElementById(id);
let roster = [];
let duel = null;

function renderPlayers(players) {
  roster = players;
  const list = el('player-list');
  list.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.dataset.playerId = p.playerId;
    list.appendChild(li);
  }
  el('players-empty').hidden = players.length > 0;
  if (!duel) {
    el('status').textContent = players.length > 0
      ? `${players.length} player${players.length === 1 ? '' : 's'} in the lobby` +
        (players.length >= 2 ? ` — ${players[0].name} can start the duel` : '')
      : 'Waiting for players…';
  }
}

function flashChip(playerId) {
  const chip = document.querySelector(`#player-list li[data-player-id="${playerId}"]`);
  if (chip) {
    chip.classList.remove('flash');
    void chip.offsetWidth;
    chip.classList.add('flash');
  }
}

function showGameView(show) {
  el('game-panel').hidden = !show;
  document.querySelector('.join-panel').hidden = show;
  document.querySelector('.players-panel').hidden = show;
}

const tv = {
  tick(remainingMs) {
    const d = el('timer-digits');
    d.textContent = (remainingMs / 1000).toFixed(1);
    d.classList.toggle('warn', remainingMs <= 10000 && remainingMs > 5000);
    d.classList.toggle('danger', remainingMs <= 5000);
  },
  state(g) {
    const chips = el('duel-chips');
    chips.innerHTML = '';
    for (const p of g.duelists) {
      const div = document.createElement('div');
      div.className = 'duel-chip';
      div.textContent = p.name;
      if (g.status === 'playing' && p.playerId === g.activePlayerId) div.classList.add('active');
      if (g.status === 'over' && p.playerId === g.winner?.playerId) div.classList.add('winner');
      if (g.status === 'over' && p.playerId === g.loser?.playerId) div.classList.add('loser');
      chips.appendChild(div);
    }
    if (g.status === 'playing') {
      const active = g.duelists.find((p) => p.playerId === g.activePlayerId);
      el('game-msg').textContent = `${active.name} — press before it hits zero!`;
    } else if (g.status === 'over') {
      el('timer-digits').textContent = '0.0';
      el('game-msg').textContent = `🏆 ${g.winner.name} wins! Rematch from your phones.`;
    }
  }
};

function startDuel(trigger) {
  const duelists = roster.slice(0, 2).map(({ playerId, name }) => ({ playerId, name }));
  const startIdx = duel ? 1 - duel.getStartIdx() : 0; // rematch swaps who starts
  duel = createDuel({ db: window.__db, room: window.__room, duelists, startIdx, onTv: tv });
  showGameView(true);
  el('status').textContent = 'Duel in progress';
  duel.begin();
  logTransition('host-ui', 'lobby-open', 'duel-started', trigger);
}

async function startLobby() {
  const db = initFirebase();
  if (!db) {
    el('status').textContent = 'Firebase not configured.';
    return;
  }
  try {
    const { code } = await createSession(db);
    window.__db = db;
    window.__room = code;
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

    window.__pressLog = [];
    consumeEvents(db, code, (ev) => {
      if (ev.type === 'press') {
        window.__pressLog.push({ eventId: ev.eventId, playerId: ev.playerId, latencyMs: ev.latencyMs });
      }
      if (ev.type === 'press' && !duel) { flashChip(ev.playerId); return; }
      if (ev.type === 'start' && !duel && roster.length >= 2 && ev.playerId === roster[0].playerId) {
        startDuel(`start event ${ev.eventId} from captain`);
        return;
      }
      if (ev.type === 'rematch' && duel?.isOver()) {
        startDuel(`rematch event ${ev.eventId} from ${ev.playerId}`);
        return;
      }
      duel?.handleEvent(ev);
    });
  } catch (err) {
    el('status').textContent = `Could not create room: ${err.message}`;
    logTransition('host-ui', 'creating', 'error', err.message);
  }
}

startLobby();
