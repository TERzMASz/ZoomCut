// ZoomCut Electron — main process
// เปิด HTTP server ในตัว (server.js) แล้วโหลด index.html ผ่าน localhost
// ทำให้ renderer (ตัวแก้ไข) ใช้โค้ดเดิมได้ทั้งดุ้น ไม่ต้องแก้
const { app, BrowserWindow, shell, systemPreferences, dialog, ipcMain, session, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer, stopRecording, recordState } = require('./server');
const { createProjectStore, projectMediaPaths } = require('./project-store');

let mainWindow = null;
let serverInfo = null;
let projectStore = null;
let ipcReady = false;
let recordingTray = null;
let recordingTrayTimer = null;
let nativeStopPromise = null;
let closeRequestId = null;
let closeInFlight = false;
const RECORDING_SHORTCUT = process.platform === 'darwin' ? 'Control+Command+S' : 'Control+Shift+S';
const authorizedMediaPaths = new Set();
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4a', '.mp3', '.wav', '.ogg']);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function validMediaPath(filePath) {
  try {
    const resolved = path.resolve(String(filePath || ''));
    return MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase()) && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch { return false; }
}

function authorizeProjectMedia(result) {
  authorizedMediaPaths.clear();
  for (const filePath of result?.document ? projectMediaPaths(result.document) : []) {
    if (validMediaPath(filePath)) authorizedMediaPaths.add(path.resolve(filePath));
  }
  return result;
}

async function stopRecordingFromMain() {
  if (nativeStopPromise) return nativeStopPromise;
  clearInterval(recordingTrayTimer);
  recordingTrayTimer = null;
  recordingTray?.setTitle('● Finishing…');
  recordingTray?.setToolTip('ZoomCut is finishing the recording');
  nativeStopPromise = Promise.resolve(stopRecording())
    .catch(error => console.error('[ZoomCut] Stop recording failed:', error))
    .finally(() => {
      nativeStopPromise = null;
      showRecordingIndicator(false);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording:stopped');
    });
  return nativeStopPromise;
}

function showRecordingIndicator(active) {
  if (!active) {
    clearInterval(recordingTrayTimer);
    recordingTrayTimer = null;
    if (recordingTray) recordingTray.destroy();
    recordingTray = null;
    if (globalShortcut.isRegistered(RECORDING_SHORTCUT)) globalShortcut.unregister(RECORDING_SHORTCUT);
    return;
  }
  if (recordingTray) return;
  globalShortcut.register(RECORDING_SHORTCUT, () => { stopRecordingFromMain(); });
  recordingTray = new Tray(nativeImage.createEmpty());
  const startedAt = Date.now();
  const refresh = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    recordingTray?.setTitle(`● REC ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
  };
  recordingTray.setToolTip('ZoomCut is recording');
  recordingTray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Stop Recording', click: () => { stopRecordingFromMain(); } },
    { label: 'Show ZoomCut', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
  ]));
  refresh();
  recordingTrayTimer = setInterval(refresh, 1000);
}

async function cleanupBeforeWindowClose() {
  // Keep close deterministic: a recording is finalized and transient export/
  // asset sessions are cancelled before Electron is allowed to tear down.
  await Promise.allSettled([
    stopRecordingFromMain(),
    Promise.resolve(serverInfo?.exportSessions?.cancelAll()),
    Promise.resolve(projectStore?.cancelAllAssets()),
  ]);
  showRecordingIndicator(false);
  globalShortcut.unregisterAll();
  const server = serverInfo?.server;
  if (server?.listening) {
    // app.exit() deliberately skips Electron's normal quit lifecycle. Close
    // the localhost listener explicitly so no Node handle survives shutdown.
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
  }
}

function webRoot() {
  // dev: โฟลเดอร์โปรเจกต์ (มี index.html), packaged: ภายใน app
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
}

function isTrustedRenderer(webContents) {
  if (!mainWindow || !serverInfo || webContents !== mainWindow.webContents) return false;
  try {
    return new URL(webContents.getURL()).origin === `http://127.0.0.1:${serverInfo.port}`;
  } catch {
    return false;
  }
}

async function createWindow() {
  serverInfo = await startServer({
    webRoot: webRoot(),
    recordingsDir: path.join(app.getPath('userData'), 'recordings'),
    exportRecoveryDir: path.join(app.getPath('userData'), 'export-recovery'),
    port: 0,
  });

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0e12',
    title: 'ZoomCut',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = serverInfo && url.startsWith(`http://127.0.0.1:${serverInfo.port}/`);
    if (!allowed) event.preventDefault();
  });

  // เปิดลิงก์ภายนอกในเบราว์เซอร์ระบบ
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' };
  });

  projectStore = createProjectStore({ userData: app.getPath('userData'), dialog });
  if (!ipcReady) {
    ipcReady = true;
    const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || !isTrustedRenderer(event.sender)) throw new Error('Untrusted IPC sender');
      return fn(...args);
    });
    handle('project:save', (document) => projectStore.save(document));
    handle('project:open', async () => authorizeProjectMedia(await projectStore.open()));
    handle('project:autosave', (document) => projectStore.autosave(document));
    handle('project:recovery', () => authorizeProjectMedia(projectStore.recovery()));
    handle('project:clear-recovery', () => projectStore.clearRecovery());
    handle('project:reset-current', () => { authorizedMediaPaths.clear(); return projectStore.resetCurrent(); });
    handle('media:register-project-path', (filePath) => {
      const resolved = path.resolve(String(filePath || ''));
      if (!authorizedMediaPaths.has(resolved) || !validMediaPath(resolved)) throw new Error('Media path is not authorized by the opened project');
      return serverInfo.registerMediaPath(resolved);
    });
    handle('media:authorize-user-file', (filePath) => {
      const resolved = path.resolve(String(filePath || ''));
      if (!validMediaPath(resolved)) throw new Error('Selected media file is not a supported media type');
      authorizedMediaPaths.add(resolved);
      return { ok: true };
    });
    handle('media:register-recording', (base) => {
      const safeBase = path.basename(String(base || '')).replace(/[^a-zA-Z0-9_.-]/g, '');
      const result = serverInfo.registerMediaPath(path.join(serverInfo.recordingsDir, safeBase + '.mp4'));
      const clicksPath = path.join(serverInfo.recordingsDir, safeBase + '.clicks.json');
      if (fs.existsSync(clicksPath)) result.clicksUrl = serverInfo.registerMediaPath(clicksPath).url;
      return result;
    });
    handle('media:persist', (arrayBuffer, extension) => {
      if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength > 32 * 1024 * 1024) throw new Error('Invalid direct media asset');
      const filePath = projectStore.persistAsset(Buffer.from(arrayBuffer), extension);
      authorizedMediaPaths.add(path.resolve(filePath));
      return serverInfo.registerMediaPath(filePath);
    });
    handle('media:begin-stream', (extension) => projectStore.beginAsset(extension));
    handle('media:append-stream', (sessionId, arrayBuffer) => projectStore.appendAsset(sessionId, arrayBuffer));
    handle('media:finish-stream', async (sessionId) => {
      const filePath = await projectStore.finishAsset(sessionId);
      authorizedMediaPaths.add(path.resolve(filePath));
      return serverInfo.registerMediaPath(filePath);
    });
    handle('media:cancel-stream', (sessionId) => projectStore.cancelAsset(sessionId));
    handle('media:choose-replacement', async (name) => {
      const result = await dialog.showOpenDialog({
        title: `Locate ${String(name || 'media file')}`,
        properties: ['openFile'],
        filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'webm', 'm4a', 'mp3', 'wav', 'ogg'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      authorizedMediaPaths.add(path.resolve(result.filePaths[0]));
      return { canceled: false, ...serverInfo.registerMediaPath(result.filePaths[0]) };
    });
    handle('export:choose-path', async (suggestedName) => {
      const result = await dialog.showSaveDialog({
        title: 'Export ZoomCut Video',
        defaultPath: String(suggestedName || 'zoomcut-export.mp4'),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const filePath = result.filePath.endsWith('.mp4') ? result.filePath : result.filePath + '.mp4';
      return { canceled: false, ...serverInfo.registerExportTarget(filePath) };
    });
    handle('export:begin', (options = {}) => {
      const plan = options.audioPlan;
      if (plan && (!Array.isArray(plan.clips) || plan.clips.length > 256)) throw new Error('Invalid export audio plan');
      if (plan?.base && (!Array.isArray(plan.base.segments) || plan.base.segments.length > 1000)) throw new Error('Invalid base audio plan');
      for (const item of [plan?.base, ...(plan?.clips || [])]) {
        if (!item?.path) continue;
        const resolved = path.resolve(item.path);
        if (!authorizedMediaPaths.has(resolved)) throw new Error('Export audio source is not authorized');
        item.path = resolved;
      }
      return serverInfo.exportSessions.begin(options);
    });
    handle('export:append', (sessionId, arrayBuffer) => serverInfo.exportSessions.append(sessionId, arrayBuffer));
    handle('export:finish', (sessionId) => serverInfo.exportSessions.finish(sessionId));
    handle('export:cancel', (sessionId) => serverInfo.exportSessions.cancel(sessionId));
    handle('system:permissions', () => ({
      screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
      microphone: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
      camera: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('camera') : 'granted',
      accessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    }));
    handle('system:request-media-access', async (kind) => {
      const type = String(kind || '');
      if (!['microphone', 'camera'].includes(type)) throw new Error('Invalid media permission type');
      if (process.platform !== 'darwin') return true;
      return systemPreferences.askForMediaAccess(type);
    });
    handle('system:open-privacy', (pane) => {
      const pages = {
        screen: 'Privacy_ScreenCapture', microphone: 'Privacy_Microphone', camera: 'Privacy_Camera',
        accessibility: 'Privacy_Accessibility', input: 'Privacy_ListenEvent',
      };
      const page = pages[pane] || pages.screen;
      return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${page}`);
    });
    handle('system:recording-indicator', (active) => { showRecordingIndicator(active); return { ok: true }; });
    handle('system:stop-recording', () => stopRecordingFromMain().then(() => ({ ok: true })));
    handle('window:close-response', async (payload = {}) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid close payload');
      if (!closeRequestId || payload.requestId !== closeRequestId) throw new Error('Stale close request');
      if (!['save', 'discard', 'cancel'].includes(payload.decision)) throw new Error('Invalid close decision');
      const decision = payload.decision;
      closeRequestId = null;
      if (decision === 'cancel') return { ok: true, closed: false };
      closeInFlight = true;
      try {
        await cleanupBeforeWindowClose();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        // The close event is intercepted to show the renderer prompt. All
        // cleanup has completed above, so exit deterministically after the
        // user decision instead of leaving a headless macOS process behind.
        app.exit(0);
        return { ok: true, closed: true };
      } finally {
        closeInFlight = false;
      }
    });
  }

  mainWindow.loadURL(`http://127.0.0.1:${serverInfo.port}/?token=${serverInfo.apiToken}`);
  mainWindow.on('unresponsive', () => {
    const recording = recordState();
    if (!recording.running && !recording.processing) return;
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'ZoomCut is not responding',
      message: 'The editor is not responding while a screen recording is active.',
      detail: 'You can stop safely from this native dialog. ZoomCut will finish and preserve the recording.',
      buttons: ['Stop Recording', 'Keep Waiting'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => { if (response === 0) stopRecordingFromMain(); });
  });
  mainWindow.on('close', (event) => {
    if (closeInFlight) return;
    event.preventDefault();
    if (closeRequestId) return;
    closeRequestId = crypto.randomBytes(12).toString('hex');
    mainWindow.webContents.send('window:close-request', { requestId: closeRequestId });
  });
  mainWindow.on('closed', () => { mainWindow = null; closeRequestId = null; });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return isTrustedRenderer(webContents) && ['media', 'display-capture'].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(Boolean(isTrustedRenderer(webContents) && ['media', 'display-capture'].includes(permission)));
  });
  // แจ้งสถานะสิทธิ์ Screen Recording (จอ) — ไม่บล็อก แค่เปิดหน้า settings ให้ถ้ายังไม่ได้
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      // การอัดครั้งแรกจะทริกเกอร์ prompt เอง — ปุ่มนี้แค่ช่วยลัดไปตั้งค่า
      console.log('[ZoomCut] Screen Recording permission:', status);
    }
  }
  await createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// ปิดแอปจริงเมื่อปิดหน้าต่าง (รวม macOS ด้วย) — เพื่อให้เปิดใหม่แล้วอ่านสิทธิ์ล่าสุด
// ไม่งั้นโปรเซสค้างด้วยสถานะสิทธิ์เดิม ทำให้ "ให้สิทธิ์แล้วแต่ยังอัดไม่ได้"
app.on('window-all-closed', () => {
  Promise.allSettled([
    stopRecordingFromMain(),
    Promise.resolve(serverInfo?.exportSessions?.cancelAll()),
    Promise.resolve(projectStore?.cancelAllAssets()),
  ]).finally(() => app.quit());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
