const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('liDesk', {
  translate: (id, text, src, tgt, online, hq) => ipcRenderer.send('tr:go', id, text, src, tgt, !!online, !!hq),
  onTr: (cb) => ipcRenderer.on('tr:ev', (_e, m) => cb(m)),
  schedule: (list) => ipcRenderer.send('ntf:schedule', list),
  cancel: (ids) => ipcRenderer.send('ntf:cancel', ids),
  fullscreen: () => ipcRenderer.invoke('win:fs'),
  printPdf: (html, name) => ipcRenderer.send('pdf:print', html, name),
  openUrl: (u) => ipcRenderer.send('open-url', u),
  ocrStatus: () => ipcRenderer.invoke('ai:ocr:status'),
  ocrPrep: () => ipcRenderer.invoke('ai:ocr:prep'),
  ocrPage: (img) => ipcRenderer.invoke('ai:ocr:page', img),
  ocrStop: () => ipcRenderer.invoke('ai:ocr:stop'),
  onAiProg: (cb) => ipcRenderer.on('ai:prog', (_e, t) => cb(t))
});
