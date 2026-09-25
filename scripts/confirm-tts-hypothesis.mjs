#!/usr/bin/env node
// confirm-tts-hypothesis.mjs — why did the first probe conclude MiMo cannot
// do Japanese?
//
// Hypothesis: MiMo-V2.5-TTS does not speak Japanese. It reads the text with
// Chinese phonemes, so the wav fed to the ASR was never Japanese.
//
// Test: transcribe the MiMo-TTS "Japanese" clip with Groq, a Japanese ASR
// that is known to be excellent. If Groq ALSO fails on it, the audio is the
// problem, not the recogniser.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCreds } from '../lib/env.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createAsrRegistry } from '../lib/asr/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, '..', '.probe');
const JA_PROBE = join(PROBE, 'ja-fixture', 'ja-meeting-sapi.wav');

const creds = loadCreds();
const config = loadConfig();
const reg = createAsrRegistry(config, creds);

const cases = [
  ['MiMo TTS "Japanese" (probe.mjs fixture)', join(PROBE, 'tts-ja.wav')],
  ['Windows SAPI real Japanese', JA_PROBE],
];

const SOURCE = 'こんにちは。私は東京で勉強している留学生です。今日の会議では、来月の発表について話し合いましょう。';

for (const [label, file] of cases) {
  if (!existsSync(file)) {
    console.log(label + ': missing ' + file);
    continue;
  }
  const wav = readFileSync(file);
  console.log('');
  console.log('=== ' + label + ' (' + (wav.length / 1024).toFixed(0) + ' KB) ===');
  for (const provider of ['groq', 'mimo']) {
    try {
      const r = await reg.get(provider).transcribe(wav, { language: 'ja', sampleRate: 16000 });
      console.log('  ' + provider.padEnd(6) + ': ' + (r.text || '(empty)').slice(0, 150));
    } catch (err) {
      console.log('  ' + provider.padEnd(6) + ': FAILED ' + err.message.slice(0, 100));
    }
  }
}
console.log('');
console.log('Source text was:');
console.log('  ' + SOURCE);
console.log('');
console.log('If Groq ALSO fails on the MiMo-TTS clip but succeeds on SAPI audio,');
console.log('the fault is with MiMo TTS, not with MiMo ASR.');
