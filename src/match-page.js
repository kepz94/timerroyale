// Challenger page for an async 1v1 invite (TR-34 / TR-35). Opened from
// /match.html?m=ID. Flow: account-gate -> claim -> play ONE locked attempt on
// the same seeded targets -> submit -> wait for the host -> result reveal.
import { ref, onValue } from 'firebase/database';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { watchAuth, signInGoogle, signOutUser, getProfile, claimUsername, validUsername } from './auth.js';
import { getMatch, claimMatch, submitChallengerScore, lifecycle, outcomeFor } from './match.js';
import { createSoloGame } from './solo.js';
import { createGuessSoloGame } from './guesssolo.js';
import { sfxStart, sfxStop } from './sfx.js';
import { fmtOff, fmtS2 } from './format.js';

const el = (id) => document.getElementById(id);
const fmtS = (ms) => (ms / 1000).toFixed(1);
const db = initFirebase();
const matchId = new URLSearchParams(location.search).get('m');

let currentUser = null;
let matchData = null;
let played = false;      // guard: this session already submitted
let unwatch = null;

function show(id) {
  ['m-challenge', 'm-play', 'm-wait', 'm-result'].forEach((s) => { el(s).hidden = s !== id; });
}

/* ---------------- account chip (mirrors landing.js) ---------------- */
async function refreshChip(user) {
  currentUser = user;
  el('auth-btn').hidden = !!user;
  el('auth-name').hidden = !user;
  el('signout-btn').hidden = !user;
  el('username-form').hidden = true;
  if (!user) { route(); return; }
  const profile = await getProfile(db, user.uid);
  if (profile) { el('auth-name').textContent = profile.displayName; el('username-form').hidden = true; }
  else { el('auth-name').textContent = 'Pick a username…'; el('username-form').hidden = false; el('username-input').focus(); }
  route();
}
el('auth-btn').addEventListener('click', async () => {
  el('auth-btn').disabled = true;
  try { await signInGoogle(); } catch (err) { if (err.code !== 'auth/popup-closed-by-user') console.warn('[auth]', err.code); }
  el('auth-btn').disabled = false;
});
el('signout-btn').addEventListener('click', signOutUser);
el('username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validUsername(el('username-input').value);
  if (!check.ok) { el('username-error').textContent = check.error; return; }
  const result = await claimUsername(db, currentUser, check.name);
  if (!result.ok) { el('username-error').textContent = result.error; return; }
  el('username-error').textContent = '';
  refreshChip(currentUser);
});

/* ---------------- routing by match state ---------------- */
function watchMatch() {
  if (unwatch) return;
  unwatch = onValue(ref(db, `matches/${matchId}`), (snap) => {
    if (!snap.exists()) return;
    matchData = { id: matchId, ...snap.val() };
    if (!el('m-play').hidden || played) {
      // once we're playing / have played, only react to completion
      if (matchData.status === 'complete') renderResult();
      else if (played) show('m-wait');
    }
  });
}

async function route() {
  if (!matchId) { el('m-status').textContent = 'No challenge id in the link.'; return; }
  if (!matchData) matchData = await getMatch(db, matchId);
  const m = matchData;
  if (!m) { el('m-status').textContent = 'This challenge could not be found.'; return; }
  const state = lifecycle(m);
  watchMatch();

  if (state === 'complete') { renderResult(); return; }
  if (state === 'expired') { el('m-status').textContent = 'This challenge expired (48h).'; show(null); return; }

  const host = m.host?.name ?? 'Someone';
  const modeLabel = m.mode === 'guess' ? 'Guess Timer (3 rounds)' : 'Classic (5 rounds)';
  el('m-status').textContent = `${host} challenged you`;
  el('m-challenge-info').textContent = `${host} sent you a ${modeLabel} duel. Sign in and play your round — the host plays their half after you.`;

  if (!currentUser) { show('m-challenge'); el('m-accept-msg').textContent = 'Sign in (top of screen) to accept.'; return; }

  // I am the host who opened my own link
  if (m.host.uid === currentUser.uid) { el('m-status').textContent = 'This is your own challenge.'; el('m-challenge-info').textContent = 'Send the link to someone else. Play your half from “My 1v1s” on the home screen once they finish.'; show('m-challenge'); el('m-accept').hidden = true; return; }

  // already claimed
  if (m.challenger) {
    if (m.challenger.uid !== currentUser.uid) { el('m-status').textContent = 'Already taken.'; el('m-challenge-info').textContent = 'Another player already accepted this challenge.'; show('m-challenge'); el('m-accept').hidden = true; return; }
    // it's mine
    if (m.challenger.score != null) { played = true; el('m-wait-score').innerHTML = `${fmtOff(m.challenger.score)}<span class="timer-unit">s off</span>`; show('m-wait'); return; }
    startPlay(); return; // claimed but not played yet
  }

  // open + unclaimed + signed in -> offer accept
  show('m-challenge'); el('m-accept').hidden = false; el('m-accept-msg').textContent = '';
}

el('m-accept').addEventListener('click', async () => {
  if (!currentUser) { el('m-accept-msg').textContent = 'Sign in (top of screen) first.'; return; }
  el('m-accept').disabled = true;
  try {
    const profile = await getProfile(db, currentUser.uid);
    const res = await claimMatch(db, matchId, { uid: currentUser.uid, name: profile?.displayName ?? 'Challenger' });
    if (!res.ok && res.reason !== 'already-claimed-by-you') {
      el('m-accept-msg').textContent = res.reason === 'already-claimed' ? 'Someone else just took this one.'
        : res.reason === 'own-match' ? 'This is your own challenge.'
        : res.reason === 'expired' ? 'This challenge expired.' : 'Could not accept — try again.';
      el('m-accept').disabled = false; return;
    }
    matchData = res.match || (await getMatch(db, matchId));
    startPlay();
  } catch (err) {
    el('m-accept-msg').textContent = 'Could not accept — online 1v1 needs Google sign-in + rules enabled.';
    el('m-accept').disabled = false;
  }
});

/* ---------------- play controller (classic + guess) ---------------- */
let game = null, guessGame = null;

function startPlay() {
  show('m-play');
  el('m-results').innerHTML = '';
  if (matchData.mode === 'guess') startGuess(); else startClassic();
}

function appendResult(label, detail) {
  const li = document.createElement('li');
  li.className = 'round-row stopped';
  li.innerHTML = `<span class="row-name">${label}</span><span class="row-time">${detail}</span>`;
  el('m-results').appendChild(li);
}

function renderClassicRound() {
  el('m-round').textContent = `Round ${game.currentRound()} / ${game.rounds()}`;
  el('m-target').innerHTML = `${fmtS(game.currentTargetMs())}<span class="timer-unit">s</span>`;
  el('m-you').classList.add('dim'); el('m-you').innerHTML = `--<span class="timer-unit">s</span>`;
  el('m-big-label').textContent = 'TAP TO START';
  el('m-msg').textContent = 'Count it in your head — no peeking.';
}

function startClassic() {
  el('m-target-row').hidden = false;
  el('m-guess-form').hidden = true;
  el('m-big').hidden = false;
  game = createSoloGame({ targets: matchData.targets });
  renderClassicRound();
}

el('m-big').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const btn = el('m-big');
  btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 150);
  if (matchData.mode === 'guess') {
    if (!guessGame || guessGame.getState() !== 'ready') return;
    btn.disabled = true; el('m-big-label').textContent = '👂 …'; el('m-msg').textContent = 'Listen…';
    guessGame.arm(() => { btn.hidden = true; el('m-guess-form').hidden = false; el('m-guess-submit').disabled = false; el('m-guess-input').focus(); el('m-msg').textContent = 'How long was that?'; });
    return;
  }
  const r = game.press();
  if (r.type === 'started') { sfxStart(); btn.classList.add('running'); el('m-big-label').textContent = 'TAP TO STOP'; el('m-msg').textContent = ''; }
  else if (r.type === 'stopped' || r.type === 'finished') {
    sfxStop(); btn.classList.remove('running');
    el('m-you').classList.remove('dim'); el('m-you').innerHTML = `${fmtS2(r.attempt.elapsedMs)}<span class="timer-unit">s</span>`;
    appendResult(`R${game.currentRound() - (r.type === 'finished' ? 0 : 1)}: ${fmtS(r.attempt.targetMs)}s`, `off ${fmtOff(r.attempt.deviationMs)}s`);
    el('m-msg').textContent = `Off by ${fmtOff(r.attempt.deviationMs)}s`;
    if (r.type === 'finished') { btn.disabled = true; submitMine(r.totalMs); }
    else { btn.disabled = true; setTimeout(() => { btn.disabled = false; renderClassicRound(); }, 700); }
  }
});

function fireMoment(kind) {
  const f = el('flash'); f.classList.remove('start', 'stop'); void f.offsetWidth; f.classList.add(kind);
  try { kind === 'start' ? sfxStart() : sfxStop(); } catch { /* audio may be blocked */ }
}
function renderGuessRound() {
  el('m-round').textContent = `Guess Timer — Round ${guessGame.currentRound()} / ${guessGame.rounds()}`;
  el('m-big-label').textContent = 'PLAY IT'; el('m-big').hidden = false; el('m-big').disabled = false;
  el('m-guess-form').hidden = true; el('m-msg').textContent = 'Tap, then feel the gap between the beeps.';
}
function startGuess() {
  el('m-target-row').hidden = true;
  guessGame = createGuessSoloGame({ targets: matchData.targets, onMoment: fireMoment });
  renderGuessRound();
}
el('m-guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = parseFloat(el('m-guess-input').value.replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0 || v > 99) { el('m-guess-error').textContent = 'Enter seconds, like 4.7'; return; }
  el('m-guess-error').textContent = ''; el('m-guess-input').value = '';
  const a = guessGame.submitGuess(Math.round(v * 1000));
  if (!a) return;
  appendResult(`R${guessGame.attempts().length}`, `off ${fmtOff(a.deltaMs)}s`);
  if (guessGame.getState() === 'done') submitMine(guessGame.totalMs());
  else renderGuessRound();
});

async function submitMine(totalMs) {
  played = true;
  el('m-wait-score').innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  show('m-wait');
  try {
    const res = await submitChallengerScore(db, matchId, currentUser.uid, totalMs);
    if (!res.ok && res.match?.status === 'complete') { matchData = res.match; renderResult(); }
  } catch (err) { el('m-status').textContent = 'Could not submit — check your connection.'; }
}

function renderResult() {
  const m = matchData;
  if (!m || m.status !== 'complete') return;
  show('m-result');
  const uid = currentUser?.uid ?? m.challenger?.uid;
  const o = outcomeFor(m, uid);
  el('m-verdict').textContent = o === 'w' ? '🏆 You won!' : o === 'l' ? 'You lost' : 'Draw';
  const mine = m.challenger?.uid === uid ? m.challenger.score : m.host.score;
  const theirs = m.challenger?.uid === uid ? m.host.score : m.challenger.score;
  el('m-result-detail').textContent = `You: ${fmtOff(mine)}s off · Opponent: ${fmtOff(theirs)}s off. Lower wins.`;
}

watchAuth(refreshChip);
