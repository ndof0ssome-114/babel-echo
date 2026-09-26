#!/usr/bin/env node
// Offline cost and model routing regression checks. Never uses real keys.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'babel-cost-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
process.env.DSH_HOME = join(temp, 'dsh');
const originalFetch = globalThis.fetch;
try {
  const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import('../lib/config.mjs');
  const { Llm } = await import('../lib/llm.mjs');
  const { Meeting } = await import('../lib/meeting.mjs');
  const { saveMeeting, loadMeeting } = await import('../lib/store.mjs');
  const config = structuredClone(DEFAULT_CONFIG);
  const llm = new Llm(config, { DEEPSEEK_API_KEY: 'mock-key-only' });
  const requests = [];
  let responses = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const next = responses.shift();
    assert.ok(next, 'every request must have a mock response');
    if (next instanceof Error) throw next;
    return await next;
  };
  const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 5 } };
  const reply = (text = 'summary', finish = 'stop') => new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: finish }], usage,
  }), { status: 200 });
  const messages = [{ role: 'user', content: 'test' }];
  responses.push(reply());
  await llm.call('summary', messages, { maxTokens: 4000 });
  assert.deepEqual(requests.at(-1).body.thinking, { type: 'disabled' });
  assert.equal(requests.at(-1).body.model, 'deepseek-flash');
  config.llm.roles.summary.model = 'deepseek-v4-pro';
  config.llm.roles.summary.thinking = 'enabled';
  responses.push(reply());
  await llm.call('summary', messages);
  assert.equal(requests.at(-1).body.model, 'deepseek-v4-pro');
  assert.deepEqual(requests.at(-1).body.thinking, { type: 'enabled' });
  config.llm.roles.summary.thinking = 'default';
  responses.push(reply());
  await llm.call('summary', messages);
  assert.equal(requests.at(-1).body.thinking, undefined);
  config.llm.roles.summary.thinking = 'disabled';
  config.llm.providers.deepseek.baseUrl = 'http://127.0.0.1:1234/v1';
  config.llm.roles.summary.model = 'custom/model:latest';
  responses.push(reply());
  await llm.call('summary', messages);
  assert.equal(requests.at(-1).body.thinking, undefined);
  assert.equal(requests.at(-1).body.model, 'custom/model:latest');
  console.log('PASS selected model IDs and endpoint-specific thinking options reach the wire');

  const m = new Meeting({ id: 'cost-regression', config, llm, asr: null, creds: {}, translateTo: 'en' });
  m.scheduleSave = () => {};
  let before = requests.length;
  responses.push(reply('', 'length'));
  await assert.rejects(llm.call('summary', messages, m.llmOptions('summary', { maxTokens: 4000 })), /上限/);
  assert.equal(requests.length - before, 1);
  assert.equal(requests.at(-1).body.max_tokens, 4000);
  assert.equal(m.stats.completionTokens, 20);
  assert.equal(m.stats.reasoningTokens, 5);
  assert.equal(m.stats.cachedInputTokens, 40);
  before = requests.length;
  responses.push(new Error('mock timeout'));
  await assert.rejects(llm.call('summary', messages, m.llmOptions('summary')), /mock timeout/);
  assert.equal(requests.length - before, 1);
  assert.equal(m.stats.llmUnreportedCalls, 1);
  console.log('PASS truncated and uncertain requests are counted without larger automatic retries');

  responses.push(new Response('busy', { status: 429 }), reply('invalid JSON'), reply('{"translations":[]}'));
  const repaired = await llm.json('translate', messages, m.llmOptions('translate'));
  assert.deepEqual(repaired.data, { translations: [] });
  assert.equal(m.stats.llmByTask.translate.calls, 3);
  assert.equal(m.stats.llmByTask.translate.completionTokens, 40);
  assert.equal(m.stats.llmByTask.translate.unreportedCalls, 1);
  assert.equal(m.stats.llmCalls, 5);
  console.log('PASS HTTP retries and JSON repairs appear in per-task usage totals');

  m.segments = [{ index: 1, text: 'First sentence.', start: 0, end: 1000, speaker: 'A' }];
  before = requests.length;
  await m.summarize({ automatic: true });
  assert.equal(requests.length, before, 'automatic summary should wait for enough new text');
  let finishSummary;
  responses.push(new Promise((r) => { finishSummary = r; }));
  const pending = m.summarize(); // manual bypasses the automatic threshold
  m.segments.push({ index: 2, text: 'Arrived during request.', start: 1000, end: 2000, speaker: 'B' });
  finishSummary(reply('Previous summary.'));
  await pending;
  assert.equal(m.summaryUpTo, 1, 'in-flight arrivals must remain unsummarized');
  responses.push(reply('Updated summary.'));
  await m.summarize();
  const prompt = JSON.stringify(requests.at(-1).body.messages);
  assert.ok(prompt.includes('Previous summary.'));
  assert.ok(prompt.includes('Arrived during request.'));
  assert.ok(!prompt.includes('First sentence.'));
  before = requests.length;
  await m.summarize();
  assert.equal(requests.length, before, 'no new text means no paid call');
  const saved = saveMeeting(m);
  assert.equal(loadMeeting(m.id).summaryUpTo, 2);
  const restored = Meeting.restore(saved, { config, llm });
  restored.scheduleSave = () => {};
  await restored.summarize();
  assert.equal(requests.length, before, 'restored cursor prevents resending summarized text');
  const legacy = Meeting.restore({ ...saved, summary: null, summaryUpTo: undefined, stats: { llmCalls: 2 } }, { config, llm });
  assert.equal(legacy.summaryUpTo, -1);
  assert.equal(legacy.stats.historicalUsageIncomplete, true);
  console.log('PASS incremental summary snapshot, threshold, no-op and persistence');

  m.translateQueue = [1];
  responses.push(reply('{"translations":[{"id":1,"text":"Translation"}]}'));
  await m.flushTranslation(true);
  assert.equal(m.segments[0].translation, 'Translation');
  responses.push(reply('{}'));
  await m.generateMinutes();
  responses.push(reply('Answer'));
  await m.ask('Question');
  responses.push(reply('{"assignments":[]}'));
  await m.resplitSpeakers();
  for (const task of ['summary', 'translate', 'minutes', 'ask', 'speakers']) assert.ok(m.stats.llmByTask[task].calls > 0);
  assert.equal(m.stats.llmCalls, Object.values(m.stats.llmByTask).reduce((sum, task) => sum + task.calls, 0));
  assert.equal(m.stats.promptTokens, Object.values(m.stats.llmByTask).reduce((sum, task) => sum + task.promptTokens, 0));
  console.log('PASS translation, minutes, answers and speaker detection all report usage');

  const liveConfig = loadConfig();
  saveConfig({ summary: { autoMs: 60000 } });
  assert.equal(liveConfig.summary.autoMs, 60000);
  assert.throws(() => saveConfig({ summary: { autoMs: 1000 } }), /摘要/);
  assert.throws(() => saveConfig({ summary: { minNewChars: -1 } }), /摘要/);
  assert.throws(() => saveConfig({ llm: { roles: { summary: { thinking: 'invalid' } } } }), /思考/);
  saveConfig({ summary: { autoMs: 0 } });
  m.config = liveConfig;
  m.startSummaryTimer();
  assert.equal(m.summaryTimer, null);
  saveConfig({ summary: { autoMs: 180000 } });
  m.startSummaryTimer();
  assert.ok(m.summaryTimer);
  m.stopTimers();
  assert.equal(responses.length, 0);
  console.log('PASS summary settings validate, update in place and disable timers');
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + sep));
  rmSync(temp, { recursive: true, force: true });
}
