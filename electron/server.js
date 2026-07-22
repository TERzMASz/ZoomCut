// ZoomCut core — HTTP server + recording (พอร์ตจาก serve.py + record.py มาเป็น Node)
// รันในตัว Electron หรือรันเดี่ยวเพื่อทดสอบก็ได้ (node electron/server.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

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
  const hook = loadUiohook();
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
  return {
    ok: true,
    app: 'ZoomCut',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    debugLog: DEBUG_LOG,
    bins: { ffmpeg, ffprobe, adb, scrcpy, screencapture, osascript },
    uiohook: {
      ok: hook !== false,
      running: rec.hookRunning,
      detail: hook === false ? 'โหลด uiohook-napi ไม่ได้ — อัดวิดีโอได้ แต่อาจไม่มี auto zoom จากคลิก' : 'พร้อมจับคลิกเมื่อเริ่มอัด',
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
// โหลดแบบ lazy + optional: ถ้า native module ยังไม่พร้อม อัดวิดีโอได้แต่ไม่มี auto-zoom
let uio = null;
function loadUiohook() {
  if (uio !== null) return uio;
  try { uio = require('uiohook-napi'); } catch { uio = false; }
  return uio;
}

// ---------- recording state ----------
const rec = {
  active: false, processing: false, mode: null, wid: null, ownerPid: null, base: null, startedAt: null,
  proc: null, touchProc: null, mirrorProc: null, remotePath: null, androidSerial: null, clicks: [], bounds: null, boundsTimer: null,
  finished: false, error: null, hookRunning: false, capStderr: '', ffmpegError: '',
};

function resetRec() {
  Object.assign(rec, { active: false, processing: false, mode: null, wid: null, ownerPid: null, base: null, startedAt: null,
    proc: null, touchProc: null, mirrorProc: null, remotePath: null, androidSerial: null, clicks: [], bounds: null, finished: false, error: null, capStderr: '', ffmpegError: '' });
}

async function startRecording(recordingsDir, opts) {
  if (rec.active) throw new Error('กำลังอัดอยู่แล้ว');
  resetRec();
  dbg(`record/start opts=${JSON.stringify(opts || {})}`);
  fs.mkdirSync(recordingsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = path.join(recordingsDir, `recording-${stamp}`);
  if (opts && opts.androidSerial) return startAndroidRecording(base, opts.androidSerial);

  // เลือกเป้าหมาย: ทั้งจอ (screenIndex) | หน้าต่าง (windowId) | iPhone (ค่าเริ่มต้น)
  let capArgs;
  if (opts && opts.screenIndex) {
    const displays = await listDisplays();
    const d = displays.find((x) => x.index === opts.screenIndex);
    if (!d) throw new Error(`ไม่พบจอ #${opts.screenIndex}`);
    rec.mode = 'display';
    rec.bounds = { x: d.x, y: d.y, w: d.w, h: d.h };
    capArgs = ['-v', '-C', '-D', String(d.index)];
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
    capArgs = ['-v', '-C', '-l', String(wid)];
  }

  const outMov = base + '.mov';
  try { fs.unlinkSync(outMov); } catch {}

  const cap = spawn(SCREENCAPTURE, [...capArgs, outMov], { stdio: ['ignore', 'ignore', 'pipe'], env: CHILD_ENV });
  dbg(`screencapture spawn ${[...capArgs, outMov].join(' ')}`);
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
      if (!rec.active) return;
      const b = await findWindowById(rec.wid);
      if (b) rec.bounds = b;
      const wins = await jxaListWindows();
      if (rec.ownerPid && !appHasWindows(wins, rec.ownerPid)) stopRecording().catch(() => {});
    }, 400);
  }

  return { base: path.basename(base) };
}

async function startAndroidRecording(base, serial) {
  const devices = await listAndroidDevices();
  if (!devices.some((d) => d.serial === serial)) throw new Error('ไม่พบ Android device — เปิด USB debugging แล้วเชื่อมต่ออีกครั้ง');
  const touch = await androidTouchDevice(serial);
  const size = await androidScreenSize(serial);
  const remote = `/sdcard/ZoomCut-${path.basename(base)}.mp4`;
  rec.mode = 'android';
  rec.base = base;
  rec.androidSerial = serial;
  rec.remotePath = remote;
  rec.bounds = { x: 0, y: 0, w: touch?.xMax || size.w, h: touch?.yMax || size.h };
  const cap = spawn(ADB, adbArgs(serial, ['shell', 'screenrecord', remote]), { stdio: ['ignore', 'ignore', 'pipe'], env: CHILD_ENV });
  rec.proc = cap;
  rec.active = true;
  rec.startedAt = Date.now();
  cap.stderr.on('data', (buf) => { rec.capStderr += String(buf); });
  cap.on('exit', () => {
    if (rec.active) {
      rec.error = 'Android screenrecord หยุดก่อนเวลา — ตรวจสาย USB/สิทธิ์ USB debugging';
      rec.active = false;
    }
  });
  startAndroidTouchTracking(serial, touch);
  startAndroidMirror(serial);
  dbg(`android screenrecord serial=${serial} remote=${remote} touch=${touch ? touch.device : 'auto'}`);
  return { base: path.basename(base) };
}

function startAndroidMirror(serial) {
  if (!fs.existsSync(SCRCPY) && SCRCPY === 'scrcpy') {
    dbg('scrcpy unavailable: Android mirror preview disabled');
    return;
  }
  const args = ['--serial', serial, '--window-title', `ZoomCut Android ${serial}`, '--stay-awake', '--no-audio'];
  const proc = spawn(SCRCPY, args, { stdio: ['ignore', 'ignore', 'pipe'], env: CHILD_ENV });
  rec.mirrorProc = proc;
  proc.stderr.on('data', (buf) => dbg(`scrcpy stderr: ${String(buf).trim()}`));
  proc.on('error', (e) => dbg(`scrcpy start failed: ${e.message}`));
}

function startAndroidTouchTracking(serial, touch) {
  const args = touch?.device ? ['shell', 'getevent', '-lt', touch.device] : ['shell', 'getevent', '-lt'];
  const proc = spawn(ADB, adbArgs(serial, args), { stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV });
  rec.touchProc = proc;
  let buf = '';
  let curX = null, curY = null, touching = false, began = false;
  const xMax = touch?.xMax || rec.bounds.w || 1;
  const yMax = touch?.yMax || rec.bounds.h || 1;
  const parse = (line) => {
    const m = line.match(/:\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]+)/);
    if (!m) return;
    const type = parseInt(m[1], 16), code = parseInt(m[2], 16);
    let val = parseInt(m[3], 16);
    if (val > 0x7fffffff) val -= 0x100000000;
    if (type === 0x0003 && code === 0x0035) curX = val;
    if (type === 0x0003 && code === 0x0036) curY = val;
    if (type === 0x0001 && code === 0x014a) {
      if (val === 1 && !touching) began = true;
      touching = val === 1;
    }
    if (type === 0x0003 && code === 0x0039) {
      if (val >= 0 && !touching) began = true;
      touching = val >= 0;
    }
    if (type === 0x0000 && code === 0x0000 && began && touching && curX !== null && curY !== null) {
      rec.clicks.push({ wall: Date.now(), x: Math.max(0, Math.min(1, curX / xMax)), y: Math.max(0, Math.min(1, curY / yMax)) });
      began = false;
    }
  };
  proc.stdout.on('data', (chunk) => {
    buf += String(chunk);
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    lines.forEach(parse);
  });
  proc.stderr.on('data', (chunk) => dbg(`android getevent stderr: ${String(chunk).trim()}`));
  proc.on('error', (e) => dbg(`android getevent failed: ${e.message}`));
}

function startInputHook() {
  const hook = loadUiohook();
  if (!hook || rec.hookRunning) {
    if (!hook) dbg('uiohook-napi unavailable: click tracking disabled');
    return;
  }
  const { uIOhook } = hook;
  const scale = 1; // uiohook คืนพิกัดเป็น screen points อยู่แล้ว
  uIOhook.on('mousedown', (e) => {
    if (!rec.active || rec.startedAt === null || !rec.bounds) return;
    const b = rec.bounds;
    const x = e.x, y = e.y;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      rec.clicks.push({ wall: Date.now(), x: (x - b.x) / b.w, y: (y - b.y) / b.h });
    }
  });
  // คีย์ลัดหยุดอัด ⌃⌘S
  uIOhook.on('keydown', (e) => {
    if (!rec.active) return;
    const KEY_S = 31; // uiohook keycode ของ S
    if (e.keycode === KEY_S && e.ctrlKey && e.metaKey) stopRecording().catch(() => {});
  });
  try { uIOhook.start(); rec.hookRunning = true; }
  catch (e) {
    rec.hookRunning = false;
    dbg(`uiohook start failed: ${e.message}`);
  }
}
function stopInputHook() {
  const hook = loadUiohook();
  if (hook && rec.hookRunning) { try { hook.uIOhook.stop(); } catch {} rec.hookRunning = false; }
}

async function stopRecording() {
  if (!rec.active) return;
  rec.active = false;
  rec.processing = true; // หยุดอัดแล้ว แต่ยังแปลงไฟล์อยู่ (frontend รอต่อ ไม่หยุด poll)
  clearInterval(rec.boundsTimer);
  stopInputHook();
  if (rec.mode === 'android') return stopAndroidRecording();
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
}

async function stopAndroidRecording() {
  const stopWall = Date.now();
  const base = rec.base;
  const outMp4 = base + '.mp4';
  if (rec.touchProc && rec.touchProc.exitCode === null) {
    try { rec.touchProc.kill('SIGTERM'); } catch {}
  }
  if (rec.mirrorProc && rec.mirrorProc.exitCode === null) {
    try { rec.mirrorProc.kill('SIGTERM'); } catch {}
  }
  if (rec.proc && rec.proc.exitCode === null) {
    rec.proc.kill('SIGINT');
    await new Promise((r) => {
      const t = setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch {} r(); }, 7000);
      rec.proc.on('exit', () => { clearTimeout(t); r(); });
    });
  }
  const pull = await execAdb(rec.androidSerial, ['pull', rec.remotePath, outMp4], 30000);
  await execAdb(rec.androidSerial, ['shell', 'rm', '-f', rec.remotePath], 5000);
  if (!pull.ok || !fs.existsSync(outMp4) || fs.statSync(outMp4).size === 0) {
    rec.error = 'ดึงวิดีโอจาก Android ไม่สำเร็จ — ตรวจว่า USB debugging ยังเชื่อมต่ออยู่'
      + (pull.stderr || pull.error ? `\n\nรายละเอียด: ${pull.stderr || pull.error}` : '');
    rec.processing = false;
    return;
  }
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
    hasClickTracking: loadUiohook() !== false,
    hookRunning: rec.hookRunning,
    debugLog: DEBUG_LOG,
  };
}

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png' };

function startServer({ webRoot, recordingsDir, port = 0 } = {}) {
  webRoot = webRoot || path.join(__dirname, '..');
  recordingsDir = recordingsDir || path.join(webRoot, 'recordings');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (obj, code = 200) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); };

    try {
      if (url.pathname === '/api/windows') {
        const [windows, displays, androidDevices] = await Promise.all([listRecordableWindows(), listDisplays(), listAndroidDevices()]);
        return send({ windows, displays, androidDevices });
      }
      if (url.pathname === '/api/record/state') return send(recordState());
      if (url.pathname === '/api/diagnostics') return send(await diagnostics());
      if (url.pathname === '/api/record/start' && req.method === 'POST') {
        let body = ''; req.on('data', (c) => (body += c)); await new Promise((r) => req.on('end', r));
        let opts = {}; try { opts = JSON.parse(body || '{}'); } catch {}
        try { const r = await startRecording(recordingsDir, opts); return send({ ok: true, ...r }); }
        catch (e) { return send({ error: e.message }, 409); }
      }
      if (url.pathname === '/api/record/stop' && req.method === 'POST') {
        stopRecording().catch(() => {}); return send({ ok: true });
      }
      // แปลงไฟล์ export จาก MediaRecorder (VFR) → MP4 frame rate คงที่ (แก้อาการค้าง)
      if (url.pathname === '/api/remux' && req.method === 'POST') {
        const bufs = []; req.on('data', (c) => bufs.push(c)); await new Promise((r) => req.on('end', r));
        const inBuf = Buffer.concat(bufs);
        const ext = (url.searchParams.get('ext') || 'webm').replace(/[^a-z0-9]/gi, '');
        const tmpIn = path.join(os.tmpdir(), `zc-remux-${Date.now()}.${ext}`);
        const tmpOut = path.join(os.tmpdir(), `zc-remux-${Date.now()}.mp4`);
        try {
          fs.writeFileSync(tmpIn, inBuf);
          const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmpIn,
            '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-r', '30', '-vsync', 'cfr', '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', tmpOut];
          const code = await new Promise((r) => execFile(FFMPEG, args, { env: CHILD_ENV, maxBuffer: 1 << 26 }, (err) => r(err ? 1 : 0)));
          if (code !== 0 || !fs.existsSync(tmpOut)) { res.writeHead(500); return res.end('remux failed'); }
          const out = fs.readFileSync(tmpOut);
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': out.length });
          res.end(out);
        } finally {
          fs.unlink(tmpIn, () => {}); fs.unlink(tmpOut, () => {});
        }
        return;
      }

      // static: index.html + recordings
      let filePath;
      if (url.pathname === '/' || url.pathname === '/index.html') filePath = path.join(webRoot, 'index.html');
      else if (url.pathname.startsWith('/recordings/')) filePath = path.join(recordingsDir, decodeURIComponent(url.pathname.slice('/recordings/'.length)));
      else filePath = path.join(webRoot, decodeURIComponent(url.pathname));
      // กัน path traversal
      if (!filePath.startsWith(webRoot) && !filePath.startsWith(recordingsDir)) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(String(e.message));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, recordingsDir }));
  });
}

module.exports = { startServer, listRecordableWindows, startRecording, stopRecording, recordState };

// รันเดี่ยวเพื่อทดสอบ: node electron/server.js
if (require.main === module) {
  startServer({ port: 8123 }).then(({ port }) => console.log(`ZoomCut server (standalone) ที่ http://localhost:${port}`));
}
