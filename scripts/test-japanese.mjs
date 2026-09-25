#!/usr/bin/env node
// test-japanese.mjs — does the Japanese path actually work?
//
// An important correction this script exists to enforce: the FIRST version of
// this test used MiMo TTS to synthesize "Japanese" audio, and both MiMo and
// Groq then produced gibberish. That result was confounded — MiMo-V2.5-TTS
// does not actually speak Japanese, it reads the text with Chinese phonemes.
// The ASR models were handed audio that was never Japanese.
//
// The fixture is synthesized by a real Japanese engine (Windows SAPI).
// MiMo ASR is documented for Chinese and English, so this test verifies
// Japanese is rejected before a MiMo API call and routed to Groq instead.
//
// then drives the full product flow through the server.
//
// usage: node scripts/test-japanese.mjs [baseUrl]

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { loadCreds } from '../lib/env.mjs';
import { loadConfig } from '../lib/config.mjs';
import { parseWav, sliceOnSilence } from '../lib/wav.mjs';
import { createAsrRegistry } from '../lib/asr/index.mjs';
import { create as createMimo } from '../lib/asr/mimo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.probe', 'ja-fixture');
const FIXTURE = join(OUT, 'ja-meeting-sapi.wav');
const BASE = process.argv[2] || 'http://127.0.0.1:8777';

const EXPECTED = ['会議', '発表', '予算', '計画書', '田中', '金曜日'];
// Hallucination signatures. NOTE: these appeared when the fixture was made by
// MiMo TTS, which does not actually speak Japanese - see
// scripts/confirm-tts-hypothesis.mjs. Real Japanese audio is recognised fine.
const GIBBERISH = /クルニタバ|ワット·|舍での|ハビオト|ケイメタ|キネドノ|くるにたば/;

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 600000 }, (err, so, se) =>
      err ? reject(new Error(cmd + ': ' + (se || err.message).slice(0, 300))) : resolve(so));
  });
}

const kanaCount = (s) => (s.match(/[ぁ-んァ-ヶ]/g) || []).length;
const hits = (s) => EXPECTED.filter((w) => s.includes(w));

async function main() {
  // ---- fixture -----------------------------------------------------------
  if (!existsSync(FIXTURE)) {
    console.log('generating the Japanese fixture with Windows SAPI...');
    await run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'make-ja-fixture.ps1')]);
  }
  if (!existsSync(FIXTURE)) {
    console.error('missing fixture: ' + FIXTURE);
    process.exitCode = 1;
    return;
  }
  const wav = readFileSync(FIXTURE);
  const info = parseWav(wav);
  console.log('fixture: ' + FIXTURE);
  console.log('         ' + info.durationSec.toFixed(1) + ' s @ ' + info.sampleRate + ' Hz (Windows 日语 SAPI)');

  // ---- Japanese provider and guard --------------------------------------
  console.log('');
  console.log('=== Japanese ASR routing ===');

  const creds = loadCreds();
  const config = loadConfig();
  const abConfig = JSON.parse(JSON.stringify(config));
  abConfig.asr.providers.groq.enabled = true;
  abConfig.asr.active = 'auto';
  const reg = createAsrRegistry(abConfig, creds);

  // chunk the audio the way the import pipeline does, then join results
  const chunks = sliceOnSilence(wav, {
    maxChunkSec: 25, minChunkSec: 3,
    silenceMs: 600, vadThreshold: config.realtime.vadThreshold,
  });
  console.log('audio split into ' + chunks.length + ' segments by silence');

  async function transcribeAll(providerName) {
    const provider = reg.get(providerName);
    const out = [];
    let ms = 0;
    let cost = 0;
    for (const c of chunks) {
      const t0 = Date.now();
      const r = await provider.transcribe(c.buffer, { language: 'ja', sampleRate: info.sampleRate });
      ms += Date.now() - t0;
      cost += ((r.seconds || c.duration) / 3600) * (abConfig.asr.providers[providerName].pricePerHour || 0);
      if (r.text) out.push(r.text);
    }
    return { text: out.join(''), ms, cost };
  }

  let groq = null;
  check('Japanese routes to Groq', reg.pick('ja')?.name === 'groq');
  let mimoRejected = false;
  try {
    await createMimo(abConfig.asr.providers.mimo, { XIAOMI_API_KEY: 'test' })
      .transcribe(chunks[0].buffer, { language: 'ja', sampleRate: info.sampleRate });
  } catch (err) {
    mimoRejected = /不支持该语言/.test(err.message);
  }
  check('MiMo rejects explicit Japanese before sending audio', mimoRejected);
  try {
    groq = await transcribeAll('groq');
    console.log('');
    console.log('Groq whisper-large-v3-turbo (' + (groq.ms / 1000).toFixed(1) + 's, $' + groq.cost.toFixed(5) + '):');
    console.log('  ' + groq.text);
  } catch (err) {
    console.log('Groq FAILED: ' + err.message);
  }

  console.log('');
  if (groq) {
    check('Groq returns kana (it really is Japanese)', kanaCount(groq.text) >= 10, kanaCount(groq.text) + ' kana');
    check('Groq recognises the actual content', hits(groq.text).length >= 3,
      JSON.stringify(hits(groq.text)) + ' of ' + JSON.stringify(EXPECTED));
  } else {
    check('Groq transcription', false, 'request failed');
  }

  // ---- full product flow -------------------------------------------------
  console.log('');
  console.log('=== full flow through the server ===');

  const boot = await (await fetch(BASE + '/api/bootstrap')).json();
  const jaRoute = boot.status.active !== 'auto' ? boot.status.active : boot.status.routes.ja;
  const jaProvider = boot.status.asr.find((p) => p.name === jaRoute);
  check('a Japanese-capable engine is routed and ready',
    !!jaProvider && jaProvider.ready && jaProvider.languages.includes('ja'),
    jaRoute + ' ready=' + (jaProvider && jaProvider.ready));
  if (!jaProvider || !jaProvider.ready) {
    console.log('\nCannot continue without a usable Japanese engine.');
    console.log(failed() === 0 ? 'ALL PASSED' : 'FAILED');
    process.exitCode = 1;
    return;
  }

  const created = await (await fetch(BASE + '/api/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '日本語テスト会議（SAPI）', language: 'ja', translateTo: 'zh', source: 'upload' }),
  })).json();
  const id = created.meeting.id;

  const up = await fetch(BASE + '/api/meetings/' + id + '/import?name=' + encodeURIComponent('ja-meeting-sapi.wav'), {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  });
  check('upload accepted', up.status === 202, 'HTTP ' + up.status);

  console.log('transcribing through ' + jaRoute + ' ...');
  const t0 = Date.now();
  let doc = null;
  while (Date.now() - t0 < 420000) {
    doc = (await (await fetch(BASE + '/api/meetings/' + id)).json()).meeting;
    if (doc.state === 'stopped' && doc.segments.length) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log('--- transcript (' + doc.segments.length + ' segments, ' + elapsed + 's wall clock) ---');
  for (const s of doc.segments) {
    console.log('  ' + s.text);
    if (s.translation) console.log('    zh> ' + s.translation);
  }
  const text = doc.segments.map((s) => s.text).join('');

  console.log('');
  check('server transcribed real Japanese', hits(text).length >= 3, JSON.stringify(hits(text)));
  check('server did NOT fall back to MiMo gibberish', !GIBBERISH.test(text));
  check('engine recorded as the Japanese provider',
    doc.upstream && doc.upstream.provider === jaRoute, doc.upstream ? doc.upstream.label : 'none');
  check('translations produced for every segment',
    doc.segments.length > 0 && doc.segments.every((s) => s.translation),
    doc.segments.filter((s) => s.translation).length + '/' + doc.segments.length);
  check('structured minutes generated', !!doc.minutes, doc.minutes ? 'ok' : 'none');

  const stats = doc.stats || {};
  check('cost accounted', (stats.asrSeconds || 0) > 5,
    (stats.asrSeconds || 0).toFixed(1) + 's audio / ' + stats.asrCalls + ' calls = $' +
    (Math.round((stats.asrCost || 0) * 100000) / 100000));

  console.log('');
  console.log('open ' + BASE + '/?meeting=' + id);
  report();
}

function failed() {
  return results.filter((x) => !x).length;
}
function report() {
  const f = failed();
  console.log(f === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : f + '/' + results.length + ' FAILED');
  process.exitCode = f ? 1 : 0;
}

await main();
