// openai-audio.mjs — adapter for any OpenAI-compatible transcription API.
//
// This single adapter covers Groq (whisper-large-v3-turbo, the cheapest
// Japanese-capable option at about $0.04/hour), OpenAI, SiliconFlow and a
// local whisper.cpp server, because they all accept the same multipart
// request to POST /audio/transcriptions.

import { encodeWav } from '../wav.mjs';

/** Providers differ in whether they accept an ISO code or want it omitted. */
function languageField(language) {
  if (!language || language === 'auto') return undefined;
  return language;
}

export function create(cfg, creds) {
  const key = creds[cfg.keyRef] || '';
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!key && !cfg.noAuth) throw new Error('asr ' + cfg.keyRef + ' is not configured');

  return {
    name: cfg.kind + ':' + cfg.model,
    kind: cfg.kind,
    label: cfg.label,
    pricePerHour: cfg.pricePerHour,
    currency: cfg.currency,
    languages: cfg.languages,

    async transcribe(wavBuffer, opts) {
      const o = opts || {};
      const started = Date.now();
      const form = new FormData();
      form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'chunk.wav');
      form.append('model', cfg.model);
      const lang = languageField(o.language);
      if (lang) form.append('language', lang);
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');

      const headers = {};
      if (key) headers.authorization = 'Bearer ' + key;

      const res = await fetch(base + '/audio/transcriptions', {
        method: 'POST',
        headers,
        body: form,
        signal: o.signal || AbortSignal.timeout(o.timeoutMs || 180000),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        const err = new Error('asr HTTP ' + res.status + ': ' + detail);
        err.status = res.status;
        if (res.status === 429) {
          const header = res.headers.get('retry-after');
          const seconds = header && Number(header);
          const fromHeader = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
          const fromBody = /try again in\s+([\d.]+)\s*(ms|s|m)\b/i.exec(detail);
          const bodyMs = fromBody ? Number(fromBody[1]) * ({ ms: 1, s: 1000, m: 60000 })[fromBody[2].toLowerCase()] : 0;
          err.retryAfterMs = Math.min(60000, Math.max(1000, fromHeader || bodyMs || 5000));
        }
        throw err;
      }
      const json = await res.json();
      const ms = Date.now() - started;
      const segments = Array.isArray(json.segments)
        ? json.segments.map((s) => ({
            start: s.start,
            end: s.end,
            text: (s.text || '').trim(),
            speaker: s.speaker,
          }))
        : [];
      const words = Array.isArray(json.words)
        ? json.words.map((w) => ({ word: w.word, start: w.start, end: w.end }))
        : [];
      const seconds = json.duration ?? null;

      return {
        text: (json.text || '').trim(),
        raw: json.text,
        seconds,
        durationSec: seconds || segments.length ? seconds ?? 0 : (wavBuffer.length - 44) / 2 / (o.sampleRate || 16000),
        words,
        utterances: segments,
        provider: cfg.label,
        model: cfg.model,
        ms,
      };
    },
  };
}
