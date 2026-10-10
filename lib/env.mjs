// env.mjs — load API credentials.
//
// Only keys saved in this app are used by default. Environment credentials
// require an explicit opt-in; unrelated applications' key stores are never read.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Keys pasted into the app's own settings screen land here.
const LOCAL_CRED_PATH = join(
  process.env.MIAOJI_DATA_DIR || join(HERE, '..', 'data'),
  'credentials.json',
);

let cached = null;

function readCreds() {
  const out = {};
  if (process.env.MIAOJI_ALLOW_ENV_CREDENTIALS === '1') {
    for (const [name, value] of Object.entries(process.env)) {
      if (/^[A-Z][A-Z0-9_]*_KEY$/.test(name) && value) out[name] = value;
    }
  }

  try {
    if (existsSync(LOCAL_CRED_PATH)) {
      const local = JSON.parse(readFileSync(LOCAL_CRED_PATH, 'utf8'));
      for (const [k, v] of Object.entries(local)) {
        if (v) out[k] = String(v);
      }
    }
  } catch {
    /* an unreadable local store must not break startup */
  }

  return out;
}

/** UI-saved keys take precedence over explicitly enabled environment keys. */
export function loadCreds() {
  if (!cached) cached = readCreds();
  return cached;
}

/**
 * Persist a credential entered in the UI and make it visible immediately.
 * Writes only to this app's local store.
 */
export function setLocalCred(name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid credential name: ' + name);
  let store = {};
  try {
    if (existsSync(LOCAL_CRED_PATH)) store = JSON.parse(readFileSync(LOCAL_CRED_PATH, 'utf8'));
  } catch {
    store = {};
  }
  if (value) store[name] = String(value);
  else delete store[name];
  mkdirSync(dirname(LOCAL_CRED_PATH), { recursive: true });
  writeFileSync(LOCAL_CRED_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
  const live = loadCreds();
  const refreshed = readCreds();
  for (const key of Object.keys(live)) delete live[key];
  Object.assign(live, refreshed);
  return { name, configured: !!value };
}

export { LOCAL_CRED_PATH };

/** Fetch a credential by name, throwing a helpful error when it is absent. */
export function cred(name) {
  const value = loadCreds()[name];
  if (!value) {
    throw new Error(
      `missing credential ${name} — add it in Babel Echo Settings`,
    );
  }
  return value;
}
