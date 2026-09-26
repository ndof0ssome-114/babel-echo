// preload.cjs — the only bridge between the Electron shell and the web UI.
//
// contextIsolation stays on and nodeIntegration stays off, so the recorder
// page never gets Node access; it only ever sees this hand-written surface.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miaojiDesktop', {
  isDesktop: true,
  platform: process.platform,

  /** Main -> renderer: global shortcut or tray asked to toggle recording. */
  onToggleRecord: (cb) => ipcRenderer.on('miaoji:toggle-record', () => cb()),

  /** Main -> renderer: File > 导入音视频. */
  onImport: (cb) => ipcRenderer.on('miaoji:import', () => cb()),

  /** Native file picker; resolves to an absolute path or null. */
  pickFile: () => ipcRenderer.invoke('miaoji:open-file'),

  /** The port the bundled server actually bound to. */
  serverUrl: () => ipcRenderer.invoke('miaoji:server-url'),

  /** macOS privacy state; null on platforms that do not expose it. */
  getMediaAccessStatus: () => ipcRenderer.invoke('miaoji:media-access-status'),

  getMicrophonePreference: () => ipcRenderer.invoke('miaoji:microphone-get'),
  setMicrophonePreference: (preference) => ipcRenderer.invoke('miaoji:microphone-set', preference),

  notify: (title, body) => ipcRenderer.send('miaoji:notify', { title, body }),

  /** Lets the shell keep the machine awake and update the tray. */
  setRecording: (value) => ipcRenderer.send('miaoji:recording-state', { value: !!value }),
});
