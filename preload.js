const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersions: () => ipcRenderer.invoke('get-versions'),
  downloadVersion: (versionId) => ipcRenderer.invoke('download-version', versionId),
  launchGame: (versionId, username) => ipcRenderer.invoke('launch-game', versionId, username),
  getInstalledVersions: () => ipcRenderer.invoke('get-installed-versions'),
  
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, progress) => callback(progress)),
  onLibraryProgress: (callback) => ipcRenderer.on('library-progress', (event, progress) => callback(progress)),
  onGameLog: (callback) => ipcRenderer.on('game-log', (event, log) => callback(log)),
  onGameClosed: (callback) => ipcRenderer.on('game-closed', (event, code) => callback(code))
});
