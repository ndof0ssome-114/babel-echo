#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Meeting, trimRepeatedPrefix } from '../lib/meeting.mjs';
import { DEFAULT_CONFIG } from '../lib/config.mjs';

const speech = Int16Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 12) * 3000));
const silent = new Int16Array(3200);
const makeMeeting = (config, provider = 'mimo') => {
  const meeting = new Meeting({ id: 'timing-test', config, language: 'zh', translateTo: '',
    asr: { pick: () => ({ name: provider }) }, llm: null, creds: {} });
  meeting.state = 'recording';
  const jobs = [];
  meeting.scheduleAsr = (job) => jobs.push(job);
  return { meeting, jobs };
};

const regular = makeMeeting(structuredClone(DEFAULT_CONFIG));
for (let second = 0; second < 10; second++) regular.meeting.ingest(speech);
assert.deepEqual(regular.jobs.filter((job) => !job.final).map((job) => job.endMs), [3000, 6000, 9000]);
console.log('PASS preview interval is measured from the previous preview, not just the start');

const customConfig = structuredClone(DEFAULT_CONFIG);
customConfig.realtime.stepMs = 5000;
const custom = makeMeeting(customConfig);
for (let second = 0; second < 11; second++) custom.meeting.ingest(speech);
assert.deepEqual(custom.jobs.filter((job) => !job.final).map((job) => job.endMs), [5000, 10000]);
console.log('PASS custom preview interval controls actual send times');

const boundaryConfig = structuredClone(DEFAULT_CONFIG);
boundaryConfig.realtime.maxUtteranceMs = 10000;
boundaryConfig.realtime.stepMs = 60000;
const boundary = makeMeeting(boundaryConfig);
for (let second = 0; second < 11; second++) boundary.meeting.ingest(speech);
assert.equal(boundary.jobs.length, 0, 'keep speaking briefly beyond the soft maximum');
boundary.meeting.ingest(speech);
assert.equal(boundary.jobs.length, 1);
assert.equal(boundary.jobs[0].final, true);
assert.equal(boundary.meeting.utterance.overlapUntilMs, 12000);
assert.equal(boundary.meeting.utterance.startMs, 10800);
assert.equal(boundary.meeting.utterance.sampleCount, 19200);
for (let i = 0; i < 7; i++) boundary.meeting.ingest(silent);
assert.equal(boundary.jobs.length, 2);
assert.equal(boundary.jobs[1].overlapUntilMs, 12000);
console.log('PASS a long sentence waits for a pause, then keeps 1.2 seconds across a forced split');

const integrationConfig = structuredClone(boundaryConfig);
let calls = 0;
const integrated = new Meeting({ id: 'overlap-integration', config: integrationConfig,
  language: 'zh', translateTo: '', llm: null, creds: {}, asr: {
    pick: () => ({ name: 'mimo' }),
    async transcribe() {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { text: ++calls === 1 ? '前半的内容继续说明' : '继续说明后半的内容',
        provider: 'MiMo', providerName: 'mimo', utterances: [], seconds: 1 };
    },
  } });
integrated.state = 'recording';
integrated.save = () => {};
integrated.scheduleTranslate = () => {};
for (let second = 0; second < 13; second++) integrated.ingest(speech);
for (let i = 0; i < 7; i++) integrated.ingest(silent);
await integrated.whenIdle();
assert.deepEqual(integrated.segments.map((segment) => segment.text), ['前半的内容继续说明', '后半的内容']);
assert.ok(integrated.segments[1].start >= integrated.segments[0].end);
console.log('PASS queued final ASR jobs retain the sentence and remove duplicated overlap text');

assert.equal(trimRepeatedPrefix('本日はよろしくお願いします', 'お願いします。次の議題です'), '次の議題です');
assert.equal(trimRepeatedPrefix('We will discuss the budget', 'the budget and deadline'), 'and deadline');
assert.equal(trimRepeatedPrefix('はい', 'はい、次です'), 'はい、次です', 'short repeated words must not be erased');
console.log('PASS duplicate text at an overlap boundary is removed conservatively');

const silentLead = makeMeeting(structuredClone(DEFAULT_CONFIG));
for (let second = 0; second < 25; second++) silentLead.meeting.ingest(new Int16Array(16000));
silentLead.meeting.ingest(speech);
assert.ok(silentLead.meeting.utterance.startMs >= 24000, 'long preceding silence must not shorten the first sentence');
console.log('PASS long initial silence does not consume the sentence limit');
