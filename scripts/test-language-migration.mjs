#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'miaoji-language-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
try {
  writeFileSync(process.env.MIAOJI_CONFIG_PATH, JSON.stringify({
    schemaVersion: 2,
    realtime: { silenceMs: 800, maxUtteranceMs: 20000 },
    asr: { routes: { ja: 'mimo' }, providers: { mimo: { languages: ['zh', 'en', 'ja'] } } },
  }));
  const { loadConfig, saveConfig } = await import('../lib/config.mjs');
  const { AsrRegistry } = await import('../lib/asr/index.mjs');
  const config = loadConfig();
  assert.equal(config.schemaVersion, 3);
  assert.deepEqual(config.asr.providers.mimo.languages, ['zh', 'en']);
  assert.equal(config.asr.routes.ja, 'groq');
  assert.equal(config.realtime.silenceMs, 1200);
  assert.equal(config.realtime.maxUtteranceMs, 30000);
  assert.equal(config.realtime.overlapMs, 1200);
  const registry = new AsrRegistry(config, { XIAOMI_API_KEY: 'test' });
  assert.equal(registry.pick('ja'), null);
  assert.equal(registry.pick('zh').name, 'mimo');
  console.log('PASS old Japanese MiMo routing and timing settings migrate safely');

  assert.throws(() => saveConfig({ asr: { providers: { mimo: { languages: ['zh', 'en', 'ja'] } } } }), /仅支持中文和英文/);
  assert.throws(() => saveConfig({ asr: { routes: { ja: 'mimo' } } }), /MiMo 不能用于/);
  saveConfig({ realtime: { stepMs: 5000, silenceMs: 1500 } });
  assert.equal(config.realtime.stepMs, 5000);
  assert.equal(config.realtime.silenceMs, 1500);
  console.log('PASS unsupported routes are rejected and timing settings persist');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
