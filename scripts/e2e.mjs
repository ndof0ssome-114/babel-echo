#!/usr/bin/env node
// e2e.mjs — end-to-end check against a running server.
//
// Streams the synthesized meeting over the real WebSocket as if it were a
// live microphone, then verifies that transcription, translation, rolling
// summary and structured minutes all actually materialise.
//
// usage: node scripts/e2e.mjs [baseUrl]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '.probe', 'fixture', 'meeting.wav');
const BASE = process.argv[2] || 'http://127.0.0.1:8777';
const SPEED = Number(process.env.E2E_SPEED || 5);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function parseWav(buf) {
  let offset = 12;
  let sampleRate = 16000;
  let dataOffset = 44;
  let dataLength = buf.length - 44;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(offset + 12);
    if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, buf.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return { sampleRate, dataOffset, dataLength };
}

async function main() {
  if (!readFileSync) throw new Error('unreachable');
  const wav = readFileSync(FIXTURE);
  const info = parseWav(wav);
  const samples = Math.floor(info.dataLength / 2);
  console.log('fixture: ' + (samples / info.sampleRate).toFixed(1) + ' s @ ' + info.sampleRate + ' Hz, streaming at ' + SPEED + 'x');

  // 1. create the meeting
  const created = await (await fetch(BASE + '/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'E2E 产品路线图会议', language: 'zh', translateTo: 'ja' }),
  })).json();
  const id = created.meeting.id;
  console.log('meeting: ' + id);

  // 2. open the realtime channel
  const wsUrl = BASE.replace('http', 'ws') + '/ws?meeting=' + id;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  const events = [];
  let sawHello = false;
  const waits = new Map();

  function waitFor(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeoutMs || 240000);
      const list = waits.get(type) || [];
      list.push((evt) => {
        clearTimeout(timer);
        resolve(evt);
      });
      waits.set(type, list);
    });
  }

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    events.push(msg);
    if (msg.type === 'hello') sawHello = true;
    if (msg.type === 'error') console.log('    [server error] ' + msg.message);
    const list = waits.get(msg.type);
    if (list && list.length) {
      const fn = list.shift();
      fn(msg);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket failed to connect')));
  });

  const helloPromise = waitFor('hello', 20000);
  const hello = await helloPromise;
  check('websocket hello received', sawHello && !!hello.meeting, 'meeting=' + (hello.meeting && hello.meeting.id));
  check('ASR engine available', (hello.asrAvailable || []).length > 0, JSON.stringify(hello.asrAvailable));
  const engine = (hello.status.asr || []).find((p) => p.name === hello.status.routes.zh);
  check('zh route provider ready', !!(engine && engine.ready), engine ? engine.name + ' / ' + engine.label : 'none');

  // 3. stream the audio
  ws.send(JSON.stringify({ type: 'start', language: 'zh', translateTo: 'ja' }));
  await new Promise((r) => setTimeout(r, 400));

  const FRAME = 1024;
  const frames = [];
  for (let s = 0; s < samples; s += FRAME) {
    const n = Math.min(FRAME, samples - s);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = wav.readInt16LE(info.dataOffset + (s + i) * 2);
    frames.push(out);
  }
  const frameMs = (FRAME / info.sampleRate) * 1000;
  const delay = frameMs / SPEED;
  console.log('streaming ' + frames.length + ' frames, ' + delay.toFixed(1) + ' ms apart...');

  for (let i = 0; i < frames.length; i++) {
    ws.send(frames[i].buffer);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, delay * 20));
  }
  await new Promise((r) => setTimeout(r, delay * 6));

  // 4. stop and wait for the pipeline to settle
  ws.send(JSON.stringify({ type: 'stop' }));
  console.log('stopped; waiting for minutes...');
  let minutes = null;
  try {
    minutes = await waitFor('minutes', 300000);
  } catch (err) {
    console.log('    ' + err.message);
  }

  // 5. force a summary refresh so the rolling-summary path is exercised even
  // when the meeting is shorter than the auto-summary interval
  await fetch(BASE + '/api/meetings/' + id + '/summarize', { method: 'POST' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));

  // 6. inspect the persisted meeting
  await new Promise((r) => setTimeout(r, 500));
  const doc = (await (await fetch(BASE + '/api/meetings/' + id)).json()).meeting;

  const text = doc.segments.map((s) => s.text).join('');
  console.log('');
  console.log('--- transcript (' + doc.segments.length + ' segments) ---');
  for (const s of doc.segments) {
    console.log('  [' + (s.start / 1000).toFixed(1) + 's] ' + s.speaker + ': ' + s.text);
    if (s.translation) console.log('        ja> ' + s.translation);
  }

  check('transcript produced segments', doc.segments.length >= 3, doc.segments.length + ' segments');
  check('transcript captured key nouns',
    /移动端/.test(text) && /预算/.test(text) && /三十万/.test(text),
    text.slice(0, 80) + '...');
  check('translations filled', doc.segments.some((s) => s.translation),
    doc.segments.filter((s) => s.translation).length + '/' + doc.segments.length);
  check('rolling summary generated', !!doc.summary, (doc.summary || '').slice(0, 60).replace(/\n/g, ' '));
  check('structured minutes generated', !!doc.minutes, doc.minutes ? 'model=' + doc.minutes.model : 'none');
  if (doc.minutes) {
    check('minutes has action items', Array.isArray(doc.minutes.actionItems) && doc.minutes.actionItems.length > 0,
      JSON.stringify(doc.minutes.actionItems || []).slice(0, 160));
    check('minutes has decisions', Array.isArray(doc.minutes.decisions) && doc.minutes.decisions.length > 0,
      JSON.stringify(doc.minutes.decisions || []).slice(0, 160));
  }
  check('ASR cost accounted', (doc.stats.asrSeconds || 0) > 5,
    (doc.stats.asrSeconds || 0).toFixed(1) + ' s audio, ' + doc.stats.asrCalls + ' calls');

  // 6. export
  const md = await (await fetch(BASE + '/api/meetings/' + id + '/export?format=md')).text();
  check('markdown export has minutes and transcript', md.includes('转写全文') && md.length > 500, md.length + ' chars');
  const vtt = await (await fetch(BASE + '/api/meetings/' + id + '/export?format=vtt&translated=1')).text();
  check('vtt export is valid', vtt.startsWith('WEBVTT'), vtt.split('\n').length + ' lines');

  // 7. Q&A
  let answer = null;
  try {
    const qa = await (await fetch(BASE + '/api/meetings/' + id + '/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '谁负责移动端方案？截止时间是什么时候？' }),
    })).json();
    answer = qa.entry && qa.entry.answer;
  } catch (err) {
    answer = 'ERROR ' + err.message;
  }
  check('Q&A answers from the transcript', !!answer && /王|周五|方案/.test(answer), (answer || '').slice(0, 120));

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? 'ALL ' + results.length + ' CHECKS PASSED'
    : failed.length + '/' + results.length + ' CHECKS FAILED');
  console.log('open ' + BASE + '/?meeting=' + id);

  ws.close();
  process.exitCode = failed.length ? 1 : 0;
}

await main();
