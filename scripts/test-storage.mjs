#!/usr/bin/env node
// Offline fault injection: a failed save must leave the previous meeting intact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = fs.mkdtempSync(join(tmpdir(), 'babel-storage-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
try {
  const store = await import('../lib/store.mjs');
  const { Meeting } = await import('../lib/meeting.mjs');
  const { DEFAULT_CONFIG } = await import('../lib/config.mjs');
  const meeting = new Meeting({ id: 'saved-meeting', config: structuredClone(DEFAULT_CONFIG), translateTo: '' });
  meeting.title = 'Original';
  meeting.save();
  meeting.title = 'Updated';

  for (const failure of ['write', 'rename']) {
    fs.writeFileSync = failure === 'write' ? (path, ...args) => {
      originalWrite(path, '{"incomplete":');
      throw new Error('simulated disk write failure');
    } : originalWrite;
    fs.renameSync = failure === 'rename' ? () => { throw new Error('simulated replacement failure'); } : originalRename;
    syncBuiltinESMExports();
    assert.throws(() => store.saveMeeting(meeting), /simulated/);
    assert.equal(store.loadMeeting(meeting.id)?.title, 'Original', failure + ' must preserve the previous JSON');
    assert.deepEqual(fs.readdirSync(join(temp, 'meetings')), ['saved-meeting.json'], 'failed save cleans its temporary file');
  }
  fs.writeFileSync = originalWrite;
  fs.renameSync = originalRename;
  syncBuiltinESMExports();
  store.saveMeeting(meeting);
  assert.equal(store.loadMeeting(meeting.id).title, 'Updated');
  assert.throws(() => store.saveMeeting({ id: '../invalid' }), /invalid meeting id/);
  console.log('PASS failed writes and replacements preserve the previous meeting');

  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  meeting.segments = [{ index: 1, text: 'Test text', start: 0, end: 1000 }];
  meeting.llm = {
    async json() { await delayed; return { data: { abstract: 'Late result' } }; },
    resolve() { return { model: 'mock' }; },
  };
  const pending = meeting.generateMinutes();
  meeting.scheduleSave();
  meeting.dispose();
  assert.equal(meeting.saveTimer, null);
  store.deleteMeeting(meeting.id);
  release();
  await pending;
  assert.equal(meeting.saveTimer, null, 'late model results must not schedule a deleted meeting save');
  meeting.save();
  assert.equal(store.loadMeeting(meeting.id), null);
  console.log('PASS deleted meetings remain deleted after a delayed model response');
} finally {
  fs.writeFileSync = originalWrite;
  fs.renameSync = originalRename;
  syncBuiltinESMExports();
  fs.rmSync(temp, { recursive: true, force: true });
}
