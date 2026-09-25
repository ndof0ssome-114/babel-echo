#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'miaoji-custom-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
process.env.DSH_HOME = join(temp, 'dsh');
process.env.MIAOJI_TEST_KEY = 'from-env';

const { loadConfig, saveConfig, deleteCustomProvider, providerStatus, pickAsrProvider } = await import('../lib/config.mjs');
const { loadCreds, setLocalCred } = await import('../lib/env.mjs');
const { Llm } = await import('../lib/llm.mjs');
const { AsrRegistry } = await import('../lib/asr/index.mjs');

let mock;
let appServer;
try {
  const creds = loadCreds();
  assert.equal(creds.MIAOJI_TEST_KEY, 'from-env');
  setLocalCred('MIAOJI_TEST_KEY', 'from-ui');
  assert.equal(creds.MIAOJI_TEST_KEY, 'from-ui', 'UI key should override environment immediately');
  setLocalCred('MIAOJI_TEST_KEY', '');
  assert.equal(creds.MIAOJI_TEST_KEY, 'from-env', 'clearing local key should restore environment key');
  console.log('PASS key update and removal preserve the effective credential order');

  let seenAuth = null;
  let seenModel = null;
  let seenAsrAuth = null;
  let seenAsrBody = '';
  mock = createServer(async (req, res) => {
    seenAuth = req.headers.authorization || null;
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'local-test-model' }] }));
      return;
    }
    if (req.url === '/v1/audio/transcriptions') {
      seenAsrAuth = req.headers.authorization || null;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seenAsrBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'テスト', duration: 1 }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenModel = body.model;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: {} }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';

  const config = loadConfig();
  saveConfig({ llm: {
    providers: { custom_local_test: {
      kind: 'openai-chat', label: 'Test local model', enabled: true,
      baseUrl, keyRef: 'MIAOJI_LOCAL_TEST_KEY', noAuth: true,
    } },
    roles: { summary: { provider: 'custom_local_test', model: 'local-test-model' } },
  } });
  assert.equal(config.llm.roles.summary.provider, 'custom_local_test');
  assert.equal(providerStatus(config, creds).llm.find((p) => p.name === 'custom_local_test').ready, true);
  const llm = new Llm(config, creds);
  const response = await llm.call('summary', [{ role: 'user', content: 'test' }]);
  assert.equal(response.text, 'OK');
  assert.equal(seenModel, 'local-test-model');
  assert.equal(seenAuth, null, 'no-auth local server should not receive an empty Bearer header');
  console.log('PASS custom local chat provider runs without an API key');

  const serverReady = new Promise((resolve, reject) => {
    appServer = spawn(process.execPath, ['server.mjs', '0'], {
      cwd: join(import.meta.dirname, '..'), env: { ...process.env, MIAOJI_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => reject(new Error('app server startup timed out')), 10000);
    appServer.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/).find((part) => part.startsWith('MIAOJI_READY '));
      if (line) { clearTimeout(timeout); resolve(JSON.parse(line.slice(13)).url); }
    });
    appServer.on('exit', (code) => { clearTimeout(timeout); reject(new Error('app server exited: ' + code)); });
  });
  const appBase = await serverReady;
  const listed = await (await fetch(new URL('/api/providers/llm/custom_local_test/models', appBase))).json();
  assert.deepEqual(listed.models, ['local-test-model']);
  console.log('PASS model list is available through the application API');
  appServer.kill();
  appServer = null;

  saveConfig({ asr: { providers: { custom_speech_test: {
    kind: 'openai-audio', label: 'Local speech', enabled: true,
    baseUrl, model: 'whisper-1', languages: ['ja', 'en'],
    keyRef: 'MIAOJI_ASR_TEST_KEY', noAuth: true,
  } }, routes: { ja: 'custom_speech_test' } } });
  assert.equal(config.asr.routes.ja, 'custom_speech_test');
  assert.equal(providerStatus(config, creds).asr.find((p) => p.name === 'custom_speech_test').model, 'whisper-1');
  assert.equal(pickAsrProvider(config, 'ja', creds).name, 'custom_speech_test');
  const asr = new AsrRegistry(config, creds);
  assert.equal(asr.pick('ja').name, 'custom_speech_test');
  assert.equal((await asr.transcribe('ja', Buffer.alloc(44))).text, 'テスト');
  assert.equal(seenAsrAuth, null);
  assert.match(seenAsrBody, /name="model"/);
  deleteCustomProvider('asr', 'custom_speech_test');
  assert.equal(config.asr.providers.custom_speech_test, undefined);
  assert.equal(config.asr.routes.ja, 'groq');
  deleteCustomProvider('llm', 'custom_local_test');
  assert.equal(config.llm.roles.summary.provider, 'deepseek');
  console.log('PASS custom providers can be added, routed, and removed safely');

  saveConfig({ asr: { providers: { mimo: { label: 'My MiMo', languages: ['zh', 'en'] } } } });
  const reloaded = (await import('../lib/config.mjs?reload-custom-test')).loadConfig();
  assert.equal(reloaded.asr.providers.mimo.label, 'My MiMo');
  assert.deepEqual(reloaded.asr.providers.mimo.languages, ['zh', 'en']);
  console.log('PASS built-in provider edits survive a restart');

  assert.throws(() => saveConfig({ llm: { providers: { custom_invalid: {
    kind: 'openai-chat', label: 'Invalid', enabled: true,
    baseUrl: 'file:///etc/passwd', keyRef: 'BAD_KEY', noAuth: true,
  } } } }), /接口地址/);
  console.log('PASS invalid provider URLs are rejected');
} finally {
  if (appServer) appServer.kill();
  if (mock) await new Promise((resolve) => mock.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
