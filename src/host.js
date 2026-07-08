// Host (TV) entry point — owns all game state and timing.
import QRCode from 'qrcode';
import { initFirebase } from './firebase.js';
import { createSession, playerJoinUrl, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';
import { createRound, randomTarget } from './round.js';
import { createMatch, clearMatch } from './elimination.js';
import { createTeamMatch } from './teammatch.js';

const el = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1);
let roster = [];
let round = null;
let match = null;
let rafId = null;

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
  if (!round) {
    el('status').textContent = players.length > 0
      ? `${players.length} player${players.length === 1 ? '' : 's'} in the lobby` +
        (players.length >= 2 ? ` — ${players[0].name} can start a round` : '')
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

// Live TV rendering. Running timers are display-only (host clock baseline);
// scoring always comes from the round engine's client-clock deltas.
let lastState = null;
function renderRelayRows(g) {
  const rows = el('round-rows');
  rows.innerHTML = '';
  const order = g.status === 'over' && g.ranking
    ? g.ranking.concat(Object.keys(g.units).filter((id) => !g.ranking.includes(id)))
    : Object.keys(g.units);
  order.forEach((unitId) => {
    const s = g.units[unitId];
    const li = document.createElement('li');
    const stateCls = s.state === 'done' ? 'stopped' : s.state === 'dnf' ? 'dnf' : s.state === 'running' ? 'running' : 'waiting';
    li.className = `round-row ${stateCls}`;
    li.dataset.playerId = unitId;
    const progress = `${(s.attempts || []).length}/${s.members.length}`;
    let time;
    if (s.state === 'done') time = `avg Δ ${fmt(s.avgDeviationMs)}s`;
    else if (s.state === 'dnf') time = 'DNF';
    else if (s.state === 'running') time = `${s.members[s.current]}: <span class="live-timer">0.0</span>s`;
    else if (s.state === 'between') time = `pass to ${s.members[s.current]}`;
    else time = '—';
    const medal = g.status === 'over' && g.ranking?.[0] === unitId ? '🥇 ' : '';
    li.innerHTML = `<span class="row-name">${medal}${s.name} <small>${progress}</small></span><span class="row-time">${time}</span>`;
    rows.appendChild(li);
  });
  if (g.status === 'running') {
    el('game-msg').textContent = 'Relay! Every member takes a turn — pass the phone!';
  } else if (g.status === 'over') {
    el('game-msg').textContent = g.roundWinner
      ? `🥇 ${g.roundWinner.name} takes the round (avg Δ ${fmt(g.roundWinner.avgDeviationMs)}s)`
      : 'Nobody finished the relay!';
  }
}

const tv = {
  state(g) {
    lastState = g;
    el('target-digits').innerHTML = `${fmt(g.targetMs)}<span class="timer-unit">s</span>`;
    if (g.mode === 'relay') { renderRelayRows(g); return; }
    const rows = el('round-rows');
    rows.innerHTML = '';
    const order = g.status === 'over' && g.ranking
      ? g.ranking.concat(Object.keys(g.players).filter((id) => !g.ranking.includes(id)))
      : Object.keys(g.players);
    order.forEach((playerId, i) => {
      const s = g.players[playerId];
      const li = document.createElement('li');
      li.className = `round-row ${s.state}`;
      li.dataset.playerId = playerId;
      const timer = s.state === 'stopped'
        ? `${fmt(s.elapsedMs)}s <span class="deviation">Δ ${fmt(s.deviationMs)}s</span>`
        : s.state === 'dnf' ? 'DNF'
        : s.state === 'running' ? `<span class="live-timer">0.0</span>s`
        : '—';
      const medal = g.status === 'over' && g.ranking?.[0] === playerId ? '🏆 ' : '';
      li.innerHTML = `<span class="row-name">${medal}${s.name}</span><span class="row-time">${timer}</span>`;
      rows.appendChild(li);
    });
    if (g.status === 'running') {
      el('game-msg').textContent = 'Tap to start your timer, tap again to stop it — land on the target!';
    } else if (g.status === 'over') {
      el('game-msg').textContent = g.winner
        ? `🏆 ${g.winner.name} wins — ${fmt(g.winner.elapsedMs)}s (Δ ${fmt(g.winner.deviationMs)}s). Next round from your phones!`
        : 'Nobody finished — next round from your phones!';
    }
  }
};

function tickLiveTimers() {
  if (lastState?.status === 'running') {
    const slots = lastState.mode === 'relay' ? lastState.units : lastState.players;
    for (const [id, s] of Object.entries(slots || {})) {
      if (s.state !== 'running') continue;
      const span = document.querySelector(`.round-row[data-player-id="${id}"] .live-timer`);
      if (span) span.textContent = fmt(Date.now() - s.startHostTs);
    }
  }
  rafId = requestAnimationFrame(tickLiveTimers);
}

function startRound(trigger) {
  const players = roster.map(({ playerId, name }) => ({ playerId, name }));
  match = null;
  clearMatch(window.__db, window.__room);
  el('match-banner').textContent = '';
  el('standings').innerHTML = '';
  round = createRound({ db: window.__db, room: window.__room, players, targetMs: randomTarget(), onTv: tv });
  showGameView(true);
  el('status').textContent = 'Round in progress';
  round.begin();
  logTransition('host-ui', 'lobby-open', 'round-started', trigger);
}

function renderMatch(m, justOut) {
  el('match-banner').textContent = m.status === 'champion'
    ? '👑 CHAMPION 👑'
    : `Elimination — Round ${m.roundNum}`;
  const standings = el('standings');
  standings.innerHTML = '';
  for (const [playerId, name] of Object.entries(m.alive || {})) {
    const li = document.createElement('li');
    li.className = 'standing alive';
    li.textContent = name;
    standings.appendChild(li);
  }
  for (const e of [...(m.eliminated || [])].reverse()) {
    const li = document.createElement('li');
    li.className = 'standing out';
    li.textContent = `${e.name} — out R${e.round}`;
    standings.appendChild(li);
  }
  if (m.status === 'champion') {
    el('game-msg').textContent = `👑 ${m.champion.name} is the last one standing!`;
  } else if (m.status === 'between') {
    const names = justOut.map((s) => s.name).join(', ');
    el('game-msg').textContent = (names ? `💀 ${names} eliminated! ` : 'Nobody eliminated — replay! ')
      + `${Object.keys(m.alive).length} remain. Captain: next round!`;
  }
}

function renderTeamMatch(m, roundState) {
  el('match-banner').textContent = m.status === 'final'
    ? '🏆 FINAL STANDINGS'
    : `Team match — Round ${m.roundNum}/${m.rounds}`;
  const standings = el('standings');
  standings.innerHTML = '';
  (m.leaderboard || []).forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'standing alive';
    li.textContent = `${i + 1}. ${t.name} — ${t.points} pts`;
    standings.appendChild(li);
  });
  if (m.status === 'final') {
    el('game-msg').textContent = `🏆 ${m.winner.name} wins the series with ${m.winner.points} points!`;
  } else if (m.status === 'between') {
    el('game-msg').textContent = `Round ${m.roundNum} scored. Captain: next round!`;
  }
}

function startTeamMatch(trigger) {
  const units = roster.map((p) => ({ unitId: p.playerId, name: p.name, members: p.members || [p.name] }));
  round = null;
  match = createTeamMatch({ db: window.__db, room: window.__room, units, onTv: tv, onMatch: renderTeamMatch });
  showGameView(true);
  el('status').textContent = 'Team match';
  match.nextRound();
  logTransition('host-ui', 'lobby-open', 'teammatch-started', trigger);
}

function startMatch(trigger) {
  const players = roster.map(({ playerId, name }) => ({ playerId, name }));
  round = null;
  match = createMatch({ db: window.__db, room: window.__room, players, onTv: tv, onMatch: renderMatch });
  showGameView(true);
  el('status').textContent = 'Elimination match';
  match.nextRound();
  logTransition('host-ui', 'lobby-open', 'match-started', trigger);
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
    tickLiveTimers();

    window.__pressLog = [];
    consumeEvents(db, code, (ev) => {
      if (ev.type === 'press') {
        window.__pressLog.push({ eventId: ev.eventId, playerId: ev.playerId, latencyMs: ev.latencyMs });
      }
      if (ev.type === 'press' && !round && !match) { flashChip(ev.playerId); return; }
      const isCaptain = roster.length >= 2 && ev.playerId === roster[0]?.playerId;
      if (ev.type === 'start-elim' && isCaptain && !match && (!round || round.isOver())) {
        startMatch(`start-elim event ${ev.eventId} from captain`);
        return;
      }
      if (ev.type === 'start-teams' && isCaptain && !match && (!round || round.isOver())) {
        startTeamMatch(`start-teams event ${ev.eventId} from captain`);
        return;
      }
      if (ev.type === 'start' && isCaptain) {
        if (match?.isBetween()) { match.nextRound(); return; }
        if (match?.isChampion?.() || match?.isFinal?.() || (!match && (!round || round.isOver()))) {
          startRound(`start event ${ev.eventId} from captain`);
          return;
        }
      }
      if (match) { match.handleEvent(ev); return; }
      round?.handleEvent(ev);
    });
  } catch (err) {
    el('status').textContent = `Could not create room: ${err.message}`;
    logTransition('host-ui', 'creating', 'error', err.message);
  }
}

startLobby();
