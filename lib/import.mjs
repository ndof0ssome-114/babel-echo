// import.mjs — transcribe an already-recorded audio/video file.
//
// 巴别回声 accepts uploads as well as live capture. The pipeline is deliberately
// boring and robust:
//   ffmpeg normalises ANY input (m4a/mp4/mov/webm/flac/...) to 16 kHz mono
//   PCM WAV, we slice it into 30-second pieces, and each piece goes through
//   exactly the same ASR path the live recorder uses.
//
// 30 seconds is a compromise: long enough to keep request overhead low,
// short enough that a failed chunk only loses half a minute of transcript.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { TMP_DIR, ensureDirs } from './config.mjs';
import { parseWav, sliceOnSilence } from './wav.mjs';

// Chunks break at the first natural pause after MIN_CHUNK_SEC, so an
// imported meeting reads like the live transcript rather than 30 s slabs.
const MAX_CHUNK_SEC = 25;
const MIN_CHUNK_SEC = 3;

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeout || 3600000, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      if (err) reject(new Error(cmd + ' failed: ' + (stderr || err.message).slice(0, 400)));
      else resolve({ stdout, stderr });
    });
  });
}

/** Media duration in seconds via ffprobe, or null when unavailable. */
export async function probeDuration(inputPath) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      inputPath,
    ], 60000);
    const v = parseFloat(String(stdout).trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Normalise any media file to 16 kHz mono 16-bit WAV.
 * Falls back to the file itself when it is already a PCM WAV and ffmpeg
 * is unavailable.
 */
export async function toAsrWav(inputPath, workPath) {
  try {
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
      workPath,
    ]);
    return { path: workPath, converted: true };
  } catch (err) {
    const buf = readFileSync(inputPath);
    if (parseWav(buf)) return { path: inputPath, converted: false };
    throw new Error('无法解码该音频（需要 ffmpeg）：' + err.message);
  }
}

/**
 * Transcribe a media file into an existing meeting.
 * onProgress({ done, total, seconds, segment }) is called per chunk.
 */
export async function importMedia(opts) {
  const { meeting, inputPath, onProgress, chunkSec } = opts;
  ensureDirs();
  const token = randomBytes(4).toString('hex');
  const workPath = join(TMP_DIR, 'import-' + meeting.id + '-' + token + '.wav');

  const asrOn = meeting.asr;
  const language = meeting.language || 'auto';

  try {
  const { path: wavPath } = await toAsrWav(inputPath, workPath);
  const buf = readFileSync(wavPath);
  const info = parseWav(buf);
  if (!info) throw new Error('解码后的音频不是有效的 PCM WAV');

  // Break on silence, not on a fixed offset, so the imported transcript has
  // real sentence boundaries instead of 30-second slabs.
  const rt = meeting.config.realtime;
  const chunks = sliceOnSilence(buf, {
    maxChunkSec: chunkSec || MAX_CHUNK_SEC,
    minChunkSec: MIN_CHUNK_SEC,
    silenceMs: rt.silenceMs,
    vadThreshold: rt.vadThreshold,
  });
  const totalSec = info.durationSec;
  meeting.emit('import-progress', { done: 0, total: chunks.length, seconds: 0, totalSeconds: Math.round(totalSec) });
  const reportProgress = (i, chunk) => {
    const progress = {
      done: i + 1,
      total: chunks.length,
      seconds: chunk.start + chunk.duration,
      totalSeconds: totalSec,
    };
    if (onProgress) onProgress(progress);
    meeting.emit('import-progress', {
      ...progress,
      seconds: Math.round(progress.seconds),
      totalSeconds: Math.round(totalSec),
    });
  };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // A chunk with no measurable energy is silence; skip the API call.
    const peak = peakLevel(chunk.buffer);
    if (peak < 0.008) {
      reportProgress(i, chunk);
      continue;
    }

    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await asrOn.transcribe(language, chunk.buffer, {
          sampleRate: info.sampleRate,
        });
      } catch (err) {
        lastErr = err;
      }
    }
    if (!result) {
      meeting.emit('error', {
        message: '第 ' + (i + 1) + '/' + chunks.length + ' 段识别失败：' + (lastErr?.message || '未知错误'),
        fatal: false,
      });
      reportProgress(i, chunk);
      continue;
    }

    meeting.stats.asrCalls++;
    meeting.stats.asrSeconds += result.seconds || chunk.duration;
    const inst = meeting.config.asr.providers[result.providerName];
    if (inst) {
      meeting.stats.asrCostCurrency = inst.currency;
      meeting.stats.asrCost += ((result.seconds || chunk.duration) / 3600) * (inst.pricePerHour || 0);
      meeting.upstream = { provider: result.providerName, model: inst.model, label: inst.label };
    }

    if (result.text) {
      meeting.pushSegment({
        text: result.text,
        start: Math.round(chunk.start * 1000),
        end: Math.round((chunk.start + chunk.duration) * 1000),
        speaker: meeting.speakerLabel('s0'),
        provider: result.provider,
      });
    }
    reportProgress(i, chunk);
  }

  // Uploads have no live PCM stream, so adopt the decoded file as the
  // meeting audio (otherwise playback 404s).
  await meeting.attachAudio(wavPath);

  meeting.durationMs = Math.round(totalSec * 1000);
  await meeting.flushTranslation(true);
  meeting.save();
  meeting.emit('import-done', { segments: meeting.segments.length, durationMs: meeting.durationMs });
  return { segments: meeting.segments.length, durationMs: meeting.durationMs };
  } finally {
    if (existsSync(workPath)) {
      try { unlinkSync(workPath); } catch { /* best effort */ }
    }
  }
}

/** Cheap peak check so silent chunks never reach the API. */
function peakLevel(wavBuffer) {
  const info = parseWav(wavBuffer);
  if (!info) return 1;
  let peak = 0;
  for (let i = info.dataOffset; i + 1 < info.dataOffset + info.dataLength; i += 2) {
    const v = Math.abs(wavBuffer.readInt16LE(i)) / 32768;
    if (v > peak) peak = v;
  }
  return peak;
}
