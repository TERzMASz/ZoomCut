'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('zoomcutDesktop', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  project: {
    save: (document) => ipcRenderer.invoke('project:save', document),
    open: () => ipcRenderer.invoke('project:open'),
    autosave: (document) => ipcRenderer.invoke('project:autosave', document),
    recovery: () => ipcRenderer.invoke('project:recovery'),
    clearRecovery: () => ipcRenderer.invoke('project:clear-recovery'),
    resetCurrent: () => ipcRenderer.invoke('project:reset-current'),
    registerProjectPath: (filePath) => ipcRenderer.invoke('media:register-project-path', filePath),
    persistAsset: (arrayBuffer, extension) => ipcRenderer.invoke('media:persist', arrayBuffer, extension),
    registerRecording: (base) => ipcRenderer.invoke('media:register-recording', base),
    chooseReplacement: (name) => ipcRenderer.invoke('media:choose-replacement', name),
  },
  export: {
    choosePath: (suggestedName) => ipcRenderer.invoke('export:choose-path', suggestedName),
  },
  system: {
    permissions: () => ipcRenderer.invoke('system:permissions'),
    openPrivacy: (pane) => ipcRenderer.invoke('system:open-privacy', pane),
    recordingIndicator: (active) => ipcRenderer.invoke('system:recording-indicator', Boolean(active)),
  },
});
