import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  isTrustedLocalRequest, resolveAccessToken, requestAccess, accessCookieName, accessCookieHeader,
} from '../lib/local-access.mjs';

const req = (host, origin) => ({
  socket: { localPort: 8777 },
  headers: { host, ...(origin === undefined ? {} : { origin }) },
});

assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777')), true);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777', 'http://127.0.0.1:8777')), true);
assert.equal(isTrustedLocalRequest(req('localhost:8777', 'http://localhost:8777')), true);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777', 'https://example.com')), false);
assert.equal(isTrustedLocalRequest(req('attacker.example:8777', 'http://attacker.example:8777')), false);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:1234')), false);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777', 'null')), false);
console.log('PASS local Host and browser Origin restriction');

// -- access token unit checks -------------------------------------------------

const TOKEN = 'a'.repeat(43);
const env = { MIAOJI_ACCESS_TOKEN: TOKEN };
assert.equal(resolveAccessToken(env), TOKEN);
assert.equal('MIAOJI_ACCESS_TOKEN' in env, false, 'the token must not leak to child processes');
const generated = resolveAccessToken({});
assert.match(generated, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(generated, resolveAccessToken({}), 'each launch gets a fresh token');
assert.throws(() => resolveAccessToken({ MIAOJI_ACCESS_TOKEN: 'short' }));

const authed = (headers, path = '/api/bootstrap') => {
  const r = { socket: { localPort: 8777 }, headers: { host: '127.0.0.1:8777', ...headers } };
  const url = new URL(path, 'http://127.0.0.1:8777');
  return (opts) => requestAccess(r, url, TOKEN, opts);
};
assert.equal(authed({})(), null);
assert.equal(authed({ authorization: 'Bearer ' + TOKEN })(), 'header');
assert.equal(authed({ authorization: 'Bearer ' + TOKEN.slice(1) + 'b' })(), null);
assert.equal(authed({ authorization: 'Basic ' + TOKEN })(), null);
assert.equal(authed({ cookie: 'other=1; ' + accessCookieName(8777) + '=' + TOKEN })(), 'cookie');
assert.equal(authed({ cookie: accessCookieName(9999) + '=' + TOKEN })(), null, 'cookie names are per port');
assert.equal(authed({}, '/?token=' + TOKEN)(), null, 'query tokens are opt-in');
assert.equal(authed({}, '/?token=' + TOKEN)({ allowQuery: true }), 'query');
assert.match(accessCookieHeader(8777, TOKEN), /HttpOnly/);
assert.match(accessCookieHeader(8777, TOKEN), /SameSite=Strict/);
console.log('PASS access token resolution, header/cookie/query matching');

// -- real server ------------------------------------------------------------

const root = join(import.meta.dirname, '..');
const server = spawn(process.execPath, ['server.mjs', '0'], {
  cwd: root, env: { ...process.env, MIAOJI_PORT: '0', MIAOJI_ACCESS_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'],
});
try {
  const info = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timed out: ' + output)), 10000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/).find((s) => s.startsWith('MIAOJI_READY '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(13))); }
    });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('server exited: ' + code + ' ' + output)); });
  });
  assert.equal(info.accessToken, TOKEN);
  assert.equal(info.accessCookie, accessCookieName(info.port));
  const base = info.url;
  const get = (path, headers = {}) => fetch(new URL(path, base), { headers, redirect: 'manual' });
  const bearer = { authorization: 'Bearer ' + TOKEN };

  assert.equal((await get('/api/bootstrap?lite=1')).status, 401);
  assert.equal((await get('/api/bootstrap?lite=1', { authorization: 'Bearer ' + 'b'.repeat(43) })).status, 401);
  assert.equal((await get('/api/bootstrap?lite=1&token=' + TOKEN)).status, 401, 'API calls must not take URL tokens');
  assert.equal((await get('/api/bootstrap?lite=1', bearer)).status, 200);
  assert.equal((await fetch(new URL('/api/config', base), { method: 'POST', body: '{}' })).status, 401);
  const models = await get('/api/providers/llm/deepseek/models');
  assert.equal(models.status, 401, 'stored keys must not be reachable without the token');
  console.log('PASS API requires the access token');

  const page = await get('/');
  assert.equal(page.status, 401);
  assert.doesNotMatch(await page.text(), /app\.js/);
  assert.equal((await get('/app.js')).status, 401);
  assert.equal((await get('/?token=' + 'c'.repeat(43))).status, 401);

  const exchange = await get('/?meeting=abc&token=' + TOKEN);
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get('set-cookie');
  assert.match(cookie, new RegExp('^' + info.accessCookie + '=' + TOKEN + ';'));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(exchange.headers.get('referrer-policy'), 'no-referrer');
  const body = await exchange.text();
  assert.match(body, /url=\/\?meeting=abc"/);
  assert.doesNotMatch(body, new RegExp(TOKEN), 'the exchange page must not echo the token');
  const sent = { cookie: cookie.split(';')[0] };
  const index = await get('/', sent);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /app\.js/);
  assert.equal((await get('/api/bootstrap?lite=1', sent)).status, 200);
  console.log('PASS link token exchanges for an HttpOnly SameSite=Strict cookie');

  const ws = (query) => new Promise((resolve) => {
    const socket = new WebSocket(new URL('/ws?meeting=missing' + query, base).href.replace(/^http/, 'ws'));
    socket.onopen = () => { resolve('open'); socket.close(); };
    socket.onerror = () => resolve('rejected');
  });
  assert.equal(await ws(''), 'rejected');
  assert.equal(await ws('&token=' + 'd'.repeat(43)), 'rejected');
  assert.equal(await ws('&token=' + TOKEN), 'open');
  console.log('PASS WebSocket upgrade requires the access token');
} finally {
  server.kill();
}
