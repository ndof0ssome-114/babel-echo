// main.cjs — Electron main process for 巴别回声.
//
// The desktop build keeps the existing local HTTP server and just gives it a
// native shell, which means one code path for the whole product. What the
// shell adds is the stuff a web page cannot do:
//   * global shortcut (Ctrl+Shift+R) to start/stop recording
//   * prevent-display-sleep while a meeting is being recorded
//   * a tray icon that keeps recording alive when the window is closed
//   * native notifications and a native file picker
//
// The server is launched with ELECTRON_RUN_AS_NODE, so the packaged app does
// not require the user to have Node installed.

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog,
        Notification, powerSaveBlocker, nativeImage, shell, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// A GUI app can outlive the shell that launched it. A closed stdout/stderr
// pipe must not become an uncaught EPIPE and show a main-process error dialog.
for (const output of [process.stdout, process.stderr]) {
  output?.on('error', () => {
    /* diagnostic output is no longer available */
  });
}

// Unpackaged: miaoji/ (desktop/ lives inside it).
// Packaged: the server files are shipped as extraResources next to the asar.
const ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');
// --selftest boots the whole shell, asserts that the bridge / permissions /
// page render / server handshake all work, prints results and exits. It is
// the only way to verify an Electron app without a human watching a window.
const SELFTEST = process.argv.includes('--selftest');
// --capture=<file.png> renders the window, saves a PNG and exits; combined
// with --open=<query> it can capture any deep-linked state.
const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  // Keep everything after the FIRST '=' : query values contain '=' too.
  return hit ? hit.slice(name.length + 3) : null;
};
const CAPTURE = argValue('capture');
const OPEN_QUERY = argValue('open');
// Self-tests need their own Chromium profile and can run while the user's
// normal 巴别回声 window remains open.
if (SELFTEST || CAPTURE) {
  const qaProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoji-qa-'));
  app.setPath('userData', qaProfile);
} else {
  // Keep the pre-rename profile so meetings, keys and local UI settings survive.
  const legacyProfile = path.join(app.getPath('appData'), 'miaoji-desktop');
  fs.mkdirSync(legacyProfile, { recursive: true });
  app.setPath('userData', legacyProfile);
}
// Mutable state must not live inside the install directory.
const DATA_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(ROOT, 'data');
// electron-builder treats desktop/build as its buildResources directory, so
// the icon is NOT inside the asar; it is copied to resources/ explicitly.
const ICON_PNG = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, 'build', 'icon.png');
const MEDIA_EXT = ['wav', 'mp3', 'm4a', 'mp4', 'mov', 'webm', 'ogg', 'oga', 'flac',
  'aac', 'wma', 'mkv', 'avi', 'opus', 'amr', 'aif', 'aiff', '3gp', 'm4v'];

let win = null;
let tray = null;
let server = null;
let serverUrl = null;
let quitting = false;
let sleepBlockerId = null;
let live = { recording: false, processing: false };
// Accelerators actually claimed; another app may already own a candidate.
const shortcuts = { toggle: null, show: null };
const alreadyNotified = new Set();

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE turns the Electron binary into a plain Node
    // runtime; port 0 asks the OS for a free port so two copies never clash.
    const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '0'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MIAOJI_PARENT_WATCHDOG: '1',
        MIAOJI_DATA_DIR: DATA_DIR,
        MIAOJI_CONFIG_PATH: path.join(DATA_DIR, 'config.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server = child;

    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('后台服务启动超时（30 秒）'));
      }
    }, 30000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('MIAOJI_READY ')) {
          if (settled) continue;
          settled = true;
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line.slice('MIAOJI_READY '.length)));
          } catch (err) {
            reject(new Error('无法解析服务握手：' + err.message));
          }
        } else if (IS_DEV && line.trim()) {
          console.log('[server]', line);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => console.error('[server]', String(d).trim()));

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (quitting) return;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('后台服务启动失败（退出码 ' + code + '）'));
        return;
      }
      dialog.showErrorBox('巴别回声后台服务已停止',
        '本地服务意外退出（退出码 ' + code + '），应用即将关闭。\n已完成的会议记录都保存在磁盘上。');
      quitting = true;
      app.quit();
    });
  });
}

function stopServer() {
  if (!server) return;
  try { server.stdin.end(); } catch { /* already gone */ }
  try { server.kill(); } catch { /* already gone */ }
  server = null;
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    title: '巴别回声',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    backgroundColor: '#f6f7f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Without an explicit permission handler Electron denies the microphone and
  // getUserMedia fails, which would make the recorder silently useless.
  const ses = win.webContents.session;
  const allowed = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
  // Capture the primary display's playback audio. The video track is required
  // by getDisplayMedia but the renderer never connects or stores its pixels.
  if (process.platform === 'win32') {
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (new URL(request.securityOrigin).origin !== new URL(serverUrl).origin) return;
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('[display capture]', err);
      }
    });
  }

  win.once('ready-to-show', () => {
    if (!SELFTEST) win.show();
  });

  // Closing the window mid-meeting would lose the recording, so hide to tray
  // instead and keep going.
  win.on('close', (e) => {
    if (!quitting && live.recording) {
      e.preventDefault();
      win.hide();
      notify('巴别回声仍在录音', '窗口已收进托盘，会议继续记录。要完全退出请右键托盘图标。');
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(serverUrl + (OPEN_QUERY ? '?' + OPEN_QUERY + (SELFTEST ? '&selftest=1' : '') : SELFTEST ? '?selftest=1' : ''));
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function sendToRenderer(channel) {
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel);
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

function trayImage() {
  if (!fs.existsSync(ICON_PNG)) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(ICON_PNG);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const rec = live.recording;
  tray.setToolTip(rec ? '巴别回声 · 正在录音' : '巴别回声 · 待机');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开巴别回声窗口', click: showWindow },
    { type: 'separator' },
    { label: rec ? '停止录音并生成纪要' : '开始录音', click: () => sendToRenderer('miaoji:toggle-record') },
    { label: '导入音视频文件…', click: () => sendToRenderer('miaoji:import') },
    { type: 'separator' },
    { label: '数据文件夹', click: () => shell.openPath(DATA_DIR) },
    { type: 'separator' },
    { label: '退出巴别回声', click: () => { quitting = true; app.quit(); } },
  ]));
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title,
        body,
        icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
        silent: false,
      }).show();
    }
  } catch {
    /* notifications are a nicety, never a failure */
  }
}

// ---------------------------------------------------------------------------
// live state polling: drives tray, sleep blocker and notifications
// ---------------------------------------------------------------------------

async function pollLive() {
  if (!serverUrl) return;
  try {
    const res = await fetch(serverUrl + 'api/live', { signal: AbortSignal.timeout(4000) });
    const next = await res.json();

    if (!!next.recording !== !!live.recording) {
      live = next;
      updateTray();
      if (win && !win.isDestroyed()) win.setTitle((next.recording ? '● ' : '') + '巴别回声');

      // A two-hour meeting must not be interrupted by the screen going to
      // sleep, so hold a wake lock for exactly as long as we are recording.
      if (next.recording) {
        if (sleepBlockerId === null) {
          sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
        }
      } else if (sleepBlockerId !== null) {
        powerSaveBlocker.stop(sleepBlockerId);
        sleepBlockerId = null;
      }
    } else {
      live = next;
    }

    for (const m of next.meetings || []) {
      if (m.hasMinutes && !alreadyNotified.has(m.id)) {
        alreadyNotified.add(m.id);
        if (!win || win.isDestroyed() || !win.isFocused()) {
          notify('巴别回声 · 纪要已生成', (m.title || '未命名会议') + '（' + m.segments + ' 段转写）');
        }
      }
    }
  } catch {
    /* server briefly unavailable; try again next tick */
  }
}

// ---------------------------------------------------------------------------
// menus + ipc
// ---------------------------------------------------------------------------

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '导入音视频…', accelerator: 'CommandOrControl+O', click: () => sendToRenderer('miaoji:import') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '录制',
      submenu: [
        {
          label: '开始 / 停止录音',
          accelerator: shortcuts.toggle || undefined,
          click: () => sendToRenderer('miaoji:toggle-record'),
        },
        {
          label: '显示主窗口',
          accelerator: shortcuts.show || undefined,
          click: showWindow,
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '在浏览器中打开', click: () => shell.openExternal(serverUrl) },
        { label: '打开数据文件夹', click: () => shell.openPath(DATA_DIR) },
        { label: '打开应用文件夹', click: () => shell.openPath(ROOT) },
      ],
    },
  ]);
}

/**
 * Global shortcuts are first-come-first-served across the whole desktop, so
 * try a short list and keep whichever registration wins. Ctrl+Shift+M is
 * taken on this machine, which is exactly why there is a fallback chain.
 */
function registerFirst(candidates, handler) {
  for (const acc of candidates) {
    try {
      if (globalShortcut.register(acc, handler)) return acc;
    } catch {
      /* malformed accelerator; try the next */
    }
  }
  return null;
}

function registerShortcuts() {
  shortcuts.toggle = registerFirst(
    ['CommandOrControl+Shift+R', 'CommandOrControl+Alt+R', 'CommandOrControl+Shift+F9'],
    () => sendToRenderer('miaoji:toggle-record'),
  );
  shortcuts.show = registerFirst(
    ['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+F10', 'CommandOrControl+Alt+M'],
    showWindow,
  );
  if (!shortcuts.toggle) console.warn('[miaoji] 无法注册录音全局快捷键，可用托盘菜单代替');
  if (!shortcuts.show) console.warn('[miaoji] 无法注册显示窗口全局快捷键');
  // The menu labels the real accelerators, so rebuild it now that we know them.
  Menu.setApplicationMenu(buildMenu());
}

function registerIpc() {
  ipcMain.handle('miaoji:open-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择要转写的音视频文件',
      properties: ['openFile'],
      filters: [
        { name: '音视频文件', extensions: MEDIA_EXT },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('miaoji:server-url', () => serverUrl);
  const microphonePrefPath = path.join(app.getPath('userData'), 'microphone.json');
  ipcMain.handle('miaoji:microphone-get', () => {
    try {
      const pref = JSON.parse(fs.readFileSync(microphonePrefPath, 'utf8'));
      return { deviceId: String(pref.deviceId || 'default'), label: String(pref.label || ''),
        includeSystemAudio: pref.includeSystemAudio !== false };
    } catch {
      return null;
    }
  });
  ipcMain.handle('miaoji:microphone-set', (_event, pref) => {
    const saved = {
      deviceId: String(pref?.deviceId || 'default').slice(0, 256),
      label: String(pref?.label || '').slice(0, 256),
      includeSystemAudio: pref?.includeSystemAudio !== false,
    };
    fs.mkdirSync(path.dirname(microphonePrefPath), { recursive: true });
    fs.writeFileSync(microphonePrefPath, JSON.stringify(saved), 'utf8');
    return saved;
  });
  ipcMain.on('miaoji:notify', (_e, payload) => notify((payload && payload.title) || '巴别回声', (payload && payload.body) || ''));
  ipcMain.on('miaoji:recording-state', (_e, payload) => {
    // The page knows the real state instantly; trust it over the poll.
    live = { ...live, recording: !!(payload && payload.value) };
    updateTray();
  });
}

// ---------------------------------------------------------------------------
// self test
// ---------------------------------------------------------------------------

/** Poll the renderer until the app's own DOM is up. */
async function waitForUi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const ready = await win.webContents.executeJavaScript(
        'document.readyState === "complete" && !!document.getElementById("statePill")',
      );
      if (ready) return true;
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (lastError) console.log('[selftest] last renderer error:', lastError);
  return false;
}

async function runCapture() {
  try {
    const uiUp = await waitForUi(30000);
    console.log('[capture] ui ready:', uiUp);
    const captureSize = /^(\d{3,4})x(\d{3,4})$/.exec(argValue('capture-size') || '');
    if (captureSize) win.setContentSize(Number(captureSize[1]), Number(captureSize[2]));
    // Let fonts settle and any fetch-driven panel paint.
    await new Promise((r) => setTimeout(r, 4500));
    // Screenshot-only theme override for visual QA; normal launches use saved appearance.
    if (argValue('capture-theme') === 'dark') {
      await win.webContents.executeJavaScript('document.documentElement.dataset.theme = "dark"');
      await new Promise((r) => setTimeout(r, 250));
    }
    if (OPEN_QUERY?.startsWith('meeting=')) {
      const seen = await win.webContents.executeJavaScript(
        'new URLSearchParams(location.search).get("meeting")',
      );
      const title = await win.webContents.executeJavaScript('document.getElementById("title").value');
      const segs = await win.webContents.executeJavaScript('document.querySelectorAll(".seg").length');
      const wanted = OPEN_QUERY.split('=').pop();
      console.log('[capture] deep link meeting=' + seen + ' (want ' + wanted + ') title="' + title + '" segments=' + segs);
      if (seen !== wanted) console.error('[capture] DEEP LINK MISMATCH');
      if (!segs) console.error('[capture] WARNING: no transcript segments rendered');
    }
    const image = await win.webContents.capturePage();
    fs.writeFileSync(CAPTURE, image.toPNG());
    console.log('[capture] wrote ' + CAPTURE + ' (' + image.getSize().width + 'x' + image.getSize().height + ')');
  } catch (err) {
    console.error('[capture] failed:', (err && err.message) || err);
  }
  quitting = true;
  app.quit();
  setTimeout(() => process.exit(0), 2000);
}

/**
 * Drive the settings drawer like a user would.
 *
 * This exists because the drawer once shipped with no close handler at all
 * and a flexbox min-height bug that clipped everything below the fold, and
 * "the window renders fine" screenshots showed neither problem.
 */
async function testSettingsDrawer(check, evalJs) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = async () => (await (await fetch(serverUrl + 'api/config')).json());
  const drawerHidden = () => evalJs('document.getElementById("drawer").hidden');

  const before = await cfg();

  await evalJs('document.getElementById("btnSettings").click()');
  await pause(1400);

  const opened = await evalJs('(() => {' +
    'const d = document.getElementById("drawer");' +
    'const b = document.getElementById("drawerBody");' +
    'const cs = getComputedStyle(b);' +
    'return { hidden: d.hidden,' +
    'title: document.getElementById("drawerTitle").textContent,' +
    'rows: document.querySelectorAll(".prov-block").length,' +
    'overflowY: cs.overflowY,' +
    'clientH: b.clientHeight, scrollH: b.scrollHeight };' +
    '})()');
  check('settings drawer opens', opened.hidden === false, 'title=' + opened.title);
  check('settings renders every provider row', opened.rows >= 4, opened.rows + ' rows');
  check('settings body can scroll (not clipped)',
    opened.overflowY === 'auto' && opened.clientH > 0,
    'overflowY=' + opened.overflowY + ' clientH=' + opened.clientH + ' scrollH=' + opened.scrollH);

  const scrolled = await evalJs('(() => { const b = document.getElementById("drawerBody");' +
    'b.scrollTop = b.scrollHeight;' +
    'return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight }; })()');
  check('content below the fold is reachable', scrolled.max === 0 || scrolled.top > 0,
    'scrollTop=' + scrolled.top + '/' + scrolled.max);

  const jaBlocked = await evalJs('(() => {' +
    'const label=[...document.querySelectorAll(".route-grid label")].find(e=>e.textContent==="日本語");' +
    'return label?.nextElementSibling?.querySelector("option[value=mimo]")?.disabled;' +
    '})()');
  check('MiMo cannot be selected for Japanese', jaBlocked === true);

  await evalJs('(() => {' +
    'const section=[...document.querySelectorAll(".settings-section")].find(e=>e.querySelector("h4")?.textContent==="实时识别节奏");' +
    'section.querySelector("input[type=number]").value="5.0";' +
    'section.querySelector("button").click();' +
    '})()');
  await pause(1000);
  check('preview interval saves from settings', (await cfg()).realtime.stepMs === 5000);
  await fetch(serverUrl + 'api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ realtime: before.realtime }) });

  // toggle the first provider switch and confirm the server persisted it
  const toggled = await evalJs('(() => { const cb = document.querySelector(".prov-block input[type=checkbox]");' +
    'if (!cb) return null; cb.checked = !cb.checked;' +
    'cb.dispatchEvent(new Event("change", { bubbles: true })); return cb.checked; })()');
  await pause(1800);
  const after = await cfg();
  const anyDifferent = Object.keys(before.asr.providers).some((k) =>
    JSON.stringify(before.asr.providers[k]) !== JSON.stringify(after.asr.providers[k]));
  check('toggling a provider switch persists to config.json', anyDifferent,
    'checkbox=' + toggled + ' changed=' + anyDifferent);

  // and that the same state is still on screen afterwards (no scroll reset)
  const afterToggle = await evalJs('(() => { const b = document.getElementById("drawerBody");' +
    'return { hidden: document.getElementById("drawer").hidden, top: b.scrollTop }; })()');
  check('drawer stays open after a toggle', afterToggle.hidden === false);

  // restore the config we just changed
  await fetch(serverUrl + 'api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asr: { providers: before.asr.providers } }),
  });

  // exit 1: the close button
  await evalJs('document.getElementById("drawerClose").click()');
  await pause(500);
  check('settings closes via the × button', (await drawerHidden()) === true);

  // exit 2: Escape
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(1000);
  await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await pause(500);
  check('settings closes via Escape', (await drawerHidden()) === true);

  // exit 3: clicking the backdrop
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(1000);
  await evalJs('document.getElementById("drawer").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
  await pause(500);
  check('settings closes by clicking the backdrop', (await drawerHidden()) === true);

  // and the header button toggles rather than only opening
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(800);
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(500);
  check('settings button toggles the drawer', (await drawerHidden()) === true);
}

async function testCustomSettings(check, evalJs) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(500);
  await evalJs('(() => {' +
    'const form=document.querySelector(".add-provider"); form.open=true;' +
    'const inputs=form.querySelectorAll(".settings-field input");' +
    'inputs[0].value="QA local ASR";' +
    'form.querySelector("button.btn.primary").click();' +
    '})()');
  await pause(900);
  const created = await (await fetch(serverUrl + 'api/config')).json();
  const found = Object.entries(created.asr.providers).find(([, value]) => value.label === 'QA local ASR');
  check('custom speech provider can be added from settings', !!found, found?.[0] || 'missing');
  if (found) await fetch(serverUrl + 'api/providers/asr/' + found[0], { method: 'DELETE' });
  await evalJs('document.getElementById("drawerClose").click()');

  const locales = await evalJs('(() => {' +
    'const s=document.getElementById("uiLanguage");' +
    's.value="en"; s.dispatchEvent(new Event("change",{bubbles:true}));' +
    'const en=document.getElementById("btnSettings").textContent;' +
    's.value="ja"; s.dispatchEvent(new Event("change",{bubbles:true}));' +
    'return {en,ja:document.getElementById("btnSettings").textContent,lang:document.documentElement.lang};' +
    '})()');
  check('English and Japanese interface switching works',
    locales.en === 'Settings' && locales.ja === '設定' && locales.lang === 'ja',
    JSON.stringify(locales));
}

async function runSelfTest() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push(!!ok);
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };
  const evalJs = (code) => win.webContents.executeJavaScript(code);

  try {
    check('window created', !win.isDestroyed());
    check('server handshake returned a URL', !!serverUrl, serverUrl);
    check('server process is running', !!server && server.exitCode === null);
    check('recording global shortcut registered', !!shortcuts.toggle, String(shortcuts.toggle));
    check('show-window global shortcut registered', !!shortcuts.show, String(shortcuts.show));
    check('sleep blocker is available', typeof powerSaveBlocker.start === 'function');
    check('tray created', !!tray && !tray.isDestroyed());

    const uiUp = await waitForUi(30000);
    check('app UI rendered', uiUp);
    if (uiUp) {
      // give boot()'s bootstrap fetch a moment to settle
      await new Promise((r) => setTimeout(r, 2000));

      const probe = await evalJs('(() => ({' +
        'desktop: !!(window.miaojiDesktop && window.miaojiDesktop.isDesktop),' +
        'title: document.title,' +
        'tabs: document.querySelectorAll(".tabs button").length,' +
        'pill: (document.getElementById("statePill") || {}).textContent || "",' +
        'engine: (document.getElementById("engineChip") || {}).textContent || "",' +
        'canRecord: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),' +
        'worklet: typeof AudioWorkletNode !== "undefined"' +
        '}))()');
      check('window.miaojiDesktop bridge exposed', probe.desktop === true);
      check('page title is 巴别回声', /巴别回声/.test(probe.title), probe.title);
      check('four side tabs rendered', probe.tabs === 4, String(probe.tabs));
      check('state pill rendered', !!probe.pill, probe.pill);
      check('engine chip shows the provider', !!probe.engine && probe.engine !== '未就绪', probe.engine);
      check('getUserMedia available', probe.canRecord === true);
      check('AudioWorklet available', probe.worklet === true);

      const api = await evalJs('fetch("/api/bootstrap").then(r=>r.json()).then(j=>Object.keys(j).join(",")).catch(e=>"err:"+e.message)');
      check('renderer can reach the local API', /status/.test(api), api);

      const live = await evalJs('fetch("/api/live").then(r=>r.json()).then(j=>typeof j.recording).catch(e=>"err:"+e.message)');
      check('/api/live responds', live === 'boolean', live);

      const perm = await evalJs('navigator.permissions && navigator.permissions.query ? navigator.permissions.query({name:"microphone"}).then(p=>p.state).catch(e=>"err:"+e.message) : Promise.resolve("unsupported")');
      check('microphone permission is not denied', perm !== 'denied', String(perm));

      const micUi = await evalJs('(() => { const s = document.getElementById("microphone");' +
        'return { selector: !!s, refresh: !!document.getElementById("btnRefreshMicrophones"),' +
        'defaultOption: !!s && !!s.querySelector("option[value=default]") }; })()');
      check('microphone selector and refresh control rendered', micUi.selector && micUi.refresh && micUi.defaultOption);
      const idleMic = await evalJs('window.miaojiSelfTest.state.microphoneListLoaded');
      check('startup defers microphone enumeration', idleMic === false);
      const audioUi = await evalJs('({ test: !!document.getElementById("btnTestMicrophone"),' +
        ' system: !!document.getElementById("includeSystemAudio"),' +
        ' checked: document.getElementById("includeSystemAudio")?.checked })');
      check('microphone test and system audio controls rendered', audioUi.test && audioUi.system);
      if (process.platform === 'win32') {
        check('system audio enabled by default on Windows', audioUi.checked === true);
        const loopback = await Promise.race([
          win.webContents.executeJavaScript('(async () => {' +
            'let stream; try { stream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});' +
            'return {audio:stream.getAudioTracks().length,video:stream.getVideoTracks().length};' +
            '} catch(e) { return {error:e.name+":"+e.message}; }' +
            'finally { stream?.getTracks().forEach(t=>t.stop()); } })()', true),
          new Promise((resolve) => setTimeout(() => resolve({ error: 'timed out' }), 10000)),
        ]);
        check('desktop loopback provides an audio track', loopback.audio > 0,
          loopback.error || 'audio=' + loopback.audio + ' video=' + loopback.video);
      }

      const micProbe = await evalJs('(async () => { const devices = await navigator.mediaDevices.enumerateDevices();' +
        'const input = devices.find(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default");' +
        'if (!input) return { available: false }; let stream;' +
        'try { stream = await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:input.deviceId}}});' +
        'return { available: true, matched: stream.getAudioTracks()[0].getSettings().deviceId === input.deviceId };' +
        '} catch (e) { return { available: true, matched: false, error: e.name }; }' +
        'finally { if (stream) stream.getTracks().forEach(t => t.stop()); } })()');
      if (micProbe.available) {
        check('specific microphone can be opened by device ID', micProbe.matched, micProbe.error || 'device ID matched');
      }

      const focusedMic = await evalJs('(async () => {' +
        'document.getElementById("microphone").dispatchEvent(new Event("focus"));' +
        'for (let i = 0; i < 30 && !window.miaojiSelfTest.state.microphoneListLoaded; i++)' +
        'await new Promise(r => setTimeout(r, 100));' +
        'return window.miaojiSelfTest.state.microphoneListLoaded;' +
        '})()');
      check('microphone list loads on first use', focusedMic === true);

      const captureProbe = await evalJs('(async () => {' +
        'const {state, startCapture, stopCapture, toggleMicrophoneTest} = window.miaojiSelfTest;' +
        'let source; try {' +
        'await toggleMicrophoneTest();' +
        'const testing = state.testingMic && !!state.stream;' +
        'await toggleMicrophoneTest();' +
        'const stopped = !state.testingMic && !state.stream;' +
        'source = new AudioContext();' +
        'const tone = source.createOscillator();' +
        'const volume = source.createGain(); volume.gain.value = 0.08;' +
        'const output = source.createMediaStreamDestination();' +
        'tone.connect(volume).connect(output); tone.start();' +
        'state.systemStream = output.stream;' +
        'await startCapture();' +
        'await new Promise(r => setTimeout(r, 600));' +
        'const peak = Math.max(...state.bars);' +
        'stopCapture(); tone.stop(); await source.close();' +
        'return {testing, stopped, peak};' +
        '} catch(e) { stopCapture(); await source?.close(); return {error:e.message}; }' +
        '})()');
      check('microphone test starts and stops capture', captureProbe.testing && captureProbe.stopped,
        captureProbe.error || 'started and stopped');
      check('microphone and system streams reach the PCM meter', captureProbe.peak >= 0.003,
        captureProbe.error || 'peak=' + captureProbe.peak);

      const nativePick = await evalJs('typeof window.miaojiDesktop.pickFile === "function" && typeof window.miaojiDesktop.setRecording === "function" && typeof window.miaojiDesktop.notify === "function"');
      check('native dialog / notify / recording IPC exposed', nativePick === true);

      const deepLinkMeeting = await evalJs('new URLSearchParams(location.search).get("meeting")');
      check('deep link query is parsed intact', !OPEN_QUERY || deepLinkMeeting === OPEN_QUERY.split('=').pop(),
        'url=' + String(deepLinkMeeting));

      await testSettingsDrawer(check, evalJs);
      await testCustomSettings(check, evalJs);
    }
  } catch (err) {
    check('selftest completed without throwing', false, String((err && err.message) || err));
  }

  const failed = results.filter((x) => !x).length;
  console.log('');
  console.log(failed === 0
    ? 'DESKTOP SELFTEST: ALL ' + results.length + ' PASSED'
    : 'DESKTOP SELFTEST: ' + failed + '/' + results.length + ' FAILED');
  quitting = true;
  app.exit(failed ? 1 : 0);
  // Belt and braces: never leave a stray Electron process behind.
  setTimeout(() => process.exit(failed ? 1 : 0), 2500);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function main() {
  await app.whenReady();
  Menu.setApplicationMenu(buildMenu());
  registerIpc();

  try {
    const info = await startServer();
    serverUrl = info.url.endsWith('/') ? info.url : info.url + '/';
  } catch (err) {
    dialog.showErrorBox('巴别回声启动失败', String((err && err.message) || err));
    quitting = true;
    app.quit();
    return;
  }

  createWindow();
  createTray();

  registerShortcuts();
  console.log('[miaoji] 快捷键: 录音=' + (shortcuts.toggle || '未注册') + ' 显示窗口=' + (shortcuts.show || '未注册'));

  setInterval(pollLive, 2500);
  pollLive();

  if (CAPTURE) await runCapture();
  if (SELFTEST) await runSelfTest();
}

if (!SELFTEST && !CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (sleepBlockerId !== null) {
      try { powerSaveBlocker.stop(sleepBlockerId); } catch { /* ignore */ }
      sleepBlockerId = null;
    }
    stopServer();
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('window-all-closed', () => {
    // On macOS apps stay alive without windows; everywhere else, quit - but
    // the recording guard in the close handler keeps the window alive while a
    // meeting is running, so this only fires when nothing is in progress.
    if (process.platform !== 'darwin') {
      quitting = true;
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  main().catch((err) => {
    dialog.showErrorBox('巴别回声启动异常', String((err && err.stack) || err));
    app.quit();
  });
}
