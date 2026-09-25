#!/usr/bin/env node
// probe3.mjs - can MiMo's audio-understanding models transcribe Japanese?
//
// mimo-v2.5-asr is locked to zh/en. But mimo-v2.6-pro / v2.6-flash accept an
// input_audio part plus a TEXT instruction, which is a general audio-LLM.
// If a transcription instruction works, Japanese is solved with the key the
// user already has - no new provider, no new signup.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cred } from '../lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.probe');
const KEY = cred('XIAOMI_API_KEY');
const URL = 'https://api.xiaomimimo.com/v1/chat/completions';

const ja = readFileSync(join(OUT, 'tts-ja.wav'));
const zh = readFileSync(join(OUT, 'tts-zh.wav'));
const b64 = (b) => 'data:audio/wav;base64,' + b.toString('base64');

const EXPECTED_JA = 'こんにちは。私は東京で勉強している留学生です。今日の会議では、来月の発表について話し合いましょう。';

const INSTRUCTIONS = {
  'zh-verbatim': '请逐字转写这段音频的内容，严格使用音频原本的语言，只输出转写文本，不要翻译，不要解释，不要加任何前后缀。',
  'en-verbatim': 'Transcribe this audio verbatim in its original language. Output ONLY the transcription, no translation, no commentary, no preamble.',
};

async function call(model, wav, instruction, { maxTokens = 800 } = {}) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: b64(wav) } },
            { type: 'text', text: instruction },
          ],
        },
      ],
      max_completion_tokens: maxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(240000),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) return { ok: false, ms, error: 'HTTP ' + res.status + ' ' + text.slice(0, 300) };
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, ms, error: 'bad json ' + text.slice(0, 200) }; }
  const msg = j.choices?.[0]?.message || {};
  return {
    ok: true, ms,
    content: (msg.content || '').trim(),
    reasoning: (msg.reasoning_content || '').slice(0, 200),
    finish: j.choices?.[0]?.finish_reason,
    usage: j.usage,
  };
}

function score(expected, got) {
  if (!got) return 0;
  // crude similarity: how many 2-grams of the expected text survive
  const norm = (s) => s.replace(/[\s、。,.!！?？·]/g, '');
  const e = norm(expected), g = norm(got);
  if (!e) return 0;
  let hit = 0, total = 0;
  for (let i = 0; i + 2 <= e.length; i++) {
    total++;
    if (g.includes(e.slice(i, i + 2))) hit++;
  }
  return total ? hit / total : 0;
}

console.log('expected JA : ' + EXPECTED_JA);
console.log('');

const models = ['mimo-v2.6-flash', 'mimo-v2.6-pro'];

for (const model of models) {
  for (const [name, instruction] of Object.entries(INSTRUCTIONS)) {
    const r = await call(model, ja, instruction);
    if (!r.ok) {
      console.log(model + ' [' + name + '] FAILED: ' + r.error);
      continue;
    }
    const s = score(EXPECTED_JA, r.content);
    console.log(model + ' [' + name + '] ' + r.ms + 'ms finish=' + r.finish +
      ' match=' + (s * 100).toFixed(0) + '%');
    console.log('   ' + (r.content || '(empty)').slice(0, 300));
    console.log('');
  }
}

console.log('--- Chinese control (audio-understanding vs dedicated ASR) ---');
const EXPECTED_ZH = '大家好，今天的会议主要讨论三个议题：第一是下个季度的产品路线图，第二是预算分配，第三是人员招聘计划。';
for (const model of ['mimo-v2.6-flash', 'mimo-v2.6-pro']) {
  const r = await call(model, zh, INSTRUCTIONS['zh-verbatim']);
  console.log(model + ': ' + (r.ok ? r.ms + 'ms match=' + (score(EXPECTED_ZH, r.content) * 100).toFixed(0) + '%' : 'FAILED ' + r.error));
  if (r.ok) console.log('   ' + (r.content || '(empty)').slice(0, 240));
}
