#!/usr/bin/env node
import assert from 'node:assert/strict';
import { AsrRegistry } from '../lib/asr/index.mjs';
import { create as createAudioAdapter } from '../lib/asr/openai-audio.mjs';
import { Meeting } from '../lib/meeting.mjs';
import { DEFAULT_CONFIG } from '../lib/config.mjs';

const config = structuredClone(DEFAULT_CONFIG);
config.asr.providers.groq.enabled = true;
const starts = [];
let attempts = 0;
const registry = new AsrRegistry(config, {});
registry.groqRequestGapMs = 25;
registry.instances.set('groq', {
  name: 'groq', languages: ['ja'],
  async transcribe() {
    starts.push(Date.now());
    attempts++;
    if (attempts === 1) {
      const error = new Error('asr HTTP 429');
      error.status = 429;
      error.retryAfterMs = 50;
      throw error;
    }
    return { text: 'こんにちは', provider: 'Groq' };
  },
});
const result = await registry.transcribe('ja', Buffer.alloc(44));
assert.equal(result.text, 'こんにちは');
assert.equal(attempts, 2);
assert.ok(starts[1] - starts[0] >= 40, '429 retry must honor retry-after');
console.log('PASS Groq 429 is retried after the provider delay');

const pair = await Promise.all([
  registry.transcribe('ja', Buffer.alloc(44)),
  registry.transcribe('ja', Buffer.alloc(44)),
]);
assert.equal(pair.length, 2);
assert.ok(starts[3] - starts[2] >= 20, 'concurrent calls must be paced');
console.log('PASS Groq requests from concurrent callers are paced');

const meeting = new Meeting({
  id: 'limit-test', config, language: 'ja', translateTo: '',
  asr: registry, llm: null, creds: {},
});
meeting.state = 'recording';
const jobs = [];
meeting.scheduleAsr = (job) => jobs.push(job);
const frame = Int16Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 20) * 3000));
for (let second = 0; second < 9; second++) meeting.ingest(frame);
assert.equal(jobs.length, 0, 'Groq preview must wait for 10 seconds of speech');
meeting.ingest(frame);
assert.equal(jobs.filter((job) => !job.final).length, 1);
for (let second = 0; second < 9; second++) meeting.ingest(frame);
assert.equal(jobs.filter((job) => !job.final).length, 1);
meeting.ingest(frame);
assert.equal(jobs.filter((job) => !job.final).length, 2);
console.log('PASS Groq interim transcription runs at 10-second intervals');
meeting.interimJob = jobs.at(-1);
meeting.closeUtterance();
assert.equal(meeting.interimJob, null, 'closed utterance must discard its obsolete preview');
console.log('PASS final transcription discards the obsolete preview');

const savedFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('Please try again in 3s.', {
    status: 429, headers: { 'retry-after': '3' },
  });
  const adapter = createAudioAdapter({
    kind: 'openai-audio', model: 'whisper-large-v3-turbo', label: 'Groq',
    keyRef: 'TEST_KEY', baseUrl: 'https://example.invalid/openai/v1',
    languages: ['ja'],
  }, { TEST_KEY: 'test' });
  await assert.rejects(adapter.transcribe(Buffer.alloc(44), { language: 'ja' }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 3000);
    return true;
  });
  console.log('PASS Groq retry-after header is parsed');
} finally {
  globalThis.fetch = savedFetch;
}
