#!/usr/bin/env node
// Offline checks that a finished recording keeps its audio and that an
// interrupted one is turned back into a playable WAV on the next start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = fs.mkdtempSync(join(tmpdir(), 'babel-lifecycle-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
try {
  const store = await import('../lib/store.mjs');
  const { Meeting } = await import('../lib/meeting.mjs');
  const { DEFAULT_CONFIG, TMP_DIR, AUDIO_DIR } = await import('../lib/config.mjs');
  const { recoverInterruptedRecordings } = await import('../lib/recovery.mjs');
  const { wavHeader } = await import('../lib/wav.mjs');
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.autoMs = 0;

  // -- a stopped meeting cannot be restarted over its own audio ---------------
  const m = new Meeting({ id: 'finished-meeting', config, translateTo: '' });
  m.start();
  m.ingest(new Int16Array(16000));
  let saved = 0;
  m.on((evt) => { if (evt.type === 'saved') saved++; });
  const first = m.stop();
  assert.equal(m.stop(), first, 'concurrent stops share one finish');
  await Promise.all([first, m.stop()]);
  assert.equal(saved, 1, 'audio is finalised once');
  assert.equal(m.state, 'stopped');
  const audio = store.findAudio(m.id);
  assert.ok(audio, 'the recording is saved');
  const before = fs.readFileSync(audio.path);
  assert.throws(() => m.start(), /已结束/);
  assert.equal(m.state, 'stopped');
  await m.stop();
  assert.deepEqual(fs.readFileSync(audio.path), before, 'restart attempts leave the saved audio untouched');
  assert.equal(fs.existsSync(join(TMP_DIR, m.id + '.pcm')), false);
  m.dispose();

  const restored = Meeting.restore(store.loadMeeting('finished-meeting'), { config });
  assert.throws(() => restored.start(), /已结束/, 'a reopened history meeting cannot record again');
  const importing = new Meeting({ id: 'importing-meeting', config, translateTo: '' });
  importing.state = 'processing';
  assert.throws(() => importing.start(), /已结束/, 'recording cannot hijack a running import');
  console.log('PASS finished meetings refuse to record again and stop only once');

  // -- crash recovery ----------------------------------------------------------
  const interrupted = new Meeting({ id: 'crashed-meeting', config, translateTo: '' });
  interrupted.title = '中断的会议';
  interrupted.state = 'recording';
  interrupted.durationMs = 500;
  interrupted.save();
  const samples = Buffer.alloc(16000 * 2 * 2 + 1, 7); // 2 s plus a torn byte
  fs.writeFileSync(join(TMP_DIR, 'crashed-meeting.pcm'), Buffer.concat([wavHeader(16000, 0, 1), samples]));
  fs.writeFileSync(join(TMP_DIR, 'unknown-meeting.pcm'), Buffer.concat([wavHeader(16000, 0, 1), samples]));
  fs.writeFileSync(join(TMP_DIR, 'empty-meeting.pcm'), wavHeader(16000, 0, 1));

  // Another live server owns the directory: its .pcm files are live, not lost.
  fs.writeFileSync(join(TMP_DIR, 'recorder.pid'), String(process.ppid));
  assert.deepEqual(recoverInterruptedRecordings({ log: () => {} }), []);
  assert.ok(fs.existsSync(join(TMP_DIR, 'crashed-meeting.pcm')));

  fs.writeFileSync(join(TMP_DIR, 'recorder.pid'), '999999999');
  const logs = [];
  assert.deepEqual(recoverInterruptedRecordings({ log: (line) => logs.push(line) }), ['crashed-meeting']);
  const wav = fs.readFileSync(join(AUDIO_DIR, 'crashed-meeting.wav'));
  assert.equal(wav.length, 44 + 64000);
  assert.equal(wav.readUInt32LE(4), 36 + 64000);
  assert.equal(wav.readUInt32LE(40), 64000);
  const doc = store.loadMeeting('crashed-meeting');
  assert.equal(doc.state, 'stopped');
  assert.equal(doc.title, '中断的会议');
  assert.deepEqual(doc.audio, { ext: '.wav', bytes: 44 + 64000 });
  assert.equal(doc.durationMs, 2000);
  assert.equal(fs.existsSync(join(TMP_DIR, 'crashed-meeting.pcm')), false);
  assert.ok(fs.existsSync(join(TMP_DIR, 'unknown-meeting.pcm')), 'unclaimed audio is kept for manual recovery');
  assert.ok(logs.some((line) => line.includes('unknown-meeting.pcm')));
  assert.equal(fs.existsSync(join(TMP_DIR, 'empty-meeting.pcm')), false, 'header-only files hold no audio');
  assert.equal(fs.readFileSync(join(TMP_DIR, 'recorder.pid'), 'utf8'), String(process.pid));
  assert.deepEqual(recoverInterruptedRecordings({ log: () => {} }), [], 'recovery is idempotent');
  console.log('PASS interrupted recordings become playable WAV files on the next start');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
