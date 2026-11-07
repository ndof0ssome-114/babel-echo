const { contextBridge, ipcRenderer } = require('electron');
// Deliberately separate from the recorder bridge: no recording/settings APIs.
contextBridge.exposeInMainWorld('babelMarkdownReader', {
  getDocument: () => ipcRenderer.invoke('babel:reader-document'),
  pickDocument: () => ipcRenderer.invoke('babel:reader-pick'),
  readImage: (relative) => ipcRenderer.invoke('babel:reader-image', relative),
  print: () => ipcRenderer.invoke('babel:reader-print'),
  savePdf: () => ipcRenderer.invoke('babel:reader-pdf'),
});
