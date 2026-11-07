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
        Notification, powerSaveBlocker, nativeImage, shell, desktopCapturer,
        systemPreferences, session } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const installMarkdownReader = require('./markdown-reader.cjs');
const { isExternalLink, markdownPathsFromArgv, macDefaultHandlerScript } = require('./markdown-files.cjs');

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
const REAL_MICROPHONE_TEST = process.argv.includes('--selftest-real-microphone');
const REAL_SYSTEM_AUDIO_TEST = process.argv.includes('--selftest-real-system-audio');
const READER_ONLY = process.argv.includes('--reader');
// Must match build.appId in package.json; macOS default-app registration uses it.
const MAC_BUNDLE_ID = 'com.miaoji.desktop';
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
const DATA_DIR = app.isPackaged || SELFTEST || CAPTURE ? path.join(app.getPath('userData'), 'data') : path.join(ROOT, 'data');
// electron-builder treats desktop/build as its buildResources directory, so
// the icon is NOT inside the asar; it is copied to resources/ explicitly.
const ICON_PNG = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, 'build', 'icon.png');
const MEDIA_EXT = ['wav', 'mp3', 'm4a', 'mp4', 'mov', 'webm', 'ogg', 'oga', 'flac',
  'aac', 'wma', 'mkv', 'avi', 'opus', 'amr', 'aif', 'aiff', '3gp', 'm4v'];

let win = null;
let markdownReader = null;
let recorderShellStarted = false;
let tray = null;
let server = null;
let serverUrl = null;
let accessToken = null;
let quitting = false;
let sleepBlockerId = null;
let live = { recording: false, processing: false };
// Markdown files the OS asked us to open before the reader was ready: double-click on
// Windows passes the path as an argument, macOS sends open-file events during launch.
const pendingMarkdown = markdownPathsFromArgv(process.argv);
// Opening a .md file starts only the reader (no recorder window, tray or shortcuts),
// exactly like --reader. Decided once the launch-time open-file events have arrived.
let readerOnly = READER_ONLY;
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (markdownReader && serverUrl) openMarkdownPath(filePath);
  else pendingMarkdown.push(filePath);
});
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
        ...((SELFTEST || CAPTURE) ? { MIAOJI_ALLOW_ENV_CREDENTIALS: '0' } : {}),
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
  // Only the bundled local server's pages get these, never a page the
  // window might have been navigated to.
  const fromApp = (url) => {
    try { return !!serverUrl && new URL(url).origin === new URL(serverUrl).origin; } catch { return false; }
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowed.has(permission) && fromApp(details?.requestingUrl || wc?.getURL())));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowed.has(permission) && fromApp(requestingOrigin || wc?.getURL()));
  // Capture the primary display's playback audio. The video track is required
  // by getDisplayMedia, but the renderer stops it immediately and only mixes
  // the loopback audio. macOS 13+ exposes this through ScreenCaptureKit/Core
  // Audio Tap; the packaged app also carries the required usage strings.
  if (['win32', 'darwin'].includes(process.platform)) {
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        if (new URL(request.securityOrigin).origin !== new URL(serverUrl).origin) {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        callback(sources.length ? { video: sources[0], audio: 'loopback' } : {});
      } catch (err) {
        console.error('[display capture]', err);
        callback({});
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

  // The recorder window must stay on the local app: a page elsewhere would
  // inherit the preload bridge. External links open in the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    let sameApp = false;
    try { sameApp = new URL(url).origin === new URL(serverUrl).origin; } catch { /* invalid URL */ }
    if (sameApp) return;
    event.preventDefault();
    if (isExternalLink(url)) shell.openExternal(url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('context-menu', (_event, params) => {
    const edit = params.editFlags;
    const items = params.isEditable ? [
      { role: 'undo', label: '撤销', enabled: edit.canUndo },
      { role: 'redo', label: '重做', enabled: edit.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: edit.canCut },
      { role: 'copy', label: '复制', enabled: edit.canCopy },
      { role: 'paste', label: '粘贴', enabled: edit.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ] : params.selectionText ? [
      { role: 'copy', label: '复制', enabled: edit.canCopy },
      { role: 'selectAll', label: '全选' },
    ] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.loadURL(serverUrl + (OPEN_QUERY ? '?' + OPEN_QUERY + (SELFTEST ? '&selftest=1' : '') : SELFTEST ? '?selftest=1' : ''));
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

function showWindow() {
  if (!serverUrl) return;
  if (!win || win.isDestroyed()) createWindow();
  startRecorderShell();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function activateWindow() {
  if (!serverUrl || !markdownReader) return;
  if (readerOnly && !recorderShellStarted) {
    const reader = [...markdownReader.readers.values()].map((entry) => entry.window)
      .find((window) => !window.isDestroyed()) || markdownReader.open();
    if (reader.isMinimized()) reader.restore();
    reader.show();
    reader.focus();
    return;
  }
  showWindow();
}

function sendToRenderer(channel) {
  showWindow();
  if (win && !win.isDestroyed()) {
    const target = win.webContents;
    if (target.isLoading()) target.once('did-finish-load', () => { if (!target.isDestroyed()) target.send(channel); });
    else target.send(channel);
  }
}

function startRecorderShell() {
  if (recorderShellStarted) return;
  recorderShellStarted = true;
  createTray(); registerShortcuts();
  console.log('[miaoji] 快捷键: 录音=' + (shortcuts.toggle || '未注册') + ' 显示窗口=' + (shortcuts.show || '未注册'));
  setInterval(pollLive, 2500); pollLive();
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

// The main process talks to the server with Node's fetch, which does not use
// the window session's cookie, so it sends the access token as a header.
function serverFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...init.headers, authorization: 'Bearer ' + accessToken } });
}

async function pollLive() {
  if (!serverUrl) return;
  try {
    const res = await serverFetch(serverUrl + 'api/live', { signal: AbortSignal.timeout(4000) });
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

/** Open a Markdown file the OS handed us (double-click, Open With, drag onto the Dock icon). */
async function openMarkdownPath(filePath) {
  try {
    const reader = markdownReader.open(await markdownReader.readMarkdownFile(filePath));
    if (reader.isMinimized()) reader.restore();
    reader.show();
    reader.focus();
  } catch (error) {
    dialog.showErrorBox('无法打开 Markdown', path.basename(String(filePath)) + '\n' + error.message);
  }
}

/**
 * Make this app the default for .md files. Both systems keep that choice with the user:
 * macOS asks for confirmation (or we explain Finder's "Change All"), and Windows only lets
 * apps open the Default apps page, where the installer has registered us.
 */
async function setDefaultMarkdownReader() {
  const owner = BrowserWindow.getFocusedWindow() || undefined;
  if (!app.isPackaged) {
    await dialog.showMessageBox(owner, { type: 'info', message: '开发模式下无法设为默认',
      detail: '只有安装版会登记 .md 文件类型。请用打包好的安装包安装后再设置。' });
    return;
  }
  if (process.platform === 'darwin') {
    const manual = '也可以手动设置：在访达中选中任意 .md 文件 → 显示简介（⌘I）→「打开方式」选择巴别回声 →「全部更改…」。';
    const status = await new Promise((resolve) => execFile('/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', macDefaultHandlerScript(MAC_BUNDLE_ID)], { timeout: 60000 },
      (error, stdout) => resolve(error ? NaN : Number(String(stdout).trim()))));
    await dialog.showMessageBox(owner, status === 0
      ? { type: 'info', message: '已将巴别回声设为 Markdown 文件的默认阅读器', detail: '如果系统弹出确认框，请选择使用巴别回声。\n' + manual }
      : { type: 'warning', message: '没能自动设置默认阅读器', detail: manual });
    return;
  }
  if (process.platform === 'win32') {
    // Registered under RegisteredApplications by the installer (build/installer.nsh).
    const machine = await new Promise((resolve) => execFile('reg',
      ['query', 'HKLM\\Software\\RegisteredApplications', '/v', 'BabelEcho'], (error) => resolve(!error)));
    const choice = await dialog.showMessageBox(owner, { type: 'info', buttons: ['打开“默认应用”设置', '取消'], defaultId: 0, cancelId: 1,
      message: '在 Windows 设置中把 .md 文件交给巴别回声',
      detail: 'Windows 不允许应用自行修改默认程序。接下来会打开“默认应用”中巴别回声的页面：点击 .md（以及 .markdown），选择“巴别回声”。\n\n也可以右键任意 .md 文件 →「打开方式」→「选择其他应用」→ 选巴别回声并勾选“始终使用此应用”。便携版不会登记文件类型，请使用安装版。' });
    if (choice.response === 0) {
      await shell.openExternal('ms-settings:defaultapps?' + (machine ? 'registeredAppMachine' : 'registeredAppUser') + '=BabelEcho')
        .catch(() => shell.openExternal('ms-settings:defaultapps'));
    }
    return;
  }
  await dialog.showMessageBox(owner, { type: 'info', message: '请在系统的“默认应用程序”设置中为 .md 文件选择巴别回声' });
}

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于巴别回声' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏巴别回声' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出巴别回声' },
      ],
    });
  }
  template.push(
    {
      label: '文件',
      submenu: [
        { label: '导入音视频…', accelerator: 'CommandOrControl+O', click: () => sendToRenderer('miaoji:import') },
        { label: 'Markdown 阅读器', click: () => markdownReader?.open() },
        { label: '打开 Markdown 文件…', accelerator: 'CommandOrControl+Shift+O', click: () => markdownReader?.openFile().catch((error) => dialog.showErrorBox('无法打开 Markdown', error.message)) },
        { label: '打印当前文档…', accelerator: 'CommandOrControl+P', click: () => markdownReader?.printFocused() },
        { label: '设为默认 Markdown 阅读器…', click: () => setDefaultMarkdownReader() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'selectAll', label: '全选' },
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
        { label: '在浏览器中打开', click: () => shell.openExternal(serverUrl + '?token=' + accessToken) },
        { label: '打开数据文件夹', click: () => shell.openPath(DATA_DIR) },
        { label: '打开应用文件夹', click: () => shell.openPath(ROOT) },
      ],
    },
  );
  return Menu.buildFromTemplate(template);
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
  // The server uses a new port on each launch; renderer localStorage is only
  // an origin-scoped cache. Keep appearance in the stable application profile.
  const appearancePath = path.join(app.getPath('userData'), 'appearance.json');
  const appearanceSchema = import(require('node:url').pathToFileURL(path.join(ROOT, 'public', 'appearance.js')).href);
  ipcMain.handle('miaoji:appearance-get', async () => {
    const { normalizeAppearance } = await appearanceSchema;
    try { return normalizeAppearance(JSON.parse(fs.readFileSync(appearancePath, 'utf8'))); }
    catch { return null; }
  });
  ipcMain.handle('miaoji:appearance-set', async (_event, preference) => {
    const { normalizeAppearance } = await appearanceSchema;
    const saved = normalizeAppearance(preference);
    fs.mkdirSync(path.dirname(appearancePath), { recursive: true });
    const temp = appearancePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(saved), 'utf8');
    fs.renameSync(temp, appearancePath);
    return saved;
  });
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
  ipcMain.handle('miaoji:media-access-status', () => {
    if (process.platform !== 'darwin') return null;
    return {
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      screen: systemPreferences.getMediaAccessStatus('screen'),
    };
  });
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
  const cfg = async () => (await (await serverFetch(serverUrl + 'api/config')).json());
  const drawerHidden = () => evalJs('document.getElementById("drawer").hidden');

  const before = await cfg();

  await evalJs('document.getElementById("btnSettings").click()');
  await pause(1400);
  await evalJs('document.querySelector("[data-tab=quick]").click()');
  await pause(900);
  const quick = await evalJs('(() => ({ cards: document.querySelectorAll(".quick-card[data-provider]").length,' +
    'overview: !!document.querySelector(".quick-overview"),' +
    'selected: document.querySelector("[data-tab=quick]").getAttribute("aria-selected") }))()');
  check('quick settings lists every provider with a status overview',
    quick.overview && quick.selected === 'true' && quick.cards >= 7, quick.cards + ' cards, overview=' + quick.overview + ' selected=' + quick.selected);
  await evalJs('document.querySelector("[data-tab=advanced]").click()');
  await pause(900);

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
    'const input=section.querySelector("input[type=number]"); input.value="5.0";' +
    'input.dispatchEvent(new Event("change", { bubbles: true }));' +
    '})()');
  await pause(1000);
  check('preview interval saves automatically from settings', (await cfg()).realtime.stepMs === 5000);
  await serverFetch(serverUrl + 'api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
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
  await serverFetch(serverUrl + 'api/config', {
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

async function testModelSettings(check, evalJs) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const before = await (await serverFetch(serverUrl + 'api/config')).json();
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(500);
  await evalJs('document.querySelector("[data-tab=advanced]").click()');
  await pause(700);
  const choose = async (field, value) => evalJs(`(() => {
    const e = document.querySelector('[data-task="summary"] [data-field="${field}"]');
    e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  // Task models save on change; wait for the last autosave to land.
  const save = async () => {
    await pause(700);
    return (await (await serverFetch(serverUrl + 'api/config')).json()).llm.roles.summary;
  };
  try {
    await choose('model-select', 'deepseek-v4-pro');
    await choose('thinking', 'disabled');
    const pro = await save();
    check('task picker saves DeepSeek Pro and thinking mode', pro.model === 'deepseek-v4-pro' && pro.thinking === 'disabled');
    await choose('model-select', 'deepseek-flash');
    check('task picker switches back to Flash', (await save()).model === 'deepseek-flash');

    // Mock discovery only. Config writes still pass through the real server.
    // No external model calls or credentials are needed for these UI checks.
    await evalJs(`(() => {
      window.qaOriginalFetch = window.fetch;
      window.fetch = async (...args) => String(args[0]).includes('/models')
        ? new Response(JSON.stringify({models:['qa-local-small', 'qa-local-large']}), {status:200})
        : window.qaOriginalFetch(...args);
    })()`);
    await choose('provider', 'local');
    await pause(300);
    const choices = await evalJs(`(() => {
      const card = document.querySelector('[data-task="summary"]');
      return { ids: [...card.querySelector('[data-field="model-select"]').options].map(o=>o.value),
        thinkingDisabled: card.querySelector('[data-field="thinking"]').disabled };
    })()`);
    check('provider change loads selectable models and resets previous ID', choices.ids.includes('qa-local-small') && !choices.ids.includes('deepseek-flash') && choices.thinkingDisabled);
    await choose('model-select', 'qa-local-large');
    const local = await save();
    check('local model selection persists', local.provider === 'local' && local.model === 'qa-local-large');
    await choose('model-select', '__manual_model__');
    await choose('model-id', 'custom/model:latest');
    check('manual model ID persists exactly', (await save()).model === 'custom/model:latest');

    await evalJs(`(() => {
      const s = document.querySelector('[data-settings="summary"]');
      s.querySelector('[data-field="autoMs"]').value = '240';
      s.querySelector('[data-field="minNewChars"]').value = '300';
      s.querySelector('[data-field="minNewChars"]').dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await pause(500);
    const summary = (await (await serverFetch(serverUrl + 'api/config')).json()).summary;
    check('summary interval and new text threshold persist', summary.autoMs === 240000 && summary.minNewChars === 300);
    await evalJs(`(() => {
      const drawer = document.getElementById('drawerBody');
      const target = document.querySelector('[data-task="summary"]');
      drawer.scrollTo({top: drawer.scrollTop + target.getBoundingClientRect().top - drawer.getBoundingClientRect().top - 12, behavior:'instant'});
    })()`);
    await pause(250);
    if (process.env.MIAOJI_QA_CAPTURE_DIR) {
      fs.mkdirSync(process.env.MIAOJI_QA_CAPTURE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MIAOJI_QA_CAPTURE_DIR, 'task-model-settings.png'), (await win.webContents.capturePage()).toPNG());
    }
  } finally {
    await evalJs('if (window.qaOriginalFetch) { window.fetch = window.qaOriginalFetch; delete window.qaOriginalFetch; }');
    await serverFetch(serverUrl + 'api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ llm: before.llm, summary: before.summary }) });
    await evalJs('document.getElementById("drawerClose").click()');
  }
}

async function testCustomSettings(check, evalJs) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await evalJs('document.getElementById("btnSettings").click()');
  await pause(500);
  await evalJs('document.querySelector("[data-tab=advanced]").click()');
  await pause(700);
  await evalJs('(() => {' +
    'const form=document.querySelector(".add-provider"); form.open=true;' +
    'const inputs=form.querySelectorAll(".settings-field input");' +
    'inputs[0].value="QA local ASR";' +
    'form.querySelector("button.btn.primary").click();' +
    '})()');
  await pause(900);
  const created = await (await serverFetch(serverUrl + 'api/config')).json();
  const found = Object.entries(created.asr.providers).find(([, value]) => value.label === 'QA local ASR');
  check('custom speech provider can be added from settings', !!found, found?.[0] || 'missing');
  if (found) await serverFetch(serverUrl + 'api/providers/asr/' + found[0], { method: 'DELETE' });
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

async function testAppearanceSettings(check, evalJs) {
  const result = await evalJs('(async () => {' +
    'const a = await import("/appearance.js");' +
    'await a.updateAppearance({skin:"endspace", mode:"dark"}, {accent:"#008577", fontSize:18});' +
    'const pref = await window.miaojiDesktop.getAppearancePreference();' +
    'return {pref, skin:document.documentElement.dataset.skin, mode:document.documentElement.dataset.theme};' +
    '})()');
  check('appearance IPC saves the selected theme and design tokens',
    result.pref.skin === 'endspace' && result.pref.profiles.endspace.fontSize === 18 &&
    result.pref.profiles.endspace.accent === '#008577' && result.skin === 'endspace' && result.mode === 'dark');
  const persisted = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'appearance.json'), 'utf8'));
  check('appearance is persisted outside the renderer origin', persisted.skin === 'endspace' && persisted.mode === 'dark');
  // Clear only disposable QA-origin preferences: a new random server port on
  // the next launch likewise has no localStorage entries from the old origin.
  await evalJs('localStorage.removeItem("babel-echo-appearance-v1"); localStorage.removeItem("miaoji-theme");');
  await win.loadURL(serverUrl);
  await waitForUi(15000);
  const restored = await evalJs('(async () => {' +
    'const a = await import("/appearance.js"); return a.getAppearance(); })()');
  check('desktop appearance restores when origin storage is empty',
    restored.skin === 'endspace' && restored.mode === 'dark' && restored.profiles.endspace.fontSize === 18);
  const isolated = await evalJs('(async () => {' +
    'const a = await import("/appearance.js"); await a.updateAppearance({skin:"default"});' +
    'return a.getAppearance(); })()');
  check('appearance profiles remain independent', isolated.profiles.default.fontSize === 14 && isolated.profiles.endspace.fontSize === 18);
  const reset = await evalJs('(async () => {' +
    'const a = await import("/appearance.js"); await a.updateAppearance({skin:"endspace"});' +
    'await a.resetAppearanceProfile(); const p=a.getAppearance();' +
    'await a.updateAppearance({skin:"default",mode:"auto"}); return p; })()');
  check('appearance reset preserves mode and clears only active customization',
    reset.skin === 'endspace' && reset.mode === 'dark' && reset.profiles.endspace.fontSize === 14 && reset.profiles.endspace.accent === '');
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
    const editMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === '编辑');
    check('native edit menu exposes copy and paste',
      ['copy', 'paste', 'selectall'].every((role) => editMenu?.submenu?.items.some((item) => item.role === role)),
      JSON.stringify(editMenu?.submenu?.items.map((item) => ({ label: item.label, role: item.role }))));
    check('text context menu is registered', win.webContents.listenerCount('context-menu') > 0);
    check('server handshake returned a URL', !!serverUrl, serverUrl);
    check('server process is running', !!server && server.exitCode === null);
    check('recording global shortcut registered', !!shortcuts.toggle, String(shortcuts.toggle));
    check('show-window global shortcut registered', !!shortcuts.show, String(shortcuts.show));
    check('sleep blocker is available', typeof powerSaveBlocker.start === 'function');
    check('tray created', !!tray && !tray.isDestroyed());

    if (app.isPackaged && process.platform === 'darwin') {
      const contents = path.dirname(path.dirname(process.execPath));
      const frameworks = path.join(contents, 'Frameworks');
      const bundles = [path.dirname(contents), ...fs.readdirSync(frameworks)
        .filter((name) => name.includes('Helper') && name.endsWith('.app'))
        .map((name) => path.join(frameworks, name))];
      for (const bundle of bundles) {
        let allowed = false;
        let detail;
        try {
          const entitlements = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundle],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          allowed = /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/.test(entitlements);
        } catch (error) { detail = error.message; }
        check('signed microphone entitlement: ' + path.basename(bundle), allowed, detail);
      }
    }

    const uiUp = await waitForUi(30000);
    check('app UI rendered', uiUp);
    if (uiUp) {
      if (!REAL_MICROPHONE_TEST) {
        await evalJs('(' + require('./synthetic-microphone.cjs').toString() + ')()');
        console.log('  INFO  microphone checks use synthetic streams; no physical microphone is opened');
      }
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
      check('engine chip shows provider readiness', !!probe.engine, probe.engine);
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
      if (['win32', 'darwin'].includes(process.platform)) {
        check('system audio enabled by default on supported desktop', audioUi.checked === true);
        if (REAL_SYSTEM_AUDIO_TEST) {
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
        } else console.log('  SKIP  physical system audio capture (requires --selftest-real-system-audio)');
      }

      const micProbe = await evalJs('(async () => { const devices = await navigator.mediaDevices.enumerateDevices();' +
        'const input = devices.find(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default");' +
        'if (!input) return { available: false }; let stream;' +
        'try { stream = await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:input.deviceId}}});' +
        'return { available: true, matched: stream.getAudioTracks()[0].getSettings().deviceId === input.deviceId };' +
        '} catch (e) { return { available: true, matched: false, error: e.name }; }' +
        'finally { if (stream) stream.getTracks().forEach(t => t.stop()); } })()');
      if (micProbe.available) {
        check((REAL_MICROPHONE_TEST ? 'physical' : 'synthetic') + ' microphone can be opened by device ID', micProbe.matched, micProbe.error || 'device ID matched');
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
      check((REAL_MICROPHONE_TEST ? 'physical' : 'synthetic') + ' microphone test starts and stops capture', captureProbe.testing && captureProbe.stopped,
        captureProbe.error || 'started and stopped');
      check('microphone and system streams reach the PCM meter', captureProbe.peak >= 0.003,
        captureProbe.error || 'peak=' + captureProbe.peak);
      if (!REAL_MICROPHONE_TEST) {
        const fixture = await evalJs('({calls:window.miaojiSyntheticMicrophone.calls,active:window.miaojiSyntheticMicrophone.active.size})');
        check('synthetic microphone streams are released', fixture.calls > 0 && fixture.active === 0, JSON.stringify(fixture));
      }

      const nativePick = await evalJs('typeof window.miaojiDesktop.pickFile === "function" && typeof window.miaojiDesktop.setRecording === "function" && typeof window.miaojiDesktop.notify === "function"');
      check('native dialog / notify / recording IPC exposed', nativePick === true);

      const deepLinkMeeting = await evalJs('new URLSearchParams(location.search).get("meeting")');
      check('deep link query is parsed intact', !OPEN_QUERY || deepLinkMeeting === OPEN_QUERY.split('=').pop(),
        'url=' + String(deepLinkMeeting));

      await testSettingsDrawer(check, evalJs);
      await testModelSettings(check, evalJs);
      await testCustomSettings(check, evalJs);
      await testAppearanceSettings(check, evalJs);
      await require('./reader-selftest.cjs')({ manager: markdownReader, root: ROOT, check,
        outputDir: process.env.MIAOJI_QA_CAPTURE_DIR, mainWindow: win, dataDir: DATA_DIR, serverUrl });
    }
  } catch (err) {
    check('selftest completed without throwing', false, String((err && err.message) || err));
  } finally {
    if (!REAL_MICROPHONE_TEST && !win.isDestroyed()) {
      await evalJs('window.miaojiSyntheticMicrophone?.cleanup()').catch(() => {});
    }
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
    accessToken = info.accessToken;
    // Every window (recorder and Markdown readers) uses the default session,
    // so one cookie authorises their page, API and WebSocket requests.
    await session.defaultSession.cookies.set({ url: serverUrl, name: info.accessCookie, value: accessToken,
      httpOnly: true, sameSite: 'strict' });
  } catch (err) {
    dialog.showErrorBox('巴别回声启动失败', String((err && err.message) || err));
    quitting = true;
    app.quit();
    return;
  }

  markdownReader = installMarkdownReader({ BrowserWindow, ipcMain, dialog, shell, Menu,
    getServerUrl: () => serverUrl, getMainWindow: () => win, selftest: SELFTEST });
  // Launched by opening a .md file: behave like --reader and show just that document.
  if (pendingMarkdown.length && !SELFTEST && !CAPTURE) readerOnly = true;
  if (readerOnly) {
    if (pendingMarkdown.length) for (const file of pendingMarkdown.splice(0)) await openMarkdownPath(file);
    else markdownReader.open();
    if (SELFTEST) {
      let failed = false;
      try {
        await require('./reader-lifecycle-selftest.cjs')({ app, BrowserWindow, Menu, ipcMain,
          manager: markdownReader, shellState: () => ({ win, tray, recorderShellStarted, shortcuts }) });
      } catch (error) { failed = true; console.error('  FAIL  reader lifecycle', error); }
      quitting = true;
      app.exit(failed ? 1 : 0);
    }
    return;
  }
  createWindow();
  startRecorderShell();
  // Files that arrived while the server was starting.
  for (const file of pendingMarkdown.splice(0)) openMarkdownPath(file);

  if (CAPTURE) await runCapture();
  if (SELFTEST) await runSelfTest();
}

if (!SELFTEST && !CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // A .md file opened while the app is running goes to a new reader window.
    const files = markdownPathsFromArgv(argv);
    if (files.length && markdownReader && serverUrl) files.forEach((file) => openMarkdownPath(file));
    else if (files.length) pendingMarkdown.push(...files);
    else if (argv.includes('--reader')) markdownReader?.open();
    else showWindow();
  });

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

  app.on('activate', activateWindow);

  main().catch((err) => {
    dialog.showErrorBox('巴别回声启动异常', String((err && err.stack) || err));
    app.quit();
  });
}
