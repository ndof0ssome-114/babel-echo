// quick-setup.js — the decisions behind the quick settings view.
//
// Pure functions over the status object from /api/bootstrap, so the browser
// and the offline tests share one implementation. The quick view only asks
// for keys; which engine serves which language or task follows from here.

export const TASKS = ['summary', 'minutes', 'translate', 'ask'];

/** Same language rule as pickAsrProvider in lib/config.mjs. */
export function supportsLanguage(provider, language) {
  if (!language || language === 'auto') return true;
  if (provider.kind === 'mimo') return ['zh', 'en'].includes(language);
  return !!(provider.languages?.includes(language) || provider.languages?.includes('auto'));
}

function usable(provider, language) {
  return !!provider && provider.enabled && provider.ready && supportsLanguage(provider, language);
}

/**
 * The ASR provider a recording in `language` will actually use, mirroring
 * pickAsrProvider: a forced engine, then the language route, then the first
 * usable engine in config order. Null when nothing can transcribe it.
 */
export function effectiveAsr(status, language) {
  const lang = language || 'auto';
  const byName = new Map(status.asr.map((p) => [p.name, p]));
  if (status.active && status.active !== 'auto' && usable(byName.get(status.active), lang)) return byName.get(status.active);
  const preferred = byName.get(status.routes[lang] || status.routes.auto || 'mimo');
  if (usable(preferred, lang)) return preferred;
  return status.asr.find((p) => usable(p, lang)) || null;
}

/**
 * Route changes that make the routing table say what will really happen:
 * a language whose route points at an unusable engine is pointed at the one
 * that will serve it instead. Working routes are never touched.
 */
export function routeRepairs(status) {
  const patch = {};
  for (const [language, name] of Object.entries(status.routes)) {
    const current = status.asr.find((p) => p.name === name);
    if (usable(current, language)) continue;
    const next = effectiveAsr(status, language);
    if (next && next.name !== name) patch[language] = next.name;
  }
  return patch;
}

/** Tasks whose text model cannot run right now. */
export function taskProblems(status) {
  return TASKS.filter((task) => {
    const role = status.roles[task];
    const provider = status.llm.find((p) => p.name === role?.provider);
    return !role?.model || !provider || !provider.enabled || !provider.ready;
  });
}

/**
 * Point every task at one text service. DeepSeek keeps the tuned split
 * (fast model for summary, translation and questions, the larger one for
 * minutes); any other service uses the one model the user picked.
 */
export function rolesFor(providerName, model, deepseek = false) {
  if (deepseek) {
    return {
      summary: { provider: providerName, model: 'deepseek-flash', thinking: 'disabled' },
      minutes: { provider: providerName, model: 'deepseek-v4-pro', thinking: 'default' },
      translate: { provider: providerName, model: 'deepseek-flash', thinking: 'disabled' },
      ask: { provider: providerName, model: 'deepseek-flash', thinking: 'default' },
    };
  }
  return Object.fromEntries(TASKS.map((task) => [task, { provider: providerName, model, thinking: 'default' }]));
}

/** One-line overall state for the top of the quick view. */
export function setupState(status, language) {
  const asr = effectiveAsr(status, language);
  const problems = taskProblems(status);
  if (!asr) return { level: 'miss', message: '还需要配置语音识别', problems };
  if (problems.length) return { level: 'warn', message: '可以转写；摘要、纪要和翻译还需要文本模型', problems };
  return { level: 'ok', message: '一切就绪，可以开始录音', problems };
}
