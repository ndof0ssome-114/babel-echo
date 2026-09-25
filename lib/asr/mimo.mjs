// mimo.mjs — Xiaomi MiMo-V2.5-ASR adapter.
//
// MiMo exposes speech recognition through /chat/completions with an
// input_audio content part. Two behaviours worth remembering:
//   * asr_options.language accepts only zh | en | auto. The model is
//     documented for Chinese and English. Explicit Japanese requests must
//     use another provider rather than silently changing to auto.
//   * The model occasionally prefixes its output with a language marker
//     such as "<chinese> ". We strip that, it is not part of the speech.

import { encodeWav } from '../wav.mjs';

const STRIP_TAG = /^\s*<[a-z_-]{2,20}>\s*/i;

function clampLanguage(language) {
  return language === 'zh' || language === 'en' ? language : 'auto';
}

export function create(cfg, creds) {
  const key = creds[cfg.keyRef];
  if (!key) throw new Error('mimo asr: missing ' + cfg.keyRef);
  const base = cfg.baseUrl.replace(/\/+$/, '');

  return {
    name: 'mimo',
    kind: cfg.kind,
    label: cfg.label,
    pricePerHour: cfg.pricePerHour,
    currency: cfg.currency,
    languages: cfg.languages,

    async transcribe(wavBuffer, opts) {
      const o = opts || {};
      if (o.language && !['zh', 'en', 'auto'].includes(o.language)) {
        throw new Error('MiMo ASR 不支持该语言，请选择其他语音引擎');
      }
      const language = clampLanguage(o.language);
      const started = Date.now();

      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: { data: 'data:audio/wav;base64,' + wavBuffer.toString('base64') },
                },
              ],
            },
          ],
          asr_options: { language },
        }),
        signal: o.signal || AbortSignal.timeout(o.timeoutMs || 180000),
      });

      if (!res.ok) {
        throw new Error('mimo asr HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
      }
      const json = await res.json();
      const raw = json.choices?.[0]?.message?.content || '';
      const ms = Date.now() - started;
      const seconds = json.usage?.seconds ?? null;
      return {
        text: raw.replace(STRIP_TAG, '').trim(),
        raw,
        seconds,
        durationSec: seconds || (wavBuffer.length - 44) / 2 / (o.sampleRate || 16000),
        words: [],
        utterances: [],
        provider: 'mimo',
        model: cfg.model,
        ms,
      };
    },
  };
}
