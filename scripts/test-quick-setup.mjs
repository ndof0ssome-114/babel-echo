#!/usr/bin/env node
// Offline checks for the quick settings logic in public/quick-setup.js: it
// must predict exactly the engine the server picks, and its automatic route
// and task changes must only ever point at something that works.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'babel-quick-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');

try {
  const { DEFAULT_CONFIG, pickAsrProvider, providerStatus } = await import('../lib/config.mjs');
  const { effectiveAsr, routeRepairs, taskProblems, rolesFor, setupState, TASKS } = await import('../public/quick-setup.js');

  const names = Object.keys(DEFAULT_CONFIG.asr.providers);
  const languages = Object.keys(DEFAULT_CONFIG.asr.routes);
  const keyRefs = [...new Set(names.map((n) => DEFAULT_CONFIG.asr.providers[n].keyRef))];

  // Every combination of enabled engines, available keys and a forced engine.
  let cases = 0;
  for (let enabledMask = 0; enabledMask < 1 << names.length; enabledMask++) {
    for (let keyMask = 0; keyMask < 1 << keyRefs.length; keyMask++) {
      for (const active of ['auto', 'groq', 'mimo']) {
        const config = structuredClone(DEFAULT_CONFIG);
        names.forEach((n, i) => { config.asr.providers[n].enabled = !!(enabledMask & (1 << i)); });
        config.asr.active = active;
        const creds = Object.fromEntries(keyRefs.filter((_, i) => keyMask & (1 << i)).map((k) => [k, 'x']));
        const status = providerStatus(config, creds);
        for (const lang of languages) {
          const server = pickAsrProvider(config, lang, creds)?.name ?? null;
          assert.equal(effectiveAsr(status, lang)?.name ?? null, server, `${lang} ${enabledMask}/${keyMask}/${active}`);
          cases++;
        }
        // Repaired routes keep pointing at the engine that really runs.
        const repaired = { ...status, routes: { ...status.routes, ...routeRepairs(status) } };
        for (const lang of languages) {
          assert.equal(effectiveAsr(repaired, lang)?.name ?? null, effectiveAsr(status, lang)?.name ?? null);
        }
      }
    }
  }
  console.log(`PASS quick view predicts the server's engine choice (${cases} cases)`);

  // Default install with only a Groq key: Japanese already routes to Groq,
  // Chinese and English fall back to it and their routes are repaired.
  const config = structuredClone(DEFAULT_CONFIG);
  config.asr.providers.groq.enabled = true;
  let status = providerStatus(config, { GROQ_API_KEY: 'x' });
  assert.deepEqual(routeRepairs(status), { zh: 'groq', en: 'groq', auto: 'groq' });
  // Working routes are never rewritten.
  status = providerStatus(config, { GROQ_API_KEY: 'x', XIAOMI_API_KEY: 'x' });
  assert.deepEqual(routeRepairs(status), {});
  // No usable engine: nothing to repair to.
  status = providerStatus(structuredClone(DEFAULT_CONFIG), {});
  assert.deepEqual(routeRepairs(status), {});
  assert.equal(setupState(status, 'zh').level, 'miss');
  console.log('PASS route repairs only touch broken routes');

  // Text tasks: DeepSeek defaults need its key; switching keeps a valid config.
  status = providerStatus(structuredClone(DEFAULT_CONFIG), { XIAOMI_API_KEY: 'x' });
  assert.deepEqual(taskProblems(status), TASKS);
  assert.equal(setupState(status, 'zh').level, 'warn');
  status = providerStatus(structuredClone(DEFAULT_CONFIG), { XIAOMI_API_KEY: 'x', DEEPSEEK_API_KEY: 'x' });
  assert.deepEqual(taskProblems(status), []);
  assert.equal(setupState(status, 'zh').level, 'ok');
  assert.deepEqual(rolesFor('deepseek', '', true), Object.fromEntries(Object.entries(DEFAULT_CONFIG.llm.roles)
    .map(([task, role]) => [task, { thinking: 'default', ...role }])), 'DeepSeek keeps the default split');
  const mimo = rolesFor('mimo', 'mimo-v2-flash');
  assert.deepEqual(Object.keys(mimo), TASKS);
  assert.ok(Object.values(mimo).every((r) => r.provider === 'mimo' && r.model === 'mimo-v2-flash' && r.thinking === 'default'));

  // The roles patch is accepted by the real config validation.
  const { saveConfig } = await import('../lib/config.mjs');
  const saved = saveConfig({ llm: { roles: mimo } });
  assert.equal(saved.llm.roles.minutes.provider, 'mimo');
  console.log('PASS task models are reported and reassigned consistently');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
