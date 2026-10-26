const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sender', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (changes) => ipcRenderer.invoke('set-config', changes),
  reload: () => ipcRenderer.send('reload'),
  loadUrl: (url) => ipcRenderer.invoke('load-url', url),
  onConfig: (fn) => ipcRenderer.on('config', (_e, c) => fn(c)),
  devtools: () => ipcRenderer.send('devtools'),
  key: (keyCode) => ipcRenderer.send('key', keyCode),
  click: () => ipcRenderer.send('click'),
  onStatus: (fn) => ipcRenderer.on('status', (_e, s) => fn(s)),
});
