// Host (TV) entry point — owns all game state and timing.
import { initFirebase } from './firebase.js';

const db = initFirebase();
document.getElementById('status').textContent = db
  ? 'Firebase connected.'
  : 'Skeleton OK — Firebase not yet configured.';
