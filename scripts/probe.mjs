#!/usr/bin/env node
// probe.mjs — verify the two provider keys and answer the one question that
// decides the whole architecture: can MiMo-V2.5-ASR transcribe Japanese?
//
// Method: synthesize known sentences with MiMo TTS, feed the resulting WAV
// back into MiMo ASR, and compare the round-trip text with the source. This
// exercises both products end to end and needs no external audio asset.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cred } from '../lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.probe');
mkdirSync(OUT, { recursive: true });

const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const DS_BASE = 'https://api.deepseek.com/v1';
const TIMEOUT = 120_000;

const log = (...a) => console.log(...a);
const hr = (t) => log('\n' + '─'.repeat(70) + '\n' + t + '\n' + '─'.repeat(70));

async function post(base, path, body, key, { raw = false } = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text);
}

/** Synthesize speech and return { wav: Buffer, ms }. */
async function tts(text, { voice = 'Chloe', style, key }) {
  const messages = [];
  if (style) messages.push({ role: 'user', content: style });
  messages.push({ role: 'assistant', content: text });
  const t0 = Date.now();
  const json = await post(
    MIMO_BASE,
    '/chat/completions',
    { model: 'mimo-v2.5-tts', messages, audio: { format: 'wav', voice } },
    key,
  );
  const b64 = json?.choices?.[0]?.message?.audio?.data;
  if (!b64) throw new Error('no audio in TTS response: ' + JSON.stringify(json).slice(0, 800));
  return { wav: Buffer.from(b64, 'base64'), ms: Date.now() - t0, voice };
}

/** Transcribe audio and return the text plus reported duration. */
async function asr(wav, { language = 'auto', key }) {
  const t0 = Date.now();
  const json = await post(
    MIMO_BASE,
    '/chat/completions',
    {
      model: 'mimo-v2.5-asr',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` },
            },
          ],
        },
      ],
      asr_options: { language },
    },
    key,
  );
  return {
    text: json?.choices?.[0]?.message?.content ?? '',
    seconds: json?.usage?.seconds ?? null,
    ms: Date.now() - t0,
    raw: json,
  };
}

// ---------------------------------------------------------------------------

const claude = { mimo: cred('XIAOMI_API_KEY'), ds: cred('DEEPSEEK_API_KEY') };

// 1. DeepSeek reachability + model list
hr('1. DeepSeek — credentials and models');
try {
  const res = await fetch(DS_BASE + '/models', {
    headers: { authorization: `Bearer ${claude.ds}` },
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json();
  log('status:', res.status);
  log('models:', (json.data || []).map((m) => m.id).join(', ') || JSON.stringify(json).slice(0, 300));
} catch (e) {
  log('FAILED:', e.message);
}

// 2. Xiaomi catalog
hr('2. Xiaomi MiMo — reachability');
try {
  const res = await fetch(MIMO_BASE + '/models', {
    headers: { authorization: `Bearer ${claude.mimo}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  log('status:', res.status);
  log('body:', body.slice(0, 500));
} catch (e) {
  log('FAILED:', e.message);
}

// 3. TTS -> ASR round trips
const CASES = [
  {
    id: 'zh',
    label: 'Chinese',
    text: '大家好，今天的会议主要讨论三个议题：第一是下个季度的产品路线图，第二是预算分配，第三是人员招聘计划。',
    style: '用平静、专业的会议发言语气朗读。',
    langs: ['zh', 'auto'],
  },
  {
    id: 'ja',
    label: 'Japanese',
    text: 'こんにちは。私は東京で勉強している留学生です。今日の会議では、来月の発表について話し合いましょう。',
    style: '落ち着いた、丁寧な会議の口調で読み上げてください。',
    langs: ['ja', 'auto'],
  },
  {
    id: 'en',
    label: 'English',
    text: 'Good morning everyone. Today we will review the product roadmap and the budget for the next quarter.',
    style: 'Calm, professional meeting tone.',
    langs: ['en', 'auto'],
  },
];

const summary = [];

for (const c of CASES) {
  hr(`3.${c.id} ${c.label} — TTS then ASR`);
  log('source:', c.text);
  let wav;
  try {
    const r = await tts(c.text, { style: c.style, key: claude.mimo });
    wav = r.wav;
    const p = join(OUT, `tts-${c.id}.wav`);
    writeFileSync(p, wav);
    log(`tts   : ok voice=${r.voice} bytes=${wav.length} in ${r.ms}ms -> ${p}`);
  } catch (e) {
    log('tts   : FAILED —', e.message);
    summary.push({ case: c.id, tts: 'FAIL', asr: '-' });
    continue;
  }

  for (const lang of c.langs) {
    try {
      const r = await asr(wav, { language: lang, key: claude.mimo });
      log(`asr[${lang}]: ${r.ms}ms  seconds=${r.seconds}`);
      log(`         ${r.text}`);
      summary.push({ case: c.id, lang, tts: 'ok', asr: 'ok', text: r.text });
    } catch (e) {
      log(`asr[${lang}]: FAILED — ${e.message}`);
      summary.push({ case: c.id, lang, tts: 'ok', asr: 'FAIL', text: e.message });
    }
  }
}

hr('SUMMARY');
console.log(JSON.stringify(summary, null, 2));
