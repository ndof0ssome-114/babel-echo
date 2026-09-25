#!/usr/bin/env node
// probe4.mjs - Japanese via MiMo audio understanding, with a real token budget.
//
// probe3 gave an empty message for Japanese on EVERY model. That is the same
// signature as the DeepSeek bug: reasoning tokens consumed the whole
// max_completion_tokens allowance. Re-run with headroom and dump the full
// reasoning so we can tell "cannot do Japanese" from "ran out of room".

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cred } from '../lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.probe');
const KEY = cred('XIAOMI_API_KEY');
const URL = 'https://api.xiaomimimo.com/v1/chat/completions';
const ja = readFileSync(join(OUT, 'tts-ja.wav'));
const b64 = (b) => 'data:audio/wav;base64,' + b.toString('base64');

const EXPECTED = 'こんにちは。私は東京で勉強している留学生です。今日の会議では、来月の発表について話し合いましょう。';

async function call(model, instruction, maxTokens) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [
        { type: 'input_audio', input_audio: { data: b64(ja) } },
        { type: 'text', text: instruction },
      ] }],
      max_completion_tokens: maxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(300000),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) return { ok: false, ms, error: 'HTTP ' + res.status + ' ' + text.slice(0, 200) };
  const j = JSON.parse(text);
  const ch = j.choices && j.choices[0];
  const msg = (ch && ch.message) || {};
  return {
    ok: true, ms,
    content: (msg.content || '').trim(),
    reasoning: msg.reasoning_content || '',
    finish: ch && ch.finish_reason,
    usage: j.usage || {},
  };
}

const INSTR = '这段音频是日语。请逐字转写为日语文本（漢字・かな），只输出转写结果，不要翻译成中文，不要解释。';

console.log('expected: ' + EXPECTED);
console.log('');

for (const [model, tokens] of [
  ['mimo-v2.6-pro', 4000],
  ['mimo-v2.6-flash', 4000],
  ['mimo-v2.5', 4000],
  ['mimo-v2.6-pro-ultraspeed', 4000],
]) {
  const r = await call(model, INSTR, tokens);
  if (!r.ok) { console.log(model + ': FAILED ' + r.error); continue; }
  console.log('=== ' + model + '  ' + r.ms + 'ms  finish=' + r.finish +
    '  usage=' + JSON.stringify(r.usage.completion_tokens_details || {}) +
    '  completion=' + r.usage.completion_tokens);
  console.log('  CONTENT  : ' + (r.content || '(EMPTY)'));
  console.log('  REASONING: ' + (r.reasoning || '(none)').replace(/\n/g, ' ').slice(0, 600));
  console.log('');
}
