// ZoomCut Electron — main process
// เปิด HTTP server ในตัว (server.js) แล้วโหลด index.html ผ่าน localhost
// ทำให้ renderer (ตัวแก้ไข) ใช้โค้ดเดิมได้ทั้งดุ้น ไม่ต้องแก้
const { app, BrowserWindow, shell, systemPreferences, dialog } = require('electron');
const path = require('path');
const { startServer } = require('./server');

let mainWindow = null;
let serverInfo = null;

function webRoot() {
  // dev: โฟลเดอร์โปรเจกต์ (มี index.html), packaged: ภายใน app
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
}

async function createWindow() {
  serverInfo = await startServer({
    webRoot: webRoot(),
    recordingsDir: path.join(app.getPath('userData'), 'recordings'),
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
    },
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!serverInfo || url !== `http://127.0.0.1:${serverInfo.port}/`) event.preventDefault();
  });

  // เปิดลิงก์ภายนอกในเบราว์เซอร์ระบบ
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverInfo.port}/`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
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
app.on('window-all-closed', () => { app.quit(); });
