// Regressions for the 2026-11 code review fixes. Temporary data and mock
// providers only; no network beyond the spawned loopback server.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { useServerToken, socketUrl } from './server-auth.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'babel-review-'));
process.env.MIAOJI_DATA_DIR = temp;
process.env.MIAOJI_CONFIG_PATH = join(temp, 'config.json');
process.env.MIAOJI_ALLOW_ENV_CREDENTIALS = '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;

try {
  // -- credentials: a damaged store is kept, not overwritten ---------------
  writeFileSync(join(temp, 'credentials.json'), '{"DEEPSEEK_API_KEY":"sk-a","GROQ_API_KEY":"gs'); // torn write
  const { setLocalCred, loadCreds } = await import('../lib/env.mjs');
  assert.deepEqual(loadCreds(), {});
  const saved = setLocalCred('XIAOMI_API_KEY', 'mi-c');
  assert.match(saved.warning, /已备份/);
  const backups = readdirSync(temp).filter((n) => n.startsWith('credentials.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.match(readFileSync(join(temp, backups[0]), 'utf8'), /sk-a/);
  assert.deepEqual(JSON.parse(readFileSync(join(temp, 'credentials.json'), 'utf8')), { XIAOMI_API_KEY: 'mi-c' });
  if (process.platform !== 'win32') assert.equal(statSync(join(temp, 'credentials.json')).mode & 0o777, 0o600);
  assert.ok(!readdirSync(temp).some((n) => n.endsWith('.tmp')));
  console.log('PASS damaged credential store is backed up instead of being overwritten; keys are 0600');

  // -- config: validation and plain-HTTP policy -----------------------------
  writeFileSync(join(temp, 'config.json'), '{"asr": {"providers": '); // torn write
  const config = await import('../lib/config.mjs');
  const loaded = config.loadConfig();
  assert.equal(loaded.server.port, 8777);
  assert.ok(readdirSync(temp).some((n) => n.startsWith('config.json.corrupt-')), 'unreadable config is moved aside');
  for (const host of ['127.0.0.1', 'localhost', '192.168.3.4', '10.0.0.2', '172.20.1.1', 'nas', 'gpu.local', '[::1]', 'fd12:3456::1']) {
    assert.ok(config.isLocalNetworkHost(host), host);
  }
  for (const host of ['api.example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.ok(!config.isLocalNetworkHost(host), host);
  assert.throws(() => config.assertSafeEndpoint('http://api.example.com/v1'), /HTTPS/);
  config.assertSafeEndpoint('https://api.example.com/v1');
  config.assertSafeEndpoint('http://192.168.1.10:11434/v1');
  assert.throws(() => config.saveConfig({ llm: { providers: { custom_x: { kind: 'openai-chat', label: 'X', baseUrl: 'http://api.example.com/v1', keyRef: 'X_KEY' } } } }), /HTTPS/);
  assert.throws(() => config.saveConfig({ realtime: { vadThreshold: 'loud' } }), /vadThreshold/);
  assert.throws(() => config.saveConfig({ realtime: { vadThreshold: 5 } }), /vadThreshold/);
  assert.throws(() => config.saveConfig({ realtime: { minNewMs: 10 } }), /minNewMs/);
  config.saveConfig({ realtime: { vadThreshold: 0.004 } });
  assert.equal(JSON.parse(readFileSync(join(temp, 'config.json'), 'utf8')).realtime.vadThreshold, 0.004);
  const { Llm, retryAfterMs } = await import('../lib/llm.mjs');
  const cfgPublicHttp = structuredClone(config.DEFAULT_CONFIG);
  cfgPublicHttp.llm.providers.deepseek.baseUrl = 'http://api.example.com/v1';
  assert.throws(() => new Llm(cfgPublicHttp, { DEEPSEEK_API_KEY: 'k' }).resolve('summary'), /HTTPS/);
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('900'), 30000);
  assert.equal(retryAfterMs(null), 0);
  assert.equal(retryAfterMs('soon'), 0);
  console.log('PASS config is validated, unreadable config is kept, plain HTTP is limited to local networks');

  // -- meeting: translation at stop, stuck processing, resplit batching -----
  const { Meeting, toSrt, toVtt } = await import('../lib/meeting.mjs');
  const base = structuredClone(config.DEFAULT_CONFIG);
  const translator = {
    calls: 0,
    async json(task, messages) {
      if (task !== 'translate') throw new Error('unexpected ' + task);
      this.calls++;
      await sleep(80);
      const items = JSON.parse(messages[1].content.split('待翻译片段：\n')[1]);
      return { data: { translations: items.map((i) => ({ id: i.id, text: 'T' + i.id })) } };
    },
    resolve: () => ({ model: 'mock' }),
  };
  const m = new Meeting({ id: 'review-translate', config: base, asr: {}, llm: translator, creds: {}, translateTo: 'ja' });
  m.save = () => {};
  m.scheduleSave = () => {};
  for (let i = 0; i < 25; i++) m.pushSegment({ text: '第' + i + '句。', start: i * 1000, end: i * 1000 + 900, speaker: 'A' });
  clearTimeout(m.translateTimer);
  const debounce = m.flushTranslation(false); // one batch of 20 in flight
  await sleep(10);
  await m.flushTranslation(true); // what stop() does
  await debounce;
  assert.equal(m.segments.filter((s) => !s.translation).length, 0, 'stop waits for the in-flight batch and drains the rest');
  m.dispose();

  const broken = new Meeting({ id: 'review-broken', config: base, asr: {}, llm: translator, creds: {} });
  broken.save = () => {};
  broken.state = 'recording';
  broken.writeAudio = async () => { throw new Error('disk gone'); };
  const errors = [];
  broken.on((e) => { if (e.type === 'error') errors.push(e.message); });
  await broken.stop();
  assert.equal(broken.state, 'stopped', 'a failing stop does not leave the meeting in processing');
  assert.match(errors.join(' '), /disk gone/);
  broken.dispose();

  const splitter = { requests: [], async json(task, messages) {
    const items = JSON.parse(messages[1].content.split('片段：\n')[1]);
    this.requests.push(items.length);
    return { data: { assignments: items.map((i) => ({ id: i.id, speaker: i.id % 2 ? '说话人2' : '说话人1' })) } };
  }, resolve: () => ({ model: 'mock' }) };
  const long = new Meeting({ id: 'review-split', config: base, asr: {}, llm: splitter, creds: {} });
  long.scheduleSave = () => {};
  long.segments = Array.from({ length: 400 }, (_, i) => ({ index: i + 1, start: i * 1000, end: i * 1000 + 900, speaker: '说话人1', text: '句子' + i }));
  long.speakers = { s0: { name: '说话人1', key: 's0' } };
  await long.resplitSpeakers();
  assert.deepEqual(splitter.requests, [150, 150, 100]);
  assert.equal(long.segments.filter((s) => s.speaker === '说话人2').length, 200);
  long.dispose();

  const doc = { segments: [{ index: 1, start: 61234, end: 3723004, speaker: 'A', text: 'a --> b\n\nc', translation: 't' }] };
  assert.equal(toSrt(doc), '1\n00:01:01,234 --> 01:02:03,004\nA：a --> b\nc\n');
  assert.ok(!toVtt(doc).split('\n').slice(2).join('\n').includes('a -->'), 'cue text cannot contain -->');
  console.log('PASS stop drains translation, failed stops settle, speaker re-split is batched, SRT export');

  // -- server: uploads, exports, range, odd frames --------------------------
  mkdirSync(join(temp, 'meetings'), { recursive: true });
  mkdirSync(join(temp, 'audio'), { recursive: true });
  const id = 'reviewdoc01';
  writeFileSync(join(temp, 'meetings', id + '.json'), JSON.stringify({ id, title: '周会 计划', state: 'stopped', createdAt: 1, segments: [
    { index: 1, start: 0, end: 1500, speaker: '说话人1', text: '你好' }] }));
  writeFileSync(join(temp, 'audio', id + '.wav'), Buffer.alloc(1000, 7));
  server = spawn(process.execPath, ['server.mjs', '0'], { cwd: root, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('review test server timeout')), 15000);
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/).find((s) => s.startsWith('MIAOJI_READY '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(13))); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('server exit ' + code)); });
  });
  const url = info.url;
  const token = useServerToken(url, info.accessToken);
  const api = new URL('/api/meetings/' + id, url).href;

  const srt = await fetch(api + '/export?format=srt');
  assert.match(srt.headers.get('content-disposition'), /filename\*=UTF-8''%E5%91%A8%E4%BC%9A%20%E8%AE%A1%E5%88%92\.srt/);
  assert.match(srt.headers.get('content-disposition'), /^attachment; filename="[\x20-\x7e]+\.srt"/);
  assert.match(await srt.text(), /^1\n00:00:00,000 --> 00:00:01,500\n/);

  const tail = await fetch(api + '/audio', { headers: { range: 'bytes=-100' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), 'bytes 900-999/1000');
  assert.equal((await tail.arrayBuffer()).byteLength, 100);
  const clamped = await fetch(api + '/audio', { headers: { range: 'bytes=990-5000' } });
  assert.equal(clamped.headers.get('content-range'), 'bytes 990-999/1000');
  assert.equal((await fetch(api + '/audio', { headers: { range: 'bytes=2000-' } })).status, 416);

  // An odd-length binary frame must not throw inside the server.
  const created = await (await fetch(new URL('/api/meetings', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const ws = new WebSocket(socketUrl(new URL('/ws?meeting=' + created.meeting.id, url), token));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ type: 'start' }));
  await sleep(100);
  ws.send(new Uint8Array([1, 2, 3]).buffer);
  ws.send(new Int16Array(1600).buffer);
  ws.send(JSON.stringify({ type: 'stop', minutes: false }));
  await sleep(600);
  ws.close();

  // Uploads stream to disk and an empty body is rejected without leftovers.
  const empty = await fetch(api + '/import?name=a.wav', { method: 'POST', body: new Uint8Array(0) });
  assert.equal(empty.status, 400);
  assert.equal(readdirSync(join(temp, 'uploads')).length, 0);
  const target = (await (await fetch(new URL('/api/meetings', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).meeting.id;
  const bad = await fetch(new URL('/api/meetings/' + target + '/import?name=broken.mp3', url), { method: 'POST', body: new Uint8Array(4096).fill(3) });
  assert.equal(bad.status, 202);
  let persisted;
  for (let i = 0; i < 100 && persisted?.state !== 'stopped'; i++) {
    await sleep(100);
    persisted = JSON.parse(readFileSync(join(temp, 'meetings', target + '.json'), 'utf8'));
  }
  assert.equal(persisted.state, 'stopped', 'a failed import is saved as finished');
  for (let i = 0; i < 20 && readdirSync(join(temp, 'uploads')).length; i++) await sleep(100);
  assert.equal(readdirSync(join(temp, 'uploads')).length, 0, 'the streamed upload is removed afterwards');
  console.log('PASS UTF-8 download names, SRT, suffix/clamped ranges, odd frames, streamed uploads, failed import state');

  let serverErr = '';
  server.stderr.on('data', (c) => { serverErr += c; });
  await sleep(100);
  assert.doesNotMatch(serverErr, /RangeError|unhandled/i);
} finally {
  if (server) server.kill();
  await sleep(200);
  rmSync(temp, { recursive: true, force: true });
}
