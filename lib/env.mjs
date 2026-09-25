// env.mjs — load API credentials.
//
// DSH keeps provider keys in ~/.dsh/.credentials.yaml under `refs:`.
// We read that file directly (no YAML dependency needed for this shape).
// Keys saved in the app take precedence so changing a key in Settings has
// an immediate and persistent effect; environment variables come next.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const CRED_PATH = join(DSH_HOME, '.credentials.yaml');

const HERE = dirname(fileURLToPath(import.meta.url));
// Keys pasted into the app's own settings screen land here. This file is
// LOCAL_CRED_PATH and take precedence over environment and central DSH keys.
const LOCAL_CRED_PATH = join(
  process.env.MIAOJI_DATA_DIR || join(HERE, '..', 'data'),
  'credentials.json',
);

let cached = null;

function readCreds() {
  const out = {};
  try {
    const text = readFileSync(CRED_PATH, 'utf8');
    const start = text.indexOf('refs:');
    if (start >= 0) {
      let block = text.slice(start + 'refs:'.length);
      const end = block.search(/\n\S/); // next top-level key ends the block
      if (end >= 0) block = block.slice(0, end);
      for (const line of block.split(/\r?\n/)) {
        const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const value = m[2].replace(/^[\"']|[\"']$/g, '');
        if (value) out[m[1]] = value;
      }
    }
  } catch {
    // No credentials file: fall back to the ambient environment only.
  }

  Object.assign(out, process.env);

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

/** UI-saved keys take precedence over environment and the central DSH store. */
export function loadCreds() {
  if (!cached) cached = readCreds();
  return cached;
}

/**
 * Persist a credential entered in the UI and make it visible immediately.
 * Writes to the local store, never to ~/.dsh/.credentials.yaml.
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

export { LOCAL_CRED_PATH, CRED_PATH };

/** Fetch a credential by name, throwing a helpful error when it is absent. */
export function cred(name) {
  const value = loadCreds()[name];
  if (!value) {
    throw new Error(
      `missing credential ${name} — set it in the environment or in ${CRED_PATH}`,
    );
  }
  return value;
}
