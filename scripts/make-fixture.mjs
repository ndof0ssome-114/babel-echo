#!/usr/bin/env node
// make-fixture.mjs — synthesize a fake multi-turn meeting for end-to-end tests.
//
// Uses MiMo TTS to speak a five-line Chinese meeting, normalises each line to
// 16 kHz mono, and concatenates them with ~1.1 s pauses. The pauses are what
// the server-side VAD keys on, so the finished file exercises the same
// utterance-splitting path a live meeting does.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { cred } from '../lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '.probe', 'fixture');
mkdirSync(OUT, { recursive: true });

const KEY = cred('XIAOMI_API_KEY');
const MIMO = 'https://api.xiaomimimo.com/v1';

const LINES = [
  { who: '田中', text: '大家好，我是田中。今天这场会议主要讨论下个季度的产品路线图，以及预算的分配。',
    style: '用沉稳、正式的会议主持人语气，中速朗读。' },
  { who: '王小明', text: '我是王小明。我建议我们先把移动端的优先级提上来，因为最近用户反馈最多的就是手机端体验。',
    style: '用年轻、干脆的语气，语速稍快。' },
  { who: '田中', text: '同意这个方向。不过预算方面我需要先确认一下，目前我们大概还剩多少可用额度？',
    style: '用沉稳、略带疑问的语气。' },
  { who: '李静', text: '我查过了，账上大概还剩三十万人民币，足够支撑两个月的开发。如果超支需要走额外的审批流程。',
    style: '用清楚、专业、汇报式的语气。' },
  { who: '田中', text: '那就这样定了。小王下周五之前把移动端的详细方案发给我，李静负责确认预算审批流程，我这边周五给出最终排期。',
    style: '用总结、拍板的语气，语速中等。' },
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(cmd + ': ' + (stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

async function tts(text, style, outPath) {
  const res = await fetch(MIMO + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: style },
        { role: 'assistant', content: text },
      ],
      audio: { format: 'wav', voice: 'Chloe' },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error('tts HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const json = await res.json();
  const b64 = json?.choices?.[0]?.message?.audio?.data;
  if (!b64) throw new Error('no audio in response');
  writeFileSync(outPath, Buffer.from(b64, 'base64'));
}

async function main() {
  console.log('synthesizing ' + LINES.length + ' lines...');
  const norm = [];
  for (let i = 0; i < LINES.length; i++) {
    const raw = join(OUT, 'raw-' + i + '.wav');
    const fixed = join(OUT, 'norm-' + i + '.wav');
    process.stdout.write('  line ' + (i + 1) + ' (' + LINES[i].who + ') ... ');
    await tts(LINES[i].text, LINES[i].style, raw);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', fixed]);
    norm.push(fixed);
    console.log('ok');
  }

  const silence = join(OUT, 'silence.wav');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1.2', '-acodec', 'pcm_s16le', silence]);

  const listPath = join(OUT, 'list.txt');
  const lines = [];
  for (const n of norm) {
    lines.push("file '" + n.replace(/\\/g, '/') + "'");
    lines.push("file '" + silence.replace(/\\/g, '/') + "'");
  }
  writeFileSync(listPath, lines.join('\n') + '\n');

  const final = join(OUT, 'meeting.wav');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-acodec', 'pcm_s16le', final]);

  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', final]);
  const transcript = LINES.map((l) => l.who + ': ' + l.text).join('\n');
  writeFileSync(join(OUT, 'expected.txt'), transcript + '\n', 'utf8');

  console.log('');
  console.log('fixture : ' + final);
  console.log('duration: ' + String(probe).trim() + ' s');
  console.log('expected transcript written to ' + join(OUT, 'expected.txt'));
}

await main();
