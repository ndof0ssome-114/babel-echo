// wav.mjs — minimal WAV (RIFF/PCM) reader and writer.
//
// MiMo-V2.5-ASR only accepts mp3/wav, and the browser sends us raw PCM, so
// the server is responsible for wrapping PCM into a valid WAV container.

/**
 * Build a canonical 44-byte PCM WAV header for a known payload size.
 * Long recordings are streamed to disk with a placeholder header and this
 * function is used again at the end to patch in the real sizes.
 */
export function wavHeader(sampleRate, dataSize, channels) {
  const ch = channels || 1;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** Wrap interleaved 16-bit PCM in a canonical 44-byte WAV header. */
export function encodeWav(int16, sampleRate, channels) {
  const dataSize = int16.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataSize);
  wavHeader(sampleRate, dataSize, channels).copy(buf, 0);
  Buffer.from(int16.buffer, int16.byteOffset, dataSize).copy(buf, 44);
  return buf;
}

/** Convert Float32 samples in [-1,1] to clamped Int16. */
export function floatTo16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Concatenate Int16Arrays. */
export function concat16(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Parse a RIFF/WAVE header. Returns null when the buffer is not PCM WAV. */
export function parseWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  const info = { sampleRate: 0, channels: 0, bitsPerSample: 0, dataOffset: 0, dataLength: 0 };
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      info.channels = buf.readUInt16LE(body + 2);
      info.sampleRate = buf.readUInt32LE(body + 4);
      info.bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      info.dataOffset = body;
      info.dataLength = Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!info.sampleRate || !info.dataOffset) return null;
  const bytesPerSample = info.bitsPerSample / 8;
  info.durationSec =
    info.dataLength / (info.sampleRate * (info.channels || 1) * (bytesPerSample || 2));
  return info;
}

/** Root-mean-square level of Int16 samples, normalised to roughly 0..1. */
export function rms16(int16) {
  if (!int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / int16.length);
}

/**
 * Cut a WAV into chunks that END AT SILENCE rather than at a fixed offset.
 *
 * A blind 30-second cut slices sentences in half and produces transcript
 * paragraphs that no longer correspond to anything a human said. Scanning a
 * 20 ms energy envelope for a pause gives the imported transcript the same
 * sentence boundaries the live recorder produces.
 *
 * Falls back to a hard cut at maxChunkSec when no pause is found (continuous
 * speech, music, noise).
 */
export function sliceOnSilence(buf, opts) {
  const o = opts || {};
  const maxSec = o.maxChunkSec || 30;
  const minSec = o.minChunkSec || 3;
  const silenceMs = o.silenceMs || 600;
  const threshold = o.vadThreshold || 0.012;

  const info = parseWav(buf);
  if (!info) return [{ buffer: buf, start: 0, duration: 0 }];

  const bytesPerSec = info.sampleRate * (info.channels || 1) * (info.bitsPerSample / 8);
  const frameSec = 0.02;
  const frameBytes = Math.max(2, Math.floor(frameSec * bytesPerSec));
  const frameCount = Math.floor(info.dataLength / frameBytes);
  if (frameCount < 2) return [{ buffer: buf, start: 0, duration: info.durationSec }];

  const silent = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const at = info.dataOffset + f * frameBytes;
    const n = Math.min(frameBytes, info.dataOffset + info.dataLength - at) >> 1;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(at + i * 2) / 32768;
      sum += v * v;
    }
    silent[f] = Math.sqrt(sum / Math.max(1, n)) < threshold ? 1 : 0;
  }

  const maxFrames = Math.max(1, Math.floor(maxSec / frameSec));
  const minFrames = Math.max(1, Math.floor(minSec / frameSec));
  const needRun = Math.max(1, Math.ceil(silenceMs / 1000 / frameSec));

  const spans = [];
  let start = 0;
  while (start < frameCount) {
    const hardEnd = Math.min(frameCount, start + maxFrames);
    if (hardEnd >= frameCount) {
      spans.push([start, frameCount]);
      break;
    }
    // Take the FIRST real pause after minSec. Cutting at the latest pause
    // instead glued every sentence of a 49 s recording into two 30 s slabs,
    // which is exactly the "wall of text" the live path avoids.
    let cut = -1;
    let run = 0;
    for (let j = Math.min(hardEnd, start + minFrames); j < hardEnd; j++) {
      if (silent[j]) {
        run++;
        if (run >= needRun) {
          cut = j + 1 - Math.ceil(needRun / 2);
          break;
        }
      } else {
        run = 0;
      }
    }
    if (cut <= start) cut = hardEnd;
    spans.push([start, cut]);
    start = cut;
  }

  return spans.map(([a, b]) => {
    const at = info.dataOffset + a * frameBytes;
    const end = Math.min(info.dataOffset + b * frameBytes, info.dataOffset + info.dataLength);
    const count = Math.max(0, (end - at) >> 1);
    const pcm = new Int16Array(count);
    for (let k = 0; k < count; k++) pcm[k] = buf.readInt16LE(at + k * 2);
    return {
      buffer: encodeWav(pcm, info.sampleRate, info.channels),
      start: (at - info.dataOffset) / bytesPerSec,
      duration: (end - at) / bytesPerSec,
    };
  });
}

/**
 * Cut a PCM WAV into ~chunkSec slices by rewriting a fresh header per slice.
 * Used when a whole meeting file is transcribed after the fact.
 */
export function sliceWav(buf, chunkSec) {
  const info = parseWav(buf);
  if (!info) return [{ buffer: buf, start: 0, duration: chunkSec }];
  const bytesPerSec = info.sampleRate * (info.channels || 1) * (info.bitsPerSample / 8);
  const step = Math.max(1, Math.floor(chunkSec * bytesPerSec));
  const out = [];
  for (let at = info.dataOffset; at < info.dataOffset + info.dataLength; at += step) {
    const end = Math.min(at + step, info.dataOffset + info.dataLength);
    const slice = buf.subarray(at, end);
    const pcm = new Int16Array(slice.buffer, slice.byteOffset, Math.floor(slice.length / 2));
    out.push({
      buffer: encodeWav(pcm, info.sampleRate, info.channels),
      start: (at - info.dataOffset) / bytesPerSec,
      duration: (end - at) / bytesPerSec,
    });
  }
  return out;
}
