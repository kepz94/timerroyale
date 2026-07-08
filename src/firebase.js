// Firebase initialization (TR-1).
// The host (TV) is the authoritative timekeeper; phones only write button-press events.
// NOTE: web app config values are public identifiers, not secrets; data access is governed by RTDB rules.
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

export const firebaseConfig = {
  apiKey: 'AIzaSyBt0tDETKkYWvHBXCK1mRN_dg-IKYNuwsc',
  authDomain: 'timerroyale.firebaseapp.com',
  databaseURL: 'https://timerroyale-default-rtdb.firebaseio.com',
  projectId: 'timerroyale',
  storageBucket: 'timerroyale.firebasestorage.app',
  messagingSenderId: '398263163161',
  appId: '1:398263163161:web:57c419423846729b85cd88'
};

export function initFirebase() {
  const app = initializeApp(firebaseConfig);
  return getDatabase(app);
}
