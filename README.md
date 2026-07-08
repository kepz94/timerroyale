# TimerRoyale

A free PWA that turns a TV into the host of timer-battle party games — players scan a QR code to join, and the TV runs timers, teams, and eliminations.

## Structure
- `index.html` + `src/host.js` — Host view (TV). Authoritative for all game state and timing.
- `player.html` + `src/player.js` — Player view (phone). Sends button-press events only.
- `src/firebase.js` — Firebase Realtime Database init (shared).

## Develop
```
npm install
npm run dev
```
Host view at `/`, player view at `/player.html`.

## Version
v0.1.0 — TR-1 skeleton.
