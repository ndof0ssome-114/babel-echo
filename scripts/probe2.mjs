#!/usr/bin/env node
// probe2.mjs — second round of experiments:
//   A. full Xiaomi model catalogue
//   B. streaming ASR time-to-first-token (the decisive number for live captions)
//   C. can a text hint nudge MiMo ASR into Japanese?
//   D. DeepSeek chat sanity on the real model ids
//   E. any local Whisper available as a Japanese fallback?

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cred } from '../lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.probe');
const MIMO = 'https://api.xiaomimimo.com/v1';
const DS = 'https://api.deepseek.com/v1';
const mimoKey = cred('XIAOMI_API_KEY');
const dsKey = cred('DEEPSEEK_API_KEY');

const hr = (t) => console.log('\n' + '─'.repeat(70) + '\n' + t + '\n' + '─'.repeat(70));

// A -----------------------------------------------------------------------
hr('A. Xiaomi model catalogue');
try {
  const r = await fetch(MIMO + '/models', { headers: { authorization: `Bearer ${mimoKey}` } });
  const j = await r.json();
  console.log(j.data.map((m) => m.id).join('\n'));
} catch (e) {
  console.log('FAILED', e.message);
}

const jaWav = readFileSync(join(OUT, 'tts-ja.wav'));
const zhWav = readFileSync(join(OUT, 'tts-zh.wav'));
const b64 = (b) => 'data:audio/wav;base64,' + b.toString('base64');

// B -----------------------------------------------------------------------
// Stream the ASR call and record when the first non-empty content delta lands.
async function streamAsr(wav, { language = 'auto', extra = {} } = {}) {
  const t0 = Date.now();
  const res = await fetch(MIMO + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mimoKey}` },
    body: JSON.stringify({
      model: 'mimo-v2.5-asr',
      stream: true,
      messages: [
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64(wav) } }] },
      ],
      asr_options: { language },
      ...extra,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };
  let ttft = null;
  let text = '';
  let seconds = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const d = j.choices?.[0]?.delta?.content;
      if (typeof d === 'string' && d.length) {
        if (ttft === null) ttft = Date.now() - t0;
        text += d;
      }
      if (j.usage?.seconds != null) seconds = j.usage.seconds;
    }
  }
  return { ttft, total: Date.now() - t0, text, seconds };
}

hr('B. streaming ASR — time to first token');
for (const [name, wav, lang] of [['zh/12s', zhWav, 'zh'], ['ja/11s', jaWav, 'auto']]) {
  try {
    const r = await streamAsr(wav, { language: lang });
    console.log(`${name} lang=${lang}: ${r.error ?? `ttft=${r.ttft}ms total=${r.total}ms seconds=${r.seconds}`}`);
    if (!r.error) console.log('   ', r.text);
  } catch (e) {
    console.log(`${name}: FAILED ${e.message}`);
  }
}

// C -----------------------------------------------------------------------
hr('C. can a text hint nudge ASR into Japanese?');
const hints = [
  { label: 'no-hint (baseline)', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64(jaWav) } }] }] },
  {
    label: 'text part + audio part',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this audio verbatim in Japanese (日本語).' },
          { type: 'input_audio', input_audio: { data: b64(jaWav) } },
        ],
      },
    ],
  },
  {
    label: 'system prompt',
    messages: [
      { role: 'system', content: 'You are a Japanese speech recognizer. Output only Japanese text.' },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64(jaWav) } }] },
    ],
  },
];
for (const h of hints) {
  try {
    const res = await fetch(MIMO + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mimoKey}` },
      body: JSON.stringify({ model: 'mimo-v2.5-asr', messages: h.messages, asr_options: { language: 'auto' } }),
      signal: AbortSignal.timeout(120_000),
    });
    const txt = await res.text();
    console.log(`\n[${h.label}] HTTP ${res.status}`);
    console.log('  ', txt.slice(0, 400).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`\n[${h.label}] FAILED ${e.message}`);
  }
}

// D -----------------------------------------------------------------------
hr('D. DeepSeek chat sanity');
for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  const t0 = Date.now();
  try {
    const r = await fetch(DS + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${dsKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是会议纪要助手。只输出JSON。' },
          { role: 'user', content: '把这句话抽成 {"决议":[...],"待办":[{"事项":"","负责人":"","截止":""}]}：小王下周把预算表发我，这周四之前必须定稿方案。' },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = await r.json();
    console.log(`\n${model}: HTTP ${r.status} in ${Date.now() - t0}ms`);
    console.log('  ', (j.choices?.[0]?.message?.content ?? JSON.stringify(j)).slice(0, 400).replace(/\n/g, ' '));
  } catch (e) {
    console.log(`\n${model}: FAILED ${e.message}`);
  }
}

// E -----------------------------------------------------------------------
hr('E. local Whisper availability (Japanese fallback)');
for (const c of ['whisper', 'whisper-cli', 'main', 'faster-whisper', 'python', 'py', 'uvx', 'pipx']) {
  try {
    const out = execFileSync('where', [c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    console.log(`${c.padEnd(14)} -> ${out.split(/\r?\n/)[0]}`);
  } catch {
    console.log(`${c.padEnd(14)} -> not found`);
  }
}
console.log('\nmodel cache dirs:');
for (const p of [join(homedir(), '.cache', 'whisper'), join(homedir(), '.cache', 'huggingface'), process.env.MIAOJI_MODEL_DIR].filter(Boolean)) {
  console.log(' ', p, existsSync(p) ? 'EXISTS' : '-');
}
