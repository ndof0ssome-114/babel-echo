const path = require('node:path');
const fs = require('node:fs/promises');
const { readMarkdownFile, readRelativeImage, isExternalLink, MAX_MARKDOWN_BYTES } = require('./markdown-files.cjs');

module.exports = function installReader({ BrowserWindow, ipcMain, dialog, shell, Menu, getServerUrl, getMainWindow, selftest }) {
  const readers = new Map();
  function isReader(event) {
    const entry = readers.get(event.sender.id);
    const url = new URL(event.sender.getURL());
    if (!entry || event.senderFrame !== event.sender.mainFrame || url.origin !== new URL(getServerUrl()).origin || url.pathname !== '/reader.html') throw new Error('无效的阅读窗口');
    return entry;
  }
  const snapshot = (document) => ({ text: document.text || '', title: document.title || 'Markdown 阅读器', hasLocalAssets: !!document.baseDir });
  function open(document = {}, language = 'zh') {
    if (typeof document.text !== 'string' && document.text !== undefined) throw new Error('无效的 Markdown 文档');
    if (Buffer.byteLength(document.text || '', 'utf8') > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件不能超过 2 MB');
    const reader = new BrowserWindow({ width: 1240, height: 920, minWidth: 640, minHeight: 480,
      title: 'Markdown 阅读器 — 巴别回声', show: !selftest, autoHideMenuBar: false,
      webPreferences: { preload: path.join(__dirname, 'reader-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, spellcheck: false } });
    const entry = { window: reader, document: { ...document, title: String(document.title || 'Markdown 阅读器').slice(0, 200) } };
    const id = reader.webContents.id;
    readers.set(id, entry);
    reader.webContents.setWindowOpenHandler(({ url }) => { if (isExternalLink(url)) shell.openExternal(url); return { action: 'deny' }; });
    reader.webContents.on('context-menu', (_event, params) => {
      if (params.selectionText) Menu.buildFromTemplate([{ role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' }]).popup({ window: reader });
    });
    reader.webContents.on('will-navigate', (event, url) => {
      const target = new URL(url);
      if (target.origin === new URL(getServerUrl()).origin && target.pathname === '/reader.html') return;
      event.preventDefault(); if (isExternalLink(url)) shell.openExternal(url);
    });
    reader.on('closed', () => readers.delete(id));
    reader.loadURL(getServerUrl() + 'reader.html?ui=' + (['zh', 'ja', 'en'].includes(language) ? language : 'zh'));
    return reader;
  }
  async function pick(entry) {
    const result = await dialog.showOpenDialog(entry.window, { title: '打开 Markdown 文件', properties: ['openFile'],
      filters: [{ name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt'] }] });
    if (result.canceled || !result.filePaths.length) return null;
    const document = await readMarkdownFile(result.filePaths[0]);
    entry.document = document; return snapshot(document);
  }
  async function print(entry) {
    return new Promise((resolve, reject) => entry.window.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
      if (ok) resolve({ canceled: false });
      else if (/cancel/i.test(reason || '')) resolve({ canceled: true });
      else reject(new Error(reason || '打印失败'));
    }));
  }
  ipcMain.handle('babel:reader-open', (event, document = {}) => {
    const main = getMainWindow();
    if (!main || event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('无效的主窗口');
    open({ text: document.text, title: document.title }, document.language); return { opened: true };
  });
  ipcMain.handle('babel:reader-document', (event) => snapshot(isReader(event).document));
  ipcMain.handle('babel:reader-pick', (event) => pick(isReader(event)));
  ipcMain.handle('babel:reader-image', (event, relative) => readRelativeImage(isReader(event).document.baseDir, relative));
  ipcMain.handle('babel:reader-print', (event) => print(isReader(event)));
  ipcMain.handle('babel:reader-pdf', async (event) => {
    const entry = isReader(event);
    const filename = entry.document.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.(md|markdown|txt)$/i, '') + '.pdf';
    const result = await dialog.showSaveDialog(entry.window, { title: '保存 PDF', defaultPath: filename, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const bytes = await entry.window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    await fs.writeFile(result.filePath, bytes); return { canceled: false };
  });
  return { open, readers, readMarkdownFile, async openFile() {
    const owner = BrowserWindow.getFocusedWindow();
    const options = { title: '打开 Markdown 文件', properties: ['openFile'], filters: [{ name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt'] }] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    return open(await readMarkdownFile(result.filePaths[0]));
  }, async printFocused() {
    const focused = BrowserWindow.getFocusedWindow(); const entry = focused && readers.get(focused.webContents.id);
    if (entry) await focused.webContents.executeJavaScript('document.getElementById("readerPrint")?.click()');
  } };
};
