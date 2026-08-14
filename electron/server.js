// ZoomCut core — HTTP server + recording (พอร์ตจาก serve.py + record.py มาเป็น Node)
// รันในตัว Electron หรือรันเดี่ยวเพื่อทดสอบก็ได้ (node electron/server.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { createApiToken, safeStaticPath, readJsonBody, streamRequestToFile, normalizeRecordingOptions } = require('./security');
const { createExportSessionManager } = require('./export-session');
const { parseOrientation, createTouchParser } = require('./android-tracking');

// แอป GUI (เปิดจาก Finder) มี PATH จำกัด ไม่รวม /opt/homebrew/bin → ต้องระบุ path ให้ชัด
function platformKey() {
  const p = process.platform === 'darwin' ? 'darwin' : process.platform;
  const a = process.arch === 'arm64' ? 'arm64' : process.arch;
  return `${p}-${a}`;
}
function bundledBin(name) {
  const base = process.resourcesPath || path.join(__dirname, '..', 'resources');
  return path.join(base, 'bin', platformKey(), name);
}
function localResourceBin(name) {
  return path.join(__dirname, '..', 'resources', 'bin', platformKey(), name);
}
function resolveBin(name, candidates) {
  for (const c of [bundledBin(name), localResourceBin(name), ...candidates]) { try { if (fs.existsSync(c)) return c; } catch {} }
  return name; // สุดท้ายพึ่ง PATH
}
const OSASCRIPT = '/usr/bin/osascript';
const SCREENCAPTURE = '/usr/sbin/screencapture';
const FFMPEG = resolveBin('ffmpeg', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
const FFPROBE = resolveBin('ffprobe', ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']);
const ADB = resolveBin('adb', ['/opt/homebrew/bin/adb', '/usr/local/bin/adb', path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb')]);
const SCRCPY = resolveBin('scrcpy', ['/opt/homebrew/bin/scrcpy', '/usr/local/bin/scrcpy']);
// PATH เสริมสำหรับ child process ทุกตัว
const BIN_DIR = path.dirname(ADB !== 'adb' ? ADB : localResourceBin('adb'));
const SCRCPY_SERVER = fs.existsSync(path.join(path.dirname(SCRCPY), 'scrcpy-server')) ? path.join(path.dirname(SCRCPY), 'scrcpy-server') : process.env.SCRCPY_SERVER_PATH;
const CHILD_ENV = {
  ...process.env,
  PATH: [BIN_DIR, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(':'),
  DYLD_LIBRARY_PATH: [path.join(path.dirname(SCRCPY), 'lib'), process.env.DYLD_LIBRARY_PATH || ''].filter(Boolean).join(':'),
};
if (SCRCPY_SERVER) CHILD_ENV.SCRCPY_SERVER_PATH = SCRCPY_SERVER;

// ---------- utilities ----------
// สำคัญ: ฝัง JXA เป็นสตริงส่งตรงให้ osascript (-e) แทนการอ้างไฟล์
// เพราะในแอปที่แพ็ก (asar) โปรเซสภายนอกอย่าง osascript อ่านไฟล์ในแอปไม่ได้
const JXA_WINDOWS = `
ObjC.import('CoreGraphics'); ObjC.import('Foundation');
var opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
var arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID));
var n = arr.count, out = [];
function numOf(d,k){var v=d.objectForKey(k);return v&&!v.isNil()?v.doubleValue:null;}
function strOf(d,k){var v=d.objectForKey(k);return v&&!v.isNil()?ObjC.unwrap(v):'';}
for (var i=0;i<n;i++){
  var d = arr.objectAtIndex(i);
  var b = d.objectForKey('kCGWindowBounds'), bounds=null;
  if(b&&!b.isNil()){bounds={x:b.objectForKey('X').doubleValue,y:b.objectForKey('Y').doubleValue,w:b.objectForKey('Width').doubleValue,h:b.objectForKey('Height').doubleValue};}
  out.push({id:numOf(d,'kCGWindowNumber'),pid:numOf(d,'kCGWindowOwnerPID'),layer:numOf(d,'kCGWindowLayer'),owner:strOf(d,'kCGWindowOwnerName'),title:strOf(d,'kCGWindowName'),bounds:bounds});
}
JSON.stringify(out);`;

const JXA_DISPLAYS = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('Foundation');
var mainId = $.CGMainDisplayID();
var screens = $.NSScreen.screens, n = screens.count, out = [];
for (var i=0;i<n;i++){
  var s = screens.objectAtIndex(i);
  var did = s.deviceDescription.objectForKey('NSScreenNumber').unsignedIntValue;
  var b = $.CGDisplayBounds(did);
  out.push({displayId:did,isMain:did===mainId,name:ObjC.unwrap(s.localizedName),x:b.origin.x,y:b.origin.y,w:b.size.width,h:b.size.height});
}
JSON.stringify(out);`;

const DEBUG_LOG = path.join(os.tmpdir(), 'zoomcut-debug.log');
function dbg(msg) { try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {} }

function runJxa(script) {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', script], { maxBuffer: 8 * 1024 * 1024, env: CHILD_ENV, timeout: 6000 }, (err, stdout, stderr) => {
      if (err) { dbg(`osascript error: ${err.message} | stderr: ${stderr}`); return resolve([]); }
      try { resolve(JSON.parse(stdout)); } catch (e) { dbg(`JSON parse fail: ${e.message} | stdout head: ${String(stdout).slice(0, 200)}`); resolve([]); }
    });
  });
}
const jxaListWindows = () => runJxa(JXA_WINDOWS);

function buildScreencaptureArgs({ screenIndex, windowId }, outputPath) {
  if (screenIndex) return ['-v', '-C', '-D', String(screenIndex), outputPath];
  // CGWindow bounds exclude the shadow. Keep the captured frame identical so normalized clicks map exactly.
  return ['-v', '-C', '-o', '-l', String(windowId), outputPath];
}

async function listDisplays() {
  const raw = await runJxa(JXA_DISPLAYS);
  // จัดลำดับ: จอหลักก่อน แล้ว index = ตำแหน่ง+1 (ตรงกับ screencapture -D)
  const sorted = raw.slice().sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0));
  return sorted.map((d, i) => ({
    index: i + 1, displayId: d.displayId, name: d.name, isMain: d.isMain,
    x: d.x, y: d.y, w: Math.round(d.w), h: Math.round(d.h),
  }));
}

const SKIP_APPS = new Set(['Window Server', 'Dock', 'Control Center', 'Notification Center',
  'Spotlight', 'Wallpaper', 'Screenshot', 'ZoomCut']);

async function listRecordableWindows() {
  const wins = await jxaListWindows();
  return wins
    .filter((w) => w.layer === 0 && w.bounds && w.bounds.w > 300 && w.bounds.h > 200 && !SKIP_APPS.has(w.owner))
    .map((w) => ({ id: w.id, app: w.owner, title: w.title, w: Math.round(w.bounds.w), h: Math.round(w.bounds.h) }));
}

async function findWindowById(wid) {
  const wins = await jxaListWindows();
  const w = wins.find((x) => x.id === wid);
  return w ? w.bounds : null;
}
async function findMirrorWindow() {
  const wins = await jxaListWindows();
  const w = wins.find((x) => (x.owner || '').toLowerCase().includes('iphone') && x.bounds && x.bounds.w > 200 && x.bounds.h > 300);
  return w ? { id: w.id, bounds: w.bounds } : null;
}
function appHasWindows(wins, pid) {
  return wins.some((w) => w.pid === pid && w.bounds && w.bounds.w > 100 && w.bounds.h > 100);
}
function focusProcess(pid) {
  if (!pid || process.platform !== 'darwin') return Promise.resolve(false);
  const script = `
ObjC.import('AppKit');
var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)});
app ? app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps) : false;`;
  return runJxa(script).then(() => true).catch(() => false);
}
async function focusWindowBeforeRecording(pid) {
  if (!pid) return;
  await focusProcess(pid);
  await new Promise((r) => setTimeout(r, 450));
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { env: CHILD_ENV },
      (err, out) => resolve(err ? null : parseFloat(String(out).trim()) || null));
  });
}
function ffprobeCodec(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { env: CHILD_ENV },
      (err, out) => resolve(err ? '' : String(out).trim()));
  });
}
function binStatus(name, bin, args = ['-version']) {
  return new Promise((resolve) => {
    execFile(bin, args, { env: CHILD_ENV, timeout: 3000 }, (err, stdout, stderr) => {
      resolve({
        name,
        path: bin,
        ok: !err,
        detail: err ? (stderr || err.message).trim() : String(stdout || stderr).split('\n')[0].trim(),
      });
    });
  });
}
function adbArgs(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}
function execAdb(serial, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(ADB, adbArgs(serial, args), { env: CHILD_ENV, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && err.message });
    });
  });
}
async function listAndroidDevices() {
  if (!fs.existsSync(ADB) && ADB === 'adb') return [];
  const r = await execAdb(null, ['devices', '-l'], 5000);
  if (!r.ok) return [];
  return r.stdout.split('\n').slice(1).map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      const model = (line.match(/\bmodel:([^\s]+)/) || [])[1] || '';
      const product = (line.match(/\bproduct:([^\s]+)/) || [])[1] || '';
      return { serial, state, model, product };
    })
    .filter((d) => d.state === 'device');
}
async function androidScreenSize(serial) {
  const r = await execAdb(serial, ['shell', 'wm', 'size'], 5000);
  const m = r.stdout.match(/Physical size:\s*(\d+)x(\d+)/) || r.stdout.match(/Override size:\s*(\d+)x(\d+)/);
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 1080, h: 1920 };
}
async function androidOrientation(serial) {
  const result = await execAdb(serial, ['shell', 'dumpsys', 'input'], 5000);
  return result.ok ? parseOrientation(result.stdout) : 0;
}
async function androidTouchDevice(serial) {
  const r = await execAdb(serial, ['shell', 'getevent', '-lp'], 7000);
  if (!r.ok) return null;
  const blocks = r.stdout.split(/\n(?=add device )/);
  for (const block of blocks) {
    if (!block.includes('ABS_MT_POSITION_X') || !block.includes('ABS_MT_POSITION_Y')) continue;
    const device = (block.match(/add device \d+:\s+([^\n]+)/) || [])[1]?.trim();
    const xMax = parseInt((block.match(/ABS_MT_POSITION_X\s+:\s+value\s+\d+,\s+min\s+\d+,\s+max\s+(\d+)/) || [])[1] || '0', 10);
    const yMax = parseInt((block.match(/ABS_MT_POSITION_Y\s+:\s+value\s+\d+,\s+min\s+\d+,\s+max\s+(\d+)/) || [])[1] || '0', 10);
    if (device && xMax && yMax) return { device, xMax, yMax };
  }
  return null;
}
async function diagnostics() {
  const hookAvailable = inputHookAvailable();
  const [ffmpeg, ffprobe, adb, scrcpy, osascript, displays, windows, androidDevices] = await Promise.all([
    binStatus('ffmpeg', FFMPEG),
    binStatus('ffprobe', FFPROBE),
    binStatus('adb', ADB, ['version']),
    binStatus('scrcpy', SCRCPY, ['--version']),
    binStatus('osascript', OSASCRIPT, ['-e', '1']),
    listDisplays().catch((e) => ({ error: e.message })),
    listRecordableWindows().catch((e) => ({ error: e.message })),
    listAndroidDevices().catch(() => []),
  ]);
  const screencapture = {
    name: 'screencapture',
    path: SCREENCAPTURE,
    ok: fs.existsSync(SCREENCAPTURE),
    detail: fs.existsSync(SCREENCAPTURE) ? 'พร้อมเรียก macOS screencapture' : 'ไม่พบ screencapture',
  };
  const scrcpyServer = {
    name: 'scrcpy-server',
    path: SCRCPY_SERVER || '',
    ok: Boolean(SCRCPY_SERVER && fs.existsSync(SCRCPY_SERVER) && fs.statSync(SCRCPY_SERVER).size > 0),
    detail: SCRCPY_SERVER ? 'Bundled Android server payload' : 'scrcpy-server not found',
  };
  return {
    ok: true,
    app: 'ZoomCut',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    debugLog: DEBUG_LOG,
    bins: { ffmpeg, ffprobe, adb, scrcpy, scrcpyServer, screencapture, osascript },
    uiohook: {
      ok: hookAvailable,
      running: rec.hookRunning,
      detail: !hookAvailable ? 'โหลด uiohook-napi ไม่ได้ — อัดวิดีโอได้ แต่อาจไม่มี auto zoom จากคลิก' : 'พร้อมจับคลิกผ่าน worker แยกเมื่อเริ่มอัด',
    },
    permissions: {
      screenRecording: process.platform === 'darwin' ? 'macOS จะยืนยันตอนเริ่มอัดจริง' : 'not_applicable',
      inputMonitoring: process.platform === 'darwin' ? 'ต้องอนุญาตให้จับคลิก/คีย์ลัดได้' : 'not_applicable',
    },
    sources: {
      displays: Array.isArray(displays) ? displays.length : 0,
      windows: Array.isArray(windows) ? windows.length : 0,
      android: Array.isArray(androidDevices) ? androidDevices.length : 0,
      displaysError: displays && displays.error,
      windowsError: windows && windows.error,
    },
  };
}

// ---------- optional global input hook (จับคลิกทั้งจอ) ----------
// Native hook อยู่ใน worker แยก เพื่อไม่ให้ Electron main/API ค้างตามหาก hook มีปัญหา
const INPUT_HOOK_WORKER = path.join(__dirname, 'input-hook-worker.js');
function inputHookAvailable() {
  try { require.resolve('uiohook-napi'); return true; } catch { return false; }
}

// ---------- recording state ----------
const rec = {
  active: false, processing: false, mode: null, wid: null, ownerPid: null, base: null, startedAt: null,
  proc: null, touchProc: null, mirrorProc: null, hookProc: null, remotePath: null, androidSerial: null, clicks: [], bounds: null, boundsTimer: null,
  boundsRefreshRunning: false,
  androidTimer: null, androidOrientation: 0, androidConnected: true, trackingError: null,
  finished: false, error: null, hookRunning: false, capStderr: '', ffmpegError: '',
};

function resetRec() {
  Object.assign(rec, { active: false, processing: false, mode: null, wid: null, ownerPid: null, base: null, startedAt: null,
    proc: null, touchProc: null, mirrorProc: null, hookProc: null, remotePath: null, androidSerial: null, clicks: [], bounds: null,
    boundsRefreshRunning: false,
    androidTimer: null, androidOrientation: 0, androidConnected: true, trackingError: null,
    finished: false, error: null, hookRunning: false, capStderr: '', ffmpegError: '' });
}

async function startRecording(recordingsDir, opts) {
  if (rec.active) throw new Error('กำลังอัดอยู่แล้ว');
  resetRec();
  dbg(`record/start opts=${JSON.stringify(opts || {})}`);
  fs.mkdirSync(recordingsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = path.join(recordingsDir, `recording-${stamp}`);
  if (opts && opts.androidSerial) return startAndroidRecording(base, opts.androidSerial);
  const outMov = base + '.mov';

  // เลือกเป้าหมาย: ทั้งจอ (screenIndex) | หน้าต่าง (windowId) | iPhone (ค่าเริ่มต้น)
  let capArgs;
  if (opts && opts.screenIndex) {
    const displays = await listDisplays();
    const d = displays.find((x) => x.index === opts.screenIndex);
    if (!d) throw new Error(`ไม่พบจอ #${opts.screenIndex}`);
    rec.mode = 'display';
    rec.bounds = { x: d.x, y: d.y, w: d.w, h: d.h };
    capArgs = buildScreencaptureArgs({ screenIndex: d.index }, outMov);
  } else {
    let wid = opts && opts.windowId;
    if (wid) {
      rec.bounds = await findWindowById(wid);
      if (!rec.bounds) throw new Error(`ไม่พบหน้าต่าง ID ${wid}`);
    } else {
      let m = await findMirrorWindow();
      if (!m) {
        spawn('/usr/bin/open', ['-a', 'iPhone Mirroring'], { env: CHILD_ENV });
        for (let i = 0; i < 10 && !m; i++) { await new Promise((r) => setTimeout(r, 1000)); m = await findMirrorWindow(); }
        if (!m) throw new Error('ไม่พบหน้าต่าง iPhone Mirroring — เชื่อมต่อ iPhone ก่อน');
      }
      wid = m.id; rec.bounds = m.bounds;
    }
    rec.mode = 'window';
    rec.wid = wid;
    const winsNow = await jxaListWindows();
    rec.ownerPid = (winsNow.find((w) => w.id === wid) || {}).pid || null;
    await focusWindowBeforeRecording(rec.ownerPid);
    capArgs = buildScreencaptureArgs({ windowId: wid }, outMov);
  }

  try { fs.unlinkSync(outMov); } catch {}

  const cap = spawn(SCREENCAPTURE, capArgs, { stdio: ['ignore', 'ignore', 'pipe'], env: CHILD_ENV });
  dbg(`screencapture spawn ${capArgs.join(' ')}`);
  rec.proc = cap;
  rec.base = base;
  rec.active = true;
  rec.startedAt = null; // ตั้งเมื่อยืนยันว่าเริ่มจริง
  cap.stderr.on('data', (buf) => { rec.capStderr += String(buf); });
  cap.on('error', (err) => {
    rec.error = `เริ่มอัดไม่สำเร็จ (${err.message}) — ตรวจว่า macOS อนุญาต Screen Recording แล้วเปิดแอปใหม่`;
    rec.active = false;
  });

  // ยืนยันเริ่มอัดเมื่อ screencapture รันต่อเนื่อง 0.8s (ไฟล์ไม่โผล่ระหว่างอัด)
  const launchedAt = Date.now();
  let capExited = false;
  cap.on('exit', () => { capExited = true; });
  const confirm = setInterval(() => {
    if (!rec.active) { clearInterval(confirm); return; }
    if (capExited && rec.startedAt === null) {
      clearInterval(confirm);
      const detail = rec.capStderr.trim();
      rec.error = 'เริ่มอัดไม่สำเร็จ — เปิด System Settings → Privacy & Security → Screen Recording ให้ ZoomCut แล้วปิด/เปิดแอปใหม่'
        + (detail ? `\n\nรายละเอียดจากระบบ: ${detail}` : '');
      rec.active = false;
      return;
    }
    if (rec.startedAt === null && Date.now() - launchedAt >= 800) {
      clearInterval(confirm);
      rec.startedAt = Date.now();
      startInputHook();
    }
  }, 150);

  // โหมดหน้าต่าง: รีเฟรช bounds กันหน้าต่างถูกย้าย + หยุดเองถ้าแอปถูกปิด
  // โหมดทั้งจอ: bounds คงที่ ไม่ต้องรีเฟรช
  if (rec.mode === 'window') {
    rec.boundsTimer = setInterval(async () => {
      if (!rec.active || rec.boundsRefreshRunning) return;
      rec.boundsRefreshRunning = true;
      try {
        const wins = await jxaListWindows();
        const tracked = wins.find(window => window.id === rec.wid);
        if (tracked?.bounds) rec.bounds = tracked.bounds;
        if (rec.ownerPid && !appHasWindows(wins, rec.ownerPid)) stopRecording().catch(() => {});
      } finally {
        rec.boundsRefreshRunning = false;
      }
    }, 750);
  }

  return { base: path.basename(base) };
}

async function startAndroidRecording(base, serial) {
  const devices = await listAndroidDevices();
  if (!devices.some((d) => d.serial === serial)) throw new Error('ไม่พบ Android device — เปิด USB debugging แล้วเชื่อมต่ออีกครั้ง');
  const touch = await androidTouchDevice(serial);
  const size = await androidScreenSize(serial);
  rec.androidOrientation = await androidOrientation(serial);
  const outMp4 = base + '.mp4';
  rec.mode = 'android';
  rec.base = base;
  rec.androidSerial = serial;
  rec.remotePath = null;
  rec.bounds = { x: 0, y: 0, w: touch?.xMax || size.w, h: touch?.yMax || size.h };
  const args = ['--serial', serial, '--window-title', `ZoomCut Android ${serial}`, '--stay-awake', '--no-audio', `--record=${outMp4}`];
  const cap = spawn(SCRCPY, args, { stdio: ['ignore', 'ignore', 'pipe'], env: CHILD_ENV });
  rec.proc = cap;
  rec.mirrorProc = cap;
  rec.active = true;
  rec.startedAt = Date.now();
  cap.stderr.on('data', (buf) => { rec.capStderr += String(buf); dbg(`scrcpy record: ${String(buf).trim()}`); });
  cap.on('exit', () => {
    if (rec.active) {
      rec.androidConnected = false;
      rec.active = false;
      rec.processing = true;
      clearInterval(rec.androidTimer);
      if (rec.touchProc && rec.touchProc.exitCode === null) try { rec.touchProc.kill('SIGTERM'); } catch {}
      finalizeAndroidRecording(Date.now()).catch(error => { rec.error = error.message; rec.processing = false; });
      dbg('Android scrcpy recorder exited; finalized available partial recording');
    }
  });
  startAndroidTouchTracking(serial, touch);
  rec.androidTimer = setInterval(async () => {
    if (!rec.active) return;
    const connected = (await listAndroidDevices()).some(device => device.serial === serial);
    rec.androidConnected = connected;
    if (!connected) return;
    rec.androidOrientation = await androidOrientation(serial);
    if ((!rec.touchProc || rec.touchProc.exitCode !== null) && !rec.trackingError) startAndroidTouchTracking(serial, touch);
  }, 1500);
  dbg(`android scrcpy record serial=${serial} output=${outMp4} touch=${touch ? touch.device : 'auto'}`);
  return { base: path.basename(base) };
}

function startAndroidTouchTracking(serial, touch) {
  const args = touch?.device ? ['shell', 'getevent', '-lt', touch.device] : ['shell', 'getevent', '-lt'];
  const proc = spawn(ADB, adbArgs(serial, args), { stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV });
  rec.touchProc = proc;
  let buf = '';
  const xMax = touch?.xMax || rec.bounds.w || 1;
  const yMax = touch?.yMax || rec.bounds.h || 1;
  const parse = createTouchParser({ xMax, yMax, orientation: () => rec.androidOrientation,
    onTouch: point => rec.clicks.push({ wall: Date.now(), ...point }) });
  proc.stdout.on('data', (chunk) => {
    buf += String(chunk);
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    lines.forEach(parse);
  });
  proc.stderr.on('data', (chunk) => {
    const detail = String(chunk).trim();
    if (/permission denied|not permitted/i.test(detail)) rec.trackingError = 'Android does not permit raw touch tracking on this device';
    dbg(`android getevent stderr: ${detail}`);
  });
  proc.on('error', (e) => dbg(`android getevent failed: ${e.message}`));
}

function startInputHook() {
  if (!inputHookAvailable() || rec.hookProc) {
    if (!inputHookAvailable()) dbg('uiohook-napi unavailable: click tracking disabled');
    return;
  }
  const proc = spawn(process.execPath, [INPUT_HOOK_WORKER], {
    env: { ...CHILD_ENV, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  rec.hookProc = proc;
  proc.on('message', message => {
    if (message?.type === 'ready') {
      rec.hookRunning = true;
      dbg(`input hook worker ready pid=${proc.pid}`);
      return;
    }
    if (message?.type === 'mousedown' && rec.active && rec.startedAt !== null && rec.bounds) {
      const b = rec.bounds;
      const x = message.x, y = message.y;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        rec.clicks.push({ wall: message.wall || Date.now(), x: (x - b.x) / b.w, y: (y - b.y) / b.h });
      }
      return;
    }
    if (message?.type === 'stop-request') stopRecording().catch(() => {});
    if (message?.type === 'error') {
      rec.trackingError = `Click tracking unavailable: ${message.error}`;
      dbg(`input hook worker error: ${message.error}`);
    }
  });
  proc.stderr.on('data', chunk => dbg(`input hook worker stderr: ${String(chunk).trim()}`));
  proc.on('error', error => {
    rec.trackingError = `Click tracking worker failed: ${error.message}`;
    dbg(rec.trackingError);
  });
  proc.on('exit', (code, signal) => {
    if (rec.hookProc !== proc) return;
    rec.hookProc = null;
    rec.hookRunning = false;
    if (rec.active && code !== 0) rec.trackingError = `Click tracking worker stopped (${signal || code})`;
    dbg(`input hook worker exit code=${code} signal=${signal || ''}`);
  });
}
function stopInputHook() {
  const proc = rec.hookProc;
  rec.hookProc = null;
  rec.hookRunning = false;
  if (!proc || proc.exitCode !== null) return;
  try { proc.send({ type: 'stop' }); } catch {}
  const term = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 250);
  const force = setTimeout(() => { if (proc.exitCode === null) try { proc.kill('SIGKILL'); } catch {} }, 1500);
  term.unref?.(); force.unref?.();
}

async function stopRecording() {
  if (!rec.active) {
    dbg('record/stop ignored (not active)');
    return;
  }
  dbg(`record/stop requested mode=${rec.mode || 'mac'} elapsedMs=${rec.startedAt ? Date.now() - rec.startedAt : 0}`);
  rec.active = false;
  rec.processing = true; // หยุดอัดแล้ว แต่ยังแปลงไฟล์อยู่ (frontend รอต่อ ไม่หยุด poll)
  clearInterval(rec.boundsTimer);
  stopInputHook();
  if (rec.mode === 'android') {
    await stopAndroidRecording();
    dbg(`record/stop finalized mode=android finished=${rec.finished} error=${JSON.stringify(rec.error || '')}`);
    return;
  }
  const stopWall = Date.now();
  const base = rec.base;
  const outMov = base + '.mov';
  const outMp4 = base + '.mp4';

  // ปิด screencapture
  if (rec.proc && rec.proc.exitCode === null) {
    rec.proc.kill('SIGINT');
    await new Promise((r) => { const t = setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch {} r(); }, 15000); rec.proc.on('exit', () => { clearTimeout(t); r(); }); });
  }
  if (!fs.existsSync(outMov) || fs.statSync(outMov).size === 0) {
    rec.error = 'ไม่มีวิดีโอถูกบันทึก — เปิดสิทธิ์ Screen Recording ให้ ZoomCut แล้วปิด/เปิดแอปใหม่'
      + (rec.capStderr.trim() ? `\n\nรายละเอียดจากระบบ: ${rec.capStderr.trim()}` : '');
    rec.processing = false;
    dbg(`record/stop failed before remux error=${JSON.stringify(rec.error)}`);
    return;
  }
  // แปลงเป็น mp4 (copy ถ้าเป็น h264, ไม่งั้น transcode)
  const codec = await ffprobeCodec(outMov);
  const args = codec === 'h264'
    ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', outMov, '-c', 'copy', '-movflags', '+faststart', outMp4]
    : ['-y', '-hide_banner', '-loglevel', 'error', '-i', outMov, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outMp4];
  const ffCode = await new Promise((r) => execFile(FFMPEG, args, { env: CHILD_ENV, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
    rec.ffmpegError = String(stderr || stdout || (err && err.message) || '').trim();
    r(err ? 1 : 0);
  }));
  if (ffCode !== 0 || !fs.existsSync(outMp4)) {
    rec.error = 'แปลงไฟล์วิดีโอไม่สำเร็จ — ตรวจว่า ffmpeg พร้อมใช้งาน'
      + (rec.ffmpegError ? `\n\nรายละเอียดจาก ffmpeg: ${rec.ffmpegError}` : '');
    rec.processing = false;
    dbg(`record/stop failed during remux error=${JSON.stringify(rec.error)}`);
    return;
  }
  try { fs.unlinkSync(outMov); } catch {}

  // sync เวลาคลิกให้ตรงเฟรมจริง: เฟรม 0 = stopWall - duration
  const dur = await ffprobeDuration(outMp4);
  let clicks = [];
  if (dur) {
    const frame0 = stopWall - dur * 1000;
    for (const c of rec.clicks) {
      const t = (c.wall - frame0) / 1000;
      if (t >= -0.25 && t <= dur + 0.25) clicks.push({ t: Math.max(0, +t.toFixed(3)), x: +c.x.toFixed(4), y: +c.y.toFixed(4) });
    }
  }
  fs.writeFileSync(base + '.clicks.json', JSON.stringify({ version: 1, clicks }, null, 2));
  rec.finished = true;
  rec.processing = false;
  rec.clicks = clicks;
  dbg(`record/stop finalized mode=mac duration=${dur || 0} clicks=${clicks.length}`);
}

async function stopAndroidRecording() {
  const stopWall = Date.now();
  const base = rec.base;
  const outMp4 = base + '.mp4';
  clearInterval(rec.androidTimer);
  if (rec.touchProc && rec.touchProc.exitCode === null) {
    try { rec.touchProc.kill('SIGTERM'); } catch {}
  }
  if (rec.proc && rec.proc.exitCode === null) {
    rec.proc.kill('SIGINT');
    await new Promise((r) => {
      const t = setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch {} r(); }, 7000);
      rec.proc.on('exit', () => { clearTimeout(t); r(); });
    });
  }
  if (!fs.existsSync(outMp4) || fs.statSync(outMp4).size === 0) {
    rec.error = 'Android recording did not produce a playable file'
      + (rec.capStderr ? `\n\nรายละเอียด: ${rec.capStderr.slice(-2000)}` : '');
    rec.processing = false;
    return;
  }
  await finalizeAndroidRecording(stopWall);
}

async function finalizeAndroidRecording(stopWall) {
  const base = rec.base;
  const outMp4 = base + '.mp4';
  if (!fs.existsSync(outMp4) || fs.statSync(outMp4).size === 0) throw new Error('Android recording stopped before a playable file was created');
  const dur = await ffprobeDuration(outMp4);
  let clicks = [];
  if (dur) {
    const frame0 = stopWall - dur * 1000;
    for (const c of rec.clicks) {
      const t = (c.wall - frame0) / 1000;
      if (t >= -0.25 && t <= dur + 0.25) clicks.push({ t: Math.max(0, +t.toFixed(3)), x: +c.x.toFixed(4), y: +c.y.toFixed(4) });
    }
  }
  fs.writeFileSync(base + '.clicks.json', JSON.stringify({ version: 1, source: 'android-adb-getevent', clicks }, null, 2));
  rec.finished = true;
  rec.processing = false;
  rec.clicks = clicks;
}

function recordState() {
  return {
    running: rec.active && rec.startedAt !== null,
    processing: rec.processing === true, // หยุดแล้วแต่ยังแปลงไฟล์อยู่ (frontend รอต่อ)
    base: rec.base ? path.basename(rec.base) : null,
    started: rec.startedAt ? rec.startedAt / 1000 : null,
    clicks: rec.clicks.length,
    finished: rec.finished,
    error: rec.error,
    hasClickTracking: inputHookAvailable(),
    hookRunning: rec.hookRunning,
    debugLog: DEBUG_LOG,
    androidConnected: rec.mode === 'android' ? rec.androidConnected : undefined,
    trackingError: rec.trackingError || undefined,
  };
}

// ---------- HTTP server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

function startServer({ webRoot, recordingsDir, exportRecoveryDir, port = 0 } = {}) {
  webRoot = webRoot || path.join(__dirname, '..');
  recordingsDir = recordingsDir || path.join(webRoot, 'recordings');
  const apiToken = createApiToken();
  const mediaPaths = new Map();
  const exportTargets = new Map();
  const exportJobs = new Map();
  const maxExportBytes = Math.max(256 * 1024 * 1024, Number(process.env.ZOOMCUT_MAX_EXPORT_BYTES) || 256 * 1024 * 1024 * 1024);

  const registerMediaPath = (filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Media file not found');
    const id = crypto.randomBytes(18).toString('hex');
    mediaPaths.set(id, resolved);
    return { id, url: `/media/${id}?token=${apiToken}`, path: resolved };
  };
  const registerExportTarget = (filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const id = crypto.randomBytes(18).toString('hex');
    exportTargets.set(id, resolved);
    return { id, path: resolved };
  };
  const consumeExportTarget = (id) => {
    const target = exportTargets.get(id);
    if (target) exportTargets.delete(id);
    return target;
  };
  const authorized = (req, url) => {
    const supplied = req.headers['x-zoomcut-token'] || url.searchParams.get('token');
    if (typeof supplied !== 'string' || supplied.length !== apiToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(apiToken));
  };
  const hasAudio = filePath => new Promise(resolve => execFile(FFPROBE,
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
    { env: CHILD_ENV, timeout: 10000 }, (error, stdout) => resolve(!error && String(stdout).trim() !== '')));
  const atempo = speed => {
    const filters = [];
    let value = Math.max(0.05, Number(speed) || 1);
    while (value < 0.5) { filters.push('atempo=0.5'); value /= 0.5; }
    while (value > 100) { filters.push('atempo=100'); value /= 100; }
    filters.push(`atempo=${value.toFixed(6)}`);
    return filters.join(',');
  };
  const offlineAudioArgs = async plan => {
    const duration = Math.max(0.1, Math.min(86400, Number(plan?.duration) || 0.1));
    const sources = [];
    if (plan?.base?.path && await hasAudio(plan.base.path)) sources.push({ ...plan.base, kind: 'base' });
    for (const clip of (plan?.clips || []).slice(0, 256)) if (clip.path && await hasAudio(clip.path)) sources.push({ ...clip, kind: 'clip' });
    const inputArgs = ['-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
    sources.forEach(source => inputArgs.push('-i', source.path));
    const filters = [`[1:a]atrim=duration=${duration},asetpts=PTS-STARTPTS[silence]`];
    const mix = ['[silence]'];
    sources.forEach((source, index) => {
      const input = index + 2;
      if (source.kind === 'base') {
        const labels = [];
        (source.segments || []).forEach((segment, segmentIndex) => {
          const label = `b${index}_${segmentIndex}`;
          const start = Math.max(0, Number(segment.start) || 0);
          const end = Math.max(start + 0.001, Number(segment.end) || start + 0.001);
          const volume = Math.max(0, Math.min(4, Number(segment.volume ?? 1) || 0));
          filters.push(`[${input}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempo(segment.speed)},volume=${volume}[${label}]`);
          labels.push(`[${label}]`);
        });
        if (labels.length) {
          const label = `base${index}`;
          filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[${label}]`);
          mix.push(`[${label}]`);
        }
      } else {
        const label = `clip${index}`;
        const start = Math.max(0, Number(source.offset) || 0);
        const length = Math.max(0.01, Number(source.duration) || 0.01);
        const delay = Math.max(0, Math.round((Number(source.outStart) || 0) * 1000));
        const volume = Math.max(0, Math.min(4, Number(source.volume ?? 1) || 0));
        filters.push(`[${input}:a]atrim=start=${start}:end=${start + length},asetpts=PTS-STARTPTS,volume=${volume},adelay=${delay}:all=1[${label}]`);
        mix.push(`[${label}]`);
      }
    });
    filters.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0,atrim=duration=${duration}[mix]`);
    return { inputArgs, filter: filters.join(';') };
  };
  const runRemux = async (input, output, jobId, metadata = {}) => {
    let args;
    if (metadata.ext === 'mjpeg') {
      const audio = await offlineAudioArgs(metadata.audioPlan);
      args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(metadata.fps || 30), '-vcodec', 'mjpeg', '-i', input,
        ...audio.inputArgs, '-filter_complex', audio.filter, '-map', '0:v:0', '-map', '[mix]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', output];
    } else {
      args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', '30', '-vsync', 'cfr', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output];
    }
    return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], env: CHILD_ENV });
    exportJobs.set(jobId, proc);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-64 * 1024); });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      exportJobs.delete(jobId);
      if (code === 0 && fs.existsSync(output)) resolve();
      else reject(new Error(signal ? 'export canceled' : (stderr.trim() || `ffmpeg exited ${code}`)));
    });
    });
  };
  const cancelRemux = (jobId) => {
    const proc = exportJobs.get(String(jobId || ''));
    if (proc && proc.exitCode === null) proc.kill('SIGTERM');
  };
  const exportSessions = createExportSessionManager({ consumeTarget: consumeExportTarget, runRemux, cancelRemux, maxBytes: maxExportBytes, recoveryDir: exportRecoveryDir });
  const serveFile = (req, res, filePath, headers) => {
    const stat = fs.statSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 0));
    const end = match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
    }
    res.writeHead(206, {
      ...headers, 'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const baseHeaders = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    };
    const send = (obj, code = 200) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    try {
      if (url.pathname.startsWith('/api/') && !authorized(req, url)) return send({ error: 'unauthorized' }, 401);
      if (url.pathname === '/api/windows') {
        const [windows, displays, androidDevices] = await Promise.all([listRecordableWindows(), listDisplays(), listAndroidDevices()]);
        return send({ windows, displays, androidDevices });
      }
      if (url.pathname === '/api/record/state') return send(recordState());
      if (url.pathname === '/api/diagnostics') return send(await diagnostics());
      if (url.pathname === '/api/record/start' && req.method === 'POST') {
        const opts = normalizeRecordingOptions(await readJsonBody(req, 64 * 1024));
        try { const result = await startRecording(recordingsDir, opts); return send({ ok: true, ...result }); }
        catch (error) { return send({ error: error.message }, 409); }
      }
      if (url.pathname === '/api/record/stop' && req.method === 'POST') {
        stopRecording().catch(() => {}); return send({ ok: true });
      }
      if (url.pathname === '/api/export/cancel' && req.method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        cancelRemux(body.jobId);
        return send({ ok: true });
      }
      if (url.pathname === '/api/remux' && req.method === 'POST') {
        const ext = (url.searchParams.get('ext') || 'webm').replace(/[^a-z0-9]/gi, '');
        const targetId = String(url.searchParams.get('target') || '');
        const requestedTarget = exportTargets.get(targetId);
        if (targetId && !requestedTarget) return send({ error: 'invalid export target' }, 400);
        if (targetId) consumeExportTarget(targetId);
        const jobId = String(url.searchParams.get('job') || crypto.randomBytes(12).toString('hex')).replace(/[^a-z0-9-]/gi, '');
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-export-'));
        const tmpIn = path.join(tempDir, `input.${ext}`);
        const tmpOut = requestedTarget || path.join(tempDir, 'output.mp4');
        try {
          await streamRequestToFile(req, tmpIn, maxExportBytes);
          await runRemux(tmpIn, tmpOut, jobId);
          if (requestedTarget) return send({ ok: true, path: requestedTarget, jobId });
          const stat = fs.statSync(tmpOut);
          res.writeHead(200, { ...baseHeaders, 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
          const output = fs.createReadStream(tmpOut);
          output.on('error', () => res.destroy());
          output.on('close', () => fs.rm(tempDir, { recursive: true, force: true }, () => {}));
          output.pipe(res);
          return;
        } catch (error) {
          fs.rm(tempDir, { recursive: true, force: true }, () => {});
          return send({ error: error.message }, error.statusCode || (error.message === 'export canceled' ? 499 : 500));
        } finally {
          fs.unlink(tmpIn, () => {});
          if (requestedTarget) fs.rm(tempDir, { recursive: true, force: true }, () => {});
        }
      }

      let filePath;
      if (url.pathname === '/' || url.pathname === '/index.html') filePath = path.join(webRoot, 'index.html');
      else if (url.pathname.startsWith('/media/')) {
        if (!authorized(req, url)) { res.writeHead(401, baseHeaders); return res.end('unauthorized'); }
        filePath = mediaPaths.get(url.pathname.slice('/media/'.length));
        if (!filePath) { res.writeHead(404, baseHeaders); return res.end('not found'); }
      } else if (url.pathname.startsWith('/recordings/')) {
        if (!authorized(req, url)) { res.writeHead(401, baseHeaders); return res.end('unauthorized'); }
        filePath = safeStaticPath(recordingsDir, url.pathname.slice('/recordings/'.length));
      }
      else filePath = safeStaticPath(webRoot, url.pathname);
      if (!filePath) { res.writeHead(403, baseHeaders); return res.end('forbidden'); }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404, baseHeaders); return res.end('not found'); }
      serveFile(req, res, filePath, baseHeaders);
    } catch (error) {
      if (!res.headersSent) send({ error: String(error.message) }, error.statusCode || 500);
      else res.destroy(error);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      server, port: server.address().port, recordingsDir, apiToken, registerMediaPath, registerExportTarget, exportSessions,
    }));
  });
}

module.exports = { startServer, listRecordableWindows, startRecording, stopRecording, recordState, buildScreencaptureArgs };

// รันเดี่ยวเพื่อทดสอบ: node electron/server.js
if (require.main === module) {
  startServer({ port: 8123 }).then(({ port, apiToken }) => console.log(`ZoomCut server (standalone) ที่ http://localhost:${port}/?token=${apiToken}`));
}
