#!/usr/bin/env node
// Offline checks for sentence reassembly, translation context and
// whole-recording speaker correction. No network, no real audio.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'babel-sentences-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');

try {
  const { splitSentences, endsSentence, joinText, groupSentences } = await import('../lib/sentences.mjs');
  const { assignSpeakers, speakerNames } = await import('../lib/diarize.mjs');
  const { DEFAULT_CONFIG, ensureDirs } = await import('../lib/config.mjs');
  const { Meeting } = await import('../lib/meeting.mjs');
  const { saveMeeting, audioPath, loadMeeting } = await import('../lib/store.mjs');
  ensureDirs();

  assert.deepEqual(splitSentences('今天开会。讨论预算！还有'), ['今天开会。', '讨论预算！', '还有']);
  assert.deepEqual(splitSentences('「はい。」そうです'), ['「はい。」', 'そうです']);
  assert.deepEqual(splitSentences('Version 3.5 shipped. Next we'), ['Version 3.5 shipped.', 'Next we']);
  assert.equal(endsSentence('终于结束了。'), true);
  assert.equal(endsSentence('他说「好的。」'), true);
  assert.equal(endsSentence('然后我们'), false);
  assert.equal(endsSentence('pi is 3.14'), false);
  assert.equal(joinText('我们下周', '再讨论'), '我们下周再讨论');
  assert.equal(joinText('we will', 'meet'), 'we will meet');
  assert.deepEqual(groupSentences(['短。', '也短。', '这一句比较长一些。'], 6), ['短。也短。', '这一句比较长一些。']);
  console.log('PASS sentence splitting, joining and grouping');

  const config = structuredClone(DEFAULT_CONFIG);
  const meeting = (id, extra = {}) => new Meeting({ id, config, translateTo: '', asr: null, llm: null, creds: {}, ...extra });

  // A hard cut in the middle of a sentence continues the same segment.
  const live = meeting('a00000000001');
  const events = [];
  live.on((evt) => events.push(evt));
  live.addText({ text: '我们先看预算。然后下个季度的', start: 0, end: 20000, speaker: '说话人1' });
  assert.equal(live.segments.length, 2);
  assert.equal(live.segments[1].open, true, 'an unfinished sentence stays open');
  assert.deepEqual(live.translateQueue, [1], 'only complete sentences are queued for translation');
  live.addText({ text: '计划要重新排。另外', start: 19000, end: 39000, speaker: '说话人1' });
  assert.equal(live.segments.length, 3);
  assert.equal(live.segments[1].text, '然后下个季度的计划要重新排。');
  assert.equal(live.segments[1].open, undefined, 'a completed sentence is closed');
  assert.ok(live.segments[1].end > 20000 && live.segments[1].end < 39000, 'the grown sentence ends inside the new piece');
  assert.deepEqual(live.translateQueue, [1, 2]);
  assert.ok(events.some((e) => e.type === 'segment-update' && e.index === 2 && e.text === '然后下个季度的计划要重新排。'));
  // A different speaker or a long gap never continues the sentence.
  live.addText({ text: '我同意', start: 39100, end: 41000, speaker: '说话人2' });
  assert.equal(live.segments[2].text, '另外');
  assert.equal(live.segments[2].open, undefined);
  live.addText({ text: '好的', start: 45000, end: 46000, speaker: '说话人2' });
  assert.equal(live.segments.at(-2).text, '我同意', 'a gap longer than the continuation window closes the sentence');
  live.closeOpenSegment();
  assert.ok(live.segments.every((s) => !s.open));
  console.log('PASS cut sentences are reassembled and translated once complete');

  // A long run of short sentences is grouped instead of one 280-character block.
  const block = meeting('a00000000002');
  const sentence = '这是一个用来测试分组的句子。';
  block.addText({ text: sentence.repeat(20), start: 0, end: 28000, speaker: '说话人1' });
  assert.ok(block.segments.length >= 3, 'long blocks are split into several segments');
  assert.ok(block.segments.every((s) => s.text.length <= 80 + sentence.length));
  assert.equal(block.segments.at(-1).end, 28000);
  for (let i = 1; i < block.segments.length; i++) assert.equal(block.segments[i].start, block.segments[i - 1].end, 'timestamps are contiguous');
  // Text with no punctuation at all is closed once it is long.
  const run = meeting('a00000000003');
  for (let i = 0; i < 6; i++) run.addText({ text: '没有标点的连续口语内容'.repeat(5), start: i * 20000, end: (i + 1) * 20000, speaker: '说话人1' });
  assert.ok(run.segments.length >= 2, 'unpunctuated speech does not grow one segment forever');
  console.log('PASS long blocks are grouped and unpunctuated speech is bounded');

  // Translation sees the preceding sentences as context.
  const calls = [];
  const llm = { json: async (task, messages) => {
    calls.push(messages);
    const items = JSON.parse(messages.at(-1).content.split('待翻译片段：\n')[1]);
    return { data: { translations: items.map((i) => ({ id: i.id, text: 'T' + i.id })) } };
  } };
  const tr = meeting('a00000000004', { translateTo: 'ja', llm });
  tr.addText({ text: '第一句。第二句。', start: 0, end: 4000, speaker: '说话人1' });
  await tr.flushTranslation(true);
  tr.addText({ text: '第三句。', start: 4100, end: 6000, speaker: '说话人1' });
  await tr.flushTranslation(true);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].at(-1).content.includes('前文'), 'the first batch has no context');
  assert.ok(calls[1].at(-1).content.includes('前文（仅供理解，不要翻译）：\n第一句。第二句。'), 'later batches carry previous sentences');
  assert.equal(tr.segments.at(-1).translation, 'T2');
  console.log('PASS translation carries previous sentences as context');

  // Whole-recording correction relabels by time and can be undone.
  assert.deepEqual([...assignSpeakers(
    [{ index: 1, start: 0, end: 4000 }, { index: 2, start: 4000, end: 9000 }, { index: 3, start: 9000, end: 9500 }, { index: 4, start: 9500, end: 12000 }],
    [{ start: 0.2, end: 3.5, speaker: 1 }, { start: 3.9, end: 4.3, speaker: 1 }, { start: 4.3, end: 8.8, speaker: 0 }, { start: 9.6, end: 11, speaker: 1 }],
  )], [[1, 1], [2, 0], [3, 0], [4, 1]], 'majority overlap wins and gaps inherit the previous speaker');
  assert.deepEqual([...speakerNames([{ index: 1 }, { index: 2 }], new Map([[1, 4], [2, 0]]))], [[4, '说话人1'], [0, '说话人2']]);

  config.asr.providers.deepgram.enabled = true;
  let sent = null;
  const fake = {
    name: 'deepgram',
    async transcribe(buffer, opts) {
      sent = { bytes: buffer.length, opts };
      return { seconds: 12, words: [
        { word: 'a', start: 0.1, end: 3.9, speaker: 0 },
        { word: 'b', start: 4.1, end: 7.9, speaker: 1 },
        { word: 'c', start: 8.1, end: 11.9, speaker: 0 },
      ] };
    },
  };
  const asr = { get: (name) => { if (name !== 'deepgram') throw new Error('unexpected ' + name); return fake; } };
  const done = meeting('a00000000005', { asr, language: 'ja' });
  done.addText({ text: '最初の発言です。', start: 0, end: 4000, speaker: '说话人1' });
  done.addText({ text: '次の人の発言です。', start: 4000, end: 8000, speaker: '说话人1' });
  done.addText({ text: '最初の人に戻ります。', start: 8000, end: 12000, speaker: '说话人1' });
  done.speakers = { s0: { name: '说话人1', key: 's0' } };
  done.state = 'stopped';
  done.durationMs = 12000;
  done.audio = { ext: '.wav', bytes: 10 };
  writeFileSync(audioPath(done.id, '.wav'), Buffer.alloc(10));
  const result = await done.diarizeRecording();
  assert.deepEqual(result, { speakers: 2, changed: 1 });
  assert.deepEqual(done.segments.map((s) => s.speaker), ['说话人1', '说话人2', '说话人1']);
  assert.deepEqual(Object.values(done.speakers).map((s) => s.name), ['说话人1', '说话人2']);
  assert.equal(sent.bytes, 10);
  assert.equal(sent.opts.language, 'ja');
  assert.equal(sent.opts.contentType, 'audio/wav');
  assert.equal(done.stats.asrSeconds, 12);
  saveMeeting(done);
  const restored = Meeting.restore(loadMeeting(done.id), { config, asr, llm: null, creds: {} });
  assert.ok(restored.speakerBackup, 'the undo point survives a restart');
  restored.undoDiarization();
  assert.deepEqual(restored.segments.map((s) => s.speaker), ['说话人1', '说话人1', '说话人1']);
  assert.deepEqual(restored.speakers, { s0: { name: '说话人1', key: 's0' } });
  assert.equal(restored.speakerBackup, null);
  assert.throws(() => restored.undoDiarization(), /没有可撤销/);
  console.log('PASS whole-recording speaker correction relabels, persists and undoes');

  // Refusals: a live meeting, no audio, no usable engine.
  const recording = meeting('a00000000006', { asr });
  recording.addText({ text: '一句。', start: 0, end: 1000, speaker: '说话人1' });
  recording.state = 'recording';
  await assert.rejects(recording.diarizeRecording(), /录音结束后/);
  recording.state = 'stopped';
  await assert.rejects(recording.diarizeRecording(), /没有保存音频/);
  recording.audio = { ext: '.wav' };
  config.asr.providers.deepgram.enabled = false;
  await assert.rejects(recording.diarizeRecording(), /Deepgram/);
  // Automatic correction is off by default and never throws.
  config.asr.providers.deepgram.enabled = true;
  await recording.autoDiarize();
  assert.equal(recording.speakerBackup, null, 'automatic correction is opt-in');
  console.log('PASS speaker correction refuses unsafe states and stays opt-in');

  // Old or crashed documents never keep a sentence open.
  const doc = { id: 'a00000000007', segments: [{ index: 1, start: 0, end: 1, text: '半句', speaker: '说话人1', open: true }] };
  const old = Meeting.restore(doc, { config, asr: null, llm: null, creds: {} });
  assert.equal(old.segments[0].open, undefined);
  assert.equal(old.speakerBackup, null);
  console.log('PASS restored meetings close unfinished sentences');

  // Manual speaker fixes: one sentence, rename, and merge by renaming.
  const fix = meeting('a00000000008');
  fix.addText({ text: '甲说一句。', start: 0, end: 1000, speaker: '说话人1' });
  fix.addText({ text: '乙说一句。', start: 1000, end: 2000, speaker: '说话人1' });
  fix.addText({ text: '丙说一句。', start: 2000, end: 3000, speaker: '说话人2' });
  fix.speakers = { s0: { name: '说话人1', key: 's0' }, s1: { name: '说话人2', key: 's1' } };
  const fixEvents = [];
  fix.on((evt) => fixEvents.push(evt));
  fix.setSegmentSpeaker(2, '王老师');
  assert.deepEqual(fix.segments.map((s) => s.speaker), ['说话人1', '王老师', '说话人2']);
  assert.ok(Object.values(fix.speakers).some((s) => s.name === '王老师'), 'a new speaker is registered');
  assert.ok(fixEvents.some((e) => e.type === 'segment-update' && e.index === 2 && e.speaker === '王老师'));
  fix.setSegmentSpeaker(99, '无效');
  fix.setSegmentSpeaker(1, '  ');
  assert.equal(fix.segments[0].speaker, '说话人1', 'unknown segments and blank names are ignored');
  fix.renameSpeaker('说话人2', '王老师');
  assert.deepEqual(fix.segments.map((s) => s.speaker), ['说话人1', '王老师', '王老师']);
  assert.equal(Object.values(fix.speakers).filter((s) => s.name === '王老师').length, 1, 'renaming onto an existing name merges');
  fix.renameSpeaker('说话人1', '李同学');
  assert.deepEqual(Object.values(fix.speakers).map((s) => s.name).sort(), ['李同学', '王老师'].sort());
  console.log('PASS speakers can be changed per sentence, renamed and merged');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
