#!/usr/bin/env node
// test-import.mjs - exercise the upload pipeline.
//
// The live path is covered by e2e.mjs; this covers the OTHER entry point:
// a compressed file (mp3, deliberately NOT wav) that must go through ffmpeg,
// get sliced, transcribed chunk by chunk, translated and summarised.
//
// usage: node scripts/test-import.mjs [baseUrl]

import { execFile } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', '.probe', 'fixture', 'meeting.wav');
const MP3 = join(HERE, '..', '.probe', 'fixture', 'meeting.mp3');
const BASE = process.argv[2] || 'http://127.0.0.1:8777';

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300000 }, (err, so, se) =>
      err ? reject(new Error(cmd + ': ' + (se || err.message).slice(0, 300))) : resolve(so));
  });
}

async function main() {
  // 1. make an mp3 - this is the point: the server must transcode it itself
  if (!existsSync(MP3)) {
    console.log('creating mp3 fixture with ffmpeg...');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', FIX, '-codec:a', 'libmp3lame', '-b:a', '64k', MP3]);
  }
  const mp3 = readFileSync(MP3);
  console.log('mp3 size: ' + (mp3.length / 1024).toFixed(0) + ' KB');

  // 2. create the meeting and open the socket first so progress is visible
  const created = await (await fetch(BASE + '/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '导入测试（mp3）', language: 'zh', translateTo: 'ja', source: 'upload' }),
  })).json();
  const id = created.meeting.id;
  console.log('meeting: ' + id);

  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?meeting=' + id);
  let progressEvents = 0;
  let statusEvents = [];
  let importDone = null;
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'import-progress') progressEvents++;
    if (m.type === 'status') statusEvents.push(m.state);
    if (m.type === 'import-done') importDone = m;
    if (m.type === 'error') console.log('    [server error] ' + m.message);
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws connect failed')));
  });

  // 3. upload
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/meetings/' + id + '/import?name=' + encodeURIComponent('会議.mp3'), {
    method: 'POST',
    headers: { 'content-type': 'audio/mpeg' },
    body: mp3,
  });
  check('upload accepted', res.status === 202, 'HTTP ' + res.status);

  // 4. wait for the background transcode + transcription to finish
  console.log('waiting for background transcription...');
  const deadline = Date.now() + 600000;
  let doc = null;
  while (Date.now() < deadline) {
    doc = (await (await fetch(BASE + '/api/meetings/' + id)).json()).meeting;
    if (doc.state === 'stopped' && doc.segments.length > 0) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  console.log('');
  console.log('--- segments (' + doc.segments.length + ') ---');
  for (const s of doc.segments) {
    console.log('  [' + (s.start / 1000).toFixed(1) + 's] ' + s.text);
    if (s.translation) console.log('        ja> ' + s.translation);
  }

  const text = doc.segments.map((s) => s.text).join('');
  check('ffmpeg decoded the mp3 into silence-split segments', doc.segments.length >= 3,
    doc.segments.length + ' segments in ' + elapsed + 's');
  check('content matches the source audio', /移动端/.test(text) && /三十万/.test(text), text.slice(0, 70) + '...');
  check('progress streamed to the client', progressEvents > 0, progressEvents + ' progress events, states=' + JSON.stringify(statusEvents));
  check('import-done emitted', !!importDone, JSON.stringify(importDone));
  check('duration recorded from ffprobe', doc.durationMs > 40000, Math.round(doc.durationMs / 1000) + 's');
  check('translations produced', doc.segments.some((s) => s.translation),
    doc.segments.filter((s) => s.translation).length + '/' + doc.segments.length);
  check('minutes auto-generated after import', !!doc.minutes,
    doc.minutes ? (doc.minutes.actionItems || []).length + ' action items' : 'none');

  // 5. audio must be re-encoded to mp3 and playable
  const audio = await fetch(BASE + '/api/meetings/' + id + '/audio');
  const bytes = Buffer.from(await audio.arrayBuffer());
  check('audio available for playback', audio.status === 200 && bytes.length > 10000,
    'HTTP ' + audio.status + ', ' + (bytes.length / 1024).toFixed(0) + ' KB, ' + audio.headers.get('content-type'));

  // range requests matter for seeking in the player
  const ranged = await fetch(BASE + '/api/meetings/' + id + '/audio', { headers: { range: 'bytes=0-1023' } });
  check('audio supports HTTP range (seeking)', ranged.status === 206, 'HTTP ' + ranged.status + ' ' + ranged.headers.get('content-range'));

  ws.close();
  console.log('');
  const failed = results.filter((x) => !x).length;
  console.log(failed === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : failed + '/' + results.length + ' FAILED');
  console.log('open ' + BASE + '/?meeting=' + id);
  process.exitCode = failed ? 1 : 0;
}

await main();
