// Deterministic tones and silence only; no voices, accounts or meeting data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../lib/wav.mjs';

export function makeTestFixtures(output) {
  mkdirSync(output, { recursive: true });
  const rate = 16000;
  const samples = new Int16Array(rate * 12);
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate;
    const frequency = time < 4 ? 440 : time >= 6 && time < 10 ? 660 : 0;
    samples[i] = frequency ? Math.round(6000 * Math.sin(2 * Math.PI * frequency * time)) : 0;
  }
  writeFileSync(join(output, 'synthetic-tones-12s.wav'), encodeWav(samples, rate, 1));
  writeFileSync(join(output, 'synthetic-silence-3s.wav'), encodeWav(new Int16Array(rate * 3), rate, 1));
  writeFileSync(join(output, 'FIXTURES.md'), '# Synthetic audio fixtures\n\n' +
    'Both files are generated PCM WAV (16 kHz, mono, signed 16-bit). No human voice or private content is included.\n\n' +
    '- synthetic-tones-12s.wav: 440 Hz for 0–4s, silence for 4–6s, 660 Hz for 6–10s, silence for 10–12s. Use for playback, seeking, duration and audio routing checks. It is not a speech recognition benchmark.\n' +
    '- synthetic-silence-3s.wav: three seconds of silence. Import should finish and avoid unnecessary speech requests.\n\n' +
    'For real ASR testing, explicitly configure your provider and use a short recording made with consent.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '../.probe/test-fixtures'));
  makeTestFixtures(output);
  console.log(`Synthetic fixtures: ${output}`);
}
