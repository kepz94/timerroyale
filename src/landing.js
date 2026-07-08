// Landing page: single player front and center; Host a Game -> /host.html.
import { createSoloGame, SOLO_ROUNDS } from './solo.js';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });

const el = (id) => document.getElementById(id);
const fmtS = (ms) => (ms / 1000).toFixed(1);
let game = null;

function renderRoundStart() {
  el('solo-round').textContent = `Round ${game.currentRound()} / ${SOLO_ROUNDS}`;
  el('solo-target').innerHTML = `${fmtS(game.currentTargetMs())}<span class="timer-unit">s</span>`;
  el('solo-big-label').textContent = 'TAP TO START';
  el('solo-msg').textContent = 'Count it in your head — no peeking.';
}

function appendResult(attempt, roundNum) {
  const li = document.createElement('li');
  li.className = 'round-row stopped';
  li.innerHTML = `<span class="row-name">R${roundNum}: ${fmtS(attempt.targetMs)}s target</span>` +
    `<span class="row-time">${fmtS(attempt.elapsedMs)}s <span class="deviation">off by ${attempt.deviationMs} ms</span></span>`;
  el('solo-results').appendChild(li);
}

function startGame() {
  game = createSoloGame();
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
  el('solo-round').textContent = 'Done!';
  el('solo-target').innerHTML = `${fmtS(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-msg').textContent = '';
  const total = el('solo-total');
  total.hidden = false;
  total.textContent = `Total: ${totalMs.toLocaleString()} ms off across ${SOLO_ROUNDS} rounds — lower is better.`;
  el('solo-again').hidden = false;
  el('solo-exit').hidden = false;
}

el('solo-btn').addEventListener('click', startGame);
el('solo-again').addEventListener('click', startGame);
el('solo-exit').addEventListener('click', () => {
  el('solo-panel').hidden = true;
  el('menu').hidden = false;
});

el('solo-big').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const btn = el('solo-big');
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 150);
  const result = game.press();
  if (result.type === 'started') {
    el('solo-big-label').textContent = 'TAP TO STOP';
    el('solo-msg').textContent = '';
  } else if (result.type === 'stopped') {
    appendResult(result.attempt, game.currentRound() - 1);
    renderRoundStart();
  } else if (result.type === 'finished') {
    appendResult(result.attempt, SOLO_ROUNDS);
    finishGame(result.totalMs);
  }
});
