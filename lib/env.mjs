// env.mjs — load API credentials.
//
// Only keys saved in this app are used by default. Environment credentials
// require an explicit opt-in; unrelated applications' key stores are never read.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeFileAtomic, quarantineFile } from './atomic-file.mjs';
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

  const local = readLocalStore();
  for (const [k, v] of Object.entries(local.store)) {
    if (v) out[k] = String(v);
  }
  return out;
}

/**
 * Read the UI key store. An unreadable store must not break startup, but it
 * must not be silently replaced either: it is reported as corrupt so the
 * next write moves it aside instead of overwriting the other keys in it.
 */
function readLocalStore() {
  if (!existsSync(LOCAL_CRED_PATH)) return { store: {}, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_CRED_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { store: parsed, corrupt: false };
  } catch (err) {
    console.error('[credentials] 无法读取 ' + LOCAL_CRED_PATH + '：' + err.message);
    return { store: {}, corrupt: true };
  }
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
  const { store, corrupt } = readLocalStore();
  // Keep the damaged file for manual recovery rather than replacing it with
  // a store that holds only the key being saved now.
  const backup = corrupt ? quarantineFile(LOCAL_CRED_PATH) : null;
  if (corrupt && !backup) throw new Error('密钥文件已损坏且无法备份，请手动检查：' + LOCAL_CRED_PATH);
  if (value) store[name] = String(value);
  else delete store[name];
  // Keys are only for the current OS user.
  writeFileAtomic(LOCAL_CRED_PATH, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  const live = loadCreds();
  const refreshed = readCreds();
  for (const key of Object.keys(live)) delete live[key];
  Object.assign(live, refreshed);
  return { name, configured: !!value, ...(backup ? { warning: '原密钥文件已损坏，已备份到 ' + backup + '，其他密钥需要重新填写' } : {}) };
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
