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
import { splitSentences, endsSentence, joinText, groupSentences } from './sentences.mjs';
import { assignSpeakers, speakerNames } from './diarize.mjs';

// An unfinished sentence absorbs the next piece of text only when it follows
// within this gap from the same speaker.
const CONTINUE_GAP_MS = 1500;
// Short sentences are grouped up to this length; a longer sentence stays whole.
const SEGMENT_TARGET_CHARS = 80;
// Text without any terminal punctuation is closed once it grows this long.
const MAX_OPEN_CHARS = 240;
// Segments per speaker re-split request.
const RESPLIT_BATCH = 150;
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
  readFileSync,
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
    this.mode = prompts.normalizeMode(opts.mode);
    this.notesDetail = prompts.normalizeNotesDetail(opts.notesDetail);
    this.notesRevision = 0;
    this.summaryMode = this.mode;
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
    // Labels before the last whole-recording speaker correction, for undo.
    this.speakerBackup = null;
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
      reasoningTokens: 0,
      reasoningReportedCalls: 0,
      cachedInputTokens: 0,
      llmUnreportedCalls: 0,
      llmByTask: {},
      tokenStatsVersion: 2,
      translateHits: 0,
    };

    this.listeners = new Set();
    this.lastActivityAt = Date.now();
    this.disposed = false;
    this.totalSamples = 0;
  // Audio is streamed to a headerless PCM file and wrapped into a WAV on
  // stop, so a two-hour meeting costs disk instead of gigabytes of heap.
    this.pcmPath = null;
    this.pcmStream = null;
    this.pcmBytes = 0;
    this.stopping = null;
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
    this.summaryAt = null;
    this.summarizing = false;
    this.translateQueue = [];
    this.translating = null; // the in-flight flush, while one runs
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
    if (this.disposed) return;
    this.lastActivityAt = Date.now();
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
      mode: this.mode,
      notesDetail: this.notesDetail,
      summaryMode: this.summaryMode,
      translateTo: this.translateTo,
      state: this.state,
      createdAt: this.createdAt,
      durationMs: this.durationMs,
      segments: this.segments,
      summary: this.summary,
      summaryUpTo: this.summaryUpTo,
      summaryAt: this.summaryAt,
      minutes: this.minutes,
      chapters: this.chapters,
      speakers: this.speakers,
      speakerBackup: this.speakerBackup ? { at: this.speakerBackup.at } : null,
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

  setNoteOptions({ mode, notesDetail } = {}) {
    if (mode !== undefined && !['meeting', 'class'].includes(mode)) throw new Error('无效的使用场景');
    if (notesDetail !== undefined && !['standard', 'detailed'].includes(notesDetail)) throw new Error('无效的纪要详细度');
    if ((mode !== undefined && mode !== this.mode) || (notesDetail !== undefined && notesDetail !== this.notesDetail)) {
      if (mode !== undefined) this.mode = mode;
      if (notesDetail !== undefined) this.notesDetail = notesDetail;
      this.notesRevision++;
    }
  }

  // -- recording ------------------------------------------------------------

  start() {
    if (this.disposed) throw new Error('会议已删除');
    if (this.state === 'recording') return;
    // Reopening a finished meeting would restart its PCM file and clock and
    // then overwrite the saved audio on the next stop.
    if (this.state === 'processing' || this.state === 'stopped') throw new Error('这场会议已结束，请新建会议后再录音');
    this.state = 'recording';
    this.openPcmStream();
    this.emit('status', { state: this.state });
    this.startTimers();
    this.scheduleSave();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.closeUtterance();
    // The utterance just closed may still continue the open sentence; close
    // it once that recognition has landed rather than across the pause.
    this.whenIdle().then(() => { if (this.state === 'paused') this.closeOpenSegment(); });
    this.state = 'paused';
    this.emit('status', { state: this.state });
    this.scheduleSave();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.emit('status', { state: this.state });
  }

  /**
   * Finish a recording. The WebSocket, the abandoned-socket timer and
   * shutdown may all call this; later callers share the first stop.
   */
  stop() {
    if (this.stopping) return this.stopping;
    if (this.state === 'stopped') return Promise.resolve();
    this.stopping = this.finishRecording().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async finishRecording() {
    this.closeUtterance();
    this.state = 'processing';
    this.emit('status', { state: this.state });
    this.stopTimers();
    try {
      // Let any in-flight recognition finish so the last utterance lands.
      await this.whenIdle();
      this.closeOpenSegment();
      await this.flushTranslation(true);
      await this.writeAudio();
      await this.autoDiarize();
    } catch (err) {
      this.emit('error', { message: '结束录音时出错，已保存现有内容：' + err.message, fatal: false });
    } finally {
      // A failure above must not leave the meeting stuck in "processing",
      // where it can neither be deleted nor recorded again.
      this.state = 'stopped';
      this.emit('status', { state: this.state });
      this.save();
      this.emit('saved', { id: this.id });
    }
  }

  startTimers() {
    this.stopTimers();
    this.startSummaryTimer();
  }

  startSummaryTimer() {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = null;
    const autoMs = this.config.summary.autoMs;
    if (autoMs > 0) {
      this.summaryTimer = setInterval(() => {
        if (this.state === 'recording' || this.state === 'paused') this.summarize({ automatic: true }).catch(() => {});
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
    if (this.disposed) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  save() {
    if (this.disposed) return;
    try {
      saveMeeting(this);
    } catch (err) {
      this.emit('error', { message: '保存失败：' + err.message });
    }
  }

  /** Invalidate a deleted meeting, including pending saves and model callbacks. */
  dispose() {
    this.disposed = true;
    this.stopTimers();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.translateQueue = [];
    this.listeners.clear();
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
    this.closeStaleSegment();
  }

  /** Close an unfinished sentence once nothing can continue it any more. */
  closeStaleSegment() {
    const last = this.segments.at(-1);
    if (!last?.open || this.busy || this.finalQueue.length) return;
    const utt = this.utterance;
    // Speech that began right after the open sentence may still complete it.
    if (utt?.hadSpeech && utt.startMs <= last.end + CONTINUE_GAP_MS) return;
    if (this.nowMs() - last.end > CONTINUE_GAP_MS) this.closeOpenSegment();
  }

  /** Create the streaming PCM sink with a placeholder WAV header. */
  openPcmStream() {
    if (this.pcmStream) return;
    try {
      this.pcmPath = joinTmp(this.id + '.pcm');
      writeFileSync(this.pcmPath, wavHeader(this.sampleRate, 0, 1));
      const stream = createWriteStream(this.pcmPath, { flags: 'a' });
      this.pcmStream = stream;
      stream.on('error', (err) => {
        if (this.pcmStream === stream) this.pcmStream = null;
        this.audioWriteFailed = true;
        // Transcription can continue, but the user must know the recording
        // itself is no longer being kept (disk full, permissions, ...).
        this.emit('error', { message: '音频写入失败，录音文件已停止保存：' + err.message, fatal: false, audioLost: true });
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
        this.addText({
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
      speakers.size === 1
        ? this.speakerLabel('s' + speakers.values().next().value)
        : this.inferSpeaker(Math.max(startMs, overlapUntilMs ?? startMs));
    this.addText({
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

  /**
   * Add recognised text as sentence-shaped segments. Recognition requests end
   * wherever the audio was cut, so an unfinished sentence stays open and
   * absorbs the start of the next piece when that piece follows immediately
   * from the same speaker. One sentence then reads and translates as one.
   */
  addText({ text, start, end, speaker, provider }) {
    let rest = String(text || '').trim();
    if (!rest) return;
    const total = rest.length;
    const span = Math.max(0, end - start);
    // Timestamps inside one recognition result are spread by character count.
    const at = (chars) => Math.round(start + span * Math.min(chars, total) / total);

    const last = this.segments.at(-1);
    if (last?.open) {
      if (last.speaker === speaker && start - last.end <= CONTINUE_GAP_MS) {
        const head = splitSentences(rest)[0];
        rest = rest.slice(head.length).trim();
        last.text = joinText(last.text, head);
        last.end = Math.max(last.end, rest ? at(total - rest.length) : Math.round(end));
        this.emit('segment-update', { index: last.index, text: last.text, end: last.end, open: true });
        if (endsSentence(head) || last.text.length >= MAX_OPEN_CHARS) this.closeOpenSegment();
        else this.scheduleSave();
        if (!rest) return;
      } else {
        this.closeOpenSegment();
      }
    }

    const sentences = splitSentences(rest);
    // The unfinished tail gets its own segment so the complete sentences
    // before it can be translated now instead of waiting for the next piece.
    const tail = endsSentence(sentences.at(-1)) ? null : sentences.pop();
    const groups = groupSentences(sentences, SEGMENT_TARGET_CHARS);
    if (tail) groups.push(tail);
    let offset = total - rest.length;
    groups.forEach((group, i) => {
      const final = i === groups.length - 1;
      const from = offset;
      offset += group.length;
      this.pushSegment({
        text: group,
        start: at(from),
        end: final ? Math.round(end) : at(offset),
        speaker,
        provider,
        open: final && !!tail && group.length < MAX_OPEN_CHARS,
      });
    });
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
    // An open sentence is translated once it is complete.
    if (seg.open) full.open = true;
    this.segments.push(full);
    this.emit('segment', { segment: full });
    if (!full.open) {
      this.translateQueue.push(full.index);
      this.scheduleTranslate();
    }
    this.scheduleSave();
  }

  /** Finish the trailing unfinished sentence, if any, and queue its translation. */
  closeOpenSegment() {
    const last = this.segments.at(-1);
    if (!last?.open) return;
    delete last.open;
    this.emit('segment-update', { index: last.index, text: last.text, end: last.end, open: false });
    this.translateQueue.push(last.index);
    this.scheduleTranslate();
    this.scheduleSave();
  }

  /**
   * Rename a speaker everywhere. Renaming to a name another speaker already
   * has merges the two: their segments share the name and one entry remains.
   */
  renameSpeaker(from, to) {
    from = String(from || '').trim();
    to = String(to || '').trim().slice(0, 60);
    if (!from || !to || from === to) return;
    for (const seg of this.segments) if (seg.speaker === from) seg.speaker = to;
    const merging = Object.values(this.speakers).some((v) => v.name === to);
    for (const [k, v] of Object.entries(this.speakers)) {
      if (v.name !== from) continue;
      if (merging) delete this.speakers[k];
      else v.name = to;
    }
    this.emit('segments', { segments: this.segments });
    this.emit('speakers', { speakers: this.speakers });
    this.scheduleSave();
  }

  /** Give one segment a different (possibly new) speaker. */
  setSegmentSpeaker(index, name) {
    const seg = this.segments.find((s) => s.index === Number(index));
    name = String(name || '').trim().slice(0, 60);
    if (!seg || !name || seg.speaker === name) return;
    seg.speaker = name;
    if (!Object.values(this.speakers).some((v) => v.name === name)) {
      let n = Object.keys(this.speakers).length;
      while (this.speakers['m' + n]) n++;
      this.speakers['m' + n] = { name, key: 'm' + n };
      this.emit('speakers', { speakers: this.speakers });
    }
    this.emit('segment-update', { index: seg.index, speaker: name });
    this.scheduleSave();
  }

  // -- translation ----------------------------------------------------------

  llmOptions(task, options) {
    return { ...options, onUsage: (usage) => {
      const counts = {
        calls: usage.calls, ms: usage.ms, promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens, reasoningTokens: usage.reasoningTokens,
        reasoningReportedCalls: usage.reasoningReportedCalls,
        cachedInputTokens: usage.cachedInputTokens, unreportedCalls: usage.unreportedCalls,
      };
      const perTask = this.stats.llmByTask[task] ||= {};
      const names = { calls: 'llmCalls', ms: 'llmMs', unreportedCalls: 'llmUnreportedCalls' };
      for (const [name, value] of Object.entries(counts)) {
        const amount = value || 0;
        perTask[name] = (perTask[name] || 0) + amount;
        const totalName = names[name] || name;
        this.stats[totalName] = (this.stats[totalName] || 0) + amount;
      }
      this.emit('stats', { stats: this.stats });
      this.scheduleSave();
    } };
  }

  scheduleTranslate() {
    if (this.disposed) return;
    if (this.translateTimer) clearTimeout(this.translateTimer);
    this.translateTimer = setTimeout(() => {
      this.translateTimer = null;
      this.flushTranslation(false).catch(() => {});
    }, 2500);
    if (this.translateTimer.unref) this.translateTimer.unref();
  }

  async flushTranslation(drain) {
    if (this.disposed) return;
    if (this.translating) {
      // A stop must not return while a debounce batch is in flight: the rest
      // of the queue would never be translated. Wait, then drain what is left.
      if (drain) {
        await this.translating;
        return this.flushTranslation(true);
      }
      return;
    }
    if (!this.translateQueue.length) return;
    const target = this.translateTo;
    if (!target) return;

    let finished;
    this.translating = new Promise((resolve) => { finished = resolve; });
    try {
      while (!this.disposed && this.translateQueue.length) {
        const batchIds = this.translateQueue.splice(0, 20);
        const batch = batchIds
          .map((i) => this.segments.find((s) => s.index === i))
          .filter((s) => s && !s.translation);
        if (!batch.length) continue;
        const context = this.segments.filter((s) => s.index < batch[0].index && !s.open).slice(-2).map((s) => s.text);
        try {
          const { data } = await this.llm.json(
            'translate',
            prompts.translateMessages({ segments: batch, target, context }),
            this.llmOptions('translate', { temperature: 0.1, maxTokens: 4000 }),
          );
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
      this.translating = null;
      finished();
    }
  }

  // -- summary --------------------------------------------------------------

  async summarize({ automatic = false } = {}) {
    if (this.summarizing) return null;
    const mode = this.mode;
    const changed = this.summary && this.summaryMode !== mode;
    // A mode change must not silently replay all historical text on a timer.
    // The explicit summary button rebuilds once from the original transcript.
    if (automatic && changed) return this.summary;
    const fresh = changed ? this.segments : this.segments.filter((s) => s.index > this.summaryUpTo);
    if (!fresh.length) return this.summary;
    if (automatic && fresh.reduce((n, s) => n + s.text.trim().length, 0) < (this.config.summary.minNewChars || 0)) return this.summary;
    const upTo = fresh[fresh.length - 1].index;
    this.summarizing = true;
    this.emit('summary-pending', {});
    try {
      const res = await this.llm.call(
        'summary',
        prompts.summaryMessages({
          previous: !changed && this.summaryUpTo >= 0 ? this.summary : null,
          newSegments: fresh,
          maxChars: this.config.summary.maxChars,
          title: this.title,
          mode,
        }),
        this.llmOptions('summary', { temperature: 0.3, maxTokens: 4000 }),
      );
      const text = (res.text || '').trim();
      if (this.mode !== mode) throw new Error('使用场景已切换，请重新总结');
      if (!text) {
        throw new Error(
          '模型返回了空内容（finish_reason=' + (res.finish || '?') + '），已保留上一版摘要',
        );
      }
      this.summary = text;
      this.summaryMode = mode;
      // Text that arrived while the request was running belongs to the next
      // summary. Advancing to the current end would silently omit it.
      this.summaryUpTo = upTo;
      this.summaryAt = Date.now();
      this.emit('summary', { summary: this.summary, summaryMode: mode, upTo: this.summaryUpTo });
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
    const revision = this.notesRevision;
    const mode = this.mode;
    const notesDetail = this.notesDetail;
    this.emit('minutes-pending', {});
    const res = await this.llm.json(
      'minutes',
      prompts.minutesMessages({
        segments: this.segments,
        title: this.title,
        summary: this.summary,
        mode,
        notesDetail,
        targetLang: targetLang || (this.language === 'auto' ? 'zh' : this.language),
      }),
      this.llmOptions('minutes', { temperature: 0.2, maxTokens: 16000 }),
    );
    const data = res.data || {};
    if (revision !== this.notesRevision) throw new Error('使用场景或纪要详细度已切换，请重新生成');
    this.minutes = {
      ...data,
      mode,
      notesDetail,
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
      this.llmOptions('ask', { temperature: 0.2, maxTokens: 6000 }),
    );
    const entry = { question, answer: res.text.trim(), at: Date.now() };
    this.qa.push(entry);
    this.emit('answer', entry);
    this.scheduleSave();
    return entry;
  }

  // -- speaker re-split -----------------------------------------------------

  async resplitSpeakers() {
    if (this.segments.length < 2) return null;
    // One request per batch keeps the JSON reply far below the output limit
    // even for meetings with thousands of segments. Labels chosen in earlier
    // batches are passed on so speaker names stay consistent.
    const map = new Map();
    const known = new Set(Object.values(this.speakers).map((s) => s.name));
    for (let i = 0; i < this.segments.length; i += RESPLIT_BATCH) {
      const batch = this.segments.slice(i, i + RESPLIT_BATCH);
      const res = await this.llm.json(
        'summary',
        prompts.speakerSplitMessages({ segments: batch, speakers: [...known] }),
        this.llmOptions('speakers', { temperature: 0.1, maxTokens: 8000 }),
      );
      if (this.disposed) return null;
      for (const a of res.data?.assignments || []) {
        const label = String(a?.speaker || '').trim().slice(0, 60);
        if (!label) continue;
        map.set(Number(a.id), label);
        known.add(label);
      }
    }
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

  // -- whole-recording speaker correction -----------------------------------

  /** The engine used for whole-recording diarization, or null if unusable. */
  diarizationProvider() {
    const name = this.config.speakers?.provider || 'deepgram';
    const cfg = this.config.asr.providers[name];
    if (!cfg || !cfg.enabled || cfg.kind !== 'deepgram') return null;
    try {
      return this.asr.get(name);
    } catch {
      return null;
    }
  }

  /**
   * Send the complete recording once to a diarizing engine and relabel every
   * segment with speaker numbers that hold for the whole meeting. Text and
   * translations are untouched; the previous labels are kept for undo.
   */
  async diarizeRecording() {
    if (this.state !== 'stopped' && this.state !== 'processing') throw new Error('请在录音结束后校正说话人');
    if (!this.segments.length) throw new Error('还没有转写内容');
    if (!this.audio) throw new Error('这场会议没有保存音频，无法校正说话人');
    const provider = this.diarizationProvider();
    if (!provider) throw new Error('整场校正说话人需要已启用并填写密钥的 Deepgram 语音引擎');
    const ext = this.audio.ext;
    const file = audioPath(this.id, ext);
    if (!existsSync(file)) throw new Error('找不到这场会议的音频文件');
    this.emit('diarize-pending', {});
    const t0 = Date.now();
    const result = await provider.transcribe(readFileSync(file), {
      language: this.language,
      contentType: ext === '.mp3' ? 'audio/mpeg' : 'audio/wav',
      timeoutMs: 15 * 60 * 1000,
    });
    if (this.disposed) return null;
    const secs = result.seconds || this.durationMs / 1000;
    const inst = this.config.asr.providers[provider.name];
    this.stats.asrCalls++;
    this.stats.asrMs += Date.now() - t0;
    this.stats.asrSeconds += secs;
    if (inst) {
      this.stats.asrCostCurrency ||= inst.currency;
      if (this.stats.asrCostCurrency === inst.currency) this.stats.asrCost += (secs / 3600) * (inst.pricePerHour || 0);
    }
    const words = (result.words || []).filter((w) => w.speaker !== undefined && w.speaker !== null);
    if (!words.length) throw new Error('语音引擎没有返回说话人信息');

    const assignment = assignSpeakers(this.segments, words);
    const names = speakerNames(this.segments, assignment);
    this.speakerBackup = {
      at: Date.now(),
      speakers: structuredClone(this.speakers),
      labels: this.segments.map((s) => [s.index, s.speaker]),
    };
    let changed = 0;
    for (const seg of this.segments) {
      const label = names.get(assignment.get(seg.index));
      if (label && label !== seg.speaker) changed++;
      if (label) seg.speaker = label;
    }
    this.speakers = Object.fromEntries([...names].map(([n, name]) => ['s' + n, { name, key: 's' + n }]));
    this.emit('segments', { segments: this.segments });
    this.emit('speakers', { speakers: this.speakers, speakerBackup: { at: this.speakerBackup.at } });
    this.emit('stats', { stats: this.stats });
    this.scheduleSave();
    return { speakers: names.size, changed };
  }

  /** Restore the speaker labels from before the last correction. */
  undoDiarization() {
    const backup = this.speakerBackup;
    if (!backup) throw new Error('没有可撤销的说话人校正');
    const labels = new Map(backup.labels);
    for (const seg of this.segments) if (labels.has(seg.index)) seg.speaker = labels.get(seg.index);
    this.speakers = backup.speakers;
    this.speakerBackup = null;
    this.emit('segments', { segments: this.segments });
    this.emit('speakers', { speakers: this.speakers, speakerBackup: null });
    this.scheduleSave();
  }

  /** Optional correction after a recording or import; failures keep the live labels. */
  async autoDiarize() {
    if (!this.config.speakers?.autoDiarize || !this.audio || !this.segments.length || !this.diarizationProvider()) return;
    try {
      await this.diarizeRecording();
    } catch (err) {
      this.emit('error', { message: '整场校正说话人失败，已保留原标注：' + err.message, fatal: false });
    }
  }

  // -- audio persistence ----------------------------------------------------

  async writeAudio() {
    if (this.pcmStream) {
      const stream = this.pcmStream;
      this.pcmStream = null;
      await new Promise((r) => { stream.once('error', r); stream.end(r); });
    }
    if (!this.pcmPath || !this.pcmBytes || !existsSync(this.pcmPath)) return this.audio;
    try {
      // Patch the placeholder header now that the payload size is known.
      // The file size is authoritative: after a write error pcmBytes counts
      // audio that never reached the disk.
      const dataBytes = Math.min(this.pcmBytes, Math.max(0, statSync(this.pcmPath).size - 44)) & ~1;
      const fd = openSync(this.pcmPath, 'r+');
      writeSync(fd, wavHeader(this.sampleRate, dataBytes, 1), 0, 44, 0);
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
      // Lets the open page offer playback and speaker correction right away.
      this.emit('audio', { audio: this.audio });
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
      mode: doc.mode,
      notesDetail: doc.notesDetail,
      translateTo: doc.translateTo,
      config: deps.config,
      asr: deps.asr,
      llm: deps.llm,
      creds: deps.creds,
      source: doc.source,
    });
    m.state = 'stopped';
    m.segments = doc.segments || [];
    // A sentence left open by a crash or an old build is simply finished.
    for (const seg of m.segments) delete seg.open;
    m.speakerBackup = doc.speakerBackup || null;
    m.summary = doc.summary || null;
    m.summaryMode = prompts.normalizeMode(doc.summaryMode || doc.mode);
    m.minutes = doc.minutes || null;
    m.chapters = doc.chapters || [];
    m.speakers = doc.speakers || {};
    m.qa = doc.qa || [];
    m.stats = { ...m.stats, ...(doc.stats || {}) };
    m.stats.llmByTask ||= {};
    if ((doc.stats?.tokenStatsVersion || 0) < 2) m.stats.historicalUsageIncomplete = true;
    m.stats.tokenStatsVersion = 2;
    m.audio = doc.audio || null;
    m.createdAt = doc.createdAt || Date.now();
    m.durationMs = doc.durationMs || 0;
    m.upstream = doc.upstream || null;
    m.summaryUpTo = m.summary && Number.isInteger(doc.summaryUpTo) ? doc.summaryUpTo : -1;
    m.summaryAt = doc.summaryAt || null;
    m.segSeq = m.segments.length;
    return m;
  }
}

/** Build ASR/LLM independent export payloads from a meeting snapshot. */
export function toMarkdown(doc, { includeTranscript = true } = {}) {
  const lines = [];
  lines.push('# ' + (doc.title || '未命名会议'));
  lines.push('');
  lines.push('- 创建时间：' + new Date(doc.createdAt).toLocaleString('zh-CN'));
  lines.push('- 时长：' + formatDuration(doc.durationMs));
  lines.push('- 使用场景：' + (doc.mode === 'class' ? '上课' : '会议'));
  if (doc.upstream) lines.push('- 识别引擎：' + doc.upstream.label);
  lines.push('');
  if (doc.minutes) {
    const m = doc.minutes;
    lines.push('## ' + (m.mode === 'class' ? '课程笔记' : '智能纪要'));
    lines.push('');
    if ((m.mode || 'meeting') !== (doc.mode || 'meeting') || (m.notesDetail || 'standard') !== (doc.notesDetail || 'detailed')) {
      lines.push('> 整理选项已改变；以下保留原版本内容，可在应用中重新生成。', '');
    }
    if (m.abstract) lines.push(m.abstract, '');
    for (const topic of Array.isArray(m.topics) ? m.topics : []) {
      if (!topic || typeof topic !== 'object') continue;
      lines.push('### ' + (topic.title || '内容详解'), '');
      if (topic.detail) lines.push(topic.detail, '');
      for (const point of Array.isArray(topic.points) ? topic.points : []) lines.push('- ' + point);
      lines.push('');
    }
    for (const [key, heading, name, detail] of [
      ['keyConcepts', '核心概念与公式', 'term', 'explanation'],
      ['examples', '例题与案例', 'title', 'explanation'],
      ['reviewQuestions', '复习问答', 'question', 'answer'],
    ]) {
      if (!Array.isArray(m[key]) || !m[key].length) continue;
      lines.push('### ' + heading, '');
      for (const item of m[key]) if (item && typeof item === 'object') lines.push('#### ' + (item[name] || ''), '', item[detail] || '', '');
    }
    if (m.decisions?.length) {
      lines.push('### 关键决议');
      for (const d of m.decisions) lines.push('- ' + (d.decision || d) + (d.context ? '（' + d.context + '）' : ''));
      lines.push('');
    }
    if (m.actionItems?.length) {
      lines.push('### 待办事项');
      lines.push('| 事项 | 负责人 | 截止 |');
      lines.push('| --- | --- | --- |');
      for (const a of m.actionItems) lines.push('| ' + [a.task, a.owner, a.due]
        .map((value) => String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')).join(' | ') + ' |');
      lines.push('');
    }
    if (m.risks?.length) {
      lines.push('### 风险与分歧');
      for (const r of m.risks) lines.push('- ' + (r.risk || r) + (r.impact ? '（' + r.impact + '）' : ''));
      lines.push('');
    }
    if (m.keywords?.length) lines.push('关键词：' + m.keywords.join('、'), '');
    if (Array.isArray(m.openQuestions) && m.openQuestions.length) lines.push('### 待确认问题', '', ...m.openQuestions.map((q) => '- ' + q), '');
    if (Array.isArray(m.chapters) && m.chapters.length) {
      lines.push('### 章节回顾', '');
      for (const chapter of m.chapters) if (chapter && typeof chapter === 'object') lines.push('#### ' + (chapter.start || '') + ' ' + (chapter.title || ''), '', chapter.summary || '', '');
    }
  }
  if (doc.summary) {
    lines.push('## ' + ((doc.summaryMode || 'meeting') === 'class' ? '课堂摘要' : '会议摘要'));
    lines.push('');
    if ((doc.summaryMode || 'meeting') !== (doc.mode || 'meeting')) lines.push('> 使用场景已改变；以下为原场景的摘要，可在应用中重新总结。', '');
    lines.push(doc.summary, '');
  }
  if (!includeTranscript) return lines.join('\n');
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

/** SubRip subtitle export. */
export function toSrt(doc, useTranslation) {
  const cue = (ms) => {
    const total = Math.max(0, Math.round(ms || 0));
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return pad(Math.floor(total / 3600000)) + ':' + pad(Math.floor((total % 3600000) / 60000)) + ':' +
      pad(Math.floor((total % 60000) / 1000)) + ',' + pad(total % 1000, 3);
  };
  return (doc.segments || []).map((seg, i) => {
    const body = useTranslation && seg.translation ? seg.translation : seg.text;
    return (i + 1) + '\n' + cue(seg.start) + ' --> ' + cue(seg.end) + '\n' + seg.speaker + '：' + String(body).replace(/\n{2,}/g, '\n') + '\n';
  }).join('\n');
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
    // A blank line or "-->" inside a cue would end or corrupt it.
    const safe = String(body).replace(/-->/g, '→').replace(/\n{2,}/g, '\n');
    out.push(String(seg.index), cue(seg.start) + ' --> ' + cue(seg.end), seg.speaker + '：' + safe, '');
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
