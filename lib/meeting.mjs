// meeting.mjs — the live meeting state machine.
//
// Everything time-critical lives here:
//   * audio arrives as raw 16 kHz mono Int16 PCM frames from the browser
//   * an energy VAD groups frames into utterances
//   * each growing utterance is re-transcribed every few seconds so the
//     transcript appears while people are still talking ("实时转写")
//   * a pause closes the utterance and freezes it as a segment
//   * closing a segment queues translation, and periodically a rolling
//     summary is regenerated from the previous summary plus only the new text
//
// The design choice worth calling out: interim results re-transcribe the
// WHOLE utterance rather than sending sliding windows. It costs more audio
// per minute but produces self-consistent text with no prefix/suffix
// reconciliation hacks, which is what makes live captions feel solid.

import { encodeWav, concat16, rms16, wavHeader } from './wav.mjs';
import * as prompts from './prompts.mjs';
import { saveMeeting, audioPath } from './store.mjs';
import { TMP_DIR, ensureDirs } from './config.mjs';
import { join as joinPath } from 'node:path';

/** Remove text recognized twice from audio carried over a forced split. */
export function trimRepeatedPrefix(previous, current) {
  if (!previous || !current) return (current || '').trim();
  const units = (value) => [...value.matchAll(/[\p{L}\p{N}]/gu)]
    .map((match) => ({ char: match[0].toLocaleLowerCase(), end: match.index + match[0].length }));
  const left = units(previous).slice(-80);
  const right = units(current).slice(0, 80);
  const longest = Math.min(left.length, right.length);
  for (let count = longest; count >= 3; count--) {
    if (left.slice(-count).map((x) => x.char).join('') !== right.slice(0, count).map((x) => x.char).join('')) continue;
    return current.slice(right[count - 1].end).replace(/^[\s\p{P}\p{S}]+/u, '').trim();
  }
  return current.trim();
}

/** Temp PCM lives next to the other meeting artefacts. */
function joinTmp(name) {
  ensureDirs();
  return joinPath(TMP_DIR, name);
}
import { execFile } from 'node:child_process';
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  statSync,
  createWriteStream,
  openSync,
  writeSync,
  closeSync,
  renameSync,
  copyFileSync,
} from 'node:fs';

export class Meeting {
  constructor(opts) {
    this.id = opts.id;
    this.title = opts.title || '未命名会议';
    this.language = opts.language || 'auto';
    // An empty string explicitly disables translation.
    this.translateTo = opts.translateTo ?? opts.config.translate.target;
    this.config = opts.config;
    this.asr = opts.asr;
    this.llm = opts.llm;
    this.creds = opts.creds;

    this.sampleRate = this.config.audio.sampleRate;
    this.state = 'idle'; // idle | recording | paused | processing | stopped
    this.source = opts.source || 'live';

    this.segments = [];
    this.summary = null;
    this.minutes = null;
    this.chapters = [];
    this.speakers = {};
    this.qa = [];
    this.audio = null;
    this.createdAt = Date.now();
    this.durationMs = 0;
    this.upstream = null;

    this.stats = {
      asrCalls: 0,
      asrMs: 0,
      asrSeconds: 0,
      asrCost: 0,
      asrCostCurrency: null,
      llmCalls: 0,
      llmMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      translateHits: 0,
    };

    this.listeners = new Set();
    this.totalSamples = 0;
  // Audio is streamed to a headerless PCM file and wrapped into a WAV on
  // stop, so a two-hour meeting costs disk instead of gigabytes of heap.
    this.pcmPath = null;
    this.pcmStream = null;
    this.pcmBytes = 0;
    this.utterance = null;
    this.segSeq = 0;
    this.uttSeq = 0;
    // ASR scheduling state. Final jobs always win over interim ones, and only
    // the newest interim request is worth keeping.
    this.busy = false;
    this.inflight = null;
    this.finalQueue = [];
    this.interimJob = null;
    this.idleWaiters = [];
    this.lastError = null;

    this.summaryUpTo = -1;
    this.summarizing = false;
    this.translateQueue = [];
    this.translating = false;
    this.translateTimer = null;
    this.summaryTimer = null;
    this.saveTimer = null;
  }

  // -- wiring ---------------------------------------------------------------

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    const evt = { type, at: Date.now(), ...(payload || {}) };
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch {
        /* a dead socket must not stop the meeting */
      }
    }
  }

  snapshot() {
    return {
      id: this.id,
      title: this.title,
      language: this.language,
      translateTo: this.translateTo,
      state: this.state,
      createdAt: this.createdAt,
      durationMs: this.durationMs,
      segments: this.segments,
      summary: this.summary,
      minutes: this.minutes,
      chapters: this.chapters,
      speakers: this.speakers,
      qa: this.qa,
      stats: this.stats,
      audio: this.audio,
      source: this.source,
      upstream: this.upstream,
    };
  }

  nowMs() {
    return (this.totalSamples / this.sampleRate) * 1000;
  }

  // -- recording ------------------------------------------------------------

  start() {
    if (this.state === 'recording') return;
    this.state = 'recording';
    this.openPcmStream();
    this.emit('status', { state: this.state });
    this.startTimers();
    this.scheduleSave();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.closeUtterance();
    this.state = 'paused';
    this.emit('status', { state: this.state });
    this.scheduleSave();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.emit('status', { state: this.state });
  }

  async stop() {
    if (this.state === 'stopped') return;
    this.closeUtterance();
    this.state = 'processing';
    this.emit('status', { state: this.state });
    this.stopTimers();
    // Let any in-flight recognition finish so the last utterance lands.
    await this.whenIdle();
    await this.flushTranslation(true);
    await this.writeAudio();
    this.state = 'stopped';
    this.emit('status', { state: this.state });
    this.save();
    this.emit('saved', { id: this.id });
  }

  startTimers() {
    this.stopTimers();
    const autoMs = this.config.summary.autoMs;
    if (autoMs > 0) {
      this.summaryTimer = setInterval(() => {
        if (this.state === 'recording' || this.state === 'paused') this.summarize().catch(() => {});
      }, autoMs);
      if (this.summaryTimer.unref) this.summaryTimer.unref();
    }
  }

  stopTimers() {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = null;
    if (this.translateTimer) clearTimeout(this.translateTimer);
    this.translateTimer = null;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  save() {
    try {
      saveMeeting(this);
    } catch (err) {
      this.emit('error', { message: '保存失败：' + err.message });
    }
  }

  // -- audio ingest ---------------------------------------------------------

  /** Feed one frame of 16 kHz mono PCM. */
  ingest(int16) {
    if (this.state !== 'recording' || !int16 || !int16.length) return;
    const rt = this.config.realtime;
    this.writePcm(int16);
    this.totalSamples += int16.length;
    this.durationMs = this.nowMs();

    const level = rms16(int16);
    const voice = level >= rt.vadThreshold;

    if (!this.utterance) this.openUtterance(this.nowMs() - (int16.length / this.sampleRate) * 1000);
    this.utterance.chunks.push(int16);
    this.utterance.sampleCount += int16.length;
    if (voice) {
      if (!this.utterance.hadSpeech && this.utterance.sampleCount > this.sampleRate * 0.5) {
        // Keep a short lead-in, but do not count minutes of preceding silence
        // against the maximum length of the first spoken sentence.
        const pcm = concat16(this.utterance.chunks);
        const keep = pcm.slice(-Math.min(pcm.length, int16.length + Math.round(this.sampleRate * 0.3)));
        this.utterance.chunks = [keep];
        this.utterance.sampleCount = keep.length;
        this.utterance.startMs = this.nowMs() - keep.length / this.sampleRate * 1000;
        this.utterance.lastInterimAt = this.utterance.startMs;
      }
      this.utterance.hadSpeech = true;
      this.utterance.lastVoiceAt = this.nowMs();
    }

    this.emit('level', { rms: Math.round(level * 1000) / 1000, voice });

    // Time-based housekeeping only happens on the frame boundary, which keeps
    // the ASR call rate bounded by the frame size rather than by wall clock.
    this.tick();
  }

  /** Create the streaming PCM sink with a placeholder WAV header. */
  openPcmStream() {
    if (this.pcmStream) return;
    try {
      this.pcmPath = joinTmp(this.id + '.pcm');
      writeFileSync(this.pcmPath, wavHeader(this.sampleRate, 0, 1));
      this.pcmStream = createWriteStream(this.pcmPath, { flags: 'a' });
      this.pcmStream.on('error', () => {
        this.pcmStream = null;
      });
    } catch (err) {
      this.pcmPath = null;
      this.pcmStream = null;
      this.emit('error', { message: '无法创建音频文件：' + err.message, fatal: false });
    }
  }

  writePcm(int16) {
    if (!this.pcmStream) return;
    const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2);
    this.pcmBytes += buf.length;
    this.pcmStream.write(buf);
  }

  openUtterance(startMs) {
    this.uttSeq += 1;
    const provider = this.asr?.pick?.(this.language)?.name;
    this.utterance = {
      id: 'u' + this.uttSeq,
      startMs,
      chunks: [],
      sampleCount: 0,
      asrLen: 0,
      lastInterimAt: startMs,
      overlapUntilMs: null,
      hadSpeech: false,
      lastVoiceAt: startMs,
      // Groq Whisper is file-oriented; frequent whole-utterance previews
      // consume its 20 RPM quota long before the final segment arrives.
      provider,
    };
  }

  /** Close the current utterance and freeze it as one or more segments. */
  closeUtterance(carryMs = 0) {
    if (!this.utterance) return;
    const utt = this.utterance;
    this.utterance = null;
    if (this.interimJob?.utteranceId === utt.id) this.interimJob = null;
    if (!utt.chunks.length) return;
    const pcm = concat16(utt.chunks);
    if (pcm.length < this.sampleRate * 0.25) return; // under 250 ms: noise
    if (!utt.hadSpeech) return; // silence only
    this.scheduleAsr({
      pcm,
      startMs: utt.startMs,
      endMs: Math.max(this.nowMs(), utt.startMs),
      final: true,
      utteranceId: utt.id,
      overlapUntilMs: utt.overlapUntilMs,
    });
    if (carryMs > 0) {
      const tail = pcm.slice(-Math.min(pcm.length, Math.round(carryMs * this.sampleRate / 1000)));
      const endMs = this.nowMs();
      this.openUtterance(endMs - tail.length / this.sampleRate * 1000);
      this.utterance.chunks = [tail];
      this.utterance.sampleCount = tail.length;
      this.utterance.asrLen = tail.length;
      this.utterance.hadSpeech = true;
      this.utterance.lastVoiceAt = endMs;
      this.utterance.lastInterimAt = endMs;
      this.utterance.overlapUntilMs = endMs;
    }
  }

  tick() {
    const rt = this.config.realtime;
    const utt = this.utterance;
    if (!utt) return;
    const now = this.nowMs();
    const durMs = now - utt.startMs;
    const silentFor = utt.hadSpeech ? now - utt.lastVoiceAt : 0;

    if (utt.hadSpeech && silentFor >= rt.silenceMs && durMs >= 600) {
      this.closeUtterance();
      return;
    }
    if (durMs >= rt.maxUtteranceMs) {
      // Wait briefly for a natural pause. If speech continues, keep audio on
      // both sides of the hard boundary so the next request has context.
      if (utt.hadSpeech && silentFor >= 300) this.closeUtterance();
      else if (durMs >= rt.maxUtteranceMs + Math.min(5000, rt.maxUtteranceMs * 0.2)) {
        this.closeUtterance(utt.hadSpeech ? rt.overlapMs : 0);
      }
      return;
    }
    if (!utt.hadSpeech) return;
    const newSamples = utt.sampleCount - utt.asrLen;
    const newMs = (newSamples / this.sampleRate) * 1000;
    const stepMs = utt.provider === 'groq' ? Math.max(rt.stepMs, 10000) : rt.stepMs;
    const minNewMs = utt.provider === 'groq' ? Math.max(rt.minNewMs, 8000) : rt.minNewMs;
    if (now - utt.lastInterimAt >= stepMs && newMs >= minNewMs) {
      const pcm = concat16(utt.chunks);
      utt.asrLen = pcm.length;
      utt.lastInterimAt = now;
      this.scheduleAsr({
        pcm,
        startMs: utt.startMs,
        endMs: now,
        final: false,
        utteranceId: utt.id,
      });
    }
  }

  // -- ASR ------------------------------------------------------------------

  /**
   * Queue recognition work. Finished utterances are queued in order and win
   * over the single slot holding the newest interim request, so a paused or
   * stopped meeting can never lose audio that arrived mid-request.
   */
  scheduleAsr(job) {
    if (job.final) this.finalQueue.push(job);
    else this.interimJob = job;
    this.drainAsr();
  }

  async drainAsr() {
    if (this.busy) return;
    const job = this.finalQueue.shift() || this.interimJob;
    if (!job) return;
    if (!job.final) this.interimJob = null;
    this.busy = true;
    this.inflight = job;
    try {
      await this.runAsr(job);
    } finally {
      this.busy = false;
      this.inflight = null;
      if (this.finalQueue.length || this.interimJob) {
        queueMicrotask(() => this.drainAsr());
      } else {
        this.idleWaiters.splice(0).forEach((resolve) => resolve());
      }
    }
  }

  /** Resolves once every queued recognition call has completed. */
  whenIdle() {
    if (!this.busy && !this.finalQueue.length && !this.interimJob) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async runAsr(job) {
    const { pcm, startMs, endMs, final, utteranceId, overlapUntilMs } = job;
    const t0 = Date.now();
    try {
      const wav = encodeWav(pcm, this.sampleRate, 1);
      const result = await this.asr.transcribe(this.language, wav, { sampleRate: this.sampleRate });
      this.stats.asrCalls++;
      this.stats.asrMs += Date.now() - t0;
      const secs = result.seconds || pcm.length / this.sampleRate;
      this.stats.asrSeconds += secs;
      const inst = this.config.asr.providers[result.providerName];
      if (inst) {
        this.stats.asrCostCurrency = inst.currency;
        this.stats.asrCost += (secs / 3600) * (inst.pricePerHour || 0);
        this.upstream = { provider: result.providerName, model: inst.model, label: inst.label };
      }
      this.lastError = null;

      if (final) this.commitSegment(result, startMs, endMs, overlapUntilMs);
      else if (result.text) {
        this.emit('partial', {
          utteranceId,
          text: result.text,
          start: Math.round(startMs),
          end: Math.round(endMs),
          provider: result.provider,
        });
      }
    } catch (err) {
      this.lastError = err.message;
      this.emit('error', {
        message: '语音识别失败：' + err.message,
        fatal: false,
        // Losing the tail of a spoken sentence is worth a visible warning.
        lostMs: final ? Math.round(endMs - startMs) : 0,
      });
    }
  }

  /** Turn a finished ASR result into transcript segments. */
  commitSegment(result, startMs, endMs, overlapUntilMs = null) {
    const utts = (result.utterances || []).filter((u) => u.text);
    const speakers = new Set(utts.map((u) => u.speaker).filter((s) => s !== undefined));

    if (speakers.size > 1) {
      // Real diarization (Deepgram): one utterance can hold several speakers.
      for (const u of utts) {
        const utteranceStart = startMs + u.start * 1000;
        const utteranceEnd = startMs + u.end * 1000;
        if (overlapUntilMs !== null && utteranceEnd <= overlapUntilMs) continue;
        const text = overlapUntilMs !== null && utteranceStart < overlapUntilMs
          ? trimRepeatedPrefix(this.segments.at(-1)?.text, u.text) : u.text;
        if (!text) continue;
        const label = this.speakerLabel('s' + u.speaker);
        this.pushSegment({
          text,
          start: Math.round(Math.max(utteranceStart, overlapUntilMs ?? utteranceStart)),
          end: Math.round(utteranceEnd),
          speaker: label,
          provider: result.provider,
        });
      }
      return;
    }

    const text = overlapUntilMs === null ? (result.text || '').trim()
      : trimRepeatedPrefix(this.segments.at(-1)?.text, result.text);
    if (!text) return;
    const label =
      utts.length === 1 && utts[0].speaker !== undefined
        ? this.speakerLabel('s' + utts[0].speaker)
        : this.inferSpeaker(Math.max(startMs, overlapUntilMs ?? startMs));
    this.pushSegment({
      text,
      start: Math.round(Math.max(startMs, overlapUntilMs ?? startMs)),
      end: Math.round(endMs),
      speaker: label,
      provider: result.provider,
    });
  }

  /**
   * Without diarization support, a long pause is the only honest signal that
   * the floor changed hands. Everything user-visible is renameable.
   */
  inferSpeaker(startMs) {
    const prev = this.segments[this.segments.length - 1];
    if (!prev) return this.speakerLabel('s0');
    const gap = startMs - (prev.end || 0);
    if (gap < 1400) return prev.speaker;
    // A long pause is the only signal available without diarization, so the
    // floor rotates between already-known speakers, or a new one appears.
    const names = Object.values(this.speakers).map((s) => s.name);
    const i = names.indexOf(prev.speaker);
    if (names.length >= 2 && i >= 0) return names[(i + 1) % names.length];
    return this.speakerLabel('s' + Object.keys(this.speakers).length);
  }

  speakerLabel(key) {
    if (!this.speakers[key]) {
      const n = Object.keys(this.speakers).length + 1;
      this.speakers[key] = { name: '说话人' + n, key };
    }
    return this.speakers[key].name;
  }

  pushSegment(seg) {
    this.segSeq += 1;
    const full = {
      index: this.segSeq,
      start: seg.start,
      end: seg.end,
      text: seg.text,
      speaker: seg.speaker,
      provider: seg.provider || null,
      translation: null,
      final: true,
    };
    this.segments.push(full);
    this.emit('segment', { segment: full });
    this.translateQueue.push(full.index);
    this.scheduleTranslate();
    this.scheduleSave();
  }

  renameSpeaker(from, to) {
    for (const seg of this.segments) if (seg.speaker === from) seg.speaker = to;
    for (const [k, v] of Object.entries(this.speakers)) if (v.name === from) v.name = to;
    this.emit('segments', { segments: this.segments });
    this.emit('speakers', { speakers: this.speakers });
    this.scheduleSave();
  }

  // -- translation ----------------------------------------------------------

  scheduleTranslate() {
    if (this.translateTimer) clearTimeout(this.translateTimer);
    this.translateTimer = setTimeout(() => {
      this.translateTimer = null;
      this.flushTranslation(false).catch(() => {});
    }, 2500);
    if (this.translateTimer.unref) this.translateTimer.unref();
  }

  async flushTranslation(drain) {
    if (this.translating) return;
    if (!this.translateQueue.length) return;
    const target = this.translateTo;
    if (!target) return;

    this.translating = true;
    try {
      while (this.translateQueue.length) {
        const batchIds = this.translateQueue.splice(0, 20);
        const batch = batchIds
          .map((i) => this.segments.find((s) => s.index === i))
          .filter((s) => s && !s.translation);
        if (!batch.length) continue;
        try {
          const t0 = Date.now();
          const { data } = await this.llm.json(
            'translate',
            prompts.translateMessages({ segments: batch, target }),
            { temperature: 0.1, maxTokens: 4000 },
          );
          this.stats.llmCalls++;
          this.stats.llmMs += Date.now() - t0;
          this.stats.translateHits += batch.length;
          const map = new Map((data.translations || []).map((t) => [Number(t.id), t.text]));
          for (const seg of batch) {
            const text = map.get(seg.index);
            if (text) {
              seg.translation = text;
              this.emit('segment-update', { index: seg.index, translation: text });
            }
          }
        } catch (err) {
          this.emit('error', { message: '翻译失败：' + err.message, fatal: false });
          // Put the batch back and stop, we will retry on the next trigger.
          this.translateQueue.unshift(...batchIds);
          break;
        }
        if (!drain) break; // one batch per debounce window
      }
      this.scheduleSave();
    } finally {
      this.translating = false;
    }
  }

  // -- summary --------------------------------------------------------------

  async summarize() {
    if (this.summarizing) return null;
    const fresh = this.segments.filter((s) => s.index > this.summaryUpTo);
    if (!fresh.length) return this.summary;
    this.summarizing = true;
    this.emit('summary-pending', {});
    try {
      const t0 = Date.now();
      const res = await this.llm.call(
        'summary',
        prompts.summaryMessages({
          previous: this.summary,
          newSegments: fresh,
          maxChars: this.config.summary.maxChars,
          title: this.title,
        }),
        // Reasoning tokens count against this budget; ~1.5k is spent thinking
        // before a single character of summary is emitted.
        { temperature: 0.3, maxTokens: 4000 },
      );
      this.stats.llmCalls++;
      this.stats.llmMs += Date.now() - t0;
      this.stats.promptTokens += res.usage?.prompt_tokens || 0;
      this.stats.completionTokens += res.usage?.completion_tokens || 0;
      const text = (res.text || '').trim();
      if (!text) {
        throw new Error(
          '模型返回了空内容（finish_reason=' + (res.finish || '?') + '），已保留上一版摘要',
        );
      }
      this.summary = text;
      this.summaryUpTo = this.segments[this.segments.length - 1].index;
      this.summaryAt = Date.now();
      this.emit('summary', { summary: this.summary, upTo: this.summaryUpTo });
      this.scheduleSave();
      return this.summary;
    } catch (err) {
      this.emit('error', { message: '实时总结失败：' + err.message, fatal: false });
      return this.summary;
    } finally {
      this.summarizing = false;
    }
  }

  // -- minutes --------------------------------------------------------------

  async generateMinutes(targetLang) {
    if (!this.segments.length) throw new Error('还没有转写内容');
    const t0 = Date.now();
    const res = await this.llm.json(
      'minutes',
      prompts.minutesMessages({
        segments: this.segments,
        title: this.title,
        summary: this.summary,
        targetLang: targetLang || (this.language === 'auto' ? 'zh' : this.language),
      }),
      { temperature: 0.2, maxTokens: 16000 },
    );
    this.stats.llmCalls++;
    this.stats.llmMs += Date.now() - t0;
    const data = res.data || {};
    this.minutes = {
      ...data,
      generatedAt: Date.now(),
      model: this.llm.resolve('minutes').model,
    };
    this.chapters = Array.isArray(data.chapters) ? data.chapters : [];
    this.emit('minutes', { minutes: this.minutes });
    this.scheduleSave();
    return this.minutes;
  }

  // -- Q&A ------------------------------------------------------------------

  async ask(question) {
    if (!this.segments.length) throw new Error('还没有转写内容');
    const t0 = Date.now();
    const history = this.qa.flatMap((q) => [
      { role: 'user', content: q.question },
      { role: 'assistant', content: q.answer },
    ]);
    const res = await this.llm.call(
      'ask',
      prompts.askMessages({
        question,
        segments: this.segments,
        summary: this.summary,
        history,
      }),
      { temperature: 0.2, maxTokens: 6000 },
    );
    this.stats.llmCalls++;
    this.stats.llmMs += Date.now() - t0;
    const entry = { question, answer: res.text.trim(), at: Date.now() };
    this.qa.push(entry);
    this.emit('answer', entry);
    this.scheduleSave();
    return entry;
  }

  // -- speaker re-split -----------------------------------------------------

  async resplitSpeakers() {
    if (this.segments.length < 2) return null;
    const res = await this.llm.json(
      'summary',
      prompts.speakerSplitMessages({
        segments: this.segments,
        speakers: Object.values(this.speakers).map((s) => s.name),
      }),
      { temperature: 0.1, maxTokens: 8000 },
    );
    const map = new Map((res.data?.assignments || []).map((a) => [Number(a.id), a.speaker]));
    const labelToKey = new Map();
    for (const [k, v] of Object.entries(this.speakers)) labelToKey.set(v.name, k);
    let counter = Object.keys(this.speakers).length;
    for (const seg of this.segments) {
      const label = map.get(seg.index) || seg.speaker;
      if (!labelToKey.has(label)) {
        counter += 1;
        const key = 's' + counter;
        this.speakers[key] = { name: label, key };
        labelToKey.set(label, key);
      }
      seg.speaker = label;
    }
    this.emit('segments', { segments: this.segments });
    this.emit('speakers', { speakers: this.speakers });
    this.scheduleSave();
    return this.speakers;
  }

  // -- audio persistence ----------------------------------------------------

  async writeAudio() {
    if (this.pcmStream) {
      await new Promise((r) => this.pcmStream.end(r));
      this.pcmStream = null;
    }
    if (!this.pcmPath || !this.pcmBytes || !existsSync(this.pcmPath)) return this.audio;
    try {
      // Patch the placeholder header now that the payload size is known.
      const fd = openSync(this.pcmPath, 'r+');
      writeSync(fd, wavHeader(this.sampleRate, this.pcmBytes, 1), 0, 44, 0);
      closeSync(fd);
      const wavPath = audioPath(this.id, '.wav');
      renameSync(this.pcmPath, wavPath);
      this.pcmPath = null;
      const mp3Path = audioPath(this.id, '.mp3');
      const ok = await this.transcode(wavPath, mp3Path).catch(() => false);
      if (ok && existsSync(mp3Path)) {
        try {
          unlinkSync(wavPath);
        } catch {
          /* keeping both is harmless */
        }
        this.audio = { ext: '.mp3', bytes: statSync(mp3Path).size };
      } else {
        this.audio = { ext: '.wav', bytes: statSync(wavPath).size };
      }
      return this.audio;
    } catch (err) {
      this.emit('error', { message: '音频保存失败：' + err.message, fatal: false });
      return null;
    }
  }

  /**
   * Adopt an existing WAV (a decoded upload) as this meeting's audio.
   * Live recordings build their file in writeAudio(); uploads arrive here.
   */
  async attachAudio(sourceWavPath) {
    try {
      const mp3Path = audioPath(this.id, '.mp3');
      const ok = await this.transcode(sourceWavPath, mp3Path).catch(() => false);
      if (ok && existsSync(mp3Path)) {
        this.audio = { ext: '.mp3', bytes: statSync(mp3Path).size };
      } else {
        const wavPath = audioPath(this.id, '.wav');
        copyFileSync(sourceWavPath, wavPath);
        this.audio = { ext: '.wav', bytes: statSync(wavPath).size };
      }
      this.emit('audio', { audio: this.audio });
      this.scheduleSave();
      return this.audio;
    } catch (err) {
      this.emit('error', { message: '音频转存失败：' + err.message, fatal: false });
      return null;
    }
  }

  transcode(from, to) {
    return new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', from, '-codec:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', to],
        { timeout: 300000 },
        (err) => (err ? reject(err) : resolve(true)),
      );
    });
  }

  // -- restore --------------------------------------------------------------

  static restore(doc, deps) {
    const m = new Meeting({
      id: doc.id,
      title: doc.title,
      language: doc.language,
      translateTo: doc.translateTo,
      config: deps.config,
      asr: deps.asr,
      llm: deps.llm,
      creds: deps.creds,
      source: doc.source,
    });
    m.state = 'stopped';
    m.segments = doc.segments || [];
    m.summary = doc.summary || null;
    m.minutes = doc.minutes || null;
    m.chapters = doc.chapters || [];
    m.speakers = doc.speakers || {};
    m.qa = doc.qa || [];
    m.stats = { ...m.stats, ...(doc.stats || {}) };
    m.audio = doc.audio || null;
    m.createdAt = doc.createdAt || Date.now();
    m.durationMs = doc.durationMs || 0;
    m.upstream = doc.upstream || null;
    m.summaryUpTo = m.segments.length ? m.segments[m.segments.length - 1].index : -1;
    m.segSeq = m.segments.length;
    return m;
  }
}

/** Build ASR/LLM independent export payloads from a meeting snapshot. */
export function toMarkdown(doc) {
  const lines = [];
  lines.push('# ' + (doc.title || '未命名会议'));
  lines.push('');
  lines.push('- 创建时间：' + new Date(doc.createdAt).toLocaleString('zh-CN'));
  lines.push('- 时长：' + formatDuration(doc.durationMs));
  if (doc.upstream) lines.push('- 识别引擎：' + doc.upstream.label);
  lines.push('');
  if (doc.minutes) {
    const m = doc.minutes;
    lines.push('## 智能纪要');
    lines.push('');
    if (m.abstract) lines.push(m.abstract, '');
    if (m.decisions?.length) {
      lines.push('### 关键决议');
      for (const d of m.decisions) lines.push('- ' + (d.decision || d));
      lines.push('');
    }
    if (m.actionItems?.length) {
      lines.push('### 待办事项');
      lines.push('| 事项 | 负责人 | 截止 |');
      lines.push('| --- | --- | --- |');
      for (const a of m.actionItems) lines.push('| ' + [a.task, a.owner, a.due].map((x) => x || '').join(' | ') + ' |');
      lines.push('');
    }
    if (m.risks?.length) {
      lines.push('### 风险与分歧');
      for (const r of m.risks) lines.push('- ' + (r.risk || r));
      lines.push('');
    }
    if (m.keywords?.length) lines.push('关键词：' + m.keywords.join('、'), '');
  }
  if (doc.summary) {
    lines.push('## 会议摘要');
    lines.push('');
    lines.push(doc.summary, '');
  }
  lines.push('## 转写全文');
  lines.push('');
  for (const s of doc.segments || []) {
    const t = formatDuration(s.start).slice(0, 8);
    lines.push('**[' + t + '] ' + s.speaker + '**：' + s.text);
    if (s.translation) lines.push('> ' + s.translation);
    lines.push('');
  }
  return lines.join('\n');
}

/** WebVTT subtitle export, including translations as the cue body. */
export function toVtt(doc, useTranslation) {
  const cue = (ms) => {
    const total = Math.max(0, ms);
    const h = String(Math.floor(total / 3600000)).padStart(2, '0');
    const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
    const ms3 = String(Math.floor(total % 1000)).padStart(3, '0');
    return h + ':' + m + ':' + s + '.' + ms3;
  };
  const out = ['WEBVTT', ''];
  for (const seg of doc.segments || []) {
    const body = useTranslation && seg.translation ? seg.translation : seg.text;
    out.push(String(seg.index), cue(seg.start) + ' --> ' + cue(seg.end), seg.speaker + '：' + body, '');
  }
  return out.join('\n');
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms || 0));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
}
