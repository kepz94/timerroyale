// Player (phone) entry point — a dumb remote that only sends button-press events.
import { initFirebase } from './firebase.js';

const db = initFirebase();
document.getElementById('status').textContent = db
  ? 'Firebase connected.'
  : 'Skeleton OK — Firebase not yet configured.';
