// Real persistence and HTTP/WS boundaries, with mock LLMs and synthetic text only.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { useServerToken, socketUrl } from './server-auth.mjs';

const temp = mkdtempSync(join(tmpdir(), 'babel-notes-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
process.env.MIAOJI_ALLOW_ENV_CREDENTIALS = '0';
let server;
try {
  const { Meeting, toMarkdown } = await import('../lib/meeting.mjs');
  const { DEFAULT_CONFIG } = await import('../lib/config.mjs');
  const { saveMeeting, loadMeeting } = await import('../lib/store.mjs');
  const { minutesMessages, summaryMessages } = await import('../lib/prompts.mjs');
  const config = structuredClone(DEFAULT_CONFIG);
  const calls = [];
  let finishSummary, finishMinutes;
  const llm = {
    async call(task, messages, options) { calls.push({ task, messages, options }); return finishSummary ? await new Promise((r) => { finishSummary.resolve = r; }) : { text: '整理后的摘要' }; },
    async json(task, messages, options) { calls.push({ task, messages, options }); return finishMinutes ? await new Promise((r) => { finishMinutes.resolve = r; }) : { data: { abstract: '概述', topics: [{ title: '函数', detail: '原文解释', points: ['步骤一'] }] } }; },
    resolve() { return { model: 'mock-notes' }; },
  };
  const m = new Meeting({ id: 'notes-qa', config, llm, creds: {}, mode: 'class', notesDetail: 'detailed' });
  m.scheduleSave = () => {};
  m.segments = [{ index: 0, start: 0, end: 1000, speaker: '老师', text: '定义：函数描述对应关系。' }];
  const restore = (doc) => Meeting.restore(doc, { config, llm, creds: {} });
  const old = restore({ id: 'old-notes', segments: [], summary: '旧摘要', minutes: { abstract: '旧纪要' } });
  assert.equal(old.mode, 'meeting'); assert.equal(old.notesDetail, 'detailed');
  assert.equal(old.summaryMode, 'meeting'); assert.equal(old.minutes.abstract, '旧纪要');
  assert.throws(() => m.setNoteOptions({ mode: 'unknown' }));
  m.setNoteOptions({ notesDetail: 'standard' });
  const saved = saveMeeting(m);
  assert.equal(restore(loadMeeting(m.id)).mode, 'class');
  assert.equal(saved.notesDetail, 'standard');
  assert.equal(restore(saved).notesDetail, 'standard');
  console.log('PASS old notes stay readable; per-record mode/detail persist with validated options');

  const classPrompt = minutesMessages({ segments: m.segments, mode: 'class', notesDetail: 'detailed' });
  const meetingPrompt = minutesMessages({ segments: m.segments, mode: 'meeting', notesDetail: 'standard' });
  assert.match(classPrompt[0].content, /课堂笔记/); assert.match(classPrompt[0].content, /推导过程/);
  assert.match(classPrompt[1].content, /keyConcepts/); assert.match(classPrompt[1].content, /reviewQuestions/);
  assert.match(meetingPrompt[0].content, /取舍/); assert.doesNotMatch(meetingPrompt[1].content, /keyConcepts/);
  assert.match(summaryMessages({ newSegments: [], maxChars: 900, mode: 'class' })[0].content, /课堂摘要/);
  await m.generateMinutes();
  assert.equal(m.minutes.mode, 'class'); assert.equal(m.minutes.notesDetail, 'standard');
  assert.equal(calls.at(-1).options.maxTokens, 16000);
  assert.match(calls.at(-1).messages[0].content, /标准模式/);
  console.log('PASS classroom/meeting and detailed/standard prompts reach the actual LLM without expanded budgets');

  await m.summarize();
  const count = calls.length;
  m.setNoteOptions({ mode: 'meeting' });
  await m.summarize({ automatic: true });
  assert.equal(calls.length, count, 'changing mode must not trigger an automatic full replay');
  await m.summarize();
  assert.equal(m.summaryMode, 'meeting');
  assert.match(calls.at(-1).messages[1].content, /定义：函数/);
  assert.match(calls.at(-1).messages[1].content, /暂无，这是第一版/);
  m.segments.push({ index: 1, start: 1000, end: 2000, text: '新增的原文', speaker: '老师' });
  await m.summarize();
  assert.match(calls.at(-1).messages[1].content, /新增的原文/);
  assert.doesNotMatch(calls.at(-1).messages[1].content, /定义：函数/);
  assert.equal(calls.at(-1).options.maxTokens, 4000);
  console.log('PASS mode rebuild is explicit and subsequent summaries remain incremental');

  m.segments.push({ index: 2, text: '延迟的转写', start: 2000, end: 3000 });
  finishSummary = {};
  const pending = m.summarize();
  m.setNoteOptions({ mode: 'class' });
  finishSummary.resolve({ text: '过期的会议摘要' }); await pending;
  assert.notEqual(m.summary, '过期的会议摘要'); assert.equal(m.summaryUpTo, 1);
  finishSummary = null;
  const originalMinutes = m.minutes;
  finishMinutes = {};
  const pendingMinutes = m.generateMinutes();
  m.setNoteOptions({ notesDetail: 'detailed' });
  finishMinutes.resolve({ data: { abstract: '过期的纪要' } });
  await assert.rejects(pendingMinutes, /已切换/); assert.equal(m.minutes, originalMinutes);
  finishMinutes = null;
  console.log('PASS mode/detail changes prevent old in-flight responses from overwriting saved notes');

  const doc = { ...m.snapshot(), summaryMode: 'class', minutes: { mode: 'class', abstract: '课堂概述', topics: [{ title: '函数详解', detail: '定义的依据', points: ['一个步骤'] }],
    keyConcepts: [{ term: '函数', explanation: '对应关系' }], examples: [{ title: '例题一', explanation: '解法步骤' }],
    reviewQuestions: [{ question: '如何理解函数？', answer: '根据原文的回答' }],
    decisions: [{ decision: '结论', context: '结论的依据' }], risks: [{ risk: '条件限制', impact: '条件的影响' }],
    openQuestions: ['尚未解答'], chapters: [{ start: '00:00', title: '第一章', summary: '完整章节内容' }] } };
  const short = toMarkdown(doc, { includeTranscript: false });
  for (const term of ['课程笔记', '课堂摘要', '对应关系', '解法步骤', '根据原文的回答', '结论的依据', '条件的影响', '完整章节内容', '尚未解答']) assert.ok(short.includes(term), term);
  assert.doesNotMatch(short, /转写全文|延迟的转写/);
  assert.match(toMarkdown(doc), /转写全文/);
  console.log('PASS clean Markdown keeps detailed content and excludes only the transcript appendix');

  mkdirSync(join(temp, 'meetings'), { recursive: true });
  writeFileSync(join(temp, 'meetings', doc.id + '.json'), JSON.stringify(doc));
  server = spawn(process.execPath, ['server.mjs', '0'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notes test server timeout')), 15000);
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/).find((s) => s.startsWith('MIAOJI_READY '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(13))); }
    });
    server.once('error', reject);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exit ' + code)); });
  });
  const base = info.url;
  const token = useServerToken(base, info.accessToken);
  const api = '/api/meetings/' + doc.id;
  const noText = await (await fetch(new URL(api + '/export?format=md&includeTranscript=0', base))).text();
  assert.doesNotMatch(noText, /转写全文|延迟的转写/); assert.match(noText, /函数详解/);
  assert.match(await (await fetch(new URL(api + '/export?format=md&includeTranscript=1', base))).text(), /延迟的转写/);
  assert.equal((await (await fetch(new URL(api + '/export?format=json', base))).json()).segments.length, 3);
  const result = await fetch(new URL(api, base), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'meeting', notesDetail: 'standard' }) });
  assert.equal(result.status, 200); assert.equal((await result.json()).meeting.mode, 'meeting');
  assert.equal(JSON.parse((await import('node:fs')).readFileSync(join(temp, 'meetings', doc.id + '.json'))).notesDetail, 'standard');
  assert.equal((await fetch(new URL(api, base), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'invalid' }) })).status, 400);
  const newRecord = await (await fetch(new URL('/api/meetings', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'class', notesDetail: 'detailed' }) })).json();
  assert.equal(newRecord.meeting.mode, 'class');
  const ws = new WebSocket(socketUrl(new URL('/ws?meeting=' + doc.id, base), token));
  try {
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const meta = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Notes metadata timeout')), 3000);
      ws.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.type === 'meta') { clearTimeout(timer); resolve(message); } });
    });
    ws.send(JSON.stringify({ type: 'config-patch', mode: 'class', notesDetail: 'detailed' }));
    assert.equal((await meta).mode, 'class');
  } finally { ws.close(); }
  console.log('PASS HTTP export, saved options, legacy JSON, record creation and WebSocket changes');
} finally {
  if (server && server.exitCode === null) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)); }
  rmSync(temp, { recursive: true, force: true });
}
