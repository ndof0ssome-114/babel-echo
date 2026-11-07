// Optional browser check (needs Playwright + Chromium; not part of test:offline).
// Records with Chromium's fake microphone, drops the WebSocket for ~5 s and
// verifies the saved recording still covers the whole wall-clock duration.
//   node scripts/ui-check-reconnect.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-ui-'));
  const srv = spawn(process.execPath, ['server.mjs', '0'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, MIAOJI_DATA_DIR: data, MIAOJI_CONFIG_PATH: path.join(data, 'config.json') } });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const info = await new Promise((resolve) => {
      let out = '';
      srv.stdout.on('data', (c) => { out += c; const l = out.split('\n').find((x) => x.startsWith('MIAOJI_READY ')); if (l) resolve(JSON.parse(l.slice(13))); });
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(info.url + '?selftest=1&token=' + info.accessToken);
    await page.waitForSelector('#btnRecord');
    await page.waitForTimeout(1000);
    await page.click('#btnRecord');
    await page.waitForFunction(() => window.miaojiSelfTest?.state.recording === true, null, { timeout: 15000 });
    const started = Date.now();
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const Real = window.WebSocket;
      let failures = 2;
      window.WebSocket = function (url) {
        if (failures-- > 0) {
          const fake = { readyState: 0, send() {}, close() {} };
          setTimeout(() => { fake.readyState = 3; fake.onclose?.(); }, 50);
          return fake;
        }
        window.WebSocket = Real;
        return new Real(url);
      };
      Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      miaojiSelfTest.state.ws.close();
    });
    await page.waitForFunction(() => miaojiSelfTest.state.ws?.readyState === 1 && !miaojiSelfTest.state.pendingAudio.length, null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    const wall = Date.now() - started;
    await page.click('#btnStop');
    await page.waitForFunction(() => document.querySelector('#statePill')?.dataset.state === 'stopped', null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    const [doc] = fs.readdirSync(path.join(data, 'meetings')).map((f) => JSON.parse(fs.readFileSync(path.join(data, 'meetings', f))));
    const missing = wall - doc.durationMs;
    console.log(JSON.stringify({ wallMs: wall, savedMs: doc.durationMs, state: doc.state, errors }));
    if (missing > 1000 || errors.length) throw new Error('recording lost ' + missing + ' ms across the reconnect');
    console.log('PASS audio captured during a WebSocket reconnect is kept');
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
