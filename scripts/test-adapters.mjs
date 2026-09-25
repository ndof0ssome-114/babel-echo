#!/usr/bin/env node
// test-adapters.mjs - exercise the ASR adapters that have no live key yet.
//
// Groq and Deepgram are the Japanese answer, but neither has a credential in
// this environment, so their request/response handling is verified against
// local mock endpoints. This catches the things that actually break in
// production: multipart field names, auth header shape, query parameters,
// and the mapping from provider JSON into our segment model.

import { createServer } from 'node:http';
import { DEFAULT_CONFIG } from '../lib/config.mjs';
import { createAsrRegistry } from '../lib/asr/index.mjs';
import { Meeting } from '../lib/meeting.mjs';
import { encodeWav } from '../lib/wav.mjs';

const PORT = 8788;
const KEY = 'test-key-123';
const captured = { openai: null, deepgram: null };

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function json(res, status, body) {
  const t = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(t);
}

const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (url.pathname === '/v1/audio/transcriptions') {
      captured.openai = {
        auth: req.headers.authorization,
        contentType: req.headers['content-type'] || '',
        text: body.toString('latin1'),
        bytes: body.length,
      };
      return json(res, 200, {
        text: 'こんにちは、テストです。今日は会議があります。',
        duration: 3.2,
        segments: [
          { start: 0, end: 1.6, text: 'こんにちは、テストです。' },
          { start: 1.6, end: 3.2, text: '今日は会議があります。' },
        ],
        words: [{ word: 'こんにちは', start: 0, end: 0.8 }],
      });
    }

    if (url.pathname === '/v1/listen') {
      captured.deepgram = {
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        query: Object.fromEntries(url.searchParams.entries()),
        bytes: body.length,
        isWav: body.toString('latin1', 0, 4) === 'RIFF',
      };
      return json(res, 200, {
        metadata: { duration: 5.5 },
        results: {
          channels: [{ alternatives: [{ transcript: 'Aです。Bです。', words: [
            { word: 'A', punctuated_word: 'A', start: 0, end: 0.5, speaker: 0 },
            { word: 'です', punctuated_word: 'です', start: 0.5, end: 2.5, speaker: 0 },
            { word: 'B', punctuated_word: 'B', start: 2.6, end: 3.0, speaker: 1 },
            { word: 'です', punctuated_word: 'です', start: 3.0, end: 5.5, speaker: 1 },
          ] }] }],
          utterances: [
            { start: 0, end: 2.5, transcript: 'Aです。', speaker: 0 },
            { start: 2.6, end: 5.5, transcript: 'Bです。', speaker: 1 },
          ],
        },
      });
    }

    json(res, 404, { error: 'no mock route ' + url.pathname });
  });
});

await new Promise((r) => mock.listen(PORT, '127.0.0.1', r));

const base = 'http://127.0.0.1:' + PORT + '/v1';

const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
config.asr.providers.groq.enabled = true;
config.asr.providers.groq.baseUrl = base;
config.asr.providers.deepgram.enabled = true;
config.asr.providers.deepgram.baseUrl = base;

const creds = { GROQ_API_KEY: KEY, DEEPGRAM_API_KEY: KEY };
const asr = createAsrRegistry(config, creds);

// a tiny 0.3 s tone so the WAV container is realistic
const pcm = new Int16Array(4800);
for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 12) * 8000);
const wav = encodeWav(pcm, 16000, 1);

// ---- OpenAI-compatible adapter (Groq / OpenAI / SiliconFlow / local) ------
console.log('\n=== openai-audio adapter (Groq shape) ===');
const groq = asr.get('groq');
const r1 = await groq.transcribe(wav, { language: 'ja' });
const cap = captured.openai;

check('sent Authorization: Bearer', cap.auth === 'Bearer ' + KEY, String(cap.auth));
check('used multipart/form-data', /multipart\/form-data; boundary=/.test(cap.contentType), cap.contentType.slice(0, 60));
check('included file part with filename', cap.text.includes('name="file"') && cap.text.includes('chunk.wav'));
check('sent model field', cap.text.includes('name="model"') && cap.text.includes('whisper-large-v3-turbo'));
check('sent language=ja', cap.text.includes('name="language"') && cap.text.includes('\r\nja\r\n'));
check('sent verbose_json', cap.text.includes('verbose_json'));
check('audio bytes reached the server', cap.text.includes('RIFF') && cap.text.includes('WAVE'));
check('parsed text', r1.text.startsWith('こんにちは'), r1.text);
check('parsed segment timestamps', r1.utterances.length === 2, JSON.stringify(r1.utterances.map((u) => [u.start, u.end])));
check('parsed duration', r1.seconds === 3.2, String(r1.seconds));

// ---- Deepgram adapter ----------------------------------------------------
console.log('\n=== deepgram adapter ===');
const dg = asr.get('deepgram');
const r2 = await dg.transcribe(wav, { language: 'ja' });
const cap2 = captured.deepgram;

check('sent Token auth', cap2.auth === 'Token ' + KEY, String(cap2.auth));
check('sent raw audio body', cap2.isWav && cap2.bytes > 1000, cap2.bytes + ' bytes, wav=' + cap2.isWav);
check('set content-type audio/wav', cap2.contentType === 'audio/wav', String(cap2.contentType));
check('requested nova-3', cap2.query.model === 'nova-3', JSON.stringify(cap2.query));
check('requested ja', cap2.query.language === 'ja');
check('enabled diarization', cap2.query.diarize === 'true');
check('requested utterances', cap2.query.utterances === 'true');
check('parsed utterances with speakers', r2.utterances.length === 2 && r2.utterances[1].speaker === 1,
  JSON.stringify(r2.utterances.map((u) => [u.speaker, u.text])));

// ---- diarization must split one chunk into two speakers -------------------
console.log('\n=== diarization integration (commitSegment) ===');
const meeting = new Meeting({
  id: 'adapter-test',
  title: 'diarization',
  language: 'ja',
  translateTo: null,
  config,
  asr,
  llm: null,
  creds: {},
});
meeting.commitSegment(r2, 0, 5500);
check('one audio chunk became two speaker segments', meeting.segments.length === 2,
  meeting.segments.map((s) => s.speaker + ':' + s.text).join(' | '));
check('segment start times offset by speaker turn',
  meeting.segments[0].start === 0 && meeting.segments[1].start === 2600,
  meeting.segments.map((s) => s.start).join(','));

// single-speaker result must stay a single segment
const meeting2 = new Meeting({ id: 'adapter-test-2', config, asr, llm: null, creds: {}, language: 'ja' });
meeting2.commitSegment(r1, 0, 3200);
check('single-speaker chunk stays one segment', meeting2.segments.length === 1,
  meeting2.segments.map((s) => s.text).join(''));

// ---- routing must honour the declared capability list ---------------------
// MiMo is documented for Chinese and English. A stale user configuration
// must not be allowed to route explicit Japanese audio to it.
console.log('\n=== language routing ===');
const single = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
single.asr.providers.groq.enabled = false;
single.asr.providers.deepgram.enabled = false;
single.asr.providers.local.enabled = false;

single.asr.providers.mimo.languages = ['zh', 'en'];
const asr2 = createAsrRegistry(single, { XIAOMI_API_KEY: 'x' });
const pickedJa = asr2.pick('ja');
check('a backend that does not declare ja is never chosen for Japanese',
  pickedJa === null, pickedJa ? pickedJa.name + ' langs=' + JSON.stringify(pickedJa.languages) : 'null');

single.asr.providers.mimo.languages = ['zh', 'en', 'ja']; // simulate a stale config
const asr2b = createAsrRegistry(single, { XIAOMI_API_KEY: 'x' });
const pickedJa2 = asr2b.pick('ja');
check('stale MiMo capability cannot override the Japanese restriction',
  pickedJa2 === null, pickedJa2 ? pickedJa2.name : 'null');

const asr3 = createAsrRegistry(config, creds);
check('ja routes to groq when enabled', asr3.pick('ja').name === 'groq', asr3.pick('ja').name);
check('zh still routes to mimo by preference',
  (() => {
    const c = JSON.parse(JSON.stringify(config));
    c.asr.providers.mimo.enabled = true;
    const reg = createAsrRegistry(c, { ...creds, XIAOMI_API_KEY: 'x' });
    return reg.pick('zh').name === 'mimo';
  })(), 'mimo');

mock.close();

console.log('');
const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : failed + '/' + results.length + ' FAILED');
process.exitCode = failed ? 1 : 0;
