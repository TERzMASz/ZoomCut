'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const MAX_EXPORT_CHUNK_BYTES = 32 * 1024 * 1024;

function appendExportChunk(sessionId, arrayBuffer) {
  if (Object.prototype.toString.call(arrayBuffer) !== '[object ArrayBuffer]') return Promise.reject(new Error('Export chunk must be an ArrayBuffer'));
  if (arrayBuffer.byteLength > MAX_EXPORT_CHUNK_BYTES) return Promise.reject(new Error('Export chunk exceeds size limit'));
  return ipcRenderer.invoke('export:append', sessionId, arrayBuffer);
}

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
    begin: (options) => ipcRenderer.invoke('export:begin', options),
    append: appendExportChunk,
    finish: (sessionId) => ipcRenderer.invoke('export:finish', sessionId),
    cancel: (sessionId) => ipcRenderer.invoke('export:cancel', sessionId),
  },
  system: {
    permissions: () => ipcRenderer.invoke('system:permissions'),
    openPrivacy: (pane) => ipcRenderer.invoke('system:open-privacy', pane),
    recordingIndicator: (active) => ipcRenderer.invoke('system:recording-indicator', Boolean(active)),
  },
});
