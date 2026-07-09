// Landing page: single player front and center; Host a Game -> /host.html.
import { createSoloGame, SOLO_ROUNDS } from './solo.js';
import { watchAuth, signInGoogle, signOutUser, getProfile, claimUsername, validUsername } from './auth.js';
import { BANNERS, ACHIEVEMENTS, tierBannerFor } from './cosmetics.js';
import { ref as dbRef2, update as dbUpdate, get as dbGet2 } from 'firebase/database';
import { DAILY_ROUNDS, dateKey, dailyTargets, todayResult, saveResult, msToMidnight, ratingColor } from './daily.js';
import { createGuessSoloGame, GUESS_SOLO_ROUNDS } from './guesssolo.js';
import { createCasualGame, CASUAL_ROUNDS } from './casual.js';
import { validatePool, resolveMode, ENVIRONMENTS } from './hostconfig.js';
import { createMatch, getMatch, submitHostScore, reconcileRecord, seededTargets, lifecycle, awaitingHost, outcomeFor } from './match.js';
import { sfxStart, sfxStop } from './sfx.js';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });

import { initFirebase } from './firebase.js';
const el = (id) => document.getElementById(id);
const db = initFirebase();

let currentUser = null;

async function refreshChip(user) {
  currentUser = user;
  el('auth-btn').hidden = !!user;
  el('auth-name').hidden = !user;
  el('signout-btn').hidden = !user;
  el('username-form').hidden = true;
  if (!user) return;
  const profile = await getProfile(db, user.uid);
  if (profile) {
    el('auth-name').textContent = profile.displayName;
  } else {
    // first sign-in: username required before the profile exists
    el('auth-name').textContent = 'Pick a username…';
    el('username-form').hidden = false;
    el('username-input').focus();
  }
}

watchAuth(refreshChip);

async function openProfile() {
  if (!currentUser) {
    // Profile lives behind Google sign-in (records/banners/achievements). Kick it off.
    try { await signInGoogle(); }
    catch (err) { if (err.code !== 'auth/popup-closed-by-user') console.warn('[auth]', err.code); }
    return;
  }
  let profile = await getProfile(db, currentUser.uid);
  if (!profile) { el('username-form').hidden = false; el('username-input').focus(); return; }
  renderProfilePanel(profile);
  el('profile-panel').hidden = false;
  // Recompute record + last-5 from completed matches (TR-36), then re-render.
  try { await reconcileRecord(db, currentUser.uid); profile = await getProfile(db, currentUser.uid); renderProfilePanel(profile); } catch { /* offline: keep cached */ }
}
el('auth-name').addEventListener('click', openProfile);

/* ---- Profile tab (TR-38) ---- */
function earnedBanners(profile) {
  const earned = { ...(profile.banners || {}) };
  earned[tierBannerFor(profile.record?.w ?? 0)] = true; // tier banners auto-earn
  earned.rookie = true;
  return earned;
}

function renderProfilePanel(profile) {
  const np = el('nameplate');
  np.className = `nameplate ${BANNERS[profile.banner]?.css ?? 'banner-rookie'}`;
  el('np-name').textContent = profile.displayName;
  const r = profile.record || { w: 0, l: 0, d: 0 };
  el('np-record').textContent = `${r.w}-${r.l}-${r.d}`;

  const earned = earnedBanners(profile);
  const grid = el('banner-grid');
  grid.innerHTML = '';
  for (const [id, def] of Object.entries(BANNERS)) {
    const li = document.createElement('li');
    const isEarned = !!earned[id];
    li.className = `banner-cell ${def.css} ${isEarned ? 'earned' : 'locked'} ${profile.banner === id ? 'active' : ''}`;
    li.innerHTML = `<span class="banner-name">${def.name}</span><small>${isEarned ? (profile.banner === id ? 'Equipped' : 'Tap to equip') : def.source}</small>`;
    if (isEarned && profile.banner !== id) {
      li.addEventListener('click', async () => {
        await dbUpdate(dbRef2(db, `users/${currentUser.uid}`), { banner: id });
        renderProfilePanel({ ...profile, banner: id });
        refreshChip(currentUser);
      });
    }
    grid.appendChild(li);
  }

  const list = el('achievement-list');
  list.innerHTML = '';
  for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
    const li = document.createElement('li');
    const unlocked = !!profile.achievements?.[id];
    li.className = `achievement ${unlocked ? 'unlocked' : 'locked'}`;
    li.innerHTML = `<span class="ach-name">${unlocked ? '🏅' : '🔒'} ${def.name}</span>` +
      `<small>${def.desc}${def.grantsBanner ? ` — unlocks the ${BANNERS[def.grantsBanner].name} banner` : ''}</small>`;
    list.appendChild(li);
  }

  const rl = el('recent-list');
  if (rl) {
    rl.innerHTML = '';
    const recent = Array.isArray(profile.recent) ? profile.recent : [];
    if (!recent.length) {
      const li = document.createElement('li');
      li.className = 'players-empty';
      li.textContent = 'No 1v1s played yet.';
      rl.appendChild(li);
    } else for (const r of recent) {
      const li = document.createElement('li');
      const tag = r.outcome === 'w' ? 'WON' : r.outcome === 'l' ? 'lost' : 'draw';
      li.className = 'round-row';
      li.innerHTML = `<span class="row-name">${r.mode} vs ${r.opponent ?? '—'}</span><span class="row-time">${tag}</span>`;
      rl.appendChild(li);
    }
  }
}

el('profile-close').addEventListener('click', () => { el('profile-panel').hidden = true; });

el('profile-username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validUsername(el('profile-username-input').value);
  if (!check.ok) { el('profile-username-error').textContent = check.error; return; }
  el('profile-username-error').textContent = '';
  const result = await claimUsername(db, currentUser, check.name);
  if (!result.ok) { el('profile-username-error').textContent = result.error; return; }
  el('profile-username-input').value = '';
  const profile = await getProfile(db, currentUser.uid);
  renderProfilePanel(profile);
  refreshChip(currentUser);
});

el('username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validUsername(el('username-input').value);
  if (!check.ok) { el('username-error').textContent = check.error; return; }
  el('username-error').textContent = '';
  const result = await claimUsername(db, currentUser, check.name);
  if (!result.ok) { el('username-error').textContent = result.error; return; }
  el('username-input').value = '';
  refreshChip(currentUser);
});
const fmtS = (ms) => (ms / 1000).toFixed(1);
import { fmtOff, fmtS2 } from './format.js';
let game = null;
let shownTotal = 0;
let mode = 'solo'; // solo | daily
let countdownTimer = null;

function roundsTotal() { return game?.rounds?.() ?? (mode === 'daily' ? DAILY_ROUNDS : SOLO_ROUNDS); }
function roundLabel(n) { return mode === 'daily' ? `Daily Royale — Round ${n} / ${DAILY_ROUNDS}` : `Round ${n} / ${roundsTotal()}`; }

function setYou(ms) {
  const you = el('solo-you');
  if (ms === null) {
    you.classList.add('dim');
    you.innerHTML = `--<span class="timer-unit">s</span>`;
  } else {
    you.classList.remove('dim');
    you.innerHTML = `${fmtS2(ms)}<span class="timer-unit">s</span>`;
  }
}

function renderScore(ms) {
  el('solo-score').innerHTML = `${fmtOff(ms)}<span class="timer-unit">s</span>`;
}

function countUpScore(from, to, durationMs = 600) {
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / durationMs);
    renderScore(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // rAF halts when the page is hidden (phone lock, app switch) — guarantee
  // the final value lands no matter what.
  setTimeout(() => renderScore(to), durationMs + 100);
}

function flyDifference(deviationMs, onArrive) {
  const fromRect = el('solo-you').getBoundingClientRect();
  const toRect = el('solo-score').getBoundingClientRect();
  const chip = document.createElement('span');
  chip.className = 'fly-chip';
  chip.textContent = `+${fmtOff(deviationMs)}s`;
  chip.style.left = `${fromRect.left + fromRect.width / 2}px`;
  chip.style.top = `${fromRect.bottom + 4}px`;
  document.body.appendChild(chip);
  const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
  const dy = (toRect.top + toRect.height / 2) - (fromRect.bottom + 4);
  requestAnimationFrame(() => {
    chip.style.transform = `translate(${dx}px, ${dy}px) scale(0.5)`;
    chip.style.opacity = '0.1';
  });
  setTimeout(() => { chip.remove(); onArrive(); }, 750);
}

function renderRoundStart() {
  renderScore(shownTotal); // re-sync in case an animation was interrupted
  el('solo-round').textContent = roundLabel(game.currentRound());
  el('solo-target').innerHTML = `${fmtS(game.currentTargetMs())}<span class="timer-unit">s</span>`;
  setYou(null);
  el('solo-big-label').textContent = 'TAP TO START';
  el('solo-msg').textContent = 'Count it in your head — no peeking.';
}

function appendResult(attempt, roundNum) {
  const li = document.createElement('li');
  li.className = 'round-row stopped';
  li.innerHTML = `<span class="row-name">R${roundNum}: ${fmtS(attempt.targetMs)}s target</span>` +
    `<span class="row-time">${fmtS2(attempt.elapsedMs)}s <span class="deviation">off by ${fmtOff(attempt.deviationMs)}s</span></span>`;
  el('solo-results').appendChild(li);
}

function startGame(opts) {
  mode = 'solo';
  el('solo-guess-form').hidden = true;
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  game = createSoloGame(opts && opts.targets ? { targets: opts.targets } : undefined);
  shownTotal = 0;
  renderScore(0);
  document.querySelector('.score-wrap').hidden = false;
  document.querySelector('.target-row').hidden = false;
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  el('solo-big').hidden = false;
  renderRoundStart();
}

function finishGame(totalMs) {
  if (hostCtx) { finishHostChallenge(totalMs); return; }
  el('solo-round').textContent = 'Done!';
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-msg').textContent = '';
  const total = el('solo-total');
  total.hidden = false;
  total.textContent = `Total: ${fmtOff(totalMs)}s off across ${roundsTotal()} rounds — lower is better.`;
  el('solo-again').hidden = mode === 'daily'; // one attempt per day
  el('solo-exit').hidden = false;
  if (mode === 'daily') {
    saveResult({ attempts: game.attempts(), totalMs });
    el('solo-round').textContent = `Daily Royale — ${dateKey()}`;
    el('daily-share').hidden = false;
    startCountdown();
  }
}

/* ---- Daily Royale (TR-23) ---- */
function startCountdown() {
  const tick = () => {
    const ms = msToMidnight();
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    el('daily-countdown').textContent = `Next challenge in ${h}:${m}:${s}`;
    el('daily-countdown').hidden = false;
  };
  tick();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

function showDailyResult(res) {
  mode = 'daily';
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  el('solo-big').hidden = true;
  el('solo-msg').textContent = "You've played today — come back after midnight!";
  el('solo-round').textContent = `Daily Royale — ${res.dateKey}`;
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(res.totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-results').innerHTML = '';
  res.attempts.forEach((a, idx) => appendResult(a, idx + 1));
  el('solo-total').hidden = false;
  el('solo-total').textContent = `Total: ${fmtOff(res.totalMs)}s off across ${DAILY_ROUNDS} rounds.`;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = false;
  el('daily-share').hidden = false;
  startCountdown();
}

function startDaily() {
  const played = todayResult();
  if (played) { showDailyResult(played); return; }
  mode = 'daily';
  el('solo-guess-form').hidden = true;
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  game = createSoloGame({ targets: dailyTargets() });
  shownTotal = 0;
  renderScore(0);
  document.querySelector('.score-wrap').hidden = false;
  document.querySelector('.target-row').hidden = false;
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  el('solo-big').hidden = false;
  renderRoundStart();
}

function drawScoreCard(res) {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1080;
  const x = c.getContext('2d');
  x.fillStyle = '#050807'; x.fillRect(0, 0, 1080, 1080);
  x.textAlign = 'center';
  x.shadowColor = 'rgba(34,197,94,0.6)'; x.shadowBlur = 30;
  x.fillStyle = '#22c55e';
  x.font = '700 92px system-ui, sans-serif';
  x.fillText('TIMERROYALE', 540, 150);
  x.shadowBlur = 0;
  x.fillStyle = '#7e967f';
  x.font = '600 44px system-ui, sans-serif';
  x.fillText(`DAILY ROYALE — ${res.dateKey}`, 540, 225);
  res.attempts.forEach((a, i) => {
    const y = 330 + i * 130;
    x.fillStyle = ratingColor(a.deviationMs);
    x.fillRect(240, y - 52, 64, 64);
    x.fillStyle = '#e9f6ec';
    x.textAlign = 'left';
    x.font = '600 52px system-ui, sans-serif';
    x.fillText(`Round ${i + 1}`, 350, y);
    x.textAlign = 'right';
    x.fillText(`off by ${fmtOff(a.deviationMs)}s`, 840, y);
    x.textAlign = 'center';
  });
  x.shadowColor = 'rgba(34,197,94,0.6)'; x.shadowBlur = 24;
  x.fillStyle = '#22c55e';
  x.font = '400 130px "DSEG7-Classic", monospace';
  x.fillText(fmtOff(res.totalMs), 540, 870);
  x.shadowBlur = 0;
  x.fillStyle = '#7e967f';
  x.font = '600 40px system-ui, sans-serif';
  x.fillText('seconds off total', 540, 930);
  x.fillStyle = '#4ade80';
  x.font = '700 44px system-ui, sans-serif';
  x.fillText('timerroyale.web.app', 540, 1010);
  return c;
}

async function shareScoreCard() {
  const res = todayResult();
  if (!res) return;
  await document.fonts.load('130px "DSEG7-Classic"').catch(() => {});
  const canvas = drawScoreCard(res);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  window.__lastCardBlob = blob; // diagnostics
  const file = new File([blob], `timerroyale-daily-${res.dateKey}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'TimerRoyale Daily' });
      return;
    }
    throw new Error('no file share');
  } catch (err) {
    if (err.name === 'AbortError') return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

el('auth-btn').addEventListener('click', async () => {
  el('auth-btn').disabled = true;
  try { await signInGoogle(); }
  catch (err) { if (err.code !== 'auth/popup-closed-by-user') console.warn('[auth]', err.code); }
  el('auth-btn').disabled = false;
});
el('signout-btn').addEventListener('click', signOutUser);

/* ---- Top-level nav: Solo / Party / Profile (TR-53) ---- */
let menuCountdownTimer = null;
function hms(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function updateDailyButtonLabel() {
  const btn = el('daily-btn');
  if (!btn) return;
  btn.textContent = todayResult()
    ? `Daily Royale · done — resets ${hms(msToMidnight())}`
    : `Daily Royale · resets ${hms(msToMidnight())}`;
}
function showSoloMenu() {
  el('menu').hidden = true;
  el('solo-menu').hidden = false;
  updateDailyButtonLabel();
  clearInterval(menuCountdownTimer);
  menuCountdownTimer = setInterval(updateDailyButtonLabel, 1000);
}
function hideSoloMenu() {
  el('solo-menu').hidden = true;
  clearInterval(menuCountdownTimer);
}
el('nav-solo')?.addEventListener('click', showSoloMenu);
el('solo-menu-back')?.addEventListener('click', () => { hideSoloMenu(); el('menu').hidden = false; });
el('nav-party')?.addEventListener('click', () => { el('menu').hidden = true; el('party-menu').hidden = false; });
el('party-menu-back')?.addEventListener('click', () => { el('party-menu').hidden = true; el('menu').hidden = false; });
el('party-host-btn')?.addEventListener('click', () => { location.href = '/tv'; });
el('party-join-btn')?.addEventListener('click', () => {
  const f = el('join-code-form');
  f.hidden = !f.hidden;
  if (!f.hidden) el('code-input').focus();
});
el('nav-profile')?.addEventListener('click', openProfile);
el('casual-btn')?.addEventListener('click', () => { hideSoloMenu(); startCasual(); });
el('daily-btn')?.addEventListener('click', () => { hideSoloMenu(); startDaily(); });
el('solo-1v1-btn')?.addEventListener('click', () => { hideSoloMenu(); openHost1v1(); });
el('solo-my1v1s-btn')?.addEventListener('click', () => { hideSoloMenu(); openMy1v1s(); });

/* ---- Casual Play: 5 rounds, Classic + Guess mixed (TR-53) ---- */
let casualGame = null;

function renderCasualRoundStart() {
  const m = casualGame.currentMode();
  el('solo-round').textContent =
    `Casual — Round ${casualGame.currentRound()} / ${CASUAL_ROUNDS} · ${m === 'classic' ? 'Tap to time' : 'Feel the gap'}`;
  el('solo-guess-form').hidden = true;
  el('solo-big').hidden = false;
  el('solo-big').disabled = false;
  el('solo-big').classList.remove('running');
  document.querySelector('.score-wrap').hidden = false;
  if (m === 'classic') {
    document.querySelector('.target-row').hidden = false;
    el('solo-target').innerHTML = `${fmtS(casualGame.currentTargetMs())}<span class="timer-unit">s</span>`;
    setYou(null);
    el('solo-big-label').textContent = 'TAP TO START';
    el('solo-msg').textContent = 'Tap to start, tap to stop — no peeking.';
  } else {
    document.querySelector('.target-row').hidden = true;
    el('solo-big-label').textContent = 'PLAY IT';
    el('solo-msg').textContent = 'Tap, then feel the gap between the beeps.';
  }
}

function startCasual() {
  mode = 'casual';
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  el('solo-guess-form').hidden = true;
  casualGame = createCasualGame({ onMoment: fireMomentSolo });
  shownTotal = 0;
  renderScore(0);
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  renderCasualRoundStart();
}

function finishCasual(totalMs) {
  el('solo-round').textContent = 'Done!';
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-guess-form').hidden = true;
  el('solo-msg').textContent = '';
  el('solo-total').hidden = false;
  el('solo-total').textContent = `Total: ${fmtOff(totalMs)}s off across ${CASUAL_ROUNDS} rounds — lower is better.`;
  el('solo-again').hidden = false;
  el('solo-exit').hidden = false;
}

/* ---- Solo Guess Timer (TR-29) ---- */
let guessGame = null;

function fireMomentSolo(kind) {
  const f = el('flash');
  f.classList.remove('start', 'stop');
  void f.offsetWidth;
  f.classList.add(kind);
  try { kind === 'start' ? sfxStart() : sfxStop(); } catch { /* audio may be blocked pre-gesture */ }
}

function renderGuessRoundStart() {
  el('solo-round').textContent = `Guess Timer — Round ${guessGame.currentRound()} / ${GUESS_SOLO_ROUNDS}`;
  el('solo-big-label').textContent = 'PLAY IT';
  el('solo-big').hidden = false;
  el('solo-big').disabled = false;
  el('solo-guess-form').hidden = true;
  el('solo-msg').textContent = 'Tap, then feel the gap between the beeps.';
}

function startGuessSolo(opts) {
  mode = 'guess-solo';
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  guessGame = createGuessSoloGame({ onMoment: fireMomentSolo, targets: opts && opts.targets ? opts.targets : undefined });
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  renderGuessRoundStart();
}

function finishGuessSolo() {
  const totalMs = guessGame.totalMs();
  if (hostCtx) { finishHostChallenge(totalMs); return; }
  el('solo-round').textContent = 'Done!';
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-guess-form').hidden = true;
  el('solo-msg').textContent = '';
  el('solo-total').hidden = false;
  el('solo-total').textContent = `Total: ${fmtOff(totalMs)}s off across ${GUESS_SOLO_ROUNDS} rounds — lower is better.`;
  el('solo-again').hidden = false;
  el('solo-exit').hidden = false;
}

el('solo-guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = parseFloat(el('solo-guess-input').value.replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0 || v > 99) {
    el('solo-guess-error').textContent = 'Enter seconds, like 4.7';
    return;
  }
  el('solo-guess-error').textContent = '';
  el('solo-guess-input').value = '';
  if (mode === 'casual') {
    const res = casualGame.submitGuess(Math.round(v * 1000));
    if (!res) return;
    appendResult(res.attempt, casualGame.currentRound() - 1);
    el('solo-guess-form').hidden = true;
    el('solo-big').hidden = false;
    el('solo-msg').textContent = `Off by ${fmtOff(res.attempt.deviationMs)}s`;
    const newTotal = shownTotal + res.attempt.deviationMs;
    countUpScore(shownTotal, newTotal);
    shownTotal = newTotal;
    if (res.type === 'finished') finishCasual(res.totalMs);
    else renderCasualRoundStart();
    return;
  }
  const attempt = guessGame.submitGuess(Math.round(v * 1000));
  if (!attempt) return;
  appendResult({ targetMs: attempt.actualMs, elapsedMs: attempt.guessMs, deviationMs: attempt.deltaMs },
    guessGame.attempts().length);
  if (guessGame.getState() === 'done') finishGuessSolo();
  else renderGuessRoundStart();
});
el('daily-share').addEventListener('click', shareScoreCard);
el('join-code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = el('code-input').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) {
    el('code-error').textContent = 'Codes are 4 letters/numbers — check the TV.';
    return;
  }
  location.href = `/play/${code}`;
});
el('solo-again').addEventListener('click', () => {
  if (mode === 'casual') return startCasual();
  if (mode === 'guess-solo') return startGuessSolo();
  return startGame();
});
el('solo-exit').addEventListener('click', () => {
  clearInterval(countdownTimer);
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('solo-panel').hidden = true;
  el('menu').hidden = false;
});

el('solo-big').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const btn = el('solo-big');
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 150);
  if (mode === 'casual') {
    if (casualGame.currentMode() === 'guess') {
      if (casualGame.getState() !== 'ready') return;
      btn.disabled = true;
      el('solo-big-label').textContent = '👂 …';
      el('solo-msg').textContent = 'Listen…';
      casualGame.arm(() => {
        btn.hidden = true;
        el('solo-guess-form').hidden = false;
        el('solo-guess-submit').disabled = false;
        el('solo-guess-input').focus();
        el('solo-msg').textContent = 'How long was that?';
      });
      return;
    }
    const cres = casualGame.press();
    if (cres.type === 'started') {
      sfxStart();
      btn.classList.add('running');
      el('solo-big-label').textContent = 'TAP TO STOP';
      el('solo-msg').textContent = '';
    } else if (cres.type === 'stopped' || cres.type === 'finished') {
      sfxStop();
      btn.classList.remove('running');
      setYou(cres.attempt.elapsedMs);
      appendResult(cres.attempt, casualGame.currentRound() - 1);
      el('solo-msg').textContent = `Off by ${fmtOff(cres.attempt.deviationMs)}s`;
      btn.disabled = true;
      flyDifference(cres.attempt.deviationMs, () => {
        const newTotal = shownTotal + cres.attempt.deviationMs;
        countUpScore(shownTotal, newTotal);
        shownTotal = newTotal;
        setTimeout(() => {
          btn.disabled = false;
          btn.hidden = false;
          if (cres.type === 'finished') finishCasual(cres.totalMs);
          else renderCasualRoundStart();
        }, 700);
      });
    }
    return;
  }
  if (mode === 'guess-solo') {
    if (guessGame.getState() !== 'ready') return;
    btn.disabled = true;
    el('solo-big-label').textContent = '👂 …';
    el('solo-msg').textContent = 'Listen…';
    guessGame.arm(() => {
      btn.hidden = true;
      el('solo-guess-form').hidden = false;
      el('solo-guess-submit').disabled = false;
      el('solo-guess-input').focus();
      el('solo-msg').textContent = 'How long was that?';
    });
    return;
  }
  const result = game.press();
  if (result.type === 'started') {
    sfxStart();
    el('solo-big').classList.add('running');
    el('solo-big-label').textContent = 'TAP TO STOP';
    el('solo-msg').textContent = '';
  } else if (result.type === 'stopped') {
    sfxStop();
    el('solo-big').classList.remove('running');
    setYou(result.attempt.elapsedMs);
    appendResult(result.attempt, game.currentRound() - 1);
    el('solo-msg').textContent = `Off by ${fmtOff(result.attempt.deviationMs)}s`;
    btn.disabled = true;
    flyDifference(result.attempt.deviationMs, () => {
      const newTotal = shownTotal + result.attempt.deviationMs;
      countUpScore(shownTotal, newTotal);
      shownTotal = newTotal;
      setTimeout(() => { btn.disabled = false; renderRoundStart(); }, 700);
    });
  } else if (result.type === 'finished') {
    sfxStop();
    el('solo-big').classList.remove('running');
    setYou(result.attempt.elapsedMs);
    appendResult(result.attempt, SOLO_ROUNDS);
    btn.disabled = true;
    flyDifference(result.attempt.deviationMs, () => {
      const newTotal = shownTotal + result.attempt.deviationMs;
      countUpScore(shownTotal, newTotal);
      shownTotal = newTotal;
      setTimeout(() => { btn.disabled = false; finishGame(result.totalMs); }, 800);
    });
  }
});


/* ---- Host branching: Screen-1 select + async 1v1 (TR-46 / TR-34, send-first) ---- */
let hostCtx = null; // set only while the host plays THEIR half of a claimed match

function openHost1v1() {
  el('host-1v1-panel').hidden = false;
  el('host-1v1-result').hidden = true;
  el('host-1v1-msg').textContent = currentUser ? '' : 'Sign in (top of screen) to create a ranked 1v1.';
}
el('host-1v1-back').addEventListener('click', () => { el('host-1v1-panel').hidden = true; el('menu').hidden = false; });

el('host-1v1-play').addEventListener('click', async () => {
  const pool = [];
  if (el('pool-classic').checked) pool.push('classic');
  if (el('pool-guess').checked) pool.push('guess');
  const check = validatePool(ENVIRONMENTS.ONEVONE, pool);
  if (!check.ok) { el('host-1v1-msg').textContent = check.reason; return; }
  if (!currentUser) { el('host-1v1-msg').textContent = 'Sign in (top of screen) to create a ranked 1v1.'; return; }
  el('host-1v1-msg').textContent = '';
  el('host-1v1-play').disabled = true;
  try {
    const profile = await getProfile(db, currentUser.uid);
    const mode = resolveMode(check.pool);
    const res = await createMatch(db, { mode, hard: false, host: { uid: currentUser.uid, name: profile?.displayName ?? 'Host' } });
    el('host-1v1-link').textContent = res.link;
    el('host-1v1-result').hidden = false;
    el('host-1v1-msg').textContent = '';
    try { await navigator.clipboard.writeText(res.link); el('host-1v1-msg').textContent = 'Link copied — send it to your challenger.'; } catch { /* clipboard may be blocked */ }
  } catch (err) {
    el('host-1v1-msg').textContent = 'Could not create the match — online 1v1 needs Google sign-in + server rules enabled.';
  }
  el('host-1v1-play').disabled = false;
});
el('host-1v1-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el('host-1v1-link').textContent); el('host-1v1-msg').textContent = 'Copied!'; } catch { /* */ }
});

/* My 1v1s — list the host's matches; play your half when the challenger has finished */
el('my-1v1s-back').addEventListener('click', () => { el('my-1v1s-panel').hidden = true; el('menu').hidden = false; });

async function openMy1v1s() {
  el('my-1v1s-panel').hidden = false;
  const list = el('my-1v1s-list');
  list.innerHTML = '';
  el('my-1v1s-empty').hidden = true;
  if (!currentUser) { el('my-1v1s-empty').textContent = 'Sign in (top of screen) to see your 1v1s.'; el('my-1v1s-empty').hidden = false; return; }
  let ids = [];
  try {
    const snap = await dbGet2(dbRef2(db, `userMatches/${currentUser.uid}`));
    ids = snap.exists() ? Object.keys(snap.val()) : [];
  } catch { el('my-1v1s-empty').textContent = 'Could not load — check your connection.'; el('my-1v1s-empty').hidden = false; return; }
  if (!ids.length) { el('my-1v1s-empty').textContent = 'No 1v1s yet — create one from “1v1 Online Invite”.'; el('my-1v1s-empty').hidden = false; return; }
  const matches = (await Promise.all(ids.map((id) => getMatch(db, id)))).filter(Boolean)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  matches.forEach((m) => renderMy1v1(list, m));
}

function renderMy1v1(list, m) {
  const li = document.createElement('li');
  li.className = 'round-row';
  const iAmHost = m.host.uid === currentUser.uid;
  const state = lifecycle(m);
  const opp = iAmHost ? (m.challenger?.name ?? 'no challenger yet') : m.host.name;
  let right = '';
  if (state === 'expired') right = 'expired';
  else if (state === 'complete') { const o = outcomeFor(m, currentUser.uid); right = o === 'w' ? 'WON' : o === 'l' ? 'lost' : 'draw'; }
  else if (state === 'open') right = m.challenger ? 'challenger playing…' : 'waiting for a challenger';
  else if (state === 'awaiting_host') right = iAmHost ? 'YOUR TURN' : 'waiting for host';
  li.innerHTML = `<span class="row-name">${m.mode} vs ${opp}</span><span class="row-time">${right}</span>`;
  if (iAmHost && awaitingHost(m)) {
    const btn = document.createElement('button');
    btn.className = 'join-btn';
    btn.textContent = 'Play your half';
    btn.addEventListener('click', () => startHostHalf(m));
    li.appendChild(btn);
  }
  list.appendChild(li);
}

function startHostHalf(m) {
  hostCtx = { matchId: m.id, mode: m.mode };
  const targets = (m.targets && m.targets.length) ? m.targets : seededTargets(m.mode, m.id);
  el('my-1v1s-panel').hidden = true;
  if (m.mode === 'classic') startGame({ targets });
  else startGuessSolo({ targets });
}

async function finishHostChallenge(totalMs) {
  const ctx = hostCtx;
  hostCtx = null;
  el('solo-round').textContent = 'Your half is in';
  el('final-score').hidden = false;
  el('final-score').innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-guess-form').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = false;
  el('solo-total').hidden = true;
  el('solo-msg').textContent = 'Scoring the match…';
  try {
    const res = await submitHostScore(db, ctx.matchId, currentUser.uid, totalMs);
    if (!res.ok) { el('solo-msg').textContent = 'This match was already scored.'; return; }
    const o = outcomeFor(res.match, currentUser.uid);
    const verdict = o === 'w' ? '🏆 You won!' : o === 'l' ? 'You lost.' : "It's a draw.";
    el('solo-round').textContent = 'Match complete';
    el('solo-msg').textContent = `${verdict}  You: ${fmtOff(res.match.host.score)}s off · Them: ${fmtOff(res.match.challenger.score)}s off.`;
  } catch (err) {
    el('solo-msg').textContent = 'Could not submit your score — check your connection / sign-in.';
  }
}
