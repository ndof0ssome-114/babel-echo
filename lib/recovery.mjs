// recovery.mjs — turn recordings interrupted by a crash back into audio.
//
// A live meeting streams to data/tmp/<id>.pcm (a WAV with a placeholder
// header) and only becomes data/audio/<id>.wav on a clean stop. If the
// process dies first, the next server start patches the header and attaches
// the file to its meeting. Nothing is deleted unless it holds no audio.

import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, writeSync,
  ftruncateSync, closeSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TMP_DIR, ensureDirs } from './config.mjs';
import { wavHeader } from './wav.mjs';
import * as store from './store.mjs';

const LOCK_NAME = 'recorder.pid';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Two servers may share one data directory (two browser-mode copies). The
// other one's .pcm files are live recordings, so only the first live server
// on a directory may adopt them.
function claimTmpDir(dir) {
  const lock = join(dir, LOCK_NAME);
  const holder = Number.parseInt(existsSync(lock) ? readFileSync(lock, 'utf8') : '', 10);
  if (Number.isInteger(holder) && holder !== process.pid && alive(holder)) return false;
  writeFileSync(lock, String(process.pid));
  // Release the claim on a normal exit, so a later process that reuses this
  // PID number is not mistaken for a live recorder.
  process.once('exit', () => {
    try {
      if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
    } catch { /* already gone */ }
  });
  return true;
}

/** Fix the RIFF/data sizes of an interrupted .pcm file in place. */
function finalizeWav(path) {
  const fd = openSync(path, 'r+');
  try {
    const header = Buffer.alloc(44);
    readSync(fd, header, 0, 44, 0);
    const sampleRate = header.readUInt32LE(24) || 16000;
    const channels = header.readUInt16LE(22) || 1;
    const dataBytes = (statSync(path).size - 44) & ~1; // drop a torn half sample
    ftruncateSync(fd, 44 + dataBytes);
    writeSync(fd, wavHeader(sampleRate, dataBytes, channels), 0, 44, 0);
    return { dataBytes, durationMs: Math.round((dataBytes / (2 * channels) / sampleRate) * 1000) };
  } finally {
    closeSync(fd);
  }
}

export function recoverInterruptedRecordings({ tmpDir = TMP_DIR, log = console.log } = {}) {
  ensureDirs();
  const recovered = [];
  if (!claimTmpDir(tmpDir)) return recovered;
  for (const name of readdirSync(tmpDir)) {
    if (!name.endsWith('.pcm')) continue;
    const id = name.slice(0, -4);
    const pcm = join(tmpDir, name);
    try {
      if (statSync(pcm).size <= 44) {
        unlinkSync(pcm);
        continue;
      }
      const doc = store.loadMeeting(id);
      // Without its meeting, or next to audio that already exists, the file
      // is left in place for manual recovery instead of being guessed at.
      if (!doc || store.findAudio(id)) {
        log('[recovery] 保留未认领的录音临时文件：' + pcm);
        continue;
      }
      const { dataBytes, durationMs } = finalizeWav(pcm);
      const wav = store.audioPath(id, '.wav');
      renameSync(pcm, wav);
      store.saveMeeting({
        ...doc,
        state: 'stopped',
        audio: { ext: '.wav', bytes: 44 + dataBytes },
        durationMs: Math.max(doc.durationMs || 0, durationMs),
      });
      recovered.push(id);
      log('[recovery] 已恢复中断的录音：' + id + '（' + Math.round(durationMs / 1000) + ' 秒）');
    } catch (err) {
      log('[recovery] 无法恢复 ' + pcm + '：' + err.message);
    }
  }
  return recovered;
}
