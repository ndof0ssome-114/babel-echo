#!/usr/bin/env node
// Offline checks for meeting defaults, import progress, and the live WS API.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'miaoji-regressions-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
process.env.DSH_HOME = join(temp, 'dsh');

let server;
try {
  const { DEFAULT_CONFIG } = await import('../lib/config.mjs');
  const { Meeting } = await import('../lib/meeting.mjs');
  const { encodeWav } = await import('../lib/wav.mjs');
  const { importMedia } = await import('../lib/import.mjs');

  const config = structuredClone(DEFAULT_CONFIG);
  const meeting = new Meeting({ id: 'translation-off', config, translateTo: '', asr: null, llm: null, creds: {} });
  assert.equal(meeting.translateTo, '', 'empty translation target must remain disabled');
  config.translate.target = 'en';
  const defaultMeeting = new Meeting({ id: 'translation-default', config, asr: null, llm: null, creds: {} });
  assert.equal(defaultMeeting.translateTo, 'en', 'new meetings use the configured target');
  console.log('PASS translation target defaults and explicit disable');

  for (const [name, samples, shouldCall] of [
    ['silent', new Int16Array(16000), false],
    ['failed', Int16Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 12) * 8000)), true],
  ]) {
    const inputPath = join(temp, name + '.wav');
    writeFileSync(inputPath, encodeWav(samples, 16000, 1));
    const events = [];
    let calls = 0;
    const fake = {
      id: name,
      language: 'zh',
      config,
      segments: [],
      stats: { asrCalls: 0, asrSeconds: 0, asrCost: 0 },
      asr: { async transcribe() { calls++; throw new Error('mock ASR failure'); } },
      emit(type, payload) { events.push({ type, ...payload }); },
      async attachAudio() {},
      async flushTranslation() {},
      save() {},
    };
    const progress = [];
    await importMedia({ meeting: fake, inputPath, onProgress: (p) => progress.push(p) });
    assert.equal(calls > 0, shouldCall, name + ' ASR calls');
    assert.equal(progress.at(-1).done, progress.at(-1).total, name + ' callback progress');
    const streamed = events.filter((e) => e.type === 'import-progress');
    assert.equal(streamed.at(-1).done, streamed.at(-1).total, name + ' WS progress');
    assert.equal(events.at(-1).type, 'import-done');
    console.log('PASS ' + name + ' import reaches complete progress');
  }

  const ready = new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.mjs', '0'], {
      cwd: root,
      env: { ...process.env, MIAOJI_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 10000);
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/).find((s) => s.startsWith('MIAOJI_READY '));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('MIAOJI_READY '.length)).url);
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited early: ' + code + ' ' + output));
    });
  });
  const base = await ready;
  const created = await (await fetch(new URL('/api/meetings', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ translateTo: '' }),
  })).json();
  assert.equal(created.meeting.translateTo, '');
  const lite = await (await fetch(new URL('/api/bootstrap?lite=1', base))).json();
  assert.equal(lite.hasMeetings, true);
  assert.equal('meetings' in lite, false);
  console.log('PASS lightweight startup skips loading transcript history');
  const socket = new WebSocket(new URL('/ws?meeting=' + created.meeting.id, base).href.replace(/^http/, 'ws'));
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const stats = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS stats reply timed out')), 3000);
      socket.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'stats') {
          clearTimeout(timer);
          resolve(msg.stats);
        }
      });
    });
    socket.send(JSON.stringify({ type: 'stats' }));
    assert.equal((await stats).asrCalls, 0);
    console.log('PASS WebSocket stats request returns current stats');
  } finally {
    socket.close();
  }
} finally {
  if (server) server.kill();
  rmSync(temp, { recursive: true, force: true });
}
