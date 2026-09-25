// index.mjs — the ASR provider registry.
//
// MiMo is the default for Chinese and English. Japanese must use a provider
// that explicitly supports it. Providers advertise their languages
// so the registry can route per language and fall back safely.
//
// The ONE hard invariant enforced below: a specific language is never sent to
// a backend that does not declare it. Falling back to an incapable engine
// would turn a clear error into silently wrong output.

import * as mimo from './mimo.mjs';
import * as openaiAudio from './openai-audio.mjs';
import * as deepgram from './deepgram.mjs';

const FACTORIES = {
  mimo: mimo.create,
  'openai-audio': openaiAudio.create,
  deepgram: deepgram.create,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AsrRegistry {
  constructor(config, creds) {
    this.config = config;
    this.creds = creds;
    this.instances = new Map();
    this.failures = new Map();
    this.nextRequestAt = new Map();
    this.requestTurns = new Map();
    // 3.5 seconds between Groq requests leaves room below its 20 RPM limit.
    this.groqRequestGapMs = 3500;
  }

  async waitForRequestSlot(name) {
    if (name !== 'groq') return;
    const previous = this.requestTurns.get(name) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const current = previous.then(() => turn);
    this.requestTurns.set(name, current);
    await previous;
    try {
      const delay = (this.nextRequestAt.get(name) || 0) - Date.now();
      if (delay > 0) await sleep(delay);
      this.nextRequestAt.set(name, Date.now() + this.groqRequestGapMs);
    } finally {
      release();
      if (this.requestTurns.get(name) === current) this.requestTurns.delete(name);
    }
  }

  /** Instantiate a provider, remembering construction failures. */
  get(name) {
    if (this.instances.has(name)) return this.instances.get(name);
    const cfg = this.config.asr.providers[name];
    if (!cfg) throw new Error('unknown asr provider: ' + name);
    const factory = FACTORIES[cfg.kind];
    if (!factory) throw new Error('unknown asr kind: ' + cfg.kind);
    let instance;
    try {
      instance = factory(cfg, this.creds);
      instance.name = name;
    } catch (err) {
      this.failures.set(name, err.message);
      throw err;
    }
    this.instances.set(name, instance);
    return instance;
  }

  /** Every enabled provider that can be constructed right now. */
  available() {
    const out = [];
    for (const [name, cfg] of Object.entries(this.config.asr.providers)) {
      if (!cfg.enabled) continue;
      try {
        this.get(name);
        out.push(name);
      } catch {
        /* not configured */
      }
    }
    return out;
  }

  /** Choose a backend for a language, with graceful fallback. */
  pick(language) {
    const asr = this.config.asr;
    const lang = language || 'auto';
    const usable = (name) => {
      const cfg = asr.providers[name];
      if (!cfg || !cfg.enabled) return null;
      if (lang !== 'auto' && (cfg.kind === 'mimo'
        ? !['zh', 'en'].includes(lang)
        : !cfg.languages.includes(lang) && !cfg.languages.includes('auto'))) return null;
      try {
        return this.get(name);
      } catch {
        return null;
      }
    };

    if (asr.active && asr.active !== 'auto') {
      const forced = usable(asr.active);
      if (forced) return forced;
    }

    // A Japanese request must not land on a zh/en-only backend.
    const order = [];
    const route = asr.routes[lang] || asr.routes.auto;
    if (route) order.push(route);
    if (lang === 'ja') {
      order.push('groq', 'deepgram', 'local');
    } else {
      order.push(asr.routes[lang] || 'mimo', 'mimo');
    }
    for (const name of Object.keys(asr.providers)) {
      order.push(name);
    }

    const seen = new Set();
    for (const name of order) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const inst = usable(name);
      if (!inst) continue;
      const langs = inst.languages || [];
      const okByLang = lang === 'auto' ? true :
        inst.kind === 'mimo' ? ['zh', 'en'].includes(lang) : langs.includes(lang) || langs.includes('auto');
      if (!okByLang) continue;
      return inst;
    }
    // A specific language must never fall through to a backend that does not
    // declare support for it. Silently using an incapable engine turns a clear
    // "no engine for this language" error into quietly wrong output. Only
    // 'auto' is allowed to use whatever is available.
    if (lang === 'auto') {
      for (const name of Object.keys(asr.providers)) {
        const inst = usable(name);
        if (inst) return inst;
      }
    }
    return null;
  }

  /** Transcribe, retrying once on the next-best provider if the first fails. */
  async transcribe(language, wavBuffer, opts) {
    const primary = this.pick(language);
    if (!primary) {
      const lang = language || 'auto';
      const labels = { zh: '中文', en: '英文', ja: '日语', auto: '自动检测' };
      const enabled = Object.entries(this.config.asr.providers)
        .filter(([, p]) => p.enabled)
        .map(([n, p]) => n + '(' + (p.languages || []).join('/') + ')');
      throw new Error(
        '没有支持「' + (labels[lang] || lang) + '」的语音识别引擎。' +
          '已启用：' + (enabled.join('、') || '无') + '。' +
          (lang === 'ja' ? ' 请在「设置」中启用 Groq、Deepgram 或支持日语的本地引擎。' : ''),
      );
    }
    const maxAttempts = primary.name === 'groq' ? 4 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.waitForRequestSlot(primary.name);
      try {
        const result = await primary.transcribe(wavBuffer, { ...(opts || {}), language });
        result.providerName = primary.name;
        return result;
      } catch (err) {
        err.providerName = primary.name;
        if (primary.name !== 'groq' || err.status !== 429 || attempt === maxAttempts - 1) {
          if (primary.name === 'groq' && err.status === 429) {
            err.message = 'Groq 每分钟请求额度已用尽，自动重试后仍被限流。录音会继续保存，请稍后重试转写。';
          }
          throw err;
        }
        const retryAt = Date.now() + (err.retryAfterMs || 5000);
        this.nextRequestAt.set(primary.name, Math.max(this.nextRequestAt.get(primary.name) || 0, retryAt));
      }
    }
  }
}

export function createAsrRegistry(config, creds) {
  return new AsrRegistry(config, creds);
}
