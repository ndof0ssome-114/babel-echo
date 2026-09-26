// config.mjs — persisted application configuration.
//
// Two ideas drive the shape of this file:
//   1. ASR is pluggable. MiMo is the default because it is already
//      provisioned and is excellent at Chinese, but MiMo cannot transcribe
//      Japanese at all (asr_options.language accepts only zh/en/auto), so
//      Japanese routes to an OpenAI-compatible provider such as Groq.
//   2. Secrets are never copied into the config. Only the *name* of a
//      credential is stored (keyRef) and the value is read from the
//      environment or ~/.dsh/.credentials.yaml at request time.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
// A packaged build is read-only, so the desktop shell redirects all mutable
// state (meetings, audio, uploaded keys) into the per-user app data folder.
export const DATA_DIR = process.env.MIAOJI_DATA_DIR || join(ROOT, 'data');
const CONFIG_PATH = process.env.MIAOJI_CONFIG_PATH || join(ROOT, 'config.json');
export const MEETINGS_DIR = join(DATA_DIR, 'meetings');
export const AUDIO_DIR = join(DATA_DIR, 'audio');
export const TMP_DIR = join(DATA_DIR, 'tmp');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');

export const DEFAULT_CONFIG = {
  schemaVersion: 3,
  server: { port: 8777, host: '127.0.0.1' },
  audio: { sampleRate: 16000 },
  realtime: {
    stepMs: 3000,        // how often an in-progress utterance is re-transcribed
    minNewMs: 1500,      // ...but only once this much new audio accumulated
    silenceMs: 1200,     // pause length that closes an utterance
    maxUtteranceMs: 30000,
    overlapMs: 1200,     // audio retained across an unavoidable hard split
    vadThreshold: 0.003, // RMS gate; quiet headset microphones need a lower floor
  },
  summary: { autoMs: 180000, maxChars: 900, minNewChars: 200 },
  translate: { target: 'ja' },
  asr: {
    active: 'auto',            // 'auto' | a provider name
    routes: { zh: 'mimo', en: 'mimo', ja: 'groq', ko: 'groq', fr: 'groq', de: 'groq', es: 'groq', auto: 'mimo' },
    providers: {
      mimo: {
        kind: 'mimo',
        label: 'Xiaomi MiMo-V2.5-ASR',
        enabled: true,
        keyRef: 'XIAOMI_API_KEY',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5-asr',
        // The documented ASR languages are Chinese and English. In
        // particular, auto detection is not a promise of Japanese support.
        languages: ['zh', 'en'],
        pricePerHour: 0.5,
        currency: 'CNY',
        note: '仅用于中文和英文；日语请选择其他语音引擎',
      },
      groq: {
        kind: 'openai-audio',
        label: 'Groq Whisper Large v3 Turbo',
        enabled: false,
        keyRef: 'GROQ_API_KEY',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'whisper-large-v3-turbo',
        languages: ['ja', 'zh', 'en', 'ko', 'fr', 'de', 'es', 'auto'],
        pricePerHour: 0.04,
        currency: 'USD',
        note: '日语最干净也最便宜（约 0.04 美元/小时），需要 Groq key',
      },
      deepgram: {
        kind: 'deepgram',
        label: 'Deepgram Nova-3 (diarization)',
        enabled: false,
        keyRef: 'DEEPGRAM_API_KEY',
        baseUrl: 'https://api.deepgram.com/v1',
        model: 'nova-3',
        languages: ['ja', 'zh', 'en', 'auto'],
        pricePerHour: 0.26,
        currency: 'USD',
        note: 'Only provider here with real speaker diarization.',
      },
      local: {
        kind: 'openai-audio',
        label: 'Local Whisper (whisper.cpp server)',
        enabled: false,
        keyRef: 'LOCAL_ASR_KEY',
        baseUrl: 'http://127.0.0.1:8080/v1',
        noAuth: true,
        model: 'whisper-1',
        languages: ['ja', 'zh', 'en', 'auto'],
        pricePerHour: 0,
        currency: 'CNY',
        note: 'Free and offline; run whisper.cpp with --server.',
      },
    },
  },
  llm: {
    providers: {
      deepseek: {
        kind: 'openai-chat',
        label: 'DeepSeek',
        enabled: true,
        keyRef: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com/v1',
      },
      mimo: {
        kind: 'openai-chat',
        label: 'Xiaomi MiMo',
        enabled: true,
        keyRef: 'XIAOMI_API_KEY',
        baseUrl: 'https://api.xiaomimimo.com/v1',
      },
      local: {
        kind: 'openai-chat',
        label: '本地文本模型（Ollama / LM Studio）',
        enabled: false,
        keyRef: 'LOCAL_LLM_KEY',
        baseUrl: 'http://127.0.0.1:11434/v1',
        noAuth: true,
      },
    },
    roles: {
      summary: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'disabled' },
      minutes: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      translate: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'disabled' },
      ask: { provider: 'deepseek', model: 'deepseek-flash' },
    },
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

function validateConfig(config) {
  const summary = config.summary;
  if (!Number.isInteger(summary.autoMs) || (summary.autoMs !== 0 && (summary.autoMs < 30000 || summary.autoMs > 3600000))) {
    throw new Error('自动摘要间隔须为 0 或 30–3600 秒');
  }
  if (!Number.isInteger(summary.maxChars) || summary.maxChars < 200 || summary.maxChars > 3000 ||
      !Number.isInteger(summary.minNewChars) || summary.minNewChars < 0 || summary.minNewChars > 10000) {
    throw new Error('摘要长度须为 200–3000 字，新增文字门槛须为 0–10000 字');
  }
  const realtimeBounds = {
    stepMs: [2000, 60000], silenceMs: [400, 3000],
    maxUtteranceMs: [10000, 60000], overlapMs: [0, 3000],
  };
  for (const [key, [min, max]] of Object.entries(realtimeBounds)) {
    const value = config.realtime[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('实时识别参数超出范围：' + key);
  }
  if (config.realtime.overlapMs >= config.realtime.maxUtteranceMs / 2) throw new Error('衔接音频不能超过最长单句的一半');
  for (const [category, kinds] of [['asr', ['mimo', 'openai-audio', 'deepgram']], ['llm', ['openai-chat']]]) {
    for (const [name, provider] of Object.entries(config[category].providers)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error('无效的引擎标识：' + name);
      if (!provider || !kinds.includes(provider.kind)) throw new Error('不支持的引擎协议：' + name);
      if (provider.noAuth && !['openai-audio', 'openai-chat'].includes(provider.kind)) throw new Error('该协议必须提供 API Key：' + name);
      if (!provider.label || String(provider.label).length > 120) throw new Error('请填写引擎名称：' + name);
      try {
        const url = new URL(provider.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { throw new Error('无效的接口地址：' + name); }
      if (provider.keyRef && !/^[A-Z][A-Z0-9_]*$/.test(provider.keyRef)) throw new Error('无效的密钥名称：' + name);
      if (category === 'asr') {
        if (!provider.model || !Array.isArray(provider.languages) || !provider.languages.length) throw new Error('请填写语音模型和支持语言：' + name);
        if (provider.kind === 'mimo' && provider.languages.some((lang) => !['zh', 'en'].includes(lang))) {
          throw new Error('MiMo 语音识别仅支持中文和英文：' + name);
        }
      }
    }
  }
  for (const [lang, route] of Object.entries(config.asr.routes)) {
    if (!config.asr.providers[route]) throw new Error('语音路由指向不存在的引擎：' + route);
    if (!['zh', 'en', 'auto'].includes(lang) && config.asr.providers[route].kind === 'mimo') {
      throw new Error('MiMo 不能用于' + lang + '语音识别');
    }
  }
  for (const role of Object.values(config.llm.roles)) {
    if (!config.llm.providers[role.provider] || !role.model) throw new Error('文本任务需要有效的引擎和模型');
    if (role.thinking !== undefined && !['default', 'enabled', 'disabled'].includes(role.thinking)) throw new Error('无效的思考模式');
  }
}

let current = null;

export function loadConfig() {
  if (current) return current;
  let fileCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('[config] ignoring unreadable config.json:', err.message);
    }
  }
  const merged = deepMerge(DEFAULT_CONFIG, fileCfg);

  // Historical configs were persisted in full. Upgrade their built-in
  // capability lists once, then preserve subsequent user edits.
  if ((fileCfg.schemaVersion || 0) < 2) {
    for (const [name, def] of Object.entries(DEFAULT_CONFIG.asr.providers)) {
      const live = merged.asr?.providers?.[name];
      if (!live) continue;
      live.languages = def.languages.slice();
    }
  }
  if ((fileCfg.schemaVersion || 0) < 3) {
    if (merged.realtime.silenceMs === 800) merged.realtime.silenceMs = 1200;
    if (merged.realtime.maxUtteranceMs === 20000) merged.realtime.maxUtteranceMs = 30000;
  }
  for (const provider of Object.values(merged.asr.providers)) {
    if (provider.kind === 'mimo') {
      provider.languages = provider.languages.filter((lang) => ['zh', 'en'].includes(lang));
      if (!provider.languages.length) provider.languages = ['zh', 'en'];
    }
  }
  for (const [lang, name] of Object.entries(merged.asr.routes)) {
    if (!['zh', 'en', 'auto'].includes(lang) && merged.asr.providers[name]?.kind === 'mimo') {
      merged.asr.routes[lang] = DEFAULT_CONFIG.asr.routes[lang] || 'groq';
    }
  }
  merged.schemaVersion = DEFAULT_CONFIG.schemaVersion;

  current = merged;
  return current;
}

export function saveConfig(patch) {
  const base = loadConfig();
  const merged = deepMerge(base, patch);
  validateConfig(merged);

  // Mutate the cached object IN PLACE rather than replacing it.
  // Consumers capture this reference once at startup (server.mjs does
  // `const config = loadConfig()`, the ASR registry stores it too), so
  // swapping in a fresh object would leave them reading stale values: the
  // change would be written to disk and even take effect at runtime, while
  // GET /api/config kept reporting the old settings and the UI snapped every
  // toggle back to its previous position.
  for (const key of Object.keys(base)) {
    if (!(key in merged)) delete base[key];
  }
  Object.assign(base, merged);
  current = base;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2) + '\n', 'utf8');
  return base;
}

export function deleteCustomProvider(category, name) {
  if (!['asr', 'llm'].includes(category) || !/^custom_[a-z0-9_]+$/.test(name)) throw new Error('只能删除自定义引擎');
  const config = loadConfig();
  if (!config[category].providers[name]) throw new Error('引擎不存在');
  const next = structuredClone(config);
  delete next[category].providers[name];
  if (category === 'asr') {
    for (const [lang, provider] of Object.entries(next.asr.routes)) {
      if (provider === name) next.asr.routes[lang] = DEFAULT_CONFIG.asr.routes[lang] || 'mimo';
    }
    if (next.asr.active === name) next.asr.active = 'auto';
  } else {
    for (const [task, role] of Object.entries(next.llm.roles)) {
      if (role.provider === name) next.llm.roles[task] = structuredClone(DEFAULT_CONFIG.llm.roles[task] || DEFAULT_CONFIG.llm.roles.summary);
    }
  }
  validateConfig(next);
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, MEETINGS_DIR, AUDIO_DIR, TMP_DIR, UPLOAD_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Japanese is the default target when the speaker is using Japanese, etc. */
export function pickAsrProvider(config, language, creds) {
  const asr = config.asr;
  const lang = language || 'auto';
  const usable = (name) => {
    const p = asr.providers[name];
    if (!p || !p.enabled || (!p.noAuth && !creds[p.keyRef])) return null;
    if (lang !== 'auto' && (p.kind === 'mimo' ? !['zh', 'en'].includes(lang) : !p.languages.includes(lang) && !p.languages.includes('auto'))) return null;
    return { name, cfg: p };
  };
  if (asr.active && asr.active !== 'auto') {
    const forced = usable(asr.active);
    if (forced) return forced;
  }
  const preferred = asr.routes[lang] || asr.routes.auto || 'mimo';

  const first = usable(preferred);
  if (first) return first;

  // Fall back through every enabled provider so a meeting never dies just
  // because the preferred backend is unconfigured.
  for (const name of Object.keys(asr.providers)) {
    const found = usable(name);
    if (found) return found;
  }
  return null;
}

/** Describe provider readiness for the settings panel without leaking keys. */
export function providerStatus(config, creds) {
  const asr = Object.entries(config.asr.providers).map(([name, p]) => ({
    name,
    kind: p.kind,
    label: p.label,
    enabled: p.enabled,
    languages: p.languages,
    pricePerHour: p.pricePerHour,
    currency: p.currency,
    note: p.note || '',
    ready: !!(p.noAuth || creds[p.keyRef]),
    hasKey: !!creds[p.keyRef],
    noAuth: !!p.noAuth,
    baseUrl: p.baseUrl,
    model: p.model,
    custom: name.startsWith('custom_'),
    keyRef: p.keyRef,
  }));
  const llm = Object.entries(config.llm.providers).map(([name, p]) => ({
    name,
    label: p.label,
    kind: p.kind,
    enabled: p.enabled !== false,
    ready: !!(p.noAuth || creds[p.keyRef]),
    hasKey: !!creds[p.keyRef],
    noAuth: !!p.noAuth,
    baseUrl: p.baseUrl,
    custom: name.startsWith('custom_'),
    keyRef: p.keyRef,
  }));
  return {
    asr,
    llm,
    routes: config.asr.routes,
    active: config.asr.active,
    roles: config.llm.roles,
    realtime: config.realtime,
    summary: config.summary,
  };
}
