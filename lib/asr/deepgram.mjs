// deepgram.mjs — Deepgram Nova pre-recorded adapter.
//
// Chosen as the third backend for one reason: it is the only cheap provider
// in this stack that returns real speaker labels (diarize=true), and it
// handles Japanese. Everything else here infers speaker turns from gaps.

export function create(cfg, creds) {
  const key = creds[cfg.keyRef];
  if (!key) throw new Error('deepgram asr: missing ' + cfg.keyRef);
  const base = cfg.baseUrl.replace(/\/+$/, '');

  return {
    name: 'deepgram',
    kind: cfg.kind,
    label: cfg.label,
    pricePerHour: cfg.pricePerHour,
    currency: cfg.currency,
    languages: cfg.languages,

    async transcribe(wavBuffer, opts) {
      const o = opts || {};
      const started = Date.now();
      const params = new URLSearchParams({
        model: cfg.model,
        smart_format: 'true',
        punctuate: 'true',
        diarize: 'true',
        utterances: 'true',
      });
      if (o.language && o.language !== 'auto') params.set('language', o.language);

      const res = await fetch(base + '/listen?' + params.toString(), {
        method: 'POST',
        headers: {
          authorization: 'Token ' + key,
          'content-type': 'audio/wav',
        },
        body: wavBuffer,
        signal: o.signal || AbortSignal.timeout(o.timeoutMs || 180000),
      });

      if (!res.ok) {
        throw new Error('deepgram HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
      }
      const json = await res.json();
      const ms = Date.now() - started;
      const alt = json.results?.channels?.[0]?.alternatives?.[0] || {};
      const utterances = (json.results?.utterances || []).map((u) => ({
        start: u.start,
        end: u.end,
        text: (u.transcript || '').trim(),
        speaker: u.speaker,
      }));
      const words = (alt.words || []).map((w) => ({
        word: w.punctuated_word || w.word,
        start: w.start,
        end: w.end,
        speaker: w.speaker,
      }));

      return {
        text: (alt.transcript || '').trim(),
        raw: alt.transcript,
        seconds: json.metadata?.duration ?? null,
        durationSec: json.metadata?.duration || 0,
        words,
        utterances,
        provider: 'deepgram',
        model: cfg.model,
        ms,
      };
    },
  };
}
