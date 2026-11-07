const assert = require('node:assert/strict');

module.exports = async function testLifecycle({ app, BrowserWindow, Menu, ipcMain, manager, shellState }) {
  let passed = 0;
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('  PASS  ' + name); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 400));
  const reader = () => [...manager.readers.values()][0]?.window;
  await settle();
  const menu = Menu.getApplicationMenu();
  check('reader-only startup has custom Markdown and workspace menus',
    menu.items.some(item => item.submenu?.items.some(entry => entry.label === '打开 Markdown 文件…')) &&
    menu.items.some(item => item.submenu?.items.some(entry => entry.label === '显示主窗口')));
  check('reader-only startup has no recorder shell or shortcuts', !shellState().recorderShellStarted && !shellState().win && !shellState().tray && !shellState().shortcuts.toggle);
  const original = reader();
  app.emit('activate');
  await settle();
  check('Dock activation reuses the reader without creating a recorder', BrowserWindow.getAllWindows().length === 1 && reader() === original && !shellState().win);
  if (process.platform === 'darwin') {
    original.minimize(); await settle(); app.emit('activate'); await settle();
    check('Dock activation restores a minimized reader', !original.isMinimized());
  }
  app.emit('second-instance', {}, ['--reader']); await settle();
  check('repeated reader launch opens another reader without recording shell', manager.readers.size === 2 && !shellState().recorderShellStarted);
  for (const entry of [...manager.readers.values()]) entry.window.close();
  await settle(); app.emit('activate'); await settle();
  check('Dock reopens the reader after the last reader closes', manager.readers.size === 1 && !shellState().recorderShellStarted);
  const workspace = menu.items.flatMap(item => item.submenu?.items || []).find(item => item.label === '显示主窗口');
  workspace.click(); await settle();
  check('explicit workspace menu initializes the recorder shell', shellState().recorderShellStarted && !!shellState().win && !!shellState().tray);
  const main = shellState().win;
  ipcMain.emit('miaoji:recording-state', {}, { value: true });
  main.close();
  check('closing while recording preserves the main window', !main.isDestroyed() && !main.isVisible());
  ipcMain.emit('miaoji:recording-state', {}, { value: false });
  main.close(); await settle(); app.emit('activate'); await settle();
  check('Dock recreates the explicitly enabled workspace after close', shellState().win !== main && !shellState().win.isDestroyed());
  console.log('READER LIFECYCLE SELFTEST: ALL ' + passed + ' PASSED');
};
