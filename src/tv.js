// TV gameboard (ADR-004). Phase 1 highlight-menu (D-Pad). Phase 2/3: PvE
// (KOTH/LMS) and PvP/Teams tournaments launch on the TV; phones send press,
// host paces rounds with Next Round. TR-52: the party tournament hierarchy runs
// through tournament.js — a GAME is first to 5 round-wins, a MATCH is Best-of-5
// games (first to 3), matches alternate on the board after each completed game
// during a tier, and Grand Finals Mode locks onto the final two teams.
import QRCode from 'qrcode';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { createSession, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';
import { validatePool, validateCategory, ENVIRONMENTS, KOTH_THRESHOLDS } from './hostconfig.js';
import { createKoth } from './koth.js';
import { createMatch as createElim } from './elimination.js';
import { createBracket, reportGameWin, activeMatches, isComplete, roundLabel } from './bracket.js';
import { createTournament, ROUNDS_TO_WIN_GAME } from './tournament.js';
import { CLASSIC_CUTOFF_MS } from './resolve.js';
import { createTeamGame, distributeTeams } from './teamgame.js';
import { createDraftState, applyPick, autoPick, draftTeams } from './draft.js';
import { ref as dbRef, set as dbSet } from 'firebase/database';
import { fmtOff, fmtS2, fmtS, fmtSigned } from './format.js';

const el = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1);
// TR-52 precision: Classic/Guess targets render to 2 decimals, Hard to 1.
const fmtTarget = (g) => (g.hard ? fmt(g.targetMs) : fmtS2(g.targetMs));
// Ledger-dot strip for a game score (filled / empty out of ROUNDS_TO_WIN_GAME).
const dots = (won, filled, empty) => filled.repeat(Math.min(won, ROUNDS_TO_WIN_GAME)) + empty.repeat(Math.max(0, ROUNDS_TO_WIN_GAME - won));
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean);
const lobbyId = parts[1] ? parts[1].toUpperCase() : null;

let players = [];
let hostId = null;
let inGame = false;    // true once a game/tournament starts (gates the menu)
let engine = null;     // active round-composing engine (koth/elim/per-match koth)
let tourney = null;    // TR-52 tournament scheduler (PvP/Teams)
let bracket = null;    // tourney.bracket (kept for the TV bracket render)
let curMatch = null;
let isTeams = false;
let draftState = null;
let pickDeadline = 0;
let draftClock = null;

/* ---------------- Phase 1: highlight menu ---------------- */
const config = { pool: { classic: true, hard: false, guess: false }, category: null, pveMode: 'koth', kothN: 5, numTeams: 2 };
let stack = ['main'];
let focus = 0;
const pop = () => { if (stack.length > 1) { stack.pop(); focus = 0; } };
const togglePve = () => { config.pveMode = config.pveMode === 'koth' ? 'lms' : 'koth'; };
const cycleKoth = (d) => { const i = KOTH_THRESHOLDS.indexOf(config.kothN); config.kothN = KOTH_THRESHOLDS[Math.min(KOTH_THRESHOLDS.length - 1, Math.max(0, i + d))]; };

const screens = {
  main: () => [
    { label: '▸ Game Pool', enter: 'pool' },
    { label: `▸ Category${config.category ? ':  ' + config.category.toUpperCase() : ''}`, enter: 'category' },
    { label: '▶ START GAME', onSelect: startGame }
  ],
  pool: () => [
    { label: `Classic       [${config.pool.classic ? '✓' : ' '}]`, onSelect: () => (config.pool.classic = !config.pool.classic) },
    { label: `Hard Classic  [${config.pool.hard ? '✓' : ' '}]`, onSelect: () => (config.pool.hard = !config.pool.hard) },
    { label: `Guess Timer   [${config.pool.guess ? '✓' : ' '}]`, onSelect: () => (config.pool.guess = !config.pool.guess) },
    { label: '◂ Back', onSelect: pop }
  ],
  category: () => [
    { label: `PvE Arcade ▸${config.category === 'pve' ? '  ✓' : ''}`, onSelect: () => (config.category = 'pve'), enter: 'pve' },
    { label: `PvP Tournament${config.category === 'pvp' ? '  ✓' : ''}`, onSelect: () => (config.category = 'pvp') },
    { label: `Teams Tournament ▸${config.category === 'teams' ? '  ✓' : ''}`, onSelect: () => (config.category = 'teams'), enter: 'teams' },
    { label: '◂ Back', onSelect: pop }
  ],
  pve: () => [
    { label: `Mode:  ${config.pveMode === 'koth' ? 'King of the Hill' : 'Last Man Standing'}   ◀ ▶`, onLeft: togglePve, onRight: togglePve },
    { label: `KOTH:  First to ${config.kothN}   ◀ ▶`, onLeft: () => cycleKoth(-1), onRight: () => cycleKoth(1) },
    { label: '◂ Back', onSelect: pop }
  ],
  teams: () => [
    { label: `# Teams:  ${config.numTeams}   ◀ ▶`, onLeft: () => (config.numTeams = Math.max(2, config.numTeams - 1)), onRight: () => (config.numTeams = Math.min(Math.max(2, activePlayers().length), config.numTeams + 1)) },
    { label: '◂ Back', onSelect: pop }
  ]
};

function onNav(dir) {
  const items = screens[stack[stack.length - 1]]();
  if (dir === 'up') focus = (focus - 1 + items.length) % items.length;
  else if (dir === 'down') focus = (focus + 1) % items.length;
  else if (dir === 'left') items[focus].onLeft?.();
  else if (dir === 'right') items[focus].onRight?.();
  else if (dir === 'select') { const it = items[focus]; it.onSelect?.(); if (it.enter) { stack.push(it.enter); focus = 0; } }
  else if (dir === 'back') pop();
  render();
}

const menuMsg = (t) => (el('tv-menu-msg').textContent = t);

function render() {
  const menu = el('tv-menu');
  if (!hostId || inGame) { menu.hidden = true; return; }
  menu.hidden = false;
  const items = screens[stack[stack.length - 1]]();
  if (focus >= items.length) focus = items.length - 1;
  const list = el('tv-menu-list');
  list.innerHTML = '';
  items.forEach((it, i) => { const li = document.createElement('li'); li.textContent = it.label; if (i === focus) li.classList.add('focused'); list.appendChild(li); });
}

/* ---------------- launch ---------------- */
const activePlayers = () => players.filter((p) => p.connected !== false).map(({ playerId, name, members }) => ({ playerId, name, members }));

function startGame() {
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  const pc = activePlayers().length;
  const pv = validatePool(ENVIRONMENTS.PARTY, pool);
  if (!pv.ok) return menuMsg(pv.reason);
  if (!config.category) return menuMsg('Pick a category first.');
  const cv = validateCategory(config.category, pc);
  if (!cv.ok) return menuMsg(cv.reason);
  if (config.category === 'pve') return launchPve();
  if (config.category === 'pvp') return launchPvp();
  if (config.category === 'teams') return launchTeams();
}

function showGame(on) {
  inGame = on;
  el('tv-game').hidden = !on;
  el('tv-menu').hidden = on || !hostId;
  document.querySelector('.join-panel').hidden = on;
  document.querySelector('.players-panel').hidden = on;
  el('status').hidden = on;
}

/* ---- PvE ---- */
function launchPve() {
  const hard = !!config.pool.hard;
  const roster = activePlayers();
  showGame(true);
  el('tv-match-banner').textContent = config.pveMode === 'koth' ? `King of the Hill — first to ${config.kothN}${hard ? ' 🔥' : ''}` : 'Last Man Standing';
  engine = config.pveMode === 'koth'
    ? createKoth({ db, room: lobbyId, players: roster, n: config.kothN, hard, onTv: { state: renderRound }, onMatch: renderKoth })
    : createElim({ db, room: lobbyId, players: roster, onTv: { state: renderRound }, onMatch: renderElim });
  logTransition('tv', 'setup', 'pve-launch', `${config.pveMode} players=${roster.length}`);
  engine.nextRound();
}

/* ---- PvP single-elim tournament (TR-52 hierarchy) ---- */
function launchPvp() {
  const ents = activePlayers().map((p) => ({ id: p.playerId, name: p.name }));
  tourney = createTournament(ents); // MATCH = Best of 5 games (first to 3)
  bracket = tourney.bracket;
  showGame(true);
  logTransition('tv', 'setup', 'pvp-launch', `${ents.length} players`);
  nextTourneyGame();
}

// Rotate onto the next game per the Match Rotation Loop / Grand Finals lock.
function nextTourneyGame() {
  engine = null;
  if (tourney.isComplete()) {
    renderBracket();
    renderChampion(bracket.champion);
    dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'tournament', status: 'complete' }).catch(() => {});
    return;
  }
  curMatch = tourney.current();
  renderBracket();
  const gf = tourney.isGrandFinals();
  el('tv-match-banner').textContent = gf ? '🏆 GRAND FINALS — Best of 5' : (isTeams ? 'Teams Tournament' : 'PvP Tournament');
  el('tv-target').innerHTML = '';
  el('tv-round-rows').innerHTML = '';
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = `${gf ? 'Grand Finals — ' : ''}Next up: ${curMatch.a.name} vs ${curMatch.b.name} — first to ${ROUNDS_TO_WIN_GAME} takes the game!`;
  setTimeout(isTeams ? startTeamMatch : startBracketGame, 2600);
}

function startBracketGame() {
  const two = [{ playerId: curMatch.a.id, name: curMatch.a.name }, { playerId: curMatch.b.id, name: curMatch.b.name }];
  // A GAME = first to ROUNDS_TO_WIN_GAME round-wins (TR-52). Party Classic opts
  // into the dead-heat void + 20s hostage cutoff (Hard runs exact-hit as-is).
  engine = createKoth({ db, room: lobbyId, players: two, n: ROUNDS_TO_WIN_GAME, hard: !!config.pool.hard, deadHeatVoid: !config.pool.hard, deadlineMs: CLASSIC_CUTOFF_MS, onTv: { state: renderRound }, onMatch: onPvpGame });
  engine.nextRound();
}

function onPvpGame(m) {
  renderKoth(m, true);
  if (m.tieVoid) { el('tv-game-msg').classList.remove('final'); el('tv-game-msg').textContent = '🟰 TIE GAME — RESETTING with a new target…'; return; }
  if (m.status === 'king') {
    tourney.reportGame(curMatch.id, m.king.playerId); // credit the game + rotate
    engine = null;
    renderBracket();
    setTimeout(nextTourneyGame, 2600);
  }
}

/* ---- Teams tournament ---- */
function launchTeams() {
  const roster = activePlayers().map((p) => ({ playerId: p.playerId, name: p.name }));
  if (roster.length < 3) return menuMsg('Teams needs at least 3 players.');
  isTeams = true;
  showGame(true);
  draftState = createDraftState(roster, config.numTeams);
  logTransition('tv', 'setup', 'draft-start', `${draftState.teams.length} teams`);
  publishDraft(true);
  renderDraft();
}

const nameOf = (pid) => (players.find((p) => p.playerId === pid) || {}).name || pid;

function publishDraft(resetClock) {
  if (resetClock && draftState.status === 'drafting') { pickDeadline = Date.now() + 20000; startClock(); }
  if (draftState.status !== 'drafting') stopClock();
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { ...draftState, deadline: draftState.status === 'drafting' ? pickDeadline : null }).catch(() => {});
}
function startClock() {
  stopClock();
  draftClock = setInterval(() => {
    if (!draftState || draftState.status !== 'drafting') { stopClock(); return; }
    if (Date.now() >= pickDeadline) { autoPick(draftState); publishDraft(true); }
    renderDraft();
  }, 500);
}
function stopClock() { if (draftClock) { clearInterval(draftClock); draftClock = null; } }
function finalizeDraft() {
  stopClock();
  const teams = draftTeams(draftState, nameOf);
  draftState = null;
  tourney = createTournament(teams.map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}`, members: t.members })));
  bracket = tourney.bracket;
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'tournament', status: 'playing' }).catch(() => {});
  logTransition('tv', 'draft', 'tournament-start', `${teams.length} teams`);
  nextTourneyGame();
}
function renderDraft() {
  if (!draftState) return;
  el('tv-match-banner').textContent = draftState.status === 'drafting' ? '📋 CAPTAIN DRAFT' : '🏷️ NAME YOUR TEAMS';
  el('tv-target').innerHTML = '';
  el('tv-round-rows').innerHTML = '';
  const st = el('tv-standings'); st.innerHTML = '';
  draftState.teams.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'standing alive';
    const turn = draftState.status === 'drafting' && i === draftState.turn ? '▶ ' : '';
    li.textContent = `${turn}${t.emoji} ${t.name} — cap ${nameOf(t.captainId)}: ${t.members.map(nameOf).join(', ')}`;
    st.appendChild(li);
  });
  if (draftState.pool.length) { const li = document.createElement('li'); li.className = 'standing out'; li.textContent = `Available: ${draftState.pool.map(nameOf).join(', ')}`; st.appendChild(li); }
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = draftState.status === 'drafting'
    ? `${nameOf(draftState.teams[draftState.turn].captainId)} is picking… (auto-pick in ${Math.max(0, Math.ceil((pickDeadline - Date.now()) / 1000))}s)`
    : 'Captains: set team name + emoji on your phone, then the host starts the tournament.';
}

function startTeamMatch() {
  const teamA = curMatch.a, teamB = curMatch.b; // entrants carry {id,name,members}
  // A GAME = first to ROUNDS_TO_WIN_GAME round-wins; active member rotates each
  // round (solo team plays every round — the 2v1 fairness rule in teamgame.js).
  engine = createTeamGame({
    db, room: lobbyId, teamA, teamB, n: ROUNDS_TO_WIN_GAME, hard: !!config.pool.hard,
    deadHeatVoid: !config.pool.hard, deadlineMs: CLASSIC_CUTOFF_MS,
    onTv: { state: (g, ctx) => renderTeamRound(g, ctx) },
    onGame: (r) => {
      if (r.status === 'tie-void') { el('tv-game-msg').classList.remove('final'); el('tv-game-msg').textContent = '🟰 TIE GAME — RESETTING with a new target…'; return; }
      if (r.status === 'over') { tourney.reportGame(curMatch.id, r.winner.id); engine = null; renderBracket(); setTimeout(nextTourneyGame, 2600); }
    }
  });
  engine.nextRound();
}

function renderTeamRound(g, ctx) {
  const ledgerA = dots(ctx.winsA, '🔵', '⚪'), ledgerB = dots(ctx.winsB, '🔴', '⚪');
  el('tv-match-banner').textContent = `${ctx.teamA.name} ${ledgerA} ${ctx.winsA}–${ctx.winsB} ${ledgerB} ${ctx.teamB.name}`;
  el('tv-target').innerHTML = `${fmtTarget(g)}<span class="timer-unit">s</span>`;
  const label = { [ctx.activeA.playerId]: ctx.teamA.name, [ctx.activeB.playerId]: ctx.teamB.name };
  const rows = el('tv-round-rows'); rows.innerHTML = '';
  Object.keys(g.players).forEach((id) => {
    const s = g.players[id];
    const li = document.createElement('li'); li.className = `round-row ${s.state}`;
    const time = s.state === 'stopped' ? `${fmtS2(s.elapsedMs)}s <span class="deviation">Δ ${fmtSigned(s.elapsedMs - g.targetMs)}s</span>` : s.state === 'dnf' ? 'DNF' : s.state === 'running' ? '⏱…' : '—';
    const medal = g.status === 'over' && g.ranking?.[0] === id ? '🏆 ' : '';
    li.innerHTML = `<span class="row-name">${medal}${label[id] || ''}: ${s.name}</span><span class="row-time">${time}</span>`;
    rows.appendChild(li);
  });
  const msg = el('tv-game-msg'); msg.classList.toggle('final', g.status === 'over');
  msg.textContent = g.status === 'running' ? 'Active players — tap to time it blind!' : g.status === 'over' ? (g.winner ? `Round to ${label[g.winner.playerId] || g.winner.name}!` : 'No winner — host taps Next Round.') : '';
  renderBracket();
}

/* ---------------- rendering ---------------- */
function renderRound(g) {
  el('tv-target').innerHTML = `${fmtTarget(g)}<span class="timer-unit">s</span>`;
  const rows = el('tv-round-rows');
  rows.innerHTML = '';
  const order = g.status === 'over' && g.ranking ? g.ranking.concat(Object.keys(g.players).filter((id) => !g.ranking.includes(id))) : Object.keys(g.players);
  order.forEach((id) => {
    const s = g.players[id];
    const li = document.createElement('li');
    li.className = `round-row ${s.state}`;
    const time = s.state === 'stopped' ? `${fmtS2(s.elapsedMs)}s <span class="deviation">Δ ${fmtSigned(s.elapsedMs - g.targetMs)}s</span>` : s.state === 'dnf' ? 'DNF' : s.state === 'running' ? '⏱…' : '—';
    const medal = g.status === 'over' && g.ranking?.[0] === id ? '🏆 ' : '';
    li.innerHTML = `<span class="row-name">${medal}${s.name}</span><span class="row-time">${time}</span>`;
    rows.appendChild(li);
  });
  const msg = el('tv-game-msg');
  msg.classList.toggle('final', g.status === 'over');
  msg.textContent = g.status === 'running' ? 'Tap to start your timer, tap again to stop — land on the target!'
    : g.status === 'over' ? (g.winner ? `🏆 ${g.winner.name} takes the round!` : 'No winner — host taps Next Round.') : '';
}

function renderKoth(m, pvp = false) {
  if (!pvp) el('tv-match-banner').textContent = m.status === 'king' ? '👑 WE HAVE A KING 👑' : `King of the Hill — first to ${m.n} (round ${m.roundNum})${m.hard ? ' 🔥' : ''}`;
  if (pvp) { renderBracket(); return; } // PvP shows the bracket in standings; skip KOTH standings
  const st = el('tv-standings');
  st.innerHTML = '';
  (m.tally || []).forEach((t) => { const li = document.createElement('li'); li.className = 'standing alive'; li.textContent = `${t.name} — ${t.wins}/${m.n}${'👑'.repeat(t.wins)}`; st.appendChild(li); });
  if (m.status === 'king') { el('tv-game-msg').classList.add('final'); el('tv-game-msg').textContent = `👑 ${m.king.name} is the King of the Hill!`; }
}

function renderElim(m) {
  el('tv-match-banner').textContent = m.status === 'champion' ? '👑 CHAMPION 👑' : `Last Man Standing — round ${m.roundNum}`;
  const st = el('tv-standings');
  st.innerHTML = '';
  for (const [id, name] of Object.entries(m.alive || {})) { const li = document.createElement('li'); li.className = 'standing alive'; li.textContent = name; st.appendChild(li); }
  for (const e of [...(m.eliminated || [])].reverse()) { const li = document.createElement('li'); li.className = 'standing out'; li.textContent = `${e.name} — out R${e.round}`; st.appendChild(li); }
  if (m.status === 'champion') { el('tv-game-msg').classList.add('final'); el('tv-game-msg').textContent = `👑 ${m.champion.name} is the last one standing!`; }
}

function renderBracket() {
  const st = el('tv-standings');
  st.innerHTML = '';
  bracket.rounds.forEach((round, ri) => {
    const hdr = document.createElement('li');
    hdr.className = 'standing';
    hdr.textContent = `— ${roundLabel(bracket, ri)} —`;
    st.appendChild(hdr);
    round.forEach((mm) => {
      const li = document.createElement('li');
      li.className = 'standing ' + (mm.winner ? 'out' : 'alive');
      const a = mm.a ? mm.a.name : '(bye)';
      const b = mm.b ? mm.b.name : (mm.bye ? '(bye)' : '…');
      const mark = mm === curMatch && !mm.winner ? '▶ ' : '';
      const games = (mm.a && mm.b) ? `  (${mm.gamesA}–${mm.gamesB})` : '';
      const win = mm.winner ? `  ✓ ${mm.winner.name}` : '';
      li.textContent = `${mark}${a} vs ${b}${games}${win}`;
      st.appendChild(li);
    });
  });
}

function renderChampion(c) {
  el('tv-match-banner').textContent = '🏆 TOURNAMENT CHAMPION 🏆';
  el('tv-target').innerHTML = '';
  el('tv-round-rows').innerHTML = '';
  el('tv-game-msg').classList.add('final');
  el('tv-game-msg').textContent = `🏆 ${c.name} wins the bracket!`;
}

/* ---------------- boot ---------------- */
async function boot() {
  if (!lobbyId) { const { code } = await createSession(db); logTransition('tv', 'boot', 'created', `room ${code}`); location.replace(`/tv/${code}`); return; }
  el('room-code').textContent = lobbyId;
  const joinUrl = `${location.origin}/play/${lobbyId}`;
  el('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  await QRCode.toCanvas(el('qr'), joinUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0d0f14', light: '#ffffff' } });
  el('status').textContent = 'Waiting for players…';
  watchPlayers(db, lobbyId, (list) => {
    players = list;
    hostId = (list.find((p) => p.uid) || {}).playerId || null;
    const ul = el('player-list'); ul.innerHTML = '';
    list.forEach((p) => { const li = document.createElement('li'); li.textContent = (hostId === p.playerId ? '⭐ ' : '') + (p.connected === false ? `⚠ ${p.name}` : p.name); li.classList.toggle('offline', p.connected === false); ul.appendChild(li); });
    el('players-empty').hidden = list.length > 0;
    if (!inGame) el('status').textContent = list.length ? `${list.length} in the lobby${hostId ? '' : ' — waiting for a signed-in host'}` : 'Waiting for players…';
    render();
  });
  consumeEvents(db, lobbyId, (ev) => {
    if (draftState) {
      if (ev.type === 'draft-pick' && ev.pick) { if (applyPick(draftState, ev.playerId, ev.pick).ok) { publishDraft(true); renderDraft(); } return; }
      if (ev.type === 'team-name' && typeof ev.name === 'string') { const t = draftState.teams.find((x) => x.captainId === ev.playerId); if (t && ev.name.trim()) { t.name = ev.name.trim().slice(0, 16); publishDraft(false); renderDraft(); } return; }
      if (ev.type === 'team-emoji' && ev.emoji) { const t = draftState.teams.find((x) => x.captainId === ev.playerId); if (t) { t.emoji = ev.emoji; publishDraft(false); renderDraft(); } return; }
      if (ev.type === 'draft-done' && ev.playerId === hostId && draftState.status === 'naming') { finalizeDraft(); return; }
    }
    if (ev.type === 'nav' && !inGame && ev.playerId === hostId && ev.dir) { onNav(ev.dir); return; }
    if (ev.type === 'press' && engine) { engine.handleEvent(ev); return; }
    if (ev.type === 'next' && engine && ev.playerId === hostId && engine.isBetween()) { engine.nextRound(); return; }
  });
  logTransition('tv', 'boot', 'lobby', `room ${lobbyId}`);
}
boot();
