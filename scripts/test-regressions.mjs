#!/usr/bin/env node
// Offline checks for meeting defaults, import progress, and the live WS API.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useServerToken, socketUrl } from './server-auth.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'miaoji-regressions-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');

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
      closeOpenSegment() {},
      async flushTranslation() {},
      async autoDiarize() {},
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

  const diarizedInput = join(temp, 'diarized.wav');
  writeFileSync(diarizedInput, encodeWav(Int16Array.from({ length: 64000 }, (_, i) => Math.round(Math.sin(i / 12) * 8000)), 16000, 1));
  const diarized = new Meeting({
    id: 'diarized-import', config, translateTo: '',
    asr: { async transcribe() { return {
      text: 'First speaker. Second speaker.', provider: 'mock', seconds: 4,
      utterances: [
        { start: 0, end: 1, text: 'First speaker.', speaker: 0 },
        { start: 1, end: 4, text: 'Second speaker.', speaker: 1 },
      ],
    }; } },
  });
  diarized.attachAudio = async () => {};
  try {
    await importMedia({ meeting: diarized, inputPath: diarizedInput });
    assert.deepEqual(diarized.segments.map((s) => [s.text, s.start, s.end, s.speaker]), [
      ['First speaker.', 0, 1000, '说话人1'],
      ['Second speaker.', 1000, 4000, '说话人2'],
    ]);
    assert.equal(diarized.stats.asrCalls, 1);
    diarized.commitSegment({
      text: 'Second speaker continues.',
      utterances: [
        { start: 0, end: 1, text: 'Second speaker', speaker: 1 },
        { start: 1, end: 2, text: 'continues.', speaker: 1 },
      ],
    }, 6000, 8000);
    assert.equal(diarized.segments.at(-1).speaker, '说话人2', 'a provider speaker ID must win over the pause heuristic');
    console.log('PASS media import preserves provider speaker turns and timestamps');
  } finally { diarized.dispose(); }

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
        resolve(JSON.parse(line.slice('MIAOJI_READY '.length)));
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited early: ' + code + ' ' + output));
    });
  });
  const info = await ready;
  const base = info.url;
  const token = useServerToken(base, info.accessToken);
  const uploadMeeting = await (await fetch(new URL('/api/meetings', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ translateTo: '' }),
  })).json();
  let uploadRequest;
  const uploaded = new Promise((resolve, reject) => {
    uploadRequest = request(new URL('/api/meetings/' + uploadMeeting.meeting.id + '/import?name=test.wav', base), { method: 'POST', headers: { authorization: 'Bearer ' + token } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    uploadRequest.on('error', reject);
  });
  try {
    uploadRequest.write(Buffer.from([1]));
    // Let the server begin reading a body that has not finished arriving.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(new URL('/api/meetings/' + uploadMeeting.meeting.id, base), { method: 'DELETE' })).status, 200);
    uploadRequest.end(Buffer.from([2]));
    assert.equal(await uploaded, 404, 'a slow upload must not start processing after its meeting is deleted');
    console.log('PASS deletion during a slow upload prevents background import');
  } finally { uploadRequest.destroy(); }
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
  const socket = new WebSocket(socketUrl(new URL('/ws?meeting=' + created.meeting.id, base), token));
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

    const event = (type, predicate = () => true) => new Promise((resolve, reject) => {
      const handler = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === type && predicate(msg)) { clearTimeout(timer); socket.removeEventListener('message', handler); resolve(msg); }
      };
      const timer = setTimeout(() => { socket.removeEventListener('message', handler); reject(new Error('WS ' + type + ' timed out')); }, 3000);
      socket.addEventListener('message', handler);
    });
    const started = event('status', (m) => m.state === 'recording');
    socket.send(JSON.stringify({ type: 'start' }));
    await started;
    assert.equal((await fetch(new URL('/api/meetings/' + created.meeting.id, base), { method: 'DELETE' })).status, 409);
    const paused = event('status', (m) => m.state === 'paused');
    socket.send(JSON.stringify({ type: 'pause' }));
    await paused;
    assert.equal((await fetch(new URL('/api/meetings/' + created.meeting.id, base), { method: 'DELETE' })).status, 409);
    const stopped = event('status', (m) => m.state === 'stopped');
    socket.send(JSON.stringify({ type: 'stop' }));
    await stopped;

    const patched = event('meta');
    socket.send(JSON.stringify({ type: 'config-patch', title: 'Before deletion' }));
    await patched;
    assert.equal((await fetch(new URL('/api/meetings/' + created.meeting.id, base), { method: 'DELETE' })).status, 200);
    const deletedError = event('error', (m) => m.fatal);
    socket.send(JSON.stringify({ type: 'start' }));
    assert.match((await deletedError).message, /已删除/);
    await new Promise((resolve) => setTimeout(resolve, 2700));
    assert.equal((await fetch(new URL('/api/meetings/' + created.meeting.id, base))).status, 404);
    console.log('PASS active recordings reject deletion and deleted WS meetings cannot reappear');
  } finally {
    socket.close();
  }

  for (const [query, expected] of [['&translateTo=', ''], ['', 'ja']]) {
    const newSocket = new WebSocket(socketUrl(new URL('/ws?new=1' + query, base), token));
    try {
      const hello = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('new WS meeting timed out')), 3000);
        newSocket.addEventListener('message', (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'hello') { clearTimeout(timer); resolve(msg); }
        });
      });
      assert.equal(hello.meeting.translateTo, expected);
    } finally { newSocket.close(); }
  }
  console.log('PASS WebSocket meeting creation preserves explicit translation disable');
} finally {
  if (server) server.kill();
  rmSync(temp, { recursive: true, force: true });
}
