'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const MAX_EXPORT_CHUNK_BYTES = 32 * 1024 * 1024;

function appendExportChunk(sessionId, arrayBuffer) {
  if (Object.prototype.toString.call(arrayBuffer) !== '[object ArrayBuffer]') return Promise.reject(new Error('Export chunk must be an ArrayBuffer'));
  if (arrayBuffer.byteLength > MAX_EXPORT_CHUNK_BYTES) return Promise.reject(new Error('Export chunk exceeds size limit'));
  return ipcRenderer.invoke('export:append', sessionId, arrayBuffer);
}

function appendMediaChunk(sessionId, arrayBuffer) {
  if (Object.prototype.toString.call(arrayBuffer) !== '[object ArrayBuffer]') return Promise.reject(new Error('Recorded media chunk must be an ArrayBuffer'));
  if (arrayBuffer.byteLength > MAX_EXPORT_CHUNK_BYTES) return Promise.reject(new Error('Recorded media chunk exceeds size limit'));
  return ipcRenderer.invoke('media:append-stream', sessionId, arrayBuffer);
}

function persistMediaAsset(arrayBuffer, extension) {
  if (Object.prototype.toString.call(arrayBuffer) !== '[object ArrayBuffer]') return Promise.reject(new Error('Recorded media asset must be an ArrayBuffer'));
  if (arrayBuffer.byteLength > MAX_EXPORT_CHUNK_BYTES) return Promise.reject(new Error('Recorded media asset exceeds direct-write size limit'));
  return ipcRenderer.invoke('media:persist', arrayBuffer, extension);
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
    persistAsset: persistMediaAsset,
    beginStream: (extension) => ipcRenderer.invoke('media:begin-stream', extension),
    appendStream: appendMediaChunk,
    finishStream: (sessionId) => ipcRenderer.invoke('media:finish-stream', sessionId),
    cancelStream: (sessionId) => ipcRenderer.invoke('media:cancel-stream', sessionId),
    registerRecording: (base) => ipcRenderer.invoke('media:register-recording', base),
    chooseReplacement: (name) => ipcRenderer.invoke('media:choose-replacement', name),
    authorizeFile: (file) => ipcRenderer.invoke('media:authorize-user-file', webUtils.getPathForFile(file)),
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
    requestMediaAccess: (kind) => ipcRenderer.invoke('system:request-media-access', kind),
    openPrivacy: (pane) => ipcRenderer.invoke('system:open-privacy', pane),
    recordingIndicator: (active) => ipcRenderer.invoke('system:recording-indicator', Boolean(active)),
    stopRecording: () => ipcRenderer.invoke('system:stop-recording'),
    respondClose: (payload) => {
      if (!payload || typeof payload !== 'object' || !['save', 'discard', 'cancel'].includes(payload.decision)) return Promise.reject(new Error('Invalid close decision'));
      return ipcRenderer.invoke('window:close-response', { requestId: String(payload.requestId || ''), decision: payload.decision });
    },
    onCloseRequest: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('window:close-request', listener);
      return () => ipcRenderer.removeListener('window:close-request', listener);
    },
    onRecordingStopped: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('recording:stopped', listener);
      return () => ipcRenderer.removeListener('recording:stopped', listener);
    },
  },
});
