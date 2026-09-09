'use strict';

// ---------- State ----------
const $ = id => document.getElementById(id);
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const desktop = window.zoomcutDesktop || null;
const API_TOKEN = new URLSearchParams(location.search).get('token') || '';

const state = {
  loaded: false,
  mode: 'video',   // 'video' | 'image'
  imageEl: null,
  aspect: '9:16',
  posV: 'center',
  bg: 0,
  bgType: 'preset', // 'preset' | 'custom' | 'image' | 'transparent'
  bgImageEl: null,
  bgColor: '#151821',
  padding: 0,      // % of min canvas dimension
  radius: 3,       // % of min canvas dimension
  shadow: 60,
  crop: { t: 0, r: 0, b: 0, l: 0 }, // ตัดขอบ (เศษส่วน 0..~0.4 ของแต่ละด้าน)
  frame: 'none',   // 'none' | 'iphone' | 'browser'
  frameColor: '#2e2c2e',
  urlText: '',
  statusBar: 'none', // 'none' | 'auto' | 'light' | 'dark'
  showTaps: true,
  // M1 foundation fields. They are persisted now; rendering and editing land
  // in later milestones so legacy projects remain behaviorally unchanged.
  cursorSettings: { enabled: true, style: 'soft', size: 1, smoothing: 0.65, clickEffect: 'ripple', clickBounce: 1, bounceDurationMs: 350, sway: 0 },
  cursorPoints: [],
  annotations: [],
  annotationLaneCount: 1,
  shortcuts: {},
  background: { type: 'preset', value: 0, colors: [], blur: 0, color: '#151821' },
  frameStyle: { type: 'none', padding: 0, radius: 3, shadow: 60 },
  debugOverlay: false,
  taps: [],        // {t, x, y} จาก clicks.json — ใช้วาด ripple
  defZoom: 1.2,
  defHold: 1.0,
  zoomStyle: 'subtle',
  exportScale: 2,
  videoExportScale: 1,
  segments: [],    // {id, start, end, speed, lane} — ท่อนที่เก็บไว้ (ช่องว่างระหว่างท่อน = ถูกตัดออก)
  selectedSeg: null,
  videoClips: [],  // {id, outStart, outDuration, mediaOffset, lane, url, video, name}
  selectedVideoId: null,
  events: [],      // {id, start, x, y, zoom, tIn, hold, tOut}
  selectedId: null,
  voiceovers: [],  // {id, start, duration, blob, url, name, lane}
  selectedVoiceId: null,
  selectedMicId: localStorage.getItem('zoomcut-mic') || '',
  facecams: [],    // {id, outStart, outDuration, blob, url, fadeIn, fadeOut, video, lane}
  selectedFaceId: null,
  selectedCamId: localStorage.getItem('zoomcut-camera') || '',
  recordCamera: localStorage.getItem('zoomcut-record-camera') === '1',
  camDefaults: { pos: 'bottom-right', shape: 'circle', size: 22, margin: 3.5, fadeIn: 0.3, fadeOut: 0.3 },
  theme: localStorage.getItem('zoomcut-theme') || 'dark',
  lang: localStorage.getItem('zoomcut-lang') || 'th',
  timelineZoom: 1,
  videoLaneCount: 1,
  voiceLaneCount: 1,
  cameraLaneCount: 1,
  laneSettings: { video: [], voice: [], camera: [] },
  exporting: false,
  baseMedia: null,
  projectPath: null,
  projectCreatedAt: null,
  dirty: false,
};
let nextId = 1;
let videoClipId = 1;
let voiceId = 1;
let faceId = 1;
let pendingOverlayFiles = [];
const history = { undo: [], redo: [] };
function eventDuration(ev) { return ev.tIn + ev.hold + ev.tOut; }
function eventEnd(ev) { return ev.start + eventDuration(ev); }
function setEventEnd(ev, end) {
  const minDur = ev.tIn + ev.tOut + 0.1;
  const maxEnd = state.mode === 'video' && video.duration ? video.duration : Infinity;
  end = Math.min(maxEnd, Math.max(ev.start + minDur, end));
  ev.hold = Math.max(0.1, end - ev.start - ev.tIn - ev.tOut);
}
function shiftEventStart(ev, start) {
  const end = eventEnd(ev);
  const minDur = ev.tIn + ev.tOut + 0.1;
  ev.start = Math.max(0, Math.min(end - minDur, start));
  ev.hold = Math.max(0.1, end - ev.start - ev.tIn - ev.tOut);
}
function normalizeEventTiming(ev) {
  if (state.mode !== 'video' || !video.duration) return;
  ev.tIn = Math.max(0.1, ev.tIn);
  ev.tOut = Math.max(0.1, ev.tOut);
  const minDur = ev.tIn + ev.tOut + 0.1;
  ev.start = Math.max(0, Math.min(ev.start, Math.max(0, video.duration - minDur)));
  setEventEnd(ev, Math.min(video.duration, eventEnd(ev)));
}

const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080] };
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
const ZOOM_STYLES = {
  subtle: { zoom: 1.2, tIn: 0.55, hold: 1.0, tOut: 0.5, mergeWindow: 0.6, mergeDist: 0.16, tapOnly: false },
  focus: { zoom: 1.6, tIn: 0.65, hold: 1.25, tOut: 0.65, mergeWindow: 0.8, mergeDist: 0.2, tapOnly: false },
  fast: { zoom: 1.35, tIn: 0.28, hold: 0.55, tOut: 0.28, mergeWindow: 0.35, mergeDist: 0.12, tapOnly: false },
  cinematic: { zoom: 1.45, tIn: 0.9, hold: 1.4, tOut: 0.9, mergeWindow: 1.0, mergeDist: 0.22, tapOnly: false },
  taponly: { zoom: 1, tIn: 0.1, hold: 0.1, tOut: 0.1, mergeWindow: 0, mergeDist: 0, tapOnly: true },
};
function currentZoomStyle() { return ZOOM_STYLES[state.zoomStyle] || ZOOM_STYLES.subtle; }
const I18N = {
  th: {
    hint: 'อัดหน้าจอ iPhone (Control Center) → ลากไฟล์มาที่นี่ → คลิกจุดที่อยากซูม → Export',
    newJob: '🆕 งานใหม่', diagnostics: '🩺 ตรวจระบบ', record: '🔴 อัดหน้าจอ',
    projectOpen: '📂 เปิดงาน', projectSave: '💾 บันทึกงาน', projectSaved: 'บันทึกแล้ว', projectAutosaved: 'สำรองอัตโนมัติแล้ว',
    projectRecovered: 'กู้คืนงานล่าสุดแล้ว', projectMissing: 'ไม่พบไฟล์สื่อของโปรเจกต์', exportCancel: 'ยกเลิก Export',
    open: '📂 เปิดวิดีโอ/รูป', exportVideo: '⬇️ Export วิดีโอ', exportPng: '⬇️ Export PNG',
    play: '▶️ เล่น', pause: '⏸ หยุด', split: '✂️ แบ่งท่อน',
    voice: '🎙 Voice over', stopVoice: '⏹ หยุดเสียง', recordingVoice: '🔴 กำลังอัดเสียง',
    output: 'ผลลัพธ์', zoomPoints: n => `🔍 ${n} จุดซูม`, voiceClip: n => `เสียง ${n}`,
    videoClip: n => `วิดีโอ ${n}`,
    recStarting: '⏳ กำลังเริ่ม...', recStopping: '⏳ กำลังปิดไฟล์...', recProcessing: '⏳ กำลังแปลงไฟล์…',
    shortcuts: 'คีย์ลัด',
    close: 'ปิด',
    preset: 'Preset', aspect: 'สัดส่วนภาพ', fitFrame: '📐 พอดีเฟรม', verticalPosition: 'ตำแหน่งแนวตั้ง',
    top: 'บน', center: 'กลาง', bottom: 'ล่าง', deviceFrame: 'กรอบอุปกรณ์', none: 'ไม่มี',
    browser: '🖥 เบราว์เซอร์', statusBar: 'Status Bar (iPhone)', off: 'ปิด', auto: 'ออโต้',
    light: 'สว่าง', dark: 'มืด', tapEffect: 'เอฟเฟกต์จุดแตะ', show: '💧 แสดง',
    background: 'พื้นหลัง', imageBg: '🖼 รูป', transparent: '⬜ ใส', videoFrame: 'เฟรมวิดีโอ',
    padding: 'ขอบรอบ', radius: 'ขอบมน', shadow: 'เงา', crop: 'ตัดขอบ (Crop)',
    cropTip: 'ตัดขอบหน้าต่าง iPhone Mirroring ออก เพื่อไม่ให้เห็นขอบตอนซูม',
    cropTop: 'บน', cropBottom: 'ล่าง', cropLeft: 'ซ้าย', cropRight: 'ขวา',
    cropReset: '↺ ล้าง crop', cropGuide: '👁 ดูขอบ', zoomDefaults: 'ค่าเริ่มต้นการซูม',
    zoomLevel: 'ระดับซูม', hold: 'ค้างไว้', exportResolution: 'ความละเอียด Export (PNG)',
    helpTip: '💡 <b>วิธีใช้:</b> เล่นวิดีโอถึงจังหวะที่กดปุ่มในแอป แล้ว<b>คลิกบนวิดีโอ</b>ตรงจุดนั้น — โปรแกรมจะซูมเข้า-ออกให้อัตโนมัติแบบนุ่มๆ<br><br>ลาก marker บน timeline เพื่อย้ายเวลา, คลิก marker เพื่อแก้ระดับซูม/ลบ',
    dropHint: '<div class="big">📱</div><div><strong>ลากวิดีโอแรกมาวางเพื่อเริ่มโปรเจกต์</strong><br>หรือกด "เพิ่มสื่อ" / "อัดหน้าจอ"<br><span style="font-size:12px">หลังจากมีวิดีโอหลักแล้ว ลากวิดีโอเพิ่มเพื่อวางเป็น overlay clip บน timeline<br>ถ้ามี .clicks.json ให้ลากมาพร้อมวิดีโอหลักเพื่อสร้าง zoom อัตโนมัติ</span></div>',
    voiceDelete: '🗑 ลบเสียงนี้', selectedSegment: '🎞 ท่อนที่เลือก', speed: 'ความเร็ว',
    segDelete: '🗑 ตัดท่อนนี้ออก', zoomMarker: '🔍 Zoom marker', zoomIn: 'เข้า', zoomOut: 'ออก',
    growLeft: '← ขยาย', growRight: 'ขยาย →', delete: '🗑 ลบ',
    pickerTitle: 'เลือกสิ่งที่จะอัด', pickerSub: 'เหมือนแชร์จอใน meeting — เลือกหน้าต่างที่ต้องการ แล้วทุกคลิกจะกลายเป็นจุดซูมอัตโนมัติ',
    androidRecord: 'Android ผ่าน USB',
    androidRecordSub: d => `อัดด้วย adb screenrecord + จับ touch จาก getevent • ${d.model || d.serial}`,
    cancel: 'ยกเลิก', diagTitle: 'ตรวจระบบ ZoomCut', exportTitle: 'กำลัง Export วิดีโอ…',
    exportSub: 'กำลังเรนเดอร์แบบเรียลไทม์ — อย่าปิดหรือสลับไปแท็บอื่น (ต้องให้แท็บนี้แสดงอยู่)',
    micDefault: 'ไมค์เริ่มต้น', micLoading: 'กำลังโหลดไมค์...', micNoDevices: 'ไม่พบไมค์', micGrant: 'อนุญาตเพื่อดูไมค์ทั้งหมด…',
    camDefault: 'กล้องเริ่มต้น', camLoading: 'กำลังโหลดกล้อง...', camNoDevices: 'ไม่พบกล้อง', camGrant: 'อนุญาตเพื่อดูกล้องทั้งหมด…',
    camOn: '📷 กล้อง', camOff: '📷 ปิดกล้อง', cameraClip: n => `กล้อง ${n}`,
    cameraOverlay: '📷 Camera overlay', cameraDelete: '🗑 ลบกล้อง', fadeIn: 'Fade in', fadeOut: 'Fade out',
    videoLane: 'วิดีโอ', voiceLane: 'เสียง', cameraLane: 'กล้อง',
    addVideoLane: 'เลนวิดีโอ', addVoiceLane: 'เลนเสียง', addCameraLane: 'เลนกล้อง',
    lane: 'เลน', closePanel: 'ปิดเมนูแก้ไข',
    quickRecordTitle: 'อัดทันที', quickRecordSub: 'เลือก Android/iPhone/จอหลักให้อัตโนมัติ',
    quickAddTitle: 'เพิ่มสื่อ', quickAddSub: 'วิดีโอแรกเป็น base, ไฟล์ถัดไปซ้อนเป็น clip',
    quickVoiceTitle: 'พากย์เสียง', quickVoiceSub: 'เลือกไมค์ แล้วอัดจากตำแหน่ง playhead',
    addOverlayVideo: 'เพิ่มวิดีโอซ้อน',
    selectedOverlayVideo: 'วิดีโอซ้อน',
    confirmDeleteSegment: 'ลบท่อนวิดีโอนี้ออกใช่ไหม?',
    confirmDeleteVideoClip: 'ลบวิดีโอซ้อนนี้ใช่ไหม?',
    confirmDeleteVoice: 'ลบเสียง voice over นี้ใช่ไหม?',
    confirmDeleteCamera: 'ลบคลิปกล้องนี้ใช่ไหม?',
    micPermission: 'เปิดไมโครโฟนไม่ได้ — ตรวจสิทธิ์ Microphone ให้ ZoomCut',
    promptCancel: 'ยกเลิก', promptOk: 'ตกลง', presetPlaceholder: '— เลือก preset —',
    newConfirm: 'เริ่มงานชิ้นใหม่? งานปัจจุบัน (วิดีโอ จุดซูม trim) จะถูกล้างทั้งหมด',
    oneSegmentRequired: 'ต้องเหลืออย่างน้อย 1 ท่อน',
    exportRemuxing: 'กำลังแปลงไฟล์ให้เล่นได้ลื่น…',
    exportSegment: (i, n, done, total, speed) => `ท่อน ${i}/${n} • ${done} / ${total} — ${speed}x`,
    actionableSuffix: '\n\nถ้าเพิ่งให้สิทธิ์ใน macOS ให้ปิด ZoomCut แล้วเปิดใหม่อีกครั้ง',
  },
  en: {
    hint: 'Record or import a screen video → click points to auto zoom → export',
    newJob: '🆕 New', diagnostics: '🩺 Diagnostics', record: '🔴 Record',
    projectOpen: '📂 Open project', projectSave: '💾 Save project', projectSaved: 'Saved', projectAutosaved: 'Autosaved',
    projectRecovered: 'Recovered latest work', projectMissing: 'Project media is missing', exportCancel: 'Cancel export',
    open: '📂 Open video/image', exportVideo: '⬇️ Export video', exportPng: '⬇️ Export PNG',
    play: '▶️ Play', pause: '⏸ Pause', split: '✂️ Split',
    voice: '🎙 Voice over', stopVoice: '⏹ Stop voice', recordingVoice: '🔴 Recording voice',
    output: 'output', zoomPoints: n => `🔍 ${n} zooms`, voiceClip: n => `Voice ${n}`,
    videoClip: n => `Video ${n}`,
    recStarting: '⏳ Starting...', recStopping: '⏳ Closing file...', recProcessing: '⏳ Processing…',
    shortcuts: 'Keyboard shortcuts',
    close: 'Close',
    preset: 'Preset', aspect: 'Aspect ratio', fitFrame: '📐 Fit frame', verticalPosition: 'Vertical position',
    top: 'Top', center: 'Center', bottom: 'Bottom', deviceFrame: 'Device frame', none: 'None',
    browser: '🖥 Browser', statusBar: 'Status bar (iPhone)', off: 'Off', auto: 'Auto',
    light: 'Light', dark: 'Dark', tapEffect: 'Tap effect', show: '💧 Show',
    background: 'Background', imageBg: '🖼 Image', transparent: '⬜ Transparent', videoFrame: 'Video frame',
    padding: 'Padding', radius: 'Radius', shadow: 'Shadow', crop: 'Crop',
    cropTip: 'Crop the iPhone Mirroring window edges so they do not appear during zooms.',
    cropTop: 'Top', cropBottom: 'Bottom', cropLeft: 'Left', cropRight: 'Right',
    cropReset: '↺ Reset crop', cropGuide: '👁 Crop guide', zoomDefaults: 'Default zoom',
    zoomLevel: 'Zoom level', hold: 'Hold', exportResolution: 'Export resolution (PNG)',
    helpTip: '💡 <b>How to use:</b> Play to the moment you tap in the app, then <b>click the video</b> at that point. ZoomCut will animate the zoom in and out smoothly.<br><br>Drag markers on the timeline to move them, or click a marker to edit zoom/delete it.',
    dropHint: '<div class="big">📱</div><div><strong>Drop the first video to start a project</strong><br>or use "Add media" / "Record screen"<br><span style="font-size:12px">After the base video is loaded, drop more videos to add overlay clips on the timeline<br>Drop .clicks.json with the base video to create automatic zooms</span></div>',
    voiceDelete: '🗑 Delete voice', selectedSegment: '🎞 Selected segment', speed: 'Speed',
    segDelete: '🗑 Delete segment', zoomMarker: '🔍 Zoom marker', zoomIn: 'In', zoomOut: 'Out',
    growLeft: '← Extend', growRight: 'Extend →', delete: '🗑 Delete',
    pickerTitle: 'Choose what to record', pickerSub: 'Pick a screen or window. Every click becomes an automatic zoom point.',
    androidRecord: 'Android over USB',
    androidRecordSub: d => `Record with adb screenrecord + getevent touch tracking • ${d.model || d.serial}`,
    cancel: 'Cancel', diagTitle: 'ZoomCut diagnostics', exportTitle: 'Exporting video…',
    exportSub: 'Rendering in real time. Keep this window visible until export finishes.',
    micDefault: 'Default microphone', micLoading: 'Loading mics...', micNoDevices: 'No microphones found', micGrant: 'Allow access to show all microphones…',
    camDefault: 'Default camera', camLoading: 'Loading cameras...', camNoDevices: 'No cameras found', camGrant: 'Allow access to show all cameras…',
    camOn: '📷 Camera', camOff: '📷 Camera off', cameraClip: n => `Camera ${n}`,
    cameraOverlay: '📷 Camera overlay', cameraDelete: '🗑 Delete camera', fadeIn: 'Fade in', fadeOut: 'Fade out',
    videoLane: 'Video', voiceLane: 'Voice', cameraLane: 'Camera',
    addVideoLane: 'Video lane', addVoiceLane: 'Voice lane', addCameraLane: 'Camera lane',
    lane: 'Lane', closePanel: 'Close edit panel',
    quickRecordTitle: 'Record now', quickRecordSub: 'Auto-pick Android, iPhone, or the main display',
    quickAddTitle: 'Add media', quickAddSub: 'First video becomes base; more videos become clips',
    quickVoiceTitle: 'Voice over', quickVoiceSub: 'Pick a mic, then record from the playhead',
    addOverlayVideo: 'Add overlay video',
    selectedOverlayVideo: 'Overlay video',
    confirmDeleteSegment: 'Delete this video segment?',
    confirmDeleteVideoClip: 'Delete this overlay video?',
    confirmDeleteVoice: 'Delete this voiceover clip?',
    confirmDeleteCamera: 'Delete this camera clip?',
    micPermission: 'Cannot open microphone. Check ZoomCut Microphone permission.',
    promptCancel: 'Cancel', promptOk: 'OK', presetPlaceholder: '— Select preset —',
    newConfirm: 'Start a new project? The current video, zoom points, and trims will be cleared.',
    oneSegmentRequired: 'At least one segment must remain.',
    exportRemuxing: 'Converting the file for smooth playback…',
    exportSegment: (i, n, done, total, speed) => `Segment ${i}/${n} • ${done} / ${total} — ${speed}x`,
    actionableSuffix: '\n\nIf you just granted macOS permissions, quit ZoomCut and open it again.',
  },
};
function tr(key, ...args) {
  const v = (I18N[state.lang] || I18N.th)[key];
  return typeof v === 'function' ? v(...args) : v;
}
function stateSnapshot() {
  return {
    segments: state.segments.map(s => ({ ...s })),
    selectedSeg: state.selectedSeg,
    videoClips: state.videoClips.map(v => ({ ...v })),
    selectedVideoId: state.selectedVideoId,
    events: state.events.map(e => ({ ...e })),
    selectedId: state.selectedId,
    voiceovers: state.voiceovers.map(v => ({ ...v })),
    selectedVoiceId: state.selectedVoiceId,
    facecams: state.facecams.map(v => ({ ...v })),
    selectedFaceId: state.selectedFaceId,
    crop: { ...state.crop },
    videoLaneCount: state.videoLaneCount,
    voiceLaneCount: state.voiceLaneCount,
    cameraLaneCount: state.cameraLaneCount,
  };
}
function restoreSnapshot(s) {
  state.segments = s.segments.map(x => ({ ...x }));
  state.selectedSeg = s.selectedSeg;
  state.videoClips = (s.videoClips || []).map(x => ({ ...x }));
  state.selectedVideoId = s.selectedVideoId || null;
  state.events = s.events.map(x => ({ ...x }));
  state.selectedId = s.selectedId;
  state.voiceovers = s.voiceovers.map(x => ({ ...x }));
  state.selectedVoiceId = s.selectedVoiceId;
  state.facecams = (s.facecams || []).map(x => ({ ...x }));
  state.selectedFaceId = s.selectedFaceId || null;
  state.crop = { ...s.crop };
  state.videoLaneCount = s.videoLaneCount || 1;
  state.voiceLaneCount = s.voiceLaneCount || 1;
  state.cameraLaneCount = s.cameraLaneCount || 1;
  syncCropUI();
  updateSegUI();
  updateTimelineUI();
  updateVoiceUI();
  updateCameraUI();
  requestRender();
}
function commitHistory() {
  if (!state.loaded) return;
  history.undo.push(stateSnapshot());
  if (history.undo.length > 80) history.undo.shift();
  history.redo.length = 0;
  markProjectDirty();
}
function undoEdit() {
  if (!history.undo.length) return;
  history.redo.push(stateSnapshot());
  restoreSnapshot(history.undo.pop());
}
function redoEdit() {
  if (!history.redo.length) return;
  history.undo.push(stateSnapshot());
  restoreSnapshot(history.redo.pop());
}
function applyTheme() {
  document.body.dataset.theme = state.theme;
  const nextThemeLabel = state.theme === 'dark'
    ? (state.lang === 'th' ? 'เปลี่ยนเป็นโหมดสว่าง' : 'Switch to light mode')
    : (state.lang === 'th' ? 'เปลี่ยนเป็นโหมดมืด' : 'Switch to dark mode');
  $('themeBtn').textContent = state.theme === 'dark' ? '☀️' : '🌙';
  $('themeBtn').title = nextThemeLabel;
  $('themeBtn').setAttribute('aria-label', nextThemeLabel);
}
function updateTimelineScale(anchorFrac = null) {
  const vp = $('timelineViewport');
  const before = anchorFrac === null ? null : vp.scrollWidth * anchorFrac - vp.scrollLeft;
  $('timelineContent').style.width = (state.timelineZoom * 100) + '%';
  if (before !== null) requestAnimationFrame(() => {
    vp.scrollLeft = Math.max(0, vp.scrollWidth * anchorFrac - before);
  });
}
function clearSelection() {
  state.selectedSeg = null;
  state.selectedVideoId = null;
  state.selectedId = null;
  state.selectedVoiceId = null;
  state.selectedFaceId = null;
  updateSegUI();
  updateTimelineUI();
  updateVoiceUI();
  updateCameraUI();
}
function selectOnly(kind, id) {
  state.selectedSeg = kind === 'seg' ? id : null;
  state.selectedVideoId = kind === 'videoClip' ? id : null;
  state.selectedId = kind === 'marker' ? id : null;
  state.selectedVoiceId = kind === 'voice' ? id : null;
  state.selectedFaceId = kind === 'camera' ? id : null;
  if (kind !== 'seg' && kind !== 'videoClip') $('segEdit').classList.remove('visible');
  if (kind !== 'marker') $('markerEdit').classList.remove('visible');
  if (kind !== 'voice') $('voiceEdit').classList.remove('visible');
  if (kind !== 'camera') $('cameraEdit').classList.remove('visible');
}
function renderLaneOptions(select, count, selected, labelKey) {
  select.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${tr(labelKey)} ${i + 1}`;
    if (i === selected) opt.selected = true;
    select.appendChild(opt);
  }
}
function laneConfig(kind, lane) {
  if (!state.laneSettings) state.laneSettings = { video: [], voice: [], camera: [] };
  if (!state.laneSettings[kind]) state.laneSettings[kind] = [];
  if (!state.laneSettings[kind][lane]) state.laneSettings[kind][lane] = { locked: false, muted: false, solo: false, hidden: false };
  return state.laneSettings[kind][lane];
}
function laneEnabled(kind, lane, purpose = 'display') {
  const configs = state.laneSettings?.[kind] || [];
  const cfg = laneConfig(kind, lane);
  if (configs.some(x => x?.solo) && !cfg.solo) return false;
  if (purpose === 'audio') return !cfg.muted;
  return !cfg.hidden;
}
function laneLabelHtml(kind, lane, labelKey) {
  const cfg = laneConfig(kind, lane);
  const labels = state.lang === 'th'
    ? { lock: 'ล็อกเลน', mute: 'ปิดเสียง', solo: 'เล่นเลนเดียว', hide: 'ซ่อนเลน' }
    : { lock: 'Lock lane', mute: 'Mute lane', solo: 'Solo lane', hide: 'Hide lane' };
  const kindLetter = kind === 'video' ? 'V' : kind === 'voice' ? 'A' : 'C';
  const name = `${tr(labelKey)} ${lane + 1}`;
  return `<div class="lane-label" data-lane-base="${kind}"><span class="lane-kind" aria-hidden="true">${kindLetter}</span><span class="lane-name" title="${name}">${name}</span><span class="lane-controls">`
    + `<button class="lane-tool lock${cfg.locked ? ' active' : ''}" data-lane-action="locked" title="${labels.lock}" aria-label="${labels.lock}" aria-pressed="${cfg.locked}"></button>`
    + `<button class="lane-tool${cfg.muted ? ' active' : ''}" data-lane-action="muted" title="${labels.mute}" aria-label="${labels.mute}" aria-pressed="${cfg.muted}">M</button>`
    + `<button class="lane-tool${cfg.solo ? ' active' : ''}" data-lane-action="solo" title="${labels.solo}" aria-label="${labels.solo}" aria-pressed="${cfg.solo}">S</button>`
    + `<button class="lane-tool visibility${cfg.hidden ? ' active' : ''}" data-lane-action="hidden" title="${labels.hide}" aria-label="${labels.hide}" aria-pressed="${cfg.hidden}">${cfg.hidden ? '○' : '●'}</button></span></div>`;
}
function bindLaneTools(groupId, kind, update) {
  $(groupId).addEventListener('click', e => {
    const button = e.target.closest('[data-lane-action]');
    if (!button) return;
    e.stopPropagation();
    const label = button.closest('[data-lane-base]');
    const row = label.closest('.lane-row');
    const lane = [...row.parentNode.children].indexOf(row);
    const key = button.dataset.laneAction;
    const cfg = laneConfig(kind, lane);
    cfg[key] = !cfg[key];
    markProjectDirty(); update(); requestRender();
  });
}
function laneFromPoint(groupId, trackClass, x, y) {
  const el = document.elementFromPoint(x, y);
  const track = el?.closest?.(`.${trackClass}`);
  if (!track || !$(groupId).contains(track)) return null;
  return parseInt(track.dataset.lane || '0', 10);
}
function applyLanguage() {
  $('langSel').value = state.lang;
  $('appHint').textContent = tr('hint');
  $('newBtn').textContent = tr('newJob');
  $('projectOpenBtn').textContent = tr('projectOpen');
  $('projectSaveBtn').textContent = tr('projectSave');
  $('exportCancel').textContent = tr('exportCancel');
  $('diagBtn').textContent = tr('diagnostics');
  if (!recState.recording) $('recBtn').textContent = tr('record');
  $('openBtn').textContent = tr('open');
  $('splitBtn').textContent = tr('split');
  if (!voiceRec.active) $('voiceBtn').textContent = tr('voice');
  $('camToggle').textContent = state.recordCamera ? tr('camOn') : tr('camOff');
  $('camToggle').classList.toggle('active', state.recordCamera);
  if (state.loaded) $('exportBtn').textContent = state.mode === 'video' ? tr('exportVideo') : tr('exportPng');
  else $('exportBtn').textContent = tr('exportVideo');
  if (video.paused) $('playBtn').textContent = tr('play');
  if ($('shortcutOverlay').classList.contains('visible')) openShortcutHelp();
  const textMap = [
    ['#sectionPreset', 'preset'], ['#sectionAspect', 'aspect'],
    ['#aspectRow [data-aspect="fit"]', 'fitFrame'], ['#sectionPosition', 'verticalPosition'],
    ['#posRow [data-pos="top"]', 'top'], ['#posRow [data-pos="center"]', 'center'], ['#posRow [data-pos="bottom"]', 'bottom'],
    ['#sectionFrame', 'deviceFrame'], ['#frameRow [data-frame="none"]', 'none'], ['#frameRow [data-frame="browser"]', 'browser'],
    ['#sectionStatusBar', 'statusBar'], ['#sbRow [data-sb="none"]', 'off'], ['#sbRow [data-sb="auto"]', 'auto'],
    ['#sbRow [data-sb="light"]', 'light'], ['#sbRow [data-sb="dark"]', 'dark'],
    ['#sectionTap', 'tapEffect'], ['#tapRow [data-tap="on"]', 'show'], ['#tapRow [data-tap="off"]', 'off'],
    ['#sectionBackground', 'background'], ['#bgImageBtn', 'imageBg'], ['#bgTransBtn', 'transparent'],
    ['#sectionVideoFrame', 'videoFrame'], ['label[for="padding"]', 'padding'],
    ['#sectionCrop', 'crop'], ['#cropReset', 'cropReset'], ['#cropToggle', 'cropGuide'],
    ['#sectionZoomDefaults', 'zoomDefaults'], ['#sectionImageExport', 'exportResolution'],
    ['#voiceDelete', 'voiceDelete'], ['#segDelete', 'segDelete'], ['#markerEdit > span:first-child', 'zoomMarker'],
    ['#mGrowL', 'growLeft'], ['#mGrowR', 'growRight'], ['#mDelete', 'delete'],
    ['#pickerOverlay h2', 'pickerTitle'], ['#pickerOverlay .sub', 'pickerSub'], ['#pickerCancel', 'cancel'],
    ['#diagOverlay h2', 'diagTitle'], ['#diagClose', 'close'], ['#exportOverlay h2', 'exportTitle'],
    ['#quickRecordTitle', 'quickRecordTitle'], ['#quickRecordSub', 'quickRecordSub'],
    ['#quickAddTitle', 'quickAddTitle'], ['#quickAddSub', 'quickAddSub'],
    ['#quickVoiceTitle', 'quickVoiceTitle'], ['#quickVoiceSub', 'quickVoiceSub'],
  ];
  for (const [sel, key] of textMap) {
    const el = document.querySelector(sel);
    if (el) el.textContent = tr(key);
  }
  updateRecordingReviewLanguage();
  $('pickerChangeSource').textContent = state.lang === 'th' ? 'เปลี่ยนแหล่ง' : 'Change source';
  $('pickerRecord').textContent = state.lang === 'th' ? '🔴 เริ่มอัด' : '🔴 Record';
  $('recordCountdown').previousElementSibling.textContent = state.lang === 'th' ? 'เริ่มอัดใน' : 'Start in';
  const fitFrame = document.querySelector('#aspectRow [data-aspect="fit"]');
  if (fitFrame) fitFrame.title = state.lang === 'th'
    ? 'พอดีเฟรม — เนื้อหาเต็มพื้นที่ ไม่มีพื้นหลังรอบ'
    : 'Fit frame — content fills the frame without surrounding background';
  for (const [id, key] of [['addVideoLane', 'addVideoLane'], ['addVoiceLane', 'addVoiceLane'], ['addCameraLane', 'addCameraLane']]) {
    $(id).querySelector('[data-lane-text]').textContent = tr(key);
  }
  const sliderLabels = [
    ['padding', 'padding'], ['radius', 'radius'], ['shadow', 'shadow'], ['cropT', 'cropTop'],
    ['cropB', 'cropBottom'], ['cropL', 'cropLeft'], ['cropR', 'cropRight'], ['defZoom', 'zoomLevel'],
    ['defHold', 'hold'], ['mZoom', 'zoomLevel'], ['mIn', 'zoomIn'], ['mHold', 'hold'], ['mOut', 'zoomOut'],
  ];
  for (const [inputId, key] of sliderLabels) {
    const label = document.querySelector(`label[for="${inputId}"]`)
      || $(inputId)?.closest('.slider-row, span')?.querySelector('label');
    if (label) {
      const translated = tr(key);
      label.textContent = translated + ' ';
      $(inputId)?.setAttribute('aria-label', translated);
    }
  }
  const gradientLabel = state.lang === 'th' ? ['gradient กำหนดเอง สี 1', 'gradient กำหนดเอง สี 2'] : ['Custom gradient color 1', 'Custom gradient color 2'];
  ['cg1', 'cg2'].forEach((id, index) => {
    const element = $(id);
    if (element) {
      element.title = gradientLabel[index];
      element.setAttribute('aria-label', gradientLabel[index]);
    }
  });
  const cropTip = $('cropTip');
  if (cropTip) cropTip.textContent = tr('cropTip');
  const tips = document.querySelectorAll('.sidebar > .tip');
  if (tips.length) tips[tips.length - 1].innerHTML = tr('helpTip');
  $('dropHint').innerHTML = tr('dropHint');
  $('presetSel').querySelector('option[value=""]').textContent = tr('presetPlaceholder');
  $('exportSub').textContent = tr('exportSub');
  $('shortcutBtn').title = tr('shortcuts');
  const controlHelp = state.lang === 'th'
    ? {
      newBtn: 'เริ่มงานชิ้นใหม่', projectOpenBtn: 'เปิดโปรเจกต์ ZoomCut', projectSaveBtn: 'บันทึกโปรเจกต์ ZoomCut',
      diagBtn: 'ตรวจระบบอัดหน้าจอ/ffmpeg/click hook', splitBtn: 'แบ่งท่อนตรงตำแหน่งหัวอ่าน',
    }
    : {
      newBtn: 'Start a new project', projectOpenBtn: 'Open ZoomCut project', projectSaveBtn: 'Save ZoomCut project',
      diagBtn: 'Check recording, ffmpeg, and click hook', splitBtn: 'Split at playhead',
    };
  for (const [id, title] of Object.entries(controlHelp)) {
    const element = $(id);
    if (element) {
      element.title = title;
      element.setAttribute('aria-label', title);
    }
  }
  const themeLabel = state.theme === 'dark' ? (state.lang === 'th' ? 'เปลี่ยนเป็นโหมดสว่าง' : 'Switch to light mode') : (state.lang === 'th' ? 'เปลี่ยนเป็นโหมดมืด' : 'Switch to dark mode');
  $('themeBtn').title = themeLabel;
  $('themeBtn').setAttribute('aria-label', themeLabel);
  const inspectorTitles = state.lang === 'th'
    ? {
      bgImageBtn: 'อัปโหลดรูปพื้นหลัง', bgTransBtn: 'พื้นหลังโปร่งใส (Export PNG)',
      cropToggle: 'สลับแสดง/ซ่อนขอบที่จะถูกตัด', debugToggle: 'แสดงพิกัด crop/source/camera สำหรับตรวจ zoom',
      presetSave: 'บันทึกค่าปัจจุบันเป็น preset', presetDel: 'ลบ preset ที่เลือก',
    }
    : {
      bgImageBtn: 'Upload background image', bgTransBtn: 'Transparent background (PNG export)',
      cropToggle: 'Show or hide the crop guide', debugToggle: 'Show crop/source/camera coordinates for zoom debugging',
      presetSave: 'Save current settings as a preset', presetDel: 'Delete selected preset',
    };
  for (const [id, title] of Object.entries(inspectorTitles)) {
    const element = $(id);
    if (element) {
      element.title = title;
      element.setAttribute('aria-label', title);
    }
  }
  $('snapBtn').title = state.lang === 'th' ? 'บันทึกเฟรมปัจจุบันเป็น PNG' : 'Save current frame as PNG';
  $('voiceBtn').title = state.lang === 'th' ? 'อัดเสียงบรรยายเริ่มที่ playhead' : 'Record voiceover starting at the playhead';
  $('micSel').title = state.lang === 'th' ? 'เลือกไมโครโฟน' : 'Choose microphone';
  $('camSel').title = state.lang === 'th' ? 'เลือกกล้อง' : 'Choose camera';
  $('cameraDelete').textContent = tr('cameraDelete');
  document.querySelectorAll('[data-lane-base="video"] .lane-name').forEach((el, i) => el.textContent = `${tr('videoLane')} ${i + 1}`);
  document.querySelectorAll('[data-lane-base="voice"] .lane-name').forEach((el, i) => el.textContent = `${tr('voiceLane')} ${i + 1}`);
  document.querySelectorAll('[data-lane-base="camera"] .lane-name').forEach((el, i) => el.textContent = `${tr('cameraLane')} ${i + 1}`);
  document.querySelectorAll('.panel-close').forEach(btn => btn.title = tr('closePanel'));
  document.querySelectorAll('#segEdit label, #voiceEdit label, #cameraEdit label').forEach(label => {
    if (label.closest('span')?.querySelector('#segLane, #voiceLane, #cameraLane')) label.textContent = tr('lane') + ' ';
  });
  const camPanel = document.querySelector('#cameraEdit > span:first-child');
  if (camPanel) camPanel.textContent = tr('cameraOverlay');
  const fadeLabels = [['camFadeIn', 'fadeIn'], ['camFadeOut', 'fadeOut']];
  for (const [inputId, key] of fadeLabels) {
    const label = $(inputId)?.closest('span')?.querySelector('label');
    if (label) label.textContent = tr(key) + ' ';
  }
  $('urlText').placeholder = 'yourwebsite.com';
  const cursorLabels = state.lang === 'th'
    ? { gradient: 'ไล่สี', color: 'สี', image: 'รูป', video: 'วิดีโอ', soft: 'นุ่ม', outline: 'เส้นขอบ', classic: 'คลาสสิก', shadow: 'เงา', solid: 'ทึบ', dot: 'จุด', pointer: 'ตัวชี้', ripple: 'ระลอก', none: 'ปิด', ring: 'วงแหวน', pulse: 'พัลส์', target: 'เป้า', reset: '↺ ล้าง cursor' }
    : { gradient: 'Gradient', color: 'Color', image: 'Image', video: 'Video', soft: 'Soft', outline: 'Outline', classic: 'Classic', shadow: 'Shadow', solid: 'Solid', dot: 'Dot', pointer: 'Pointer', ripple: 'Ripple', none: 'None', ring: 'Ring', pulse: 'Pulse', target: 'Target', reset: '↺ Reset cursor' };
  document.querySelectorAll('#bgTypeRow [data-bg-type]').forEach(button => { if (cursorLabels[button.dataset.bgType]) button.textContent = cursorLabels[button.dataset.bgType]; });
  document.querySelectorAll('#cursorStyleRow [data-cursor-style], #cursorEffectRow [data-cursor-effect]').forEach(button => { const key = button.dataset.cursorStyle || button.dataset.cursorEffect; if (cursorLabels[key]) button.textContent = cursorLabels[key]; });
  $('cursorReset').textContent = cursorLabels.reset;
  syncBgActive();
  updateTimelineUI();
  updateSegUI();
  updateVoiceUI();
  updateCameraUI();
  if (!$('recordingHud').hidden) setRecordingHud($('recordingHud').dataset.mode, {
    elapsed: Number($('recordingHud').dataset.elapsed) || 0,
    clicks: Number($('recordingHud').dataset.clicks) || 0,
  });
  updatePreviewTransport();
  queueMicrotask(() => globalThis.refreshEditorShellIcons?.());
}

const PHONE_COLORS = [
  ['#2e2c2e', 'Space Black'], ['#bebdb9', 'Natural Titanium'],
  ['#f5f4f2', 'White'], ['#c2a58a', 'Desert'], ['#394a5c', 'Blue'],
];

const BACKGROUNDS = [
  ['#667eea', '#764ba2'], ['#f093fb', '#f5576c'], ['#4facfe', '#00f2fe'],
  ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#30cfd0', '#330867'],
  ['#0f0c29', '#302b63'], ['#232526', '#414345'],
];

// ---------- Background swatches ----------
const bgGrid = $('bgGrid');
BACKGROUNDS.forEach((g, i) => {
  const d = document.createElement('button');
  d.type = 'button';
  d.className = 'bg-swatch' + (i === state.bg ? ' active' : '');
  d.setAttribute('role', 'radio');
  d.setAttribute('aria-checked', i === state.bg ? 'true' : 'false');
  d.tabIndex = i === state.bg ? 0 : -1;
  d.style.background = `linear-gradient(135deg, ${g[0]}, ${g[1]})`;
  d.onclick = () => {
    state.bg = i;
    state.bgType = 'preset';
    state.background = { ...state.background, type: 'gradient', value: i, colors: g.slice(), color: state.bgColor };
    syncBgActive();
    requestRender();
    markProjectDirty();
  };
  bgGrid.appendChild(d);
});
bgGrid.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) return;
  const options = [...bgGrid.querySelectorAll('.bg-swatch')];
  const current = options.indexOf(document.activeElement);
  if (current < 0) return;
  const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next = options[(current + direction + options.length) % options.length];
  event.preventDefault();
  next.click();
  next.focus();
});

function syncBgActive() {
  bgGrid.querySelectorAll('.bg-swatch').forEach((el, j) => {
    const active = (state.bgType === 'preset' || state.bgType === 'gradient' || state.bgType === 'custom') && j === state.bg;
    el.classList.toggle('active', active);
    el.setAttribute('aria-checked', active ? 'true' : 'false');
    el.tabIndex = active ? 0 : -1;
    el.setAttribute('aria-label', `${state.lang === 'th' ? 'พื้นหลังไล่สี' : 'Gradient background'} ${j + 1}`);
  });
  $('bgImageBtn').classList.toggle('active', state.bgType === 'image');
  $('bgTransBtn').classList.toggle('active', state.bgType === 'transparent');
  const type = state.bgType === 'image' ? 'image' : state.bgType === 'color' ? 'color' : 'gradient';
  setChipRow('bgTypeRow', 'bgType', type);
}

$('bgTypeRow').addEventListener('click', e => {
  const button = e.target.closest('[data-bg-type]');
  if (!button || button.disabled) return;
  const type = button.dataset.bgType;
  if (type === 'gradient') state.bgType = state.bgType === 'custom' ? 'custom' : 'preset';
  else if (type === 'color') state.bgType = 'color';
  else if (type === 'image') state.bgType = 'image';
  state.background = { ...state.background, type, value: state.bg, color: state.bgColor, colors: [$('cg1').value, $('cg2').value] };
  syncBgActive(); requestRender(); markProjectDirty();
});
$('bgColor').addEventListener('input', e => { state.bgColor = e.target.value; state.bgType = 'color'; state.background = { ...state.background, type: 'color', color: state.bgColor, value: state.bg }; syncBgActive(); requestRender(); markProjectDirty(); });
$('cg1').addEventListener('input', () => { state.bgType = 'custom'; state.background = { ...state.background, type: 'gradient', colors: [$('cg1').value, $('cg2').value], value: state.bg }; syncBgActive(); requestRender(); markProjectDirty(); });
$('cg2').addEventListener('input', () => { state.bgType = 'custom'; state.background = { ...state.background, type: 'gradient', colors: [$('cg1').value, $('cg2').value], value: state.bg }; syncBgActive(); requestRender(); markProjectDirty(); });
$('bgTransBtn').onclick = () => { state.bgType = 'transparent'; state.background = { ...state.background, type: 'transparent', value: state.bg }; syncBgActive(); requestRender(); markProjectDirty(); };
$('bgImageBtn').onclick = () => $('bgImageInput').click();
$('bgImageInput').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { state.bgImageEl = img; state.bgType = 'image'; state.background = { ...state.background, type: 'image', value: f.name || 'local-image' }; syncBgActive(); requestRender(); markProjectDirty(); };
  img.src = URL.createObjectURL(f);
};
$('bgBlur').addEventListener('input', e => { const value = parseFloat(e.target.value) || 0; state.background = { ...state.background, blur: value }; $('bgBlurVal').textContent = String(value); requestRender(); markProjectDirty(); });

// ---------- ตัวช่วยผูก chip row ----------
function bindChips(rowId, attr, cb) {
  $(rowId).addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c || c.dataset[attr] === undefined) return;
    $(rowId).querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
    cb(c.dataset[attr]);
    requestRender();
  });
}
function setChipRow(rowId, attr, val) {
  $(rowId).querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('active', c.dataset[attr] === String(val)));
}

bindChips('posRow', 'pos', v => state.posV = v);
bindChips('sbRow', 'sb', v => state.statusBar = v);
bindChips('tapRow', 'tap', v => state.showTaps = v === 'on');
bindChips('scaleRow', 'scale', v => state.exportScale = parseInt(v));
$('videoExportPreset').value = String(state.videoExportScale);
$('videoExportPreset').onchange = e => { state.videoExportScale = parseFloat(e.target.value) || 1; markProjectDirty(); };
bindChips('zoomStyleRow', 'zoomStyle', v => {
  state.zoomStyle = v;
  const z = currentZoomStyle();
  if (!z.tapOnly) {
    state.defZoom = z.zoom;
    state.defHold = z.hold;
    $('defZoom').value = state.defZoom;
    $('defZoomVal').textContent = state.defZoom.toFixed(1) + 'x';
    $('defHold').value = state.defHold;
    $('defHoldVal').textContent = state.defHold.toFixed(1) + 's';
  }
});
bindChips('frameRow', 'frame', v => {
  state.frame = v;
  $('phoneColors').style.display = v === 'iphone' ? 'flex' : 'none';
  $('urlText').style.display = v === 'browser' ? 'block' : 'none';
  if (state.aspect === 'fit') setCanvasForAspect(); // เฟรมเปลี่ยนสัดส่วนกรอบรวม
});
$('frameReset').onclick = () => {
  state.frame = 'none'; state.frameColor = PHONE_COLORS[0][0]; state.padding = 0; state.radius = 3; state.shadow = 60;
  setChipRow('frameRow', 'frame', 'none');
  $('phoneColors').style.display = 'none'; $('urlText').style.display = 'none';
  for (const [id, value, suffix] of [['padding', 0, '%'], ['radius', 3, '%'], ['shadow', 60, '']]) { $(id).value = value; $(id + 'Val').textContent = value + suffix; }
  if (state.aspect === 'fit') setCanvasForAspect();
  requestRender(); markProjectDirty();
};

function syncCursorUI() {
  const settings = state.cursorSettings || {};
  setChipRow('cursorStyleRow', 'cursorStyle', settings.style || 'soft');
  setChipRow('cursorEffectRow', 'cursorEffect', settings.clickEffect || 'ripple');
  for (const [id, value, text] of [['cursorSize', settings.size || 1, `${Number(settings.size || 1).toFixed(1)}x`], ['cursorSmoothing', settings.smoothing ?? .65, `${Math.round((settings.smoothing ?? .65) * 100)}%`], ['cursorBounce', settings.clickBounce ?? 1, Number(settings.clickBounce ?? 1).toFixed(1)], ['cursorSway', settings.sway ?? 0, Number(settings.sway ?? 0).toFixed(1)]]) {
    $(id).value = value; $(id + 'Val').textContent = text;
  }
}
bindChips('cursorStyleRow', 'cursorStyle', v => { state.cursorSettings.style = v; markProjectDirty(); });
bindChips('cursorEffectRow', 'cursorEffect', v => { state.cursorSettings.clickEffect = v; markProjectDirty(); });
$('cursorSize').addEventListener('input', e => { state.cursorSettings.size = parseFloat(e.target.value); $('cursorSizeVal').textContent = state.cursorSettings.size.toFixed(1) + 'x'; requestRender(); markProjectDirty(); });
$('cursorSmoothing').addEventListener('input', e => { state.cursorSettings.smoothing = parseFloat(e.target.value); $('cursorSmoothingVal').textContent = Math.round(state.cursorSettings.smoothing * 100) + '%'; requestRender(); markProjectDirty(); });
$('cursorBounce').addEventListener('input', e => { state.cursorSettings.clickBounce = parseFloat(e.target.value); $('cursorBounceVal').textContent = state.cursorSettings.clickBounce.toFixed(1); requestRender(); markProjectDirty(); });
$('cursorSway').addEventListener('input', e => { state.cursorSettings.sway = parseFloat(e.target.value); $('cursorSwayVal').textContent = state.cursorSettings.sway.toFixed(1); requestRender(); markProjectDirty(); });
$('cursorReset').onclick = () => { state.cursorSettings = { ...ZoomCutCore.DEFAULT_CURSOR_SETTINGS }; syncCursorUI(); requestRender(); markProjectDirty(); };

const phoneColorsRow = $('phoneColors');
PHONE_COLORS.forEach(([hex, name], i) => {
  const d = document.createElement('div');
  d.className = 'phone-swatch' + (i === 0 ? ' active' : '');
  d.style.background = hex;
  d.title = name;
  d.onclick = () => {
    state.frameColor = hex;
    phoneColorsRow.querySelectorAll('.phone-swatch').forEach(x => x.classList.toggle('active', x === d));
    requestRender();
  };
  phoneColorsRow.appendChild(d);
});

$('urlText').addEventListener('input', e => { state.urlText = e.target.value; requestRender(); });

// ---------- Presets (localStorage) ----------
const PRESET_KEY = 'zoomcut-presets';
const PRESET_FIELDS = ['aspect', 'posV', 'bg', 'bgType', 'padding', 'radius', 'shadow',
  'frame', 'frameColor', 'urlText', 'statusBar', 'showTaps', 'defZoom', 'defHold', 'exportScale', 'bgColor'];

function loadPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; } catch { return {}; } }
function refreshPresetList(selected) {
  const sel = $('presetSel');
  sel.innerHTML = `<option value="">${tr('presetPlaceholder')}</option>`;
  for (const name of Object.keys(loadPresets())) {
    const o = document.createElement('option');
    o.value = o.textContent = name;
    if (name === selected) o.selected = true;
    sel.appendChild(o);
  }
}
refreshPresetList();

// prompt() ไม่รองรับใน Electron → ใช้ modal เอง
function zcPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:200';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px;width:360px';
    box.innerHTML = `<div style="font-size:14px;margin-bottom:10px">${message}</div>
      <input type="text" class="url-input" style="margin-top:0" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="btn small" data-act="cancel">${tr('promptCancel')}</button>
        <button class="btn small primary" data-act="ok">${tr('promptOk')}</button></div>`;
    ov.appendChild(box);
    document.body.appendChild(ov);
    const input = box.querySelector('input');
    input.value = defaultValue;
    input.focus(); input.select();
    const close = (val) => { ov.remove(); resolve(val); };
    box.querySelector('[data-act=ok]').onclick = () => close(input.value.trim() || null);
    box.querySelector('[data-act=cancel]').onclick = () => close(null);
    ov.addEventListener('click', e => { if (e.target === ov) close(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    });
  });
}

$('presetSave').onclick = async () => {
  const name = await zcPrompt(state.lang === 'th' ? 'ตั้งชื่อ preset:' : 'Preset name:', $('presetSel').value || 'My preset');
  if (!name) return;
  const all = loadPresets();
  const s = {};
  for (const k of PRESET_FIELDS) s[k] = state[k];
  if (s.bgType === 'image') s.bgType = 'preset'; // รูปพื้นหลังบันทึกลง preset ไม่ได้
  s.crop = { ...state.crop }; // เก็บค่าตัดขอบ (สำเนา ไม่ผูก reference)
  s._cg1 = $('cg1').value; s._cg2 = $('cg2').value;
  all[name] = s;
  localStorage.setItem(PRESET_KEY, JSON.stringify(all));
  refreshPresetList(name);
};
$('presetDel').onclick = () => {
  const name = $('presetSel').value;
  if (!name) return;
  const all = loadPresets();
  delete all[name];
  localStorage.setItem(PRESET_KEY, JSON.stringify(all));
  refreshPresetList();
};
$('presetSel').onchange = e => {
  const s = loadPresets()[e.target.value];
  if (s) applySettings(s);
};

function applySettings(s) {
  for (const k of PRESET_FIELDS) if (s[k] !== undefined) state[k] = s[k];
  if (s.crop) { state.crop = { t: s.crop.t || 0, r: s.crop.r || 0, b: s.crop.b || 0, l: s.crop.l || 0 }; syncCropUI(); }
  if (s._cg1) $('cg1').value = s._cg1;
  if (s._cg2) $('cg2').value = s._cg2;
  if (s.bgColor) state.bgColor = s.bgColor;
  // sync UI ทั้งหมด
  setCanvasForAspect();
  setChipRow('aspectRow', 'aspect', state.aspect);
  setChipRow('posRow', 'pos', state.posV);
  setChipRow('frameRow', 'frame', state.frame);
  setChipRow('sbRow', 'sb', state.statusBar);
  setChipRow('tapRow', 'tap', state.showTaps ? 'on' : 'off');
  setChipRow('scaleRow', 'scale', state.exportScale);
  $('phoneColors').style.display = state.frame === 'iphone' ? 'flex' : 'none';
  $('urlText').style.display = state.frame === 'browser' ? 'block' : 'none';
  $('urlText').value = state.urlText;
  $('videoExportPreset').value = String(state.videoExportScale || 1);
  $('bgColor').value = state.bgColor || state.background?.color || '#151821';
  $('bgBlur').value = state.background?.blur || 0;
  $('bgBlurVal').textContent = String(state.background?.blur || 0);
  phoneColorsRow.querySelectorAll('.phone-swatch').forEach((x, i) =>
    x.classList.toggle('active', PHONE_COLORS[i][0] === state.frameColor));
  for (const [id, key, fmt] of [['padding', 'padding', v => v + '%'], ['radius', 'radius', v => v + '%'],
    ['shadow', 'shadow', v => v], ['defZoom', 'defZoom', v => v.toFixed(1) + 'x'], ['defHold', 'defHold', v => v.toFixed(1) + 's']]) {
    $(id).value = state[key];
    $(id + 'Val').textContent = fmt(state[key]);
  }
  syncBgActive();
  syncCursorUI();
  requestRender();
}

// ---------- Controls ----------
// ปรับขนาด canvas ตามสัดส่วน — โหมด "fit" คำนวณให้เนื้อหา (วิดีโอหลัง crop + เฟรม) เต็มพอดี
function setCanvasForAspect() {
  if (state.aspect !== 'fit') {
    const [w, h] = ASPECTS[state.aspect];
    canvas.width = w; canvas.height = h;
    return;
  }
  const m = media();
  const va = m ? m.w / m.h : 9 / 16;
  const bf = state.frame === 'iphone' ? 0.035 : 0;
  const tf = state.frame === 'browser' ? 0.075 : 0;
  const outerAspect = (1 + 2 * bf) / (1 / va + 2 * bf + tf); // กว้าง/สูง ของกรอบรวม
  const MAX = 1920;
  let W, H;
  if (outerAspect >= 1) { W = MAX; H = Math.round(MAX / outerAspect); }
  else { H = MAX; W = Math.round(MAX * outerAspect); }
  canvas.width = Math.max(2, W - (W % 2));
  canvas.height = Math.max(2, H - (H % 2));
}
$('aspectRow').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.aspect = chip.dataset.aspect;
  document.querySelectorAll('#aspectRow .chip').forEach(c => c.classList.toggle('active', c === chip));
  setCanvasForAspect();
  requestRender();
});

function bindSlider(id, key, valId, fmt) {
  $(id).addEventListener('input', e => {
    state[key] = parseFloat(e.target.value);
    $(valId).textContent = fmt(state[key]);
    requestRender();
  });
}
bindSlider('padding', 'padding', 'paddingVal', v => v + '%');
bindSlider('radius', 'radius', 'radiusVal', v => v + '%');
bindSlider('shadow', 'shadow', 'shadowVal', v => v);
bindSlider('defZoom', 'defZoom', 'defZoomVal', v => v.toFixed(1) + 'x');
bindSlider('defHold', 'defHold', 'defHoldVal', v => v.toFixed(1) + 's');

// ---------- Crop (ตัดขอบ) ----------
let showCropGuide = false;
function bindCrop(id, edge, valId) {
  $(id).addEventListener('input', e => {
    state.crop[edge] = parseFloat(e.target.value) / 100;
    $(valId).textContent = e.target.value + '%';
    if (state.aspect === 'fit') setCanvasForAspect(); // crop เปลี่ยนสัดส่วน → ปรับ canvas
    requestRender();
  });
}
bindCrop('cropT', 't', 'cropTVal');
bindCrop('cropB', 'b', 'cropBVal');
bindCrop('cropL', 'l', 'cropLVal');
bindCrop('cropR', 'r', 'cropRVal');
function syncCropUI() {
  for (const [id, edge, valId] of [['cropT','t','cropTVal'],['cropB','b','cropBVal'],['cropL','l','cropLVal'],['cropR','r','cropRVal']]) {
    $(id).value = state.crop[edge] * 100;
    $(valId).textContent = (state.crop[edge] * 100).toFixed(1).replace(/\.0$/,'') + '%';
  }
}
$('cropReset').onclick = () => { state.crop = { t: 0, r: 0, b: 0, l: 0 }; syncCropUI(); if (state.aspect === 'fit') setCanvasForAspect(); requestRender(); };
$('cropToggle').onclick = () => {
  showCropGuide = !showCropGuide;
  $('cropToggle').classList.toggle('active', showCropGuide);
  requestRender();
};
$('debugToggle').onclick = () => {
  state.debugOverlay = !state.debugOverlay;
  $('debugToggle').classList.toggle('active', state.debugOverlay);
  requestRender();
};

// ---------- File loading ----------
$('openBtn').onclick = () => $('fileInput').click();
$('quickAddMedia').onclick = () => $('fileInput').click();
$('quickRecord').onclick = () => startSmartRecording();
$('quickVoice').onclick = () => $('voiceBtn').click();
async function authorizeUserFiles(files) {
  if (!desktop) return true;
  try {
    await Promise.all(files.map(file => desktop.project.authorizeFile(file)));
    return true;
  } catch (error) {
    showActionableError(error?.message || (state.lang === 'th'
      ? 'ไม่สามารถเปิดไฟล์ที่เลือกได้'
      : 'Unable to open the selected file'));
    return false;
  }
}
$('fileInput').onchange = async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  if (!await authorizeUserFiles(files)) return;
  handleMediaFiles(files);
  e.target.value = '';
};

function fileSource(file) {
  let sourcePath = '';
  try { sourcePath = desktop?.getPathForFile(file) || ''; } catch {}
  return { sourcePath, name: file.name || '', type: file.type || '' };
}

async function registerMediaSource(sourcePath) {
  if (!desktop || !sourcePath) throw new Error(tr('projectMissing'));
  return desktop.project.registerProjectPath(sourcePath);
}

function handleMediaFiles(files) {
  const json = files.find(f => f.name.endsWith('.json'));
  const images = files.filter(f => f.type.startsWith('image/'));
  const videos = files.filter(f => f.type.startsWith('video/'));
  if (!state.loaded) {
    if (videos[0]) { pendingOverlayFiles = videos.slice(1); loadFile(videos[0], json); return; }
    if (images[0]) { loadImage(images[0]); return; }
  }
  for (const f of videos) addVideoClip(f);
  if (!videos.length && images[0]) loadImage(images[0]);
  if (json && state.loaded) importClicks(json);
}

const stage = $('stage');
stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', async e => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const files = [...e.dataTransfer.files];
  if (!await authorizeUserFiles(files)) return;
  const vid = files.find(f => f.type.startsWith('video/'));
  const img = files.find(f => f.type.startsWith('image/'));
  const json = files.find(f => f.name.endsWith('.json'));
  if (vid || img) handleMediaFiles(files);
  else if (json && state.loaded) importClicks(json);
});

function addVideoClip(file) {
  if (!state.loaded || state.mode !== 'video') { loadFile(file); return; }
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.onloadedmetadata = () => {
    commitHistory();
    const outStart = Math.min(Math.max(0, sourceToOutputTime(video.currentTime)), Math.max(0, outputDuration() - 0.1));
    const outDuration = Math.min(v.duration || 3, Math.max(0.1, outputDuration() - outStart));
    const lane = Math.max(1, state.videoLaneCount - 1);
    state.videoClips.push({
      id: videoClipId++,
      outStart,
      outDuration,
      mediaOffset: 0,
      lane,
      url,
      video: v,
      name: file.name || tr('videoClip', videoClipId - 1),
      ...fileSource(file),
      opacity: 1,
      scale: 100,
      posX: 50,
      posY: 50,
      volume: 1,
      muted: false,
    });
    state.videoLaneCount = Math.max(state.videoLaneCount, lane + 1);
    selectOnly('videoClip', videoClipId - 1);
    updateSegUI();
    requestRender();
  };
}

// สร้างจุดซูมอัตโนมัติจาก clicks.json ที่ได้จาก record.py
async function importClicks(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert(state.lang === 'th' ? 'อ่านไฟล์ clicks.json ไม่ได้' : 'Cannot read clicks.json'); return; }
  const clicks = data.clicks || [];
  // v2 recordings carry a normalized pointer stream; v1 imports remain valid
  // and intentionally recover with an empty cursor timeline.
  state.cursorPoints = (data.version >= 2 && Array.isArray(data.cursor) ? data.cursor : [])
    .filter(point => Number.isFinite(Number(point.t)) && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
    .map(point => ({ t: Math.max(0, Number(point.t)), x: clamp(Number(point.x), 0, 1), y: clamp(Number(point.y), 0, 1), kind: 'move' }));
  state.taps = clicks.map(c => ({ t: c.t, x: c.x, y: c.y })); // ทุกคลิกกลายเป็น ripple
  state.events = [];
  for (const c of clicks) {
    const z = currentZoomStyle();
    if (z.tapOnly) continue;
    const last = state.events[state.events.length - 1];
    const dist = last ? Math.hypot(c.x - last.x, c.y - last.y) : 1;
    if (last && c.t < last.start + last.tIn + last.hold + z.mergeWindow && dist < z.mergeDist) {
      // คลิกซ้ำใกล้ๆ จุดเดิม → ยืดช่วงค้างของซูมเดิมแทนการซูมใหม่
      last.hold = Math.max(last.hold, c.t - last.start - last.tIn + z.hold);
    } else {
      state.events.push({
        id: nextId++,
        start: Math.max(0, c.t - 0.35),
        x: c.x, y: c.y,
        zoom: state.defZoom,
        tIn: z.tIn, hold: state.defHold, tOut: z.tOut,
      });
    }
  }
  state.selectedId = null;
  updateTimelineUI();
  requestRender();
  if (clicks.length) $('zoomCount').textContent = state.lang === 'th'
    ? `🔍 ${state.events.length} จุดซูม (จาก ${clicks.length} คลิก)`
    : `🔍 ${state.events.length} zooms (${clicks.length} clicks)`;
}

function enterLoadedUI() {
  const isVideo = state.mode === 'video';
  canvas.style.display = '';
  $('dropHint').style.display = 'none';
  $('exportBtn').disabled = false;
  $('videoExportPreset').disabled = !isVideo;
  $('snapBtn').disabled = false;
  $('playBtn').disabled = !isVideo;
  $('splitBtn').disabled = !isVideo;
  $('voiceBtn').disabled = !isVideo;
  $('quickVoice').disabled = !isVideo;
  $('projectSaveBtn').disabled = !desktop;
  $('exportBtn').textContent = isVideo ? tr('exportVideo') : tr('exportPng');
  $('imgExportSec').style.display = isVideo ? 'none' : '';
  document.querySelector('.timeline-area').style.display = isVideo ? '' : 'none';
  $('editorShell').classList.toggle('timeline-hidden', !isVideo);
  $('previewTransport').hidden = !isVideo;
  updatePreviewTransport();
  updateTimelineScale();
  queueMicrotask(() => globalThis.refreshEditorShellIcons?.());
}

function loadImage(file) {
  const img = new Image();
  img.onload = () => {
    state.mode = 'image';
    state.imageEl = img;
    state.loaded = true;
    state.baseMedia = fileSource(file);
    state.events = [];
    state.taps = [];
    state.cursorPoints = [];
    state.annotations = [];
    state.annotationLaneCount = 1;
    state.voiceovers = [];
    state.selectedVoiceId = null;
    state.videoClips = [];
    state.selectedVideoId = null;
    state.facecams = [];
    state.selectedFaceId = null;
    state.videoLaneCount = 1;
    state.voiceLaneCount = 1;
    state.cameraLaneCount = 1;
    state.laneSettings = { video: [], voice: [], camera: [] };
    state.selectedId = null;
    state.crop = { t: 0, r: 0, b: 0, l: 0 };
    syncCropUI();
    video.pause();
    enterLoadedUI();
    const portrait = img.naturalHeight > img.naturalWidth;
    document.querySelector(`#aspectRow .chip[data-aspect="${portrait ? '4:5' : '16:9'}"]`).click();
    requestRender();
  };
  img.src = URL.createObjectURL(file);
}

function loadFile(file, clicksFile) {
  loadVideoSource(URL.createObjectURL(file), fileSource(file), clicksFile);
}

function loadVideoSource(url, source, clicksFile, onLoaded) {
  video.src = url;
  video.onloadedmetadata = () => {
    state.mode = 'video';
    state.loaded = true;
    state.baseMedia = { ...(source || {}), url };
    state.events = [];
    state.taps = [];
    state.cursorPoints = [];
    state.annotations = [];
    state.annotationLaneCount = 1;
    state.voiceovers = [];
    state.selectedVoiceId = null;
    state.videoClips = [];
    state.selectedVideoId = null;
    state.facecams = [];
    state.selectedFaceId = null;
    state.videoLaneCount = 1;
    state.voiceLaneCount = 1;
    state.cameraLaneCount = 1;
    state.laneSettings = { video: [], voice: [], camera: [] };
    state.selectedId = null;
    state.crop = { t: 0, r: 0, b: 0, l: 0 };
    syncCropUI();
    initSegments();
    video.playbackRate = 1;
    enterLoadedUI();
    // auto-pick aspect matching the source orientation
    const portrait = video.videoHeight > video.videoWidth;
    const target = portrait ? '9:16' : '16:9';
    document.querySelector(`#aspectRow .chip[data-aspect="${target}"]`).click();
    video.currentTime = 0;
    updateTimelineUI();
    requestRender();
    if (clicksFile) importClicks(clicksFile);
    if (pendingOverlayFiles.length) {
      const queued = pendingOverlayFiles.splice(0);
      queued.forEach(addVideoClip);
    }
    if (onLoaded) onLoaded();
  };
}

let autosaveTimer = null;
let autosaveBusy = false;
function setProjectStatus(text) { $('projectStatus').textContent = text || ''; }
function markProjectDirty() {
  if (!state.loaded || !desktop) return;
  state.dirty = true;
  setProjectStatus('•');
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => autosaveProject(), 1200);
}

function assetExtension(blob, fallback) {
  const type = String(blob?.type || '');
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('wav')) return 'wav';
  if (type.includes('ogg')) return 'ogg';
  return fallback;
}

async function persistRecordedAssets() {
  if (!desktop) return;
  const pending = [...state.voiceovers, ...state.facecams].filter(x => !x.sourcePath && x.blob);
  for (const clip of pending) {
    const oldUrl = clip.url;
    const stored = await desktop.project.persistAsset(await clip.blob.arrayBuffer(), assetExtension(clip.blob, 'webm'));
    clip.sourcePath = stored.path;
    clip.url = stored.url;
    if (state.voiceovers.includes(clip)) clip.audio = new Audio(stored.url);
    else {
      const element = document.createElement('video');
      element.src = stored.url; element.muted = true; element.playsInline = true;
      clip.video = element;
    }
    clip.blob = null;
    if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
  }
}

async function projectDocument() {
  await persistRecordedAssets();
  const document = ZoomCutCore.createProject(state, { createdAt: state.projectCreatedAt });
  state.projectCreatedAt = document.createdAt;
  return document;
}

async function autosaveProject() {
  if (!desktop || !state.loaded || autosaveBusy || !state.baseMedia?.sourcePath) return;
  autosaveBusy = true;
  try {
    await desktop.project.autosave(await projectDocument());
    state.dirty = false;
    setProjectStatus(tr('projectAutosaved'));
  } catch (error) {
    setProjectStatus(error.message || 'Autosave failed');
  } finally {
    autosaveBusy = false;
  }
}

async function saveProject() {
  if (!desktop || !state.loaded) return;
  try {
    const result = await desktop.project.save(await projectDocument());
    if (result.canceled) return;
    state.projectPath = result.path;
    state.dirty = false;
    setProjectStatus(tr('projectSaved'));
  } catch (error) { showActionableError(error.message); }
}

function replaceMissingPath(document, missing, replacement) {
  const update = item => {
    if (item && (item.id === missing.id || missing.kind === 'base')) item.sourcePath = replacement.path;
  };
  if (missing.kind === 'base') update(document.baseMedia);
  if (missing.kind === 'video') (document.state.videoClips || []).forEach(update);
  if (missing.kind === 'voice') (document.state.voiceovers || []).forEach(update);
  if (missing.kind === 'camera') (document.state.facecams || []).forEach(update);
  document.mediaPaths = ZoomCutCore.collectMediaPaths(document);
}

async function relinkMissingMedia(document, missingItems) {
  for (const missing of missingItems || []) {
    const replacement = await desktop.project.chooseReplacement(missing.name || missing.path);
    if (replacement.canceled) return false;
    replaceMissingPath(document, missing, replacement);
  }
  return true;
}

async function hydrateClip(clip, kind) {
  const registered = await registerMediaSource(clip.sourcePath);
  clip.url = registered.url;
  if (kind === 'voice') clip.audio = new Audio(registered.url);
  else {
    const element = document.createElement('video');
    element.src = registered.url; element.muted = true; element.playsInline = true; element.preload = 'auto';
    clip.video = element;
  }
  return clip;
}

async function restoreProject(document, projectPath, recovered = false) {
  document = ZoomCutCore.validateProject(document);
  const base = await registerMediaSource(document.baseMedia.sourcePath);
  loadVideoSource(base.url, { ...document.baseMedia, url: base.url }, null, async () => {
    try {
      const saved = document.state;
      const settings = document.settings || {};
      Object.assign(state, settings);
      // New v2 aliases are intentionally projected back onto the legacy
      // renderer fields until the cursor/annotation UI is implemented.
      if (settings.background && typeof settings.background === 'object') {
        if (settings.background.type) state.bgType = settings.background.type;
        if (settings.background.value !== undefined) state.bg = settings.background.value;
        if (settings.background.color) state.bgColor = settings.background.color;
        if (Array.isArray(settings.background.colors)) {
          state.background = { ...state.background, colors: settings.background.colors.slice(0, 4) };
          if (settings.background.colors[0]) $('cg1').value = settings.background.colors[0];
          if (settings.background.colors[1]) $('cg2').value = settings.background.colors[1];
        }
      }
      if (settings.frameStyle !== undefined) {
        state.frame = typeof settings.frameStyle === 'string' ? settings.frameStyle : (settings.frameStyle.type || state.frame);
        if (typeof settings.frameStyle === 'object') {
          state.padding = settings.frameStyle.padding ?? state.padding;
          state.radius = settings.frameStyle.radius ?? state.radius;
          state.shadow = settings.frameStyle.shadow ?? state.shadow;
        }
      }
      state.segments = saved.segments.map(x => ({ ...x }));
      state.events = (saved.events || []).map(x => ({ ...x }));
      state.taps = (saved.taps || []).map(x => ({ ...x }));
      state.cursorPoints = (saved.cursorPoints || []).map(x => ({ ...x }));
      state.annotations = (saved.annotations || []).map(x => ({ ...x }));
      state.annotationLaneCount = saved.annotationLaneCount || 1;
      state.videoClips = await Promise.all((saved.videoClips || []).map(x => hydrateClip({ ...x }, 'video')));
      state.voiceovers = await Promise.all((saved.voiceovers || []).map(x => hydrateClip({ ...x }, 'voice')));
      state.facecams = await Promise.all((saved.facecams || []).map(x => hydrateClip({ ...x }, 'camera')));
      state.videoLaneCount = saved.videoLaneCount || 1;
      state.voiceLaneCount = saved.voiceLaneCount || 1;
      state.cameraLaneCount = saved.cameraLaneCount || 1;
      state.projectPath = projectPath || null;
      state.projectCreatedAt = document.createdAt || null;
      state.dirty = false;
      nextId = Math.max(1, ...state.events.map(x => Number(x.id) + 1));
      videoClipId = Math.max(1, ...state.videoClips.map(x => Number(x.id) + 1));
      voiceId = Math.max(1, ...state.voiceovers.map(x => Number(x.id) + 1));
      faceId = Math.max(1, ...state.facecams.map(x => Number(x.id) + 1));
      applySettings(document.settings || {});
      setChipRow('zoomStyleRow', 'zoomStyle', state.zoomStyle);
      updateTimelineUI(); updateSegUI(); updateVoiceUI(); updateCameraUI(); requestRender();
      setProjectStatus(recovered ? tr('projectRecovered') : tr('projectSaved'));
    } catch (error) { showActionableError(error.message); }
  });
}

async function openProject() {
  if (!desktop) return;
  try {
    const result = await desktop.project.open();
    if (result.canceled) return;
    if (result.missing?.length && !await relinkMissingMedia(result.document, result.missing)) return;
    await restoreProject(result.document, result.path, false);
  } catch (error) { showActionableError(error.message); }
}

$('projectSaveBtn').onclick = saveProject;
$('projectOpenBtn').onclick = openProject;
if (desktop) {
  $('projectOpenBtn').style.display = '';
  $('projectSaveBtn').style.display = '';
  setTimeout(async () => {
    if (state.loaded) return;
    const recovery = await desktop.project.recovery().catch(() => null);
    if (!recovery || !confirm(state.lang === 'th' ? 'พบงานที่สำรองอัตโนมัติไว้ ต้องการกู้คืนหรือไม่?' : 'An autosaved project was found. Recover it?')) return;
    if (recovery.missing?.length && !await relinkMissingMedia(recovery.document, recovery.missing)) return;
    restoreProject(recovery.document, null, true);
  }, 500);
}
document.addEventListener('change', e => { if (!e.target.closest('#langSel, #themeBtn')) markProjectDirty(); });
document.addEventListener('pointerup', () => { if (state.loaded) markProjectDirty(); });
window.addEventListener('beforeunload', () => { if (state.dirty) autosaveProject(); });

// ---------- Camera math ----------
// ID_CAM = กล้องพัก: ซูม 1 เท่า อยู่กึ่งกลางพื้นที่ crop (คำนวณสดเพราะขึ้นกับ crop)
function idCam() {
  const cr = cropRect();
  return { zoom: 1, cx: cr.x + cr.w / 2, cy: cr.y + cr.h / 2 };
}
const easeInOut = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
const lerp = (a, b, t) => a + (b - a) * t;
function lerpCam(a, b, t) {
  // interpolate zoom in log space for smoother feel
  return {
    zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), t)),
    cx: lerp(a.cx, b.cx, t),
    cy: lerp(a.cy, b.cy, t),
  };
}

function cameraAt(t) {
  const rest = idCam();
  const events = state.events;
  let evalFn = () => rest;
  for (const e of events) {
    if (e.start > t) break;
    const prev = evalFn;
    const startCam = prev(e.start);
    const target = { zoom: e.zoom, cx: e.x, cy: e.y };
    evalFn = (tt) => {
      const dt = tt - e.start;
      if (dt < 0) return prev(tt);
      if (dt < e.tIn) return lerpCam(startCam, target, easeInOut(dt / e.tIn));
      if (dt < e.tIn + e.hold) return target;
      if (dt < e.tIn + e.hold + e.tOut) return lerpCam(target, rest, easeInOut((dt - e.tIn - e.hold) / e.tOut));
      return rest;
    };
  }
  return evalFn(t);
  // หมายเหตุ: การ clamp ให้อยู่ในพื้นที่ crop ทำที่ sourceRect() แทน
}

// ---------- Rendering ----------
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; drawFrame(); });
}

function roundRectPath(c, x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  c.beginPath();
  c.moveTo(x+r, y);
  c.arcTo(x+w, y, x+w, y+h, r);
  c.arcTo(x+w, y+h, x, y+h, r);
  c.arcTo(x, y+h, x, y, r);
  c.arcTo(x, y, x+w, y, r);
  c.closePath();
}

// rawMedia = ต้นฉบับเต็ม (พิกเซลจริง), media = หลังตัดขอบ (ใช้คำนวณสัดส่วน/layout)
function rawMedia() {
  if (state.mode === 'image')
    return state.imageEl ? { el: state.imageEl, w: state.imageEl.naturalWidth, h: state.imageEl.naturalHeight } : null;
  return state.loaded && video.videoWidth ? { el: video, w: video.videoWidth, h: video.videoHeight } : null;
}
function cropRect() {
  const c = state.crop;
  return { x: c.l, y: c.t, w: Math.max(0.05, 1 - c.l - c.r), h: Math.max(0.05, 1 - c.t - c.b) };
}
function cropPx() {
  const m = rawMedia(), cr = cropRect();
  return { x: cr.x * m.w, y: cr.y * m.h, w: cr.w * m.w, h: cr.h * m.h };
}
function media() {
  const m = rawMedia();
  if (!m) return null;
  const cp = cropPx();
  return { el: m.el, w: cp.w, h: cp.h }; // ขนาดหลังตัดขอบ → สัดส่วนถูกต้อง
}
// พื้นที่ต้นฉบับ (พิกเซลจริง) ที่จะนำมาวาด ตาม camera + crop (clamp ให้อยู่ในพื้นที่ crop)
function sourceRect(cam) {
  const m = rawMedia(), cp = cropPx();
  const sw = cp.w / cam.zoom, sh = cp.h / cam.zoom;
  let sx = cam.cx * m.w - sw / 2, sy = cam.cy * m.h - sh / 2;
  sx = Math.min(cp.x + cp.w - sw, Math.max(cp.x, sx));
  sy = Math.min(cp.y + cp.h - sh, Math.max(cp.y, sy));
  return { sx, sy, sw, sh };
}

// คำนวณตำแหน่ง: outer = ขอบเขตรวมกรอบอุปกรณ์, content = พื้นที่วิดีโอจริง
function layout() {
  const W = canvas.width, H = canvas.height;
  const minDim = Math.min(W, H);
  // โหมด "พอดีเฟรม": ไม่มีขอบพื้นหลัง (padding = 0)
  const pad = state.aspect === 'fit' ? 0 : state.padding / 100 * minDim;
  const availW = W - pad * 2, availH = H - pad * 2;
  const m = media();
  const va = m ? m.w / m.h : 9 / 16;

  const bf = state.frame === 'iphone' ? 0.035 : 0;   // ความหนา bezel เทียบความกว้าง content
  const tf = state.frame === 'browser' ? 0.075 : 0;  // ความสูงแถบเบราว์เซอร์

  // หา content width ใหญ่สุดที่ outer ยังอยู่ในพื้นที่
  let cw = Math.min(availW / (1 + 2 * bf), availH / (1 / va + 2 * bf + tf));
  const ch = cw / va;
  const bezel = bf * cw, topBar = tf * cw;
  const outerW = cw + bezel * 2, outerH = ch + bezel * 2 + topBar;

  const x = (W - outerW) / 2;
  let y;
  if (state.posV === 'top') y = pad;
  else if (state.posV === 'bottom') y = H - pad - outerH;
  else y = (H - outerH) / 2;

  let rOuter, rContent;
  if (state.frame === 'iphone') {
    rContent = cw * 0.1;            // มุมจอ iPhone โค้งมาก
    rOuter = rContent + bezel;
  } else {
    rOuter = rContent = state.radius / 100 * minDim;
  }
  return {
    outer: { x, y, w: outerW, h: outerH, r: rOuter },
    content: { x: x + bezel, y: y + bezel + topBar, w: cw, h: ch, r: rContent },
    bezel, topBar,
  };
}

// ---------- พื้นหลัง ----------
let checkerPattern = null;
function drawBackground(forExport) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const blur = Math.max(0, Number(state.background?.blur || 0));
  const bleed = blur ? blur * 2 : 0;
  ctx.save();
  if (blur) ctx.filter = `blur(${blur}px)`;
  if (state.bgType === 'transparent') {
    if (!forExport) {
      if (!checkerPattern) {
        const p = document.createElement('canvas');
        p.width = p.height = 32;
        const pc = p.getContext('2d');
        pc.fillStyle = '#23262f'; pc.fillRect(0, 0, 32, 32);
        pc.fillStyle = '#2d313c'; pc.fillRect(0, 0, 16, 16); pc.fillRect(16, 16, 16, 16);
        checkerPattern = ctx.createPattern(p, 'repeat');
      }
      ctx.fillStyle = checkerPattern;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore(); return;
  }
  if (state.bgType === 'image' && state.bgImageEl) {
    const img = state.bgImageEl;
    const s = Math.max((W + bleed * 2) / img.naturalWidth, (H + bleed * 2) / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore(); return;
  }
  if (state.bgType === 'color') {
    ctx.fillStyle = state.bgColor || state.background?.color || '#151821';
    ctx.fillRect(-bleed, -bleed, W + bleed * 2, H + bleed * 2);
    ctx.restore(); return;
  }
  const colors = state.background?.colors?.length >= 2 ? state.background.colors : null;
  const [c1, c2] = state.bgType === 'custom' ? [$('cg1').value, $('cg2').value] : (colors || BACKGROUNDS[state.bg]);
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(-bleed, -bleed, W + bleed * 2, H + bleed * 2);
  ctx.restore();
}

// ---------- Status bar ปลอมแบบ Screeny ----------
const sbSample = { t: 0, color: '#ffffff' };
function drawStatusBar(L) {
  const c = L.content;
  const portrait = c.h > c.w;
  const h = c.h * (portrait ? 0.064 : 0.05); // สัดส่วน status bar จริงของ iPhone (~54/844)

  let bg, fg;
  if (state.statusBar === 'light') { bg = '#ffffff'; fg = '#000000'; }
  else if (state.statusBar === 'dark') { bg = '#000000'; fg = '#ffffff'; }
  else { // auto: ดูดสีจากวิดีโอใต้แถบ
    if (performance.now() - sbSample.t > 400) {
      try {
        const d = ctx.getImageData(c.x + c.w / 2 - 20, c.y + h + 3, 40, 4).data;
        let r = 0, g = 0, b = 0, n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        sbSample.color = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
        sbSample.t = performance.now();
      } catch {}
    }
    bg = sbSample.color;
    const m = bg.match(/\d+/g) || [255, 255, 255];
    const lum = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
    fg = lum > 140 ? '#000000' : '#ffffff';
  }

  ctx.save();
  roundRectPath(ctx, c.x, c.y, c.w, c.h, c.r);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(c.x, c.y, c.w, h);

  ctx.fillStyle = fg;
  const fs = h * 0.42;
  ctx.font = `600 ${fs}px -apple-system, "SF Pro Text", sans-serif`;
  ctx.textBaseline = 'middle';
  const cy = c.y + h / 2;
  // เวลา 9:41 ฝั่งซ้าย
  ctx.textAlign = 'center';
  ctx.fillText('9:41', c.x + c.w * 0.17, cy);
  // ฝั่งขวา: สัญญาณ + wifi + แบตเตอรี่
  const rx = c.x + c.w * 0.83;
  const u = fs; // หน่วยไอคอน
  // สัญญาณ 4 ขีด
  for (let i = 0; i < 4; i++) {
    const bh = u * (0.35 + i * 0.18);
    ctx.fillRect(rx - u * 2.6 + i * u * 0.28, cy + u * 0.45 - bh, u * 0.18, bh);
  }
  // wifi (สามส่วนโค้ง)
  ctx.strokeStyle = fg;
  ctx.lineWidth = u * 0.14;
  ctx.lineCap = 'round';
  for (let i = 1; i <= 3; i++) {
    ctx.beginPath();
    ctx.arc(rx - u * 0.9, cy + u * 0.35, u * 0.25 * i, Math.PI * 1.28, Math.PI * 1.72);
    ctx.stroke();
  }
  // แบตเตอรี่เต็ม
  const bw = u * 1.1, bh2 = u * 0.55, bx = rx + u * 0.1, by = cy - bh2 / 2;
  ctx.globalAlpha = 0.45;
  roundRectPath(ctx, bx, by, bw, bh2, bh2 * 0.25);
  ctx.stroke();
  ctx.globalAlpha = 1;
  roundRectPath(ctx, bx + u * 0.1, by + u * 0.1, bw - u * 0.2, bh2 - u * 0.2, bh2 * 0.15);
  ctx.fill();
  ctx.fillRect(bx + bw + u * 0.05, cy - u * 0.1, u * 0.08, u * 0.2);
  ctx.restore();
  ctx.textAlign = 'left';
}

// ---------- แถบเบราว์เซอร์ปลอม ----------
function drawBrowserChrome(L) {
  const { outer, topBar } = L;
  const cy = outer.y + topBar / 2;
  const u = topBar;
  // ปุ่มจราจร
  const dots = ['#ff5f57', '#febc2e', '#28c840'];
  dots.forEach((col, i) => {
    ctx.beginPath();
    ctx.arc(outer.x + u * 0.45 + i * u * 0.42, cy, u * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  });
  // ช่อง URL
  const pw = outer.w * 0.52, px = outer.x + (outer.w - pw) / 2;
  roundRectPath(ctx, px, cy - u * 0.26, pw, u * 0.52, u * 0.26);
  ctx.fillStyle = 'rgba(255,255,255,.09)';
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = `${u * 0.3}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🔒 ' + (state.urlText || 'yourwebsite.com'), px + pw / 2, cy + u * 0.02);
  ctx.textAlign = 'left';
}

// ---------- Ripple จุดแตะ ----------
const easeOutQuad = t => 1 - (1 - t) * (1 - t);
function drawTaps(L, cam) {
  if (!state.showTaps || state.mode !== 'video' || !state.taps.length) return;
  const ct = video.currentTime;
  const c = L.content;
  const sr = sourceRect(cam);
  const m = rawMedia();
  const effect = state.cursorSettings?.clickEffect || 'ripple';
  if (effect === 'none') return;
  for (const tp of state.taps) {
    const dt = ct - tp.t;
    const duration = Math.max(0.08, (state.cursorSettings?.bounceDurationMs || 350) / 1000);
    if (dt < 0 || dt > duration) continue;
    const p = easeOutQuad(dt / duration);
    // พิกัด tap เป็น normalized ของวิดีโอเต็ม → พิกเซลต้นฉบับ → พิกัดบน content
    const px = c.x + (tp.x * m.w - sr.sx) / sr.sw * c.w;
    const py = c.y + (tp.y * m.h - sr.sy) / sr.sh * c.h;
    if (px < c.x || px > c.x + c.w || py < c.y || py > c.y + c.h) continue;
    const rad = (0.018 + (effect === 'target' ? 0.025 : effect === 'ring' ? 0.04 : 0.05) * p) * c.w * Math.sqrt(cam.zoom);
    ctx.save();
    roundRectPath(ctx, c.x, c.y, c.w, c.h, c.r);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.lineWidth = c.w * 0.004;
    ctx.strokeStyle = `rgba(255,255,255,${0.78 * (1 - p)})`;
    ctx.stroke();
    if (effect === 'pulse' || effect === 'ripple') {
      ctx.fillStyle = `rgba(255,255,255,${(effect === 'pulse' ? 0.38 : 0.22) * (1 - p)})`;
      ctx.fill();
    }
    if (effect === 'target') {
      ctx.beginPath();
      ctx.arc(px, py, rad * 0.46, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - p)})`;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px - rad * 1.25, py); ctx.lineTo(px + rad * 1.25, py);
      ctx.moveTo(px, py - rad * 1.25); ctx.lineTo(px, py + rad * 1.25);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function sourcePointOnCanvas(point, L, cam) {
  const c = L.content, sr = sourceRect(cam), m = rawMedia();
  if (!m || !point) return null;
  const px = c.x + (point.x * m.w - sr.sx) / sr.sw * c.w;
  const py = c.y + (point.y * m.h - sr.sy) / sr.sh * c.h;
  if (px < c.x || px > c.x + c.w || py < c.y || py > c.y + c.h) return null;
  return { x: px, y: py };
}

function drawCursor(L, cam) {
  if (state.mode !== 'video' || !state.cursorSettings?.enabled || !state.cursorPoints?.length) return;
  const sample = ZoomCutCore.cursorAt(state.cursorPoints, video.currentTime, state.cursorSettings.smoothing);
  if (!sample || sample.opacity <= 0) return;
  const point = sourcePointOnCanvas(sample, L, cam);
  if (!point) return;
  const c = L.content;
  const settings = state.cursorSettings;
  const base = Math.max(12, Math.min(c.w, c.h) * 0.042 * (settings.size || 1));
  const recentTap = state.taps.reduce((best, tap) => {
    const age = video.currentTime - tap.t;
    return age >= 0 && age <= (settings.bounceDurationMs || 350) / 1000 && (!best || tap.t > best.t) ? tap : best;
  }, null);
  const age = recentTap ? video.currentTime - recentTap.t : Infinity;
  const bounceT = recentTap ? clamp(age / Math.max(0.08, (settings.bounceDurationMs || 350) / 1000), 0, 1) : 1;
  const bounce = recentTap ? 1 + (settings.clickBounce || 0) * Math.sin(Math.PI * bounceT) * 0.16 : 1;
  const sway = Math.sin(video.currentTime * 4.2) * (settings.sway || 0) * 0.08;
  const r = base * bounce;
  ctx.save();
  roundRectPath(ctx, c.x, c.y, c.w, c.h, c.r);
  ctx.clip();
  ctx.translate(point.x, point.y);
  ctx.rotate(sway);
  ctx.globalAlpha = sample.opacity;
  ctx.lineJoin = 'round';
  const style = settings.style || 'soft';
  if (style === 'pointer') {
    ctx.beginPath(); ctx.moveTo(-r * .24, -r * .9); ctx.lineTo(r * .22, r * .48); ctx.lineTo(r * .58, r * .38);
    ctx.lineTo(r * .76, r * .58); ctx.lineTo(r * .32, r * .68); ctx.lineTo(r * .12, r * 1.02); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = Math.max(2, r * .1); ctx.strokeStyle = '#171922'; ctx.stroke();
  } else if (style === 'dot') {
    ctx.beginPath(); ctx.arc(0, 0, r * .34, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = Math.max(2, r * .09); ctx.strokeStyle = 'rgba(23,25,34,.9)'; ctx.stroke();
  } else {
    if (style === 'shadow' || style === 'soft') { ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = r * .38; ctx.shadowOffsetY = r * .14; }
    ctx.beginPath(); ctx.arc(0, 0, r * .52, 0, Math.PI * 2);
    ctx.fillStyle = style === 'outline' ? 'rgba(255,255,255,.12)' : style === 'classic' ? '#fff' : style === 'solid' ? '#11131a' : 'rgba(255,255,255,.88)';
    ctx.fill();
    if (style === 'outline' || style === 'classic' || style === 'shadow' || style === 'soft') {
      ctx.shadowColor = 'transparent'; ctx.lineWidth = Math.max(2, r * .1); ctx.strokeStyle = style === 'outline' ? '#fff' : '#181a22'; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(-r * .16, -r * .16, r * .12, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
  }
  ctx.restore();
}

function drawAnnotations(L, cam) {
  if (!state.annotations?.length || state.mode !== 'video') return;
  const t = video.currentTime, c = L.content, m = rawMedia(), sr = sourceRect(cam);
  const map = (x, y) => ({ x: c.x + (x * m.w - sr.sx) / sr.sw * c.w, y: c.y + (y * m.h - sr.sy) / sr.sh * c.h });
  ctx.save(); roundRectPath(ctx, c.x, c.y, c.w, c.h, c.r); ctx.clip();
  for (const annotation of state.annotations) {
    if (t < annotation.start || t > annotation.start + annotation.duration) continue;
    const a = map(annotation.x || 0, annotation.y || 0), b = map(annotation.x2 ?? annotation.x ?? 0, annotation.y2 ?? annotation.y ?? 0);
    ctx.globalAlpha = clamp((annotation.opacity ?? 1), 0, 1);
    ctx.strokeStyle = annotation.color || '#aeb8ff'; ctx.fillStyle = annotation.color || '#aeb8ff';
    ctx.lineWidth = Math.max(3, c.w * .006);
    if (annotation.type === 'text') { ctx.font = `700 ${Math.max(18, c.w * .035)}px -apple-system, sans-serif`; ctx.fillText(annotation.text || '', a.x, a.y); }
    else if (annotation.type === 'arrow') { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); const angle = Math.atan2(b.y - a.y, b.x - a.x); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - 16 * Math.cos(angle - .5), b.y - 16 * Math.sin(angle - .5)); ctx.lineTo(b.x - 16 * Math.cos(angle + .5), b.y - 16 * Math.sin(angle + .5)); ctx.closePath(); ctx.fill(); }
    else if (annotation.type === 'rectangle' || annotation.type === 'highlight') { ctx.globalAlpha *= annotation.type === 'highlight' ? .3 : 1; ctx.strokeRect(a.x, a.y, (annotation.width || .2) * c.w, (annotation.height || .12) * c.h); }
    else if (annotation.type === 'blur') { ctx.globalAlpha *= .24; ctx.fillRect(a.x, a.y, (annotation.width || .2) * c.w, (annotation.height || .12) * c.h); }
  }
  ctx.restore();
}

function drawDebugOverlay(L, cam) {
  if (!state.debugOverlay || !rawMedia()) return;
  const c = L.content;
  const m = rawMedia();
  const sr = sourceRect(cam);
  const cr = cropRect();
  ctx.save();
  roundRectPath(ctx, c.x, c.y, c.w, c.h, c.r);
  ctx.clip();
  ctx.lineWidth = Math.max(2, c.w * 0.004);
  ctx.strokeStyle = 'rgba(67,233,123,.95)';
  ctx.strokeRect(c.x + (cr.x * m.w - sr.sx) / sr.sw * c.w, c.y + (cr.y * m.h - sr.sy) / sr.sh * c.h,
    cr.w * m.w / sr.sw * c.w, cr.h * m.h / sr.sh * c.h);
  const cx = c.x + (cam.cx * m.w - sr.sx) / sr.sw * c.w;
  const cy = c.y + (cam.cy * m.h - sr.sy) / sr.sh * c.h;
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy); ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14); ctx.stroke();
  ctx.fillStyle = 'rgba(108,124,255,.9)';
  for (const tp of state.taps) {
    const px = c.x + (tp.x * m.w - sr.sx) / sr.sw * c.w;
    const py = c.y + (tp.y * m.h - sr.sy) / sr.sh * c.h;
    if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
  const lines = [
    `cam ${cam.zoom.toFixed(2)}x @ ${cam.cx.toFixed(3)}, ${cam.cy.toFixed(3)}`,
    `source ${Math.round(sr.sx)},${Math.round(sr.sy)} ${Math.round(sr.sw)}x${Math.round(sr.sh)}`,
    `crop ${cr.x.toFixed(2)},${cr.y.toFixed(2)} ${cr.w.toFixed(2)}x${cr.h.toFixed(2)}`,
  ];
  ctx.save();
  ctx.font = `${Math.max(18, canvas.width * 0.014)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'top';
  const pad = 12, lh = Math.max(24, canvas.width * 0.019);
  const w = Math.max(...lines.map(s => ctx.measureText(s).width)) + pad * 2;
  ctx.fillStyle = 'rgba(10,12,18,.78)';
  roundRectPath(ctx, c.x + 12, c.y + 12, w, lines.length * lh + pad, 8);
  ctx.fill();
  ctx.fillStyle = '#e8eaf0';
  lines.forEach((s, i) => ctx.fillText(s, c.x + 12 + pad, c.y + 12 + pad / 2 + i * lh));
  ctx.restore();
}

function drawFacecamOverlay(L) {
  if (!state.facecams.length || state.mode !== 'video') return;
  const outT = sourceToOutputTime(video.currentTime);
  const activeClips = state.facecams
    .filter(c => laneEnabled('camera', c.lane || 0) && outT >= clipOutStart(c) && outT <= clipOutStart(c) + clipOutDuration(c))
    .sort((a, b) => (a.lane || 0) - (b.lane || 0));
  const activeIds = new Set(activeClips.map(x => x.id));
  for (const clip of state.facecams) if (!activeIds.has(clip.id) && clip.video && !clip.video.paused) clip.video.pause();
  for (const active of activeClips) drawFacecamClip(active, L, outT);
}

function drawFacecamClip(active, L, outT) {
  const vid = active.video || document.createElement('video');
  if (!active.video) {
    vid.src = active.url; vid.muted = true; vid.playsInline = true;
    active.video = vid;
  }
  const off = Math.max(0, outT - clipOutStart(active)) + clipMediaOffset(active);
  if (vid.readyState >= 1 && Math.abs((vid.currentTime || 0) - off) > 0.12) {
    try { vid.currentTime = off; } catch {}
  }
  if (!video.paused && vid.paused) vid.play().catch(() => {});
  if (video.paused && !vid.paused) vid.pause();
  if (vid.readyState < 2) return;
  const c = L.content;
  const size = Math.min(c.w, c.h) * ((active.size ?? state.camDefaults.size) / 100);
  const margin = c.w * ((active.margin ?? state.camDefaults.margin) / 100);
  const pos = active.pos || state.camDefaults.pos;
  let x = c.x + c.w - size - margin;
  let y = c.y + c.h - size - margin;
  if (pos.includes('left')) x = c.x + margin;
  if (pos.includes('center')) x = c.x + (c.w - size) / 2;
  if (pos.includes('top')) y = c.y + margin;
  const t = outT - clipOutStart(active);
  const remain = clipOutStart(active) + clipOutDuration(active) - outT;
  const fadeIn = active.fadeIn || 0, fadeOut = active.fadeOut || 0;
  const alphaIn = fadeIn > 0 ? Math.min(1, t / fadeIn) : 1;
  const alphaOut = fadeOut > 0 ? Math.min(1, remain / fadeOut) : 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alphaIn, alphaOut));
  if ((active.shape || state.camDefaults.shape) === 'circle') {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, x, y, size, size, size * 0.16);
  }
  ctx.clip();
  const va = vid.videoWidth / vid.videoHeight || 1;
  let sw = vid.videoWidth, sh = vid.videoHeight, sx = 0, sy = 0;
  if (va > 1) { sw = vid.videoHeight; sx = (vid.videoWidth - sw) / 2; }
  else { sh = vid.videoWidth; sy = (vid.videoHeight - sh) / 2; }
  ctx.drawImage(vid, sx, sy, sw, sh, x, y, size, size);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alphaIn, alphaOut));
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = Math.max(2, size * 0.025);
  if ((active.shape || state.camDefaults.shape) === 'circle') {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, x, y, size, size, size * 0.16);
  }
  ctx.stroke();
  ctx.restore();
}

function drawOverlayVideoClips(L) {
  if (!state.videoClips.length || state.mode !== 'video') return;
  const outT = sourceToOutputTime(video.currentTime);
  const active = state.videoClips
    .filter(c => laneEnabled('video', c.lane || 0) && outT >= clipOutStart(c) && outT <= clipOutStart(c) + clipOutDuration(c))
    .sort((a, b) => (a.lane || 0) - (b.lane || 0));
  const activeIds = new Set(active.map(x => x.id));
  for (const clip of state.videoClips) {
    if (!activeIds.has(clip.id) && clip.video && !clip.video.paused) clip.video.pause();
  }
  if (!active.length) return;
  const c = L.content;
  for (const clip of active) {
    const vid = clip.video || document.createElement('video');
    if (!clip.video) {
      vid.src = clip.url; vid.muted = true; vid.playsInline = true;
      clip.video = vid;
    }
    const off = Math.max(0, outT - clipOutStart(clip)) + clipMediaOffset(clip);
    if (vid.readyState >= 1 && Math.abs((vid.currentTime || 0) - off) > 0.12) {
      try { vid.currentTime = off; } catch {}
    }
    if (!video.paused && vid.paused) vid.play().catch(() => {});
    if (video.paused && !vid.paused) vid.pause();
    if (vid.readyState < 2) continue;
    const va = vid.videoWidth / vid.videoHeight || 1;
    let dw = c.w, dh = dw / va;
    if (dh < c.h) { dh = c.h; dw = dh * va; }
    const scale = (clip.scale ?? 100) / 100;
    dw *= scale; dh *= scale;
    const dx = c.x + (c.w - dw) * ((clip.posX ?? 50) / 100);
    const dy = c.y + (c.h - dh) * ((clip.posY ?? 50) / 100);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, clip.opacity ?? 1));
    roundRectPath(ctx, c.x, c.y, c.w, c.h, c.r);
    ctx.clip();
    ctx.drawImage(vid, dx, dy, dw, dh);
    ctx.restore();
  }
}

// วาดตัวช่วยตั้ง crop: หน้าต่างเต็ม + กรอบเขียว = ส่วนที่เก็บไว้ (พื้นที่มืด = ถูกตัด)
function drawCropGuide() {
  const W = canvas.width, H = canvas.height;
  const rm = rawMedia();
  const pad = 0.05 * Math.min(W, H);
  const availW = W - pad * 2, availH = H - pad * 2;
  const va = rm.w / rm.h;
  let cw = availW, ch = cw / va;
  if (ch > availH) { ch = availH; cw = ch * va; }
  const bx = (W - cw) / 2, by = (H - ch) / 2;
  ctx.drawImage(rm.el, 0, 0, rm.w, rm.h, bx, by, cw, ch);
  // พื้นที่ที่จะเก็บ
  const cr = cropRect();
  const kx = bx + cr.x * cw, ky = by + cr.y * ch, kw = cr.w * cw, kh = cr.h * ch;
  // ทับส่วนที่ถูกตัดด้วยสีมืด
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(bx, by, cw, ky - by);                 // บน
  ctx.fillRect(bx, ky + kh, cw, by + ch - (ky + kh)); // ล่าง
  ctx.fillRect(bx, ky, kx - bx, kh);                  // ซ้าย
  ctx.fillRect(kx + kw, ky, bx + cw - (kx + kw), kh); // ขวา
  // กรอบเขียว
  ctx.strokeStyle = '#43e97b';
  ctx.lineWidth = Math.max(2, 0.004 * Math.min(W, H));
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(kx, ky, kw, kh);
  ctx.setLineDash([]);
}

function drawFrame(forExport = false) {
  forExport = forExport || state.exporting;
  drawBackground(forExport);

  const m = media();
  if (!m) return;

  // โหมด "ดูขอบ": แสดงทั้งหน้าต่าง (ยังไม่ตัด) + กรอบเขียวบอกส่วนที่จะเก็บไว้
  if (showCropGuide && !forExport && rawMedia()) {
    drawCropGuide();
    return;
  }

  const L = layout();
  const { outer, content } = L;
  const minDim = Math.min(canvas.width, canvas.height);

  // เงา
  if (state.shadow > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${state.shadow / 100 * 0.6})`;
    ctx.shadowBlur = state.shadow / 100 * minDim * 0.08;
    ctx.shadowOffsetY = state.shadow / 100 * minDim * 0.02;
    roundRectPath(ctx, outer.x, outer.y, outer.w, outer.h, outer.r);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

  // ตัวกรอบอุปกรณ์
  if (state.frame === 'iphone') {
    roundRectPath(ctx, outer.x, outer.y, outer.w, outer.h, outer.r);
    ctx.fillStyle = state.frameColor;
    ctx.fill();
    // ไฮไลต์ขอบโลหะ
    ctx.save();
    roundRectPath(ctx, outer.x, outer.y, outer.w, outer.h, outer.r);
    ctx.lineWidth = Math.max(2, L.bezel * 0.12);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.stroke();
    ctx.restore();
  } else if (state.frame === 'browser') {
    roundRectPath(ctx, outer.x, outer.y, outer.w, outer.h, outer.r);
    ctx.fillStyle = '#2b2b30';
    ctx.fill();
  }

  // วิดีโอ/รูป พร้อม camera zoom + ตัดขอบ (crop)
  const cam = state.mode === 'video' ? cameraAt(video.currentTime) : idCam();
  const sr = sourceRect(cam);

  ctx.save();
  if (state.frame === 'browser') {
    // มุมล่างโค้งตาม outer มุมบนเป็นเหลี่ยม (โดนแถบทับ)
    roundRectPath(ctx, outer.x, outer.y, outer.w, outer.h, outer.r);
  } else {
    roundRectPath(ctx, content.x, content.y, content.w, content.h, content.r);
  }
  ctx.clip();
  const baseSegment = state.mode === 'video' ? segAt(video.currentTime) : null;
  if (!baseSegment || laneEnabled('video', baseSegment.lane || 0)) {
    ctx.drawImage(m.el, sr.sx, sr.sy, sr.sw, sr.sh, content.x, content.y, content.w, content.h);
  }
  ctx.restore();

  drawOverlayVideoClips(L);
  if (state.statusBar !== 'none') drawStatusBar(L);
  if (state.frame === 'browser') drawBrowserChrome(L);
  // Keep overlays in a stable z-order for preview and offline export.
  drawAnnotations(L, cam);
  drawTaps(L, cam);
  drawCursor(L, cam);
  drawFacecamOverlay(L);
  drawDebugOverlay(L, cam);
}

// continuous render while playing
function loop() {
  if (state.loaded && state.mode === 'video' && !video.paused && !state.exporting) segPlaybackTick();
  if (state.loaded && (!video.paused || state.exporting)) drawFrame();
  if (state.loaded && !video.paused && !state.exporting) { updatePlayheadUI(); syncVoicePreview(); }
  if (state.loaded && !state.exporting) syncBaseAudioLane();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- Click on canvas → add zoom ----------
canvas.addEventListener('click', e => {
  if (!state.loaded || state.exporting || state.mode !== 'video') return;
  const bounds = canvas.getBoundingClientRect();
  const px = (e.clientX - bounds.left) / bounds.width * canvas.width;
  const py = (e.clientY - bounds.top) / bounds.height * canvas.height;
  const rect = layout().content;
  if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) return;

  // คลิกในพื้นที่ที่เห็น → แปลงกลับเป็นพิกัดวิดีโอเต็ม (normalized) ผ่าน source rect
  const cam = cameraAt(video.currentTime);
  const sr = sourceRect(cam);
  const m = rawMedia();
  const relX = (px - rect.x) / rect.w, relY = (py - rect.y) / rect.h;
  const vx = (sr.sx + relX * sr.sw) / m.w;
  const vy = (sr.sy + relY * sr.sh) / m.h;

  const ev = {
    id: nextId++,
    start: Math.max(0, video.currentTime - 0.35), // start zooming slightly before the tap
    x: vx, y: vy,
    zoom: state.defZoom,
    tIn: currentZoomStyle().tIn, hold: state.defHold, tOut: currentZoomStyle().tOut,
  };
  if (currentZoomStyle().tapOnly) return;
  commitHistory();
  state.events.push(ev);
  state.events.sort((a, b) => a.start - b.start);
  selectOnly('marker', ev.id);
  updateTimelineUI();
  requestRender();
});

// ---------- Playback ----------
const playBtn = $('playBtn');
function fmtPreviewTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const whole = Math.floor(safe % 60);
  const centis = Math.floor((safe - Math.floor(safe)) * 100);
  return `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
function updatePreviewTransport() {
  const enabled = state.loaded && state.mode === 'video' && Number.isFinite(video.duration);
  $('previewCurrent').textContent = fmtPreviewTime(enabled ? video.currentTime : 0);
  $('previewDuration').textContent = fmtPreviewTime(enabled ? video.duration : 0);
  for (const id of ['previewStepBack', 'previewPlay', 'previewStepForward']) $(id).disabled = !enabled;
  $('previewPlay').classList.toggle('is-playing', enabled && !video.paused);
  const playLabel = video.paused
    ? (state.lang === 'th' ? 'เล่น' : 'Play')
    : (state.lang === 'th' ? 'หยุดชั่วคราว' : 'Pause');
  $('previewPlay').title = playLabel;
  $('previewPlay').setAttribute('aria-label', playLabel);
  const backLabel = state.lang === 'th' ? 'ย้อนหนึ่งเฟรม' : 'Previous frame';
  const forwardLabel = state.lang === 'th' ? 'ไปข้างหน้าหนึ่งเฟรม' : 'Next frame';
  $('previewStepBack').title = backLabel;
  $('previewStepBack').setAttribute('aria-label', backLabel);
  $('previewStepForward').title = forwardLabel;
  $('previewStepForward').setAttribute('aria-label', forwardLabel);
}
playBtn.onclick = () => {
  if (video.paused) {
    const last = state.segments[state.segments.length - 1];
    // ถ้าเล่นจบท้ายสุดแล้ว → เริ่มใหม่จากต้น
    if (last && video.currentTime >= last.end - 0.05) video.currentTime = state.segments[0].start;
    startSegPlayback();
    video.play();
  } else video.pause();
};
$('previewPlay').onclick = () => playBtn.click();
$('previewStepBack').onclick = () => seekBy(-1 / 30);
$('previewStepForward').onclick = () => seekBy(1 / 30);
video.addEventListener('play', () => {
  playBtn.textContent = tr('pause');
  updatePreviewTransport();
  // ปิดโหมด "ดูขอบ" อัตโนมัติเมื่อเริ่มเล่น (ไม่งั้นจะเห็นภาพ guide นิ่ง เหมือนซูมไม่ทำงาน)
  if (showCropGuide) { showCropGuide = false; $('cropToggle').classList.remove('active'); }
});
video.addEventListener('pause', () => { playBtn.textContent = tr('play'); updatePreviewTransport(); stopVoicePreview(); });
video.addEventListener('seeked', () => { requestRender(); updatePlayheadUI(); updatePreviewTransport(); syncVoicePreview(true); });
video.addEventListener('ended', () => video.pause());

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
function openShortcutHelp() {
  const rows = [
    ['Space', state.lang === 'th' ? 'เล่น/หยุด' : 'Play/Pause'],
    ['B / C / ⌘B', state.lang === 'th' ? 'แบ่งท่อนที่ playhead' : 'Split at playhead'],
    ['I / O', state.lang === 'th' ? 'ตั้งหัว/หางท่อนที่เลือก' : 'Set in/out point'],
    ['Q / W', state.lang === 'th' ? 'ตัดซ้าย/ขวาถึง playhead' : 'Trim left/right to playhead'],
    ['Delete', state.lang === 'th' ? 'ลบ item ที่เลือก' : 'Delete selected item'],
    ['⌘/Ctrl+Z', state.lang === 'th' ? 'Undo' : 'Undo'],
    ['⌘/Ctrl+D', state.lang === 'th' ? 'ทำสำเนาคลิปที่เลือก' : 'Duplicate selected clip'],
    ['⇧⌘/Ctrl+Z', state.lang === 'th' ? 'Redo' : 'Redo'],
    ['← / →', state.lang === 'th' ? 'เลื่อน playhead 0.1 วิ' : 'Seek 0.1s'],
    ['⇧← / ⇧→', state.lang === 'th' ? 'เลื่อน playhead 1 วิ' : 'Seek 1s'],
    ['Home / End', state.lang === 'th' ? 'ไปต้น/ท้ายวิดีโอ' : 'Go to start/end'],
    ['J / K / L', state.lang === 'th' ? 'ถอย / หยุด / เล่น' : 'Back / Stop / Play'],
    ['↑ / ↓', state.lang === 'th' ? 'เลือกท่อนก่อนหน้า/ถัดไป' : 'Select previous/next segment'],
    ['[ / ]', state.lang === 'th' ? 'เลือกท่อนก่อนหน้า/ถัดไป' : 'Select previous/next segment'],
    ['A / V', state.lang === 'th' ? 'เลือกท่อนปัจจุบัน / ล้าง selection' : 'Select current / clear selection'],
    ['⌘/Ctrl + + / -', state.lang === 'th' ? 'ซูม timeline เข้า/ออก' : 'Zoom timeline in/out'],
    ['⇧Z', state.lang === 'th' ? 'Fit timeline' : 'Fit timeline'],
    ['R', state.lang === 'th' ? 'เริ่ม/หยุด voice over' : 'Start/stop voice over'],
    ['?', state.lang === 'th' ? 'เปิดหน้าคีย์ลัด' : 'Show shortcuts'],
  ];
  $('shortcutTitle').textContent = tr('shortcuts');
  $('shortcutClose').textContent = tr('close');
  $('shortcutGrid').innerHTML = rows.map(([key, label]) =>
    `<div class="shortcut-item"><span>${label}</span><kbd>${key}</kbd></div>`).join('');
  $('shortcutOverlay').classList.add('visible');
}
$('shortcutBtn').onclick = openShortcutHelp;
$('shortcutClose').onclick = () => $('shortcutOverlay').classList.remove('visible');
$('shortcutOverlay').addEventListener('click', e => { if (e.target === $('shortcutOverlay')) $('shortcutOverlay').classList.remove('visible'); });

document.addEventListener('keydown', e => {
  if (isTypingTarget(e.target) || state.exporting) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); openShortcutHelp(); return; }
  if (e.key === 'Escape') {
    $('shortcutOverlay').classList.remove('visible');
    $('diagOverlay').classList.remove('visible');
    clearSelection();
    return;
  }
  if (!state.loaded || state.mode !== 'video') return;

  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redoEdit() : undoEdit(); return; }
  if (mod && key === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if ((mod && key === 'b') || key === 'b' || key === 'c') { e.preventDefault(); splitVideoClipAtPlayhead() || splitVoiceAtPlayhead() || splitCameraAtPlayhead() || actionSplitAtPlayhead(); return; }
  if (e.code === 'Space') { e.preventDefault(); playBtn.onclick(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actionDeleteSelected(); return; }
  if (key === 'i' || key === 'q') { e.preventDefault(); actionTrimStartToPlayhead(); return; }
  if (key === 'o' || key === 'w') { e.preventDefault(); actionTrimEndToPlayhead(); return; }
  if (key === 'r') { e.preventDefault(); $('voiceBtn').click(); return; }
  if (key === 'j') { e.preventDefault(); video.pause(); seekBy(e.shiftKey ? -1 : -0.5); return; }
  if (key === 'k') { e.preventDefault(); video.pause(); return; }
  if (key === 'l') { e.preventDefault(); if (video.paused) playBtn.onclick(); else video.playbackRate = Math.min(4, (video.playbackRate || 1) + 0.5); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(e.shiftKey ? -1 : -0.1); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(e.shiftKey ? 1 : 0.1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectSegmentNearPlayhead(-1); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); selectSegmentNearPlayhead(1); return; }
  if (e.key === '[') { e.preventDefault(); selectSegmentNearPlayhead(-1); return; }
  if (e.key === ']') { e.preventDefault(); selectSegmentNearPlayhead(1); return; }
  if (!mod && key === 'a') {
    e.preventDefault();
    const s = segAt(video.currentTime);
    if (s) { selectOnly('seg', s.id); updateSegUI(); }
    return;
  }
  if (!mod && key === 'v') {
    e.preventDefault();
    clearSelection();
    return;
  }
  if (e.key === 'Home') { e.preventDefault(); video.currentTime = 0; return; }
  if (e.key === 'End') { e.preventDefault(); video.currentTime = video.duration || 0; return; }
  if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setTimelineZoom(state.timelineZoom * 1.25); return; }
  if (mod && e.key === '-') { e.preventDefault(); setTimelineZoom(state.timelineZoom / 1.25); return; }
  if (e.shiftKey && key === 'z') { e.preventDefault(); state.timelineZoom = 1; updateTimelineScale(0); return; }
});

// ---------- Timeline ----------
const timeline = $('timeline');
const playhead = $('playhead');
$('stage').addEventListener('pointerdown', e => {
  if (e.target === $('stage') || e.target === $('dropHint')) clearSelection();
});
const voiceRec = {
  active: false, recorder: null, stream: null, chunks: [], start: 0, startedAt: 0,
  voiceSession: null, voiceWrite: Promise.resolve(), voiceWriteError: null,
  camChunks: [], camRecorder: null, camStream: null, camSession: null, camWrite: Promise.resolve(), camWriteError: null,
  livePeaks: [], lastPeakAt: 0,
  audioCtx: null, analyser: null, data: null, meterRaf: null,
};
let exportAudioCtx = null;
let videoAudioSourceNode = null;
let videoAudioPreviewGain = null;

function fmtTime(t) {
  const m = Math.floor(t / 60), s = (t % 60);
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

async function refreshMicDevices() {
  const sel = $('micSel');
  sel.innerHTML = `<option value="">${tr('micLoading')}</option>`;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const visible = mics.filter(d => d.label && d.deviceId !== 'default');
    const needsAccess = mics.some(d => !d.label);
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    const defaultMic = mics.find(d => d.deviceId === 'default' && d.label);
    def.textContent = defaultMic
      ? `${tr('micDefault')} — ${defaultMic.label.replace(/^Default\s*-\s*/i, '')}`
      : tr('micDefault');
    sel.appendChild(def);
    visible.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label;
      if (state.selectedMicId && d.deviceId === state.selectedMicId) o.selected = true;
      sel.appendChild(o);
    });
    if (needsAccess || !mics.length) {
      const grant = document.createElement('option');
      grant.value = '__grant_microphone__';
      grant.textContent = tr('micGrant');
      sel.appendChild(grant);
    }
  } catch {
    sel.innerHTML = `<option value="">${tr('micDefault')}</option><option value="__grant_microphone__">${tr('micGrant')}</option>`;
  }
}
async function refreshCameraDevices() {
  const sel = $('camSel');
  sel.innerHTML = `<option value="">${tr('camLoading')}</option>`;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const visible = cams.filter(d => d.label && d.deviceId !== 'default');
    const needsAccess = cams.some(d => !d.label);
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    const defaultCamera = cams.find(d => d.deviceId === 'default' && d.label);
    def.textContent = defaultCamera
      ? `${tr('camDefault')} — ${defaultCamera.label.replace(/^Default\s*-\s*/i, '')}`
      : tr('camDefault');
    sel.appendChild(def);
    visible.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label;
      if (state.selectedCamId && d.deviceId === state.selectedCamId) o.selected = true;
      sel.appendChild(o);
    });
    if (needsAccess || !cams.length) {
      const grant = document.createElement('option');
      grant.value = '__grant_camera__';
      grant.textContent = tr('camGrant');
      sel.appendChild(grant);
    }
  } catch {
    sel.innerHTML = `<option value="">${tr('camDefault')}</option><option value="__grant_camera__">${tr('camGrant')}</option>`;
  }
}
let requestingMediaAccess = false;
async function requestMediaAccess(kind) {
  if (requestingMediaAccess) return false;
  requestingMediaAccess = true;
  const sel = kind === 'microphone' ? $('micSel') : $('camSel');
  sel.disabled = true;
  try {
    if (desktop?.system.requestMediaAccess) {
      const granted = await desktop.system.requestMediaAccess(kind);
      if (!granted) throw new Error(kind === 'microphone' ? tr('micPermission') : (state.lang === 'th'
        ? 'ไม่สามารถเปิดกล้องได้ กรุณาอนุญาต Camera ให้ ZoomCut ใน System Settings'
        : 'Cannot open camera. Allow ZoomCut Camera access in System Settings.'));
    }
    const constraints = kind === 'microphone' ? { audio: true } : { video: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach(track => track.stop());
    await refreshMicDevices();
    await refreshCameraDevices();
    return true;
  } catch (error) {
    showActionableError(error?.message || (kind === 'microphone' ? tr('micPermission') : 'Camera permission denied'));
    if (kind === 'microphone') await refreshMicDevices();
    else await refreshCameraDevices();
    return false;
  } finally {
    requestingMediaAccess = false;
    sel.disabled = false;
  }
}
$('micSel').onchange = async e => {
  if (e.target.value === '__grant_microphone__') {
    e.target.value = '';
    await requestMediaAccess('microphone');
    return;
  }
  state.selectedMicId = e.target.value;
  localStorage.setItem('zoomcut-mic', state.selectedMicId);
};
$('camSel').onchange = async e => {
  if (e.target.value === '__grant_camera__') {
    e.target.value = '';
    await requestMediaAccess('camera');
    return;
  }
  state.selectedCamId = e.target.value;
  localStorage.setItem('zoomcut-camera', state.selectedCamId);
};
$('camToggle').onclick = async () => {
  const enable = !state.recordCamera;
  if (enable && !await requestMediaAccess('camera')) return;
  state.recordCamera = enable;
  localStorage.setItem('zoomcut-record-camera', state.recordCamera ? '1' : '0');
  applyLanguage();
};
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => { refreshMicDevices(); refreshCameraDevices(); });
}
refreshMicDevices();
refreshCameraDevices();

function startMicMeter(stream) {
  stopMicMeter();
  voiceRec.audioCtx = new AudioContext();
  const src = voiceRec.audioCtx.createMediaStreamSource(stream);
  voiceRec.analyser = voiceRec.audioCtx.createAnalyser();
  voiceRec.analyser.fftSize = 1024;
  voiceRec.data = new Uint8Array(voiceRec.analyser.fftSize);
  src.connect(voiceRec.analyser);
  const tick = () => {
    if (!voiceRec.active || !voiceRec.analyser) return;
    voiceRec.analyser.getByteTimeDomainData(voiceRec.data);
    let sum = 0;
    for (const v of voiceRec.data) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / voiceRec.data.length);
    if (performance.now() - voiceRec.lastPeakAt >= 80) {
      voiceRec.livePeaks.push(Math.min(1, rms * 4));
      voiceRec.lastPeakAt = performance.now();
    }
    $('micLevel').style.width = Math.min(100, Math.round(rms * 280)) + '%';
    voiceRec.meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

function compactPeaks(values, buckets = 48) {
  if (!values.length) return Array.from({ length: buckets }, () => 0.08);
  const peaks = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * values.length / buckets);
    const end = Math.max(start + 1, Math.floor((i + 1) * values.length / buckets));
    peaks.push(Math.max(0.02, ...values.slice(start, end)));
  }
  return peaks;
}

function queueRecordedChunk(event, kind) {
  if (!event.data.size) return;
  const sessionKey = kind === 'voice' ? 'voiceSession' : 'camSession';
  const writeKey = kind === 'voice' ? 'voiceWrite' : 'camWrite';
  const errorKey = kind === 'voice' ? 'voiceWriteError' : 'camWriteError';
  const chunksKey = kind === 'voice' ? 'chunks' : 'camChunks';
  if (!desktop || !voiceRec[sessionKey]) {
    voiceRec[chunksKey].push(event.data);
    return;
  }
  voiceRec[writeKey] = voiceRec[writeKey]
    .then(async () => desktop.project.appendStream(voiceRec[sessionKey].id, await event.data.arrayBuffer()))
    .catch(error => { voiceRec[errorKey] = error; });
}

async function finishRecordedMedia(kind, mimeType) {
  const sessionKey = kind === 'voice' ? 'voiceSession' : 'camSession';
  const writeKey = kind === 'voice' ? 'voiceWrite' : 'camWrite';
  const errorKey = kind === 'voice' ? 'voiceWriteError' : 'camWriteError';
  const chunksKey = kind === 'voice' ? 'chunks' : 'camChunks';
  await voiceRec[writeKey];
  if (voiceRec[errorKey]) throw voiceRec[errorKey];
  if (desktop && voiceRec[sessionKey]) {
    const stored = await desktop.project.finishStream(voiceRec[sessionKey].id);
    voiceRec[sessionKey] = null;
    return { ...stored, blob: null };
  }
  const blob = new Blob(voiceRec[chunksKey], { type: mimeType });
  return { path: null, url: URL.createObjectURL(blob), blob };
}
function stopMicMeter() {
  if (voiceRec.meterRaf) cancelAnimationFrame(voiceRec.meterRaf);
  voiceRec.meterRaf = null;
  $('micLevel').style.width = '0%';
  if (voiceRec.audioCtx) voiceRec.audioCtx.close().catch(() => {});
  voiceRec.audioCtx = null;
  voiceRec.analyser = null;
  voiceRec.data = null;
}

async function voicePeaksFromBlob(blob, buckets = 48) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try {
    const buffer = await ac.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / buckets));
    const peaks = [];
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const start = i * step, end = Math.min(data.length, start + step);
      for (let j = start; j < end; j++) max = Math.max(max, Math.abs(data[j]));
      peaks.push(Math.min(1, max));
    }
    return peaks;
  } catch {
    return Array.from({ length: buckets }, () => 0.08);
  } finally {
    ac.close().catch(() => {});
  }
}
function waveformHtml(peaks = []) {
  const vals = peaks.length ? peaks : Array.from({ length: 32 }, () => 0.08);
  return `<div class="voice-wave">${vals.map(v => `<span style="height:${Math.max(12, Math.round(v * 100))}%"></span>`).join('')}</div>`;
}

async function startVoiceover() {
  if (!state.loaded || state.mode !== 'video' || voiceRec.active) return;
  let stream;
  try {
    const audio = state.selectedMicId ? { deviceId: { exact: state.selectedMicId }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    await refreshMicDevices();
  } catch (e) {
    alert(tr('micPermission'));
    return;
  }
  voiceRec.active = true;
  voiceRec.stream = stream;
  voiceRec.chunks = [];
  voiceRec.camChunks = [];
  voiceRec.voiceWrite = Promise.resolve();
  voiceRec.camWrite = Promise.resolve();
  voiceRec.voiceWriteError = null;
  voiceRec.camWriteError = null;
  voiceRec.livePeaks = [];
  voiceRec.lastPeakAt = 0;
  voiceRec.start = sourceToOutputTime(video.currentTime);
  voiceRec.startedAt = performance.now();
  voiceRec.recorder = new MediaRecorder(stream);
  try {
    voiceRec.voiceSession = desktop ? await desktop.project.beginStream(assetExtension({ type: voiceRec.recorder.mimeType }, 'webm')) : null;
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    voiceRec.active = false;
    showActionableError(error.message);
    return;
  }
  voiceRec.recorder.ondataavailable = e => queueRecordedChunk(e, 'voice');
  voiceRec.recorder.onstop = async () => {
    try {
      const media = await finishRecordedMedia('voice', voiceRec.recorder.mimeType || 'audio/webm');
      const duration = Math.max(0.1, (performance.now() - voiceRec.startedAt) / 1000);
      const peaks = media.blob ? await voicePeaksFromBlob(media.blob) : compactPeaks(voiceRec.livePeaks);
      commitHistory();
      state.voiceovers.push({
        id: voiceId++, sourcePath: media.path,
        start: outputToSourceTime(voiceRec.start),
        duration: Math.min(duration, Math.max(0.1, outputDuration() - voiceRec.start)),
        outStart: Math.min(outputDuration() - 0.1, Math.max(0, voiceRec.start)),
        outDuration: Math.min(duration, Math.max(0.1, outputDuration() - voiceRec.start)),
        blob: media.blob, url: media.url, peaks,
        lane: 0, volume: 1, muted: false,
        name: tr('voiceClip', voiceId - 1), audio: new Audio(media.url),
      });
      updateVoiceUI();
    } catch (error) {
      if (voiceRec.voiceSession) desktop?.project.cancelStream(voiceRec.voiceSession.id).catch(() => {});
      voiceRec.voiceSession = null;
      showActionableError(error.message);
    } finally {
      voiceRec.stream?.getTracks().forEach(t => t.stop());
      stopMicMeter();
      voiceRec.active = false;
      $('voiceBtn').classList.remove('recording');
      $('voiceBtn').textContent = tr('voice');
    }
  };
  if (state.recordCamera) {
    try {
      const videoConstraints = state.selectedCamId ? { deviceId: { exact: state.selectedCamId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
      voiceRec.camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      await refreshCameraDevices();
      voiceRec.camRecorder = new MediaRecorder(voiceRec.camStream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
      voiceRec.camSession = desktop ? await desktop.project.beginStream('webm') : null;
      voiceRec.camRecorder.ondataavailable = e => queueRecordedChunk(e, 'camera');
      voiceRec.camRecorder.onstop = async () => {
        try {
          const media = await finishRecordedMedia('camera', voiceRec.camRecorder.mimeType || 'video/webm');
          const outDuration = Math.max(0.1, (performance.now() - voiceRec.startedAt) / 1000);
          const v = document.createElement('video');
          v.src = media.url; v.muted = true; v.playsInline = true;
          commitHistory();
          state.facecams.push({
            id: faceId++, sourcePath: media.path,
            start: outputToSourceTime(voiceRec.start),
            duration: Math.min(outDuration, Math.max(0.1, outputDuration() - voiceRec.start)),
            outStart: voiceRec.start,
            outDuration: Math.min(outDuration, Math.max(0.1, outputDuration() - voiceRec.start)),
            mediaOffset: 0, blob: media.blob, url: media.url, video: v, lane: 0,
            fadeIn: state.camDefaults.fadeIn, fadeOut: state.camDefaults.fadeOut,
            pos: state.camDefaults.pos, shape: state.camDefaults.shape, size: state.camDefaults.size, margin: state.camDefaults.margin,
            name: tr('cameraClip', faceId - 1),
          });
          updateCameraUI();
        } catch (error) {
          if (voiceRec.camSession) desktop?.project.cancelStream(voiceRec.camSession.id).catch(() => {});
          voiceRec.camSession = null;
          showActionableError(error.message);
        } finally {
          voiceRec.camStream?.getTracks().forEach(t => t.stop());
          voiceRec.camStream = null;
        }
      };
      voiceRec.camRecorder.start(250);
    } catch (e) {
      if (voiceRec.camSession) desktop?.project.cancelStream(voiceRec.camSession.id).catch(() => {});
      voiceRec.camSession = null;
      voiceRec.camStream?.getTracks().forEach(track => track.stop());
      voiceRec.camStream = null;
      alert(state.lang === 'th' ? 'เปิดกล้องไม่ได้ — ตรวจสิทธิ์ Camera ให้ ZoomCut' : 'Cannot open camera. Check ZoomCut Camera permission.');
    }
  }
  voiceRec.recorder.start(250);
  startMicMeter(stream);
  $('voiceBtn').classList.add('recording');
  $('voiceBtn').textContent = tr('stopVoice');
}
function stopVoiceover() {
  if (!voiceRec.active) return;
  try { voiceRec.recorder.stop(); } catch {}
  try { if (voiceRec.camRecorder && voiceRec.camRecorder.state !== 'inactive') voiceRec.camRecorder.stop(); } catch {}
}
$('voiceBtn').onclick = () => voiceRec.active ? stopVoiceover() : startVoiceover();

function updateVoiceUI() {
  const group = $('voiceTrackGroup');
  group.innerHTML = '';
  if (!video.duration) return;
  const needed = Math.max(1, state.voiceLaneCount, ...state.voiceovers.map(v => (v.lane || 0) + 1));
  state.voiceLaneCount = needed;
  for (let lane = 0; lane < needed; lane++) {
    const row = document.createElement('div');
    row.className = 'lane-row';
    row.innerHTML = `${laneLabelHtml('voice', lane, 'voiceLane')}<div class="voice-track" data-lane="${lane}"></div>`;
    const track = row.querySelector('.voice-track');
    for (const v of state.voiceovers.filter(x => (x.lane || 0) === lane)) {
      const el = document.createElement('div');
      const outStart = voiceOutStart(v);
      const outEnd = outStart + voiceOutDuration(v);
      const sourceStart = outputToSourceTime(outStart);
      const sourceEnd = outputToSourceTime(outEnd);
      el.className = 'voice-clip' + (v.id === state.selectedVoiceId ? ' selected' : '');
      el.dataset.id = v.id;
      el.style.left = (sourceStart / video.duration * 100) + '%';
      el.style.width = (Math.max(0.1, sourceEnd - sourceStart) / video.duration * 100) + '%';
      el.innerHTML = `<span class="clip-handle left" data-edge="left"></span>${waveformHtml(v.peaks)}<span class="voice-label">${escapeHtml(v.name || tr('voiceClip', v.id))}</span><span class="clip-handle right" data-edge="right"></span>`;
      track.appendChild(el);
    }
    group.appendChild(row);
  }
  const sel = state.voiceovers.find(v => v.id === state.selectedVoiceId);
  const panel = $('voiceEdit');
  if (sel) {
    panel.classList.add('visible');
    $('voiceEditLabel').textContent = `🎙 ${sel.name || tr('voiceClip', sel.id)} ${fmtTime(voiceOutStart(sel))}–${fmtTime(voiceOutStart(sel) + voiceOutDuration(sel))}`;
    renderLaneOptions($('voiceLane'), state.voiceLaneCount, sel.lane || 0, 'voiceLane');
    $('voiceVolume').value = sel.volume ?? 1;
    $('voiceVolumeVal').textContent = `${Math.round((sel.volume ?? 1) * 100)}%`;
    $('voiceMuted').checked = Boolean(sel.muted);
  } else {
    panel.classList.remove('visible');
  }
}
$('voiceTrackGroup').addEventListener('click', e => {
  const clip = e.target.closest('.voice-clip');
  if (!clip) { if (e.target.closest('.voice-track')) clearSelection(); return; }
  selectOnly('voice', parseInt(clip.dataset.id));
  const v = state.voiceovers.find(x => x.id === state.selectedVoiceId);
  if (v) video.currentTime = outputToSourceTime(voiceOutStart(v));
  updateVoiceUI();
});
let voiceDrag = null;
$('voiceTrackGroup').addEventListener('pointerdown', e => {
  const clip = e.target.closest('.voice-clip');
  if (!clip || !state.loaded) return;
  selectOnly('voice', parseInt(clip.dataset.id));
  const v = state.voiceovers.find(x => x.id === state.selectedVoiceId);
  if (!v) return;
  if (laneConfig('voice', v.lane || 0).locked) return;
  const track = clip.closest('.voice-track');
  const bounds = track.getBoundingClientRect();
  const sourceT = (e.clientX - bounds.left) / bounds.width * video.duration;
  const outT = sourceToOutputTime(sourceT);
  const edge = e.target.closest('.clip-handle')?.dataset.edge || null;
  commitHistory();
  voiceDrag = { clip: v, edge, offset: outT - clipOutStart(v), pointerId: e.pointerId };
  $('voiceTrackGroup').setPointerCapture(e.pointerId);
  video.currentTime = outputToSourceTime(clipOutStart(v));
  updateVoiceUI();
});
$('voiceTrackGroup').addEventListener('pointermove', e => {
  if (!voiceDrag) return;
  const lane = laneFromPoint('voiceTrackGroup', 'voice-track', e.clientX, e.clientY);
  if (lane !== null && !voiceDrag.edge) voiceDrag.clip.lane = lane;
  const track = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.voice-track')
    || $('voiceTrackGroup').querySelector(`.voice-track[data-lane="${voiceDrag.clip.lane || 0}"]`)
    || $('voiceTrackGroup').querySelector('.voice-track');
  const bounds = track.getBoundingClientRect();
  const sourceT = Math.min(video.duration, Math.max(0, (e.clientX - bounds.left) / bounds.width * video.duration));
  const outT = sourceToOutputTime(sourceT);
  if (voiceDrag.edge === 'left') setClipOutStart(voiceDrag.clip, snapOutTime(outT, bounds, voiceDrag.clip));
  else if (voiceDrag.edge === 'right') setClipOutEnd(voiceDrag.clip, snapOutTime(outT, bounds, voiceDrag.clip));
  else moveClipOut(voiceDrag.clip, snapOutTime(outT - voiceDrag.offset, bounds, voiceDrag.clip));
  updateVoiceUI();
});
$('voiceTrackGroup').addEventListener('pointerup', e => {
  if (!voiceDrag) return;
  const lane = laneFromPoint('voiceTrackGroup', 'voice-track', e.clientX, e.clientY);
  if (lane !== null && !voiceDrag.edge) voiceDrag.clip.lane = lane;
  voiceDrag = null;
  updateVoiceUI();
});
$('voiceDelete').onclick = () => {
  if (!state.selectedVoiceId || !confirm(tr('confirmDeleteVoice'))) return;
  commitHistory();
  const v = state.voiceovers.find(x => x.id === state.selectedVoiceId);
  if (v && v.audio) v.audio.pause();
  state.voiceovers = state.voiceovers.filter(x => x.id !== state.selectedVoiceId);
  state.selectedVoiceId = null;
  updateVoiceUI();
};
$('voiceClose').onclick = clearSelection;
$('voiceLane').onchange = e => {
  const v = state.voiceovers.find(x => x.id === state.selectedVoiceId);
  if (!v) return;
  commitHistory();
  v.lane = parseInt(e.target.value, 10) || 0;
  updateVoiceUI();
};
$('voiceVolume').oninput = e => {
  const clip = state.voiceovers.find(x => x.id === state.selectedVoiceId);
  if (!clip) return;
  clip.volume = parseFloat(e.target.value);
  $('voiceVolumeVal').textContent = `${Math.round(clip.volume * 100)}%`;
  if (clip.audio) clip.audio.volume = Math.min(1, clip.volume);
};
$('voiceMuted').onchange = e => {
  const clip = state.voiceovers.find(x => x.id === state.selectedVoiceId);
  if (!clip) return;
  clip.muted = e.target.checked;
  if (clip.audio) clip.audio.muted = clip.muted;
};
function stopVoicePreview() {
  for (const v of state.voiceovers) {
    if (!v.audio) continue;
    v.audio.pause();
  }
}
function syncVoicePreview(force = false) {
  if (!state.loaded || state.exporting || state.mode !== 'video') return;
  const outT = sourceToOutputTime(video.currentTime);
  for (const v of state.voiceovers) {
    if (!v.audio) v.audio = new Audio(v.url);
    const start = voiceOutStart(v), dur = voiceOutDuration(v);
    const inClip = !video.paused && laneEnabled('voice', v.lane || 0, 'audio') && outT >= start && outT <= start + dur && !!segAt(video.currentTime);
    if (!inClip) { v.audio.pause(); continue; }
    const off = Math.max(0, outT - start);
    if (force || Math.abs(v.audio.currentTime - off) > 0.12) v.audio.currentTime = off;
    v.audio.playbackRate = 1;
    v.audio.volume = Math.min(1, v.volume ?? 1);
    v.audio.muted = Boolean(v.muted);
    if (v.audio.paused) v.audio.play().catch(() => {});
  }
}

function updateCameraUI() {
  const group = $('cameraTrackGroup');
  group.innerHTML = '';
  if (!video.duration) return;
  const needed = Math.max(1, state.cameraLaneCount, ...state.facecams.map(c => (c.lane || 0) + 1));
  state.cameraLaneCount = needed;
  for (let lane = 0; lane < needed; lane++) {
    const row = document.createElement('div');
    row.className = 'lane-row';
    row.innerHTML = `${laneLabelHtml('camera', lane, 'cameraLane')}<div class="camera-track" data-lane="${lane}"></div>`;
    const track = row.querySelector('.camera-track');
    for (const c of state.facecams.filter(x => (x.lane || 0) === lane)) {
      const outStart = clipOutStart(c);
      const outEnd = outStart + clipOutDuration(c);
      const sourceStart = outputToSourceTime(outStart);
      const sourceEnd = outputToSourceTime(outEnd);
      const el = document.createElement('div');
      el.className = 'camera-clip' + (c.id === state.selectedFaceId ? ' selected' : '');
      el.dataset.id = c.id;
      el.style.left = (sourceStart / video.duration * 100) + '%';
      el.style.width = (Math.max(0.1, sourceEnd - sourceStart) / video.duration * 100) + '%';
      el.innerHTML = `<span class="clip-handle left" data-edge="left"></span><span class="voice-label">${escapeHtml(c.name || tr('cameraClip', c.id))}</span><span class="clip-handle right" data-edge="right"></span>`;
      track.appendChild(el);
    }
    group.appendChild(row);
  }
  const sel = state.facecams.find(c => c.id === state.selectedFaceId);
  const panel = $('cameraEdit');
  if (sel) {
    panel.classList.add('visible');
    $('cameraEditLabel').textContent = `${sel.name || tr('cameraClip', sel.id)} ${fmtTime(clipOutStart(sel))}–${fmtTime(clipOutStart(sel) + clipOutDuration(sel))}`;
    renderLaneOptions($('cameraLane'), state.cameraLaneCount, sel.lane || 0, 'cameraLane');
    $('camPos').value = sel.pos || state.camDefaults.pos;
    $('camShape').value = sel.shape || state.camDefaults.shape;
    $('camSize').value = sel.size ?? state.camDefaults.size;
    $('camMargin').value = sel.margin ?? state.camDefaults.margin;
    $('camSizeVal').textContent = `${sel.size ?? state.camDefaults.size}%`;
    $('camMarginVal').textContent = `${sel.margin ?? state.camDefaults.margin}%`;
    $('camFadeIn').value = sel.fadeIn ?? 0;
    $('camFadeOut').value = sel.fadeOut ?? 0;
    $('camFadeInVal').textContent = (sel.fadeIn ?? 0).toFixed(1) + 's';
    $('camFadeOutVal').textContent = (sel.fadeOut ?? 0).toFixed(1) + 's';
  } else {
    panel.classList.remove('visible');
  }
}
let camDrag = null;
$('cameraTrackGroup').addEventListener('pointerdown', e => {
  const clip = e.target.closest('.camera-clip');
  if (!clip) { if (e.target.closest('.camera-track')) clearSelection(); return; }
  if (!state.loaded) return;
  selectOnly('camera', parseInt(clip.dataset.id));
  const c = state.facecams.find(x => x.id === state.selectedFaceId);
  if (!c) return;
  if (laneConfig('camera', c.lane || 0).locked) return;
  const track = clip.closest('.camera-track');
  const bounds = track.getBoundingClientRect();
  const sourceT = (e.clientX - bounds.left) / bounds.width * video.duration;
  const outT = sourceToOutputTime(sourceT);
  const edge = e.target.closest('.clip-handle')?.dataset.edge || null;
  commitHistory();
  camDrag = { clip: c, edge, offset: outT - clipOutStart(c) };
  $('cameraTrackGroup').setPointerCapture(e.pointerId);
  video.currentTime = outputToSourceTime(clipOutStart(c));
  updateCameraUI();
});
$('cameraTrackGroup').addEventListener('pointermove', e => {
  if (!camDrag) return;
  const lane = laneFromPoint('cameraTrackGroup', 'camera-track', e.clientX, e.clientY);
  if (lane !== null && !camDrag.edge) camDrag.clip.lane = lane;
  const track = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.camera-track')
    || $('cameraTrackGroup').querySelector(`.camera-track[data-lane="${camDrag.clip.lane || 0}"]`)
    || $('cameraTrackGroup').querySelector('.camera-track');
  const bounds = track.getBoundingClientRect();
  const sourceT = Math.min(video.duration, Math.max(0, (e.clientX - bounds.left) / bounds.width * video.duration));
  const outT = sourceToOutputTime(sourceT);
  if (camDrag.edge === 'left') setClipOutStart(camDrag.clip, snapOutTime(outT, bounds, camDrag.clip));
  else if (camDrag.edge === 'right') setClipOutEnd(camDrag.clip, snapOutTime(outT, bounds, camDrag.clip));
  else moveClipOut(camDrag.clip, snapOutTime(outT - camDrag.offset, bounds, camDrag.clip));
  updateCameraUI(); requestRender();
});
$('cameraTrackGroup').addEventListener('pointerup', e => {
  if (!camDrag) return;
  const lane = laneFromPoint('cameraTrackGroup', 'camera-track', e.clientX, e.clientY);
  if (lane !== null && !camDrag.edge) camDrag.clip.lane = lane;
  camDrag = null;
  updateCameraUI(); requestRender();
});
$('cameraDelete').onclick = () => {
  if (!state.selectedFaceId || !confirm(tr('confirmDeleteCamera'))) return;
  commitHistory();
  state.facecams = state.facecams.filter(x => x.id !== state.selectedFaceId);
  state.selectedFaceId = null;
  updateCameraUI(); requestRender();
};
$('cameraClose').onclick = clearSelection;
$('cameraLane').onchange = e => {
  const c = state.facecams.find(x => x.id === state.selectedFaceId);
  if (!c) return;
  commitHistory();
  c.lane = parseInt(e.target.value, 10) || 0;
  updateCameraUI();
};
function bindCameraFade(id, key, valId) {
  $(id).addEventListener('input', e => {
    const c = state.facecams.find(x => x.id === state.selectedFaceId);
    const val = parseFloat(e.target.value);
    if (c) c[key] = val;
    else state.camDefaults[key] = val;
    $(valId).textContent = val.toFixed(1) + 's';
    requestRender();
  });
}
bindCameraFade('camFadeIn', 'fadeIn', 'camFadeInVal');
bindCameraFade('camFadeOut', 'fadeOut', 'camFadeOutVal');
function bindCameraControl(id, key, valId, fmt) {
  $(id).addEventListener('input', e => {
    const c = state.facecams.find(x => x.id === state.selectedFaceId);
    const val = e.target.type === 'range' ? parseFloat(e.target.value) : e.target.value;
    if (c) c[key] = val;
    else state.camDefaults[key] = val;
    if (valId) $(valId).textContent = fmt ? fmt(val) : String(val);
    requestRender();
  });
}
bindCameraControl('camPos', 'pos');
bindCameraControl('camShape', 'shape');
bindCameraControl('camSize', 'size', 'camSizeVal', v => `${v}%`);
bindCameraControl('camMargin', 'margin', 'camMarginVal', v => `${v}%`);

function updatePlayheadUI() {
  if (!state.loaded || !video.duration) return;
  const frac = video.currentTime / video.duration;
  playhead.style.left = (frac * 100) + '%';
  const outLen = outputDuration();
  const edited = state.segments.length > 1 || state.segments.some(s => s.speed !== 1)
    || (state.segments[0] && (state.segments[0].start > 0.05 || state.segments[0].end < video.duration - 0.05));
  $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`
    + (edited ? ` • ${tr('output')} ${fmtTime(outLen)}` : '');
  updatePreviewTransport();
}

// ---------- Segments (ตัดหลายท่อน + speed แยกท่อน) ----------
let segId = 1;
function initSegments() {
  state.segments = [{ id: segId++, start: 0, end: video.duration, speed: 1, lane: 0 }];
  state.selectedSeg = null;
  updateSegUI();
}
function outputDuration() {
  return state.segments.reduce((a, s) => a + (s.end - s.start) / s.speed, 0);
}
function segmentOutputStart(target) {
  let out = 0;
  for (const s of state.segments) {
    if (s === target || s.id === target.id) return out;
    out += (s.end - s.start) / s.speed;
  }
  return out;
}
function sourceToOutputTime(t) {
  let out = 0;
  for (const s of state.segments) {
    if (t >= s.start - 1e-3 && t <= s.end + 1e-3) return out + Math.max(0, t - s.start) / s.speed;
    out += (s.end - s.start) / s.speed;
  }
  return Math.max(0, Math.min(outputDuration(), out));
}
function outputToSourceTime(outT) {
  let cursor = 0;
  for (const s of state.segments) {
    const len = (s.end - s.start) / s.speed;
    if (outT <= cursor + len + 1e-3) return Math.min(s.end, s.start + Math.max(0, outT - cursor) * s.speed);
    cursor += len;
  }
  const last = state.segments[state.segments.length - 1];
  return last ? last.end : 0;
}
function voiceOutStart(v) {
  if (v.outStart !== undefined) return v.outStart;
  return sourceToOutputTime(v.start || 0);
}
function voiceOutDuration(v) {
  return v.outDuration !== undefined ? v.outDuration : (v.duration || 0);
}
function clipMediaOffset(c) { return c.mediaOffset || 0; }
function clipOutStart(c) { return c.outStart !== undefined ? c.outStart : voiceOutStart(c); }
function clipOutDuration(c) { return c.outDuration !== undefined ? c.outDuration : voiceOutDuration(c); }
function snapOutTime(value, bounds, exclude) {
  const candidates = [0, outputDuration(), sourceToOutputTime(video.currentTime)];
  for (const clip of [...state.videoClips, ...state.voiceovers, ...state.facecams]) {
    if (clip === exclude) continue;
    candidates.push(clipOutStart(clip), clipOutStart(clip) + clipOutDuration(clip));
  }
  return ZoomCutCore.snapTime(value, candidates, outputDuration() * 8 / Math.max(1, bounds?.width || 1));
}
function setClipOutStart(c, start) {
  const end = clipOutStart(c) + clipOutDuration(c);
  c.outStart = Math.max(0, Math.min(start, end - 0.1));
  c.outDuration = Math.max(0.1, end - c.outStart);
  c.start = outputToSourceTime(c.outStart);
  c.duration = c.outDuration;
}
function setClipOutEnd(c, end) {
  c.outDuration = Math.max(0.1, end - clipOutStart(c));
  c.duration = c.outDuration;
}
function moveClipOut(c, start) {
  const dur = clipOutDuration(c);
  c.outStart = Math.max(0, Math.min(outputDuration() - dur, start));
  c.start = outputToSourceTime(c.outStart);
}
function segAt(t) {
  return state.segments.find(s => t >= s.start - 1e-3 && t < s.end - 1e-3)
      || state.segments.find(s => t >= s.start - 1e-3 && t <= s.end + 1e-3);
}
function firstSeg() { return state.segments[0]; }

function actionSplitAtPlayhead() {
  const t = video.currentTime;
  const s = segAt(t);
  if (!s || t <= s.start + 0.05 || t >= s.end - 0.05) return false;
  commitHistory();
  const idx = state.segments.indexOf(s);
  const right = { id: segId++, start: t, end: s.end, speed: s.speed, lane: s.lane || 0 };
  s.end = t;
  state.segments.splice(idx + 1, 0, right);
  selectOnly('seg', right.id);
  updateSegUI();
  return true;
}
function actionTrimStartToPlayhead() {
  const t = video.currentTime;
  const s = state.segments.find(x => x.id === state.selectedSeg) || segAt(t);
  if (!s || t <= s.start + 0.05 || t >= s.end - 0.05) return false;
  commitHistory();
  s.start = t;
  selectOnly('seg', s.id);
  updateSegUI();
  return true;
}
function actionTrimEndToPlayhead() {
  const t = video.currentTime;
  const s = state.segments.find(x => x.id === state.selectedSeg) || segAt(t);
  if (!s || t <= s.start + 0.05 || t >= s.end - 0.05) return false;
  commitHistory();
  s.end = t;
  selectOnly('seg', s.id);
  updateSegUI();
  return true;
}
function actionDeleteSelected() {
  if (state.selectedId) {
    commitHistory();
    state.events = state.events.filter(e => e.id !== state.selectedId);
    state.selectedId = null;
    updateTimelineUI(); requestRender();
    return true;
  }
  if (state.selectedVideoId) {
    commitHistory();
    state.videoClips = state.videoClips.filter(x => x.id !== state.selectedVideoId);
    state.selectedVideoId = null;
    updateSegUI();
    requestRender();
    return true;
  }
  if (state.selectedVoiceId) {
    commitHistory();
    const v = state.voiceovers.find(x => x.id === state.selectedVoiceId);
    if (v && v.audio) v.audio.pause();
    state.voiceovers = state.voiceovers.filter(x => x.id !== state.selectedVoiceId);
    state.selectedVoiceId = null;
    updateVoiceUI();
    return true;
  }
  if (state.selectedFaceId) {
    commitHistory();
    state.facecams = state.facecams.filter(x => x.id !== state.selectedFaceId);
    state.selectedFaceId = null;
    updateCameraUI();
    requestRender();
    return true;
  }
  if (state.selectedSeg && state.segments.length > 1) {
    commitHistory();
    state.segments = state.segments.filter(s => s.id !== state.selectedSeg);
    state.selectedSeg = null;
    updateSegUI();
    jumpToSegStart();
    return true;
  }
  return false;
}

function duplicateSelection() {
  commitHistory();
  const offset = 0.2;
  if (state.selectedVideoId) {
    const source = state.videoClips.find(x => x.id === state.selectedVideoId);
    if (!source) return;
    const element = document.createElement('video');
    element.src = source.url; element.muted = true; element.playsInline = true;
    const copy = { ...source, id: videoClipId++, outStart: Math.min(outputDuration() - clipOutDuration(source), clipOutStart(source) + offset), video: element, audioSourceNode: undefined };
    state.videoClips.push(copy); selectOnly('videoClip', copy.id); updateSegUI(); requestRender(); return;
  }
  if (state.selectedVoiceId) {
    const source = state.voiceovers.find(x => x.id === state.selectedVoiceId);
    if (!source) return;
    const copy = { ...source, id: voiceId++, outStart: Math.min(outputDuration() - clipOutDuration(source), clipOutStart(source) + offset), audio: new Audio(source.url) };
    state.voiceovers.push(copy); selectOnly('voice', copy.id); updateVoiceUI(); return;
  }
  if (state.selectedFaceId) {
    const source = state.facecams.find(x => x.id === state.selectedFaceId);
    if (!source) return;
    const element = document.createElement('video');
    element.src = source.url; element.muted = true; element.playsInline = true;
    const copy = { ...source, id: faceId++, outStart: Math.min(outputDuration() - clipOutDuration(source), clipOutStart(source) + offset), video: element };
    state.facecams.push(copy); selectOnly('camera', copy.id); updateCameraUI(); requestRender(); return;
  }
  if (state.selectedId) {
    const source = state.events.find(x => x.id === state.selectedId);
    if (!source) return;
    const copy = { ...source, id: nextId++, start: Math.min(video.duration - eventDuration(source), source.start + offset) };
    state.events.push(copy); state.events.sort((a, b) => a.start - b.start); selectOnly('marker', copy.id); updateTimelineUI(); requestRender();
  }
}
function splitVideoClipAtPlayhead() {
  const outT = sourceToOutputTime(video.currentTime);
  const c = state.videoClips.find(x => outT > clipOutStart(x) + 0.05 && outT < clipOutStart(x) + clipOutDuration(x) - 0.05);
  if (!c) return false;
  commitHistory();
  const leftDur = outT - clipOutStart(c);
  const rightDur = clipOutDuration(c) - leftDur;
  const rightVideo = document.createElement('video');
  rightVideo.src = c.url; rightVideo.muted = true; rightVideo.playsInline = true; rightVideo.preload = 'auto';
  const right = { ...c, id: videoClipId++, outStart: outT, outDuration: rightDur, start: outputToSourceTime(outT), duration: rightDur, mediaOffset: clipMediaOffset(c) + leftDur, name: tr('videoClip', videoClipId - 1), video: rightVideo };
  c.outDuration = leftDur; c.duration = leftDur;
  state.videoClips.push(right);
  selectOnly('videoClip', right.id);
  updateSegUI();
  return true;
}
function splitVoiceAtPlayhead() {
  const outT = sourceToOutputTime(video.currentTime);
  const v = state.voiceovers.find(x => outT > clipOutStart(x) + 0.05 && outT < clipOutStart(x) + clipOutDuration(x) - 0.05);
  if (!v) return false;
  commitHistory();
  const leftDur = outT - clipOutStart(v);
  const rightDur = clipOutDuration(v) - leftDur;
  const right = { ...v, id: voiceId++, outStart: outT, outDuration: rightDur, start: outputToSourceTime(outT), duration: rightDur, mediaOffset: clipMediaOffset(v) + leftDur, name: tr('voiceClip', voiceId - 1), audio: new Audio(v.url) };
  v.outDuration = leftDur; v.duration = leftDur;
  state.voiceovers.push(right);
  selectOnly('voice', right.id);
  updateVoiceUI();
  return true;
}
function splitCameraAtPlayhead() {
  const outT = sourceToOutputTime(video.currentTime);
  const c = state.facecams.find(x => outT > clipOutStart(x) + 0.05 && outT < clipOutStart(x) + clipOutDuration(x) - 0.05);
  if (!c) return false;
  commitHistory();
  const leftDur = outT - clipOutStart(c);
  const rightDur = clipOutDuration(c) - leftDur;
  const rightVideo = document.createElement('video');
  rightVideo.src = c.url; rightVideo.muted = true; rightVideo.playsInline = true;
  const right = { ...c, id: faceId++, outStart: outT, outDuration: rightDur, start: outputToSourceTime(outT), duration: rightDur, mediaOffset: clipMediaOffset(c) + leftDur, name: tr('cameraClip', faceId - 1), video: rightVideo };
  c.outDuration = leftDur; c.duration = leftDur;
  state.facecams.push(right);
  selectOnly('camera', right.id);
  updateCameraUI();
  return true;
}
function selectSegmentNearPlayhead(dir = 1) {
  if (!state.segments.length) return;
  const ordered = state.segments.slice().sort((a, b) => a.start - b.start);
  let idx = ordered.findIndex(s => s.id === state.selectedSeg);
  if (idx < 0) idx = ordered.findIndex(s => video.currentTime < s.end);
  idx = Math.min(ordered.length - 1, Math.max(0, idx + dir));
  selectOnly('seg', ordered[idx].id);
  video.currentTime = ordered[idx].start;
  updateSegUI();
}
function seekBy(delta) {
  if (!state.loaded || state.mode !== 'video') return;
  video.currentTime = Math.min(video.duration || 0, Math.max(0, video.currentTime + delta));
}
function setTimelineZoom(next) {
  if (!state.loaded) return;
  const dur = video.duration || 1;
  const anchor = dur ? video.currentTime / dur : 0;
  state.timelineZoom = Math.min(8, Math.max(1, next));
  updateTimelineScale(anchor);
}
$('addVideoLane').onclick = () => { state.videoLaneCount++; updateSegUI(); };
$('addVoiceLane').onclick = () => { state.voiceLaneCount++; updateVoiceUI(); };
$('addCameraLane').onclick = () => { state.cameraLaneCount++; updateCameraUI(); };
bindLaneTools('videoTrackGroup', 'video', updateSegUI);
bindLaneTools('voiceTrackGroup', 'voice', updateVoiceUI);
bindLaneTools('cameraTrackGroup', 'camera', updateCameraUI);

function updateSegUI() {
  const group = $('videoTrackGroup');
  group.innerHTML = '';
  if (!video.duration) return;
  const needed = Math.max(1, state.videoLaneCount, ...state.segments.map(s => (s.lane || 0) + 1), ...state.videoClips.map(c => (c.lane || 0) + 1));
  state.videoLaneCount = needed;
  for (let lane = 0; lane < needed; lane++) {
    const row = document.createElement('div');
    row.className = 'lane-row';
    row.innerHTML = `${laneLabelHtml('video', lane, 'videoLane')}<div class="seg-track" data-lane="${lane}"></div>`;
    const track = row.querySelector('.seg-track');
    for (const s of state.segments.filter(x => (x.lane || 0) === lane)) {
      const el = document.createElement('div');
      el.className = 'seg-block' + (s.id === state.selectedSeg ? ' selected' : '') + (s.speed > 1 ? ' fast' : '');
      el.style.left = (s.start / video.duration * 100) + '%';
      el.style.width = ((s.end - s.start) / video.duration * 100) + '%';
      el.dataset.id = s.id;
      el.dataset.kind = 'segment';
      el.innerHTML = `<span class="seg-handle left" data-edge="left"></span><span class="spd">${s.speed}x</span><span class="seg-handle right" data-edge="right"></span>`;
      track.appendChild(el);
    }
    for (const c of state.videoClips.filter(x => (x.lane || 0) === lane)) {
      const outStart = clipOutStart(c);
      const outEnd = outStart + clipOutDuration(c);
      const sourceStart = outputToSourceTime(outStart);
      const sourceEnd = outputToSourceTime(outEnd);
      const el = document.createElement('div');
      el.className = 'seg-block overlay' + (c.id === state.selectedVideoId ? ' selected' : '');
      el.style.left = (sourceStart / video.duration * 100) + '%';
      el.style.width = (Math.max(0.1, sourceEnd - sourceStart) / video.duration * 100) + '%';
      el.dataset.id = c.id;
      el.dataset.kind = 'clip';
      el.innerHTML = `<span class="seg-handle left" data-edge="left"></span><span class="spd">${escapeHtml(c.name || tr('videoClip', c.id))}</span><span class="seg-handle right" data-edge="right"></span>`;
      track.appendChild(el);
    }
    group.appendChild(row);
  }
  updateRulerUI();
  updateVoiceUI();
  updateCameraUI();
  const sel = state.segments.find(s => s.id === state.selectedSeg);
  const clipSel = state.videoClips.find(c => c.id === state.selectedVideoId);
  const panel = $('segEdit');
  if (sel || clipSel) {
    panel.classList.add('visible');
    const speedWrap = $('segSpeed').closest('span');
    if (sel) {
      speedWrap.style.display = '';
      $('overlayControls').style.display = 'none';
      $('segSpeed').value = String(sel.speed);
      renderLaneOptions($('segLane'), state.videoLaneCount, sel.lane || 0, 'videoLane');
      $('segEditLabel').textContent = `${tr('selectedSegment')} ${fmtTime(sel.start)}–${fmtTime(sel.end)}`;
    } else {
      speedWrap.style.display = 'none';
      $('overlayControls').style.display = '';
      $('overlayScale').value = clipSel.scale ?? 100;
      $('overlayScaleVal').textContent = `${clipSel.scale ?? 100}%`;
      $('overlayX').value = clipSel.posX ?? 50;
      $('overlayY').value = clipSel.posY ?? 50;
      $('overlayOpacity').value = clipSel.opacity ?? 1;
      $('overlayVolume').value = clipSel.volume ?? 1;
      $('overlayMuted').checked = Boolean(clipSel.muted);
      renderLaneOptions($('segLane'), state.videoLaneCount, clipSel.lane || 0, 'videoLane');
      $('segEditLabel').textContent = `🎞 ${tr('selectedOverlayVideo')} ${fmtTime(clipOutStart(clipSel))}–${fmtTime(clipOutStart(clipSel) + clipOutDuration(clipSel))}`;
    }
  } else {
    panel.classList.remove('visible');
    $('overlayControls').style.display = 'none';
  }
  updatePlayheadUI();
}

function bindOverlayControl(id, key, format) {
  $(id).addEventListener('input', e => {
    const clip = state.videoClips.find(x => x.id === state.selectedVideoId);
    if (!clip) return;
    clip[key] = parseFloat(e.target.value);
    if (format) format(clip[key]);
    requestRender(); markProjectDirty();
  });
}
bindOverlayControl('overlayScale', 'scale', value => $('overlayScaleVal').textContent = `${Math.round(value)}%`);
bindOverlayControl('overlayX', 'posX');
bindOverlayControl('overlayY', 'posY');
bindOverlayControl('overlayOpacity', 'opacity');
bindOverlayControl('overlayVolume', 'volume');
$('overlayMuted').onchange = e => {
  const clip = state.videoClips.find(x => x.id === state.selectedVideoId);
  if (!clip) return;
  clip.muted = e.target.checked; markProjectDirty();
};

function updateRulerUI() {
  const ruler = $('ruler');
  ruler.innerHTML = '';
  if (!video.duration) return;
  const approxTicks = Math.min(10, Math.max(4, Math.floor(video.duration / 2)));
  const step = video.duration / approxTicks;
  for (let i = 0; i <= approxTicks; i++) {
    const t = Math.min(video.duration, i * step);
    const el = document.createElement('div');
    el.className = 'ruler-tick';
    el.style.left = (t / video.duration * 100) + '%';
    el.textContent = fmtTime(t);
    ruler.appendChild(el);
  }
}

function clampSegment(s) {
  const minLen = 0.1;
  const ordered = state.segments.slice().sort((a, b) => a.start - b.start);
  const idx = ordered.indexOf(s);
  const prev = ordered[idx - 1];
  const next = ordered[idx + 1];
  s.start = Math.max(prev ? prev.end : 0, Math.min(s.start, s.end - minLen));
  s.end = Math.min(next ? next.start : video.duration, Math.max(s.end, s.start + minLen));
}

let segDrag = null;
$('videoTrackGroup').addEventListener('pointerdown', e => {
  const block = e.target.closest('.seg-block');
  if (!block) { if (e.target.closest('.seg-track')) clearSelection(); return; }
  const kind = block.dataset.kind || 'segment';
  const id = parseInt(block.dataset.id);
  if (kind === 'clip') selectOnly('videoClip', id);
  else selectOnly('seg', id);
  const s = kind === 'clip'
    ? state.videoClips.find(x => x.id === state.selectedVideoId)
    : state.segments.find(x => x.id === state.selectedSeg);
  if (!s) return;
  if (laneConfig('video', s.lane || 0).locked) return;
  const track = block.closest('.seg-track');
  const bounds = track.getBoundingClientRect();
  const edge = e.target.closest('.seg-handle')?.dataset.edge || null;
  const t = (e.clientX - bounds.left) / bounds.width * video.duration;
  const outT = sourceToOutputTime(t);
  segDrag = kind === 'clip'
    ? { kind, s, edge, offset: outT - clipOutStart(s) }
    : { kind, s, edge, offsetStart: t - s.start, offsetEnd: s.end - t };
  if (edge || kind === 'clip') commitHistory();
  $('videoTrackGroup').setPointerCapture(e.pointerId);
  video.currentTime = kind === 'clip' ? outputToSourceTime(clipOutStart(s)) : (edge === 'right' ? s.end : s.start);
  updateSegUI();
});
$('videoTrackGroup').addEventListener('pointermove', e => {
  if (!segDrag || !video.duration) return;
  const lane = laneFromPoint('videoTrackGroup', 'seg-track', e.clientX, e.clientY);
  if (segDrag.kind === 'clip' && lane !== null && !segDrag.edge) segDrag.s.lane = lane;
  const track = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.seg-track')
    || $('videoTrackGroup').querySelector(`.seg-track[data-lane="${segDrag.s.lane || 0}"]`)
    || $('videoTrackGroup').querySelector('.seg-track');
  const bounds = track.getBoundingClientRect();
  const raw = Math.min(video.duration, Math.max(0, (e.clientX - bounds.left) / bounds.width * video.duration));
  if (segDrag.kind === 'clip') {
    const outT = sourceToOutputTime(raw);
    if (segDrag.edge === 'left') setClipOutStart(segDrag.s, snapOutTime(outT, bounds, segDrag.s));
    else if (segDrag.edge === 'right') setClipOutEnd(segDrag.s, snapOutTime(outT, bounds, segDrag.s));
    else moveClipOut(segDrag.s, snapOutTime(outT - segDrag.offset, bounds, segDrag.s));
    video.currentTime = outputToSourceTime(clipOutStart(segDrag.s));
  } else if (segDrag.edge === 'left') {
    segDrag.s.start = raw;
    clampSegment(segDrag.s);
    video.currentTime = segDrag.s.start;
  } else if (segDrag.edge === 'right') {
    segDrag.s.end = raw;
    clampSegment(segDrag.s);
    video.currentTime = Math.max(segDrag.s.start, segDrag.s.end - 0.02);
  }
  updateSegUI(); requestRender();
});
$('videoTrackGroup').addEventListener('pointerup', e => {
  if (!segDrag) return;
  const lane = laneFromPoint('videoTrackGroup', 'seg-track', e.clientX, e.clientY);
  if (segDrag.kind === 'clip' && lane !== null && !segDrag.edge) segDrag.s.lane = lane;
  segDrag = null;
  updateSegUI(); requestRender();
});

$('splitBtn').onclick = () => {
  actionSplitAtPlayhead();
};

$('segDelete').onclick = () => {
  if (state.selectedVideoId) {
    if (!confirm(tr('confirmDeleteVideoClip'))) return;
    commitHistory();
    state.videoClips = state.videoClips.filter(c => c.id !== state.selectedVideoId);
    state.selectedVideoId = null;
    updateSegUI(); requestRender();
    return;
  }
  if (state.segments.length <= 1) { alert(tr('oneSegmentRequired')); return; }
  if (!state.selectedSeg || !confirm(tr('confirmDeleteSegment'))) return;
  commitHistory();
  state.segments = state.segments.filter(s => s.id !== state.selectedSeg);
  state.selectedSeg = null;
  updateSegUI();
  jumpToSegStart();
};
$('segClose').onclick = clearSelection;

$('segSpeed').addEventListener('change', e => {
  const s = state.segments.find(x => x.id === state.selectedSeg);
  if (!s) return;
  commitHistory();
  s.speed = parseFloat(e.target.value);
  if (segAt(video.currentTime) === s) video.playbackRate = s.speed;
  updateSegUI();
});
$('segLane').addEventListener('change', e => {
  const s = state.selectedVideoId
    ? state.videoClips.find(x => x.id === state.selectedVideoId)
    : state.segments.find(x => x.id === state.selectedSeg);
  if (!s) return;
  commitHistory();
  s.lane = parseInt(e.target.value, 10) || 0;
  updateSegUI();
});

// เลื่อน playhead ไปยังต้นท่อนแรกที่ยังเหลือ (ใช้หลังลบท่อน)
function jumpToSegStart() {
  if (state.segments.length) video.currentTime = state.segments[0].start;
}

// ตัวขับการเล่นแบบข้ามช่องที่ถูกตัด + ใช้ speed ต่อท่อน
// timeupdate เป็น backup ให้การข้ามช่วงตัดทำงานแม้แท็บถูกพักเบื้องหลัง (rAF หยุด)
video.addEventListener('timeupdate', () => {
  if (state.mode === 'video' && !video.paused) segPlaybackTick();
});

// ติดตามท่อนที่กำลังเล่นด้วย index (ชัดเจน ไม่กำกวมที่ขอบท่อน)
let playIdx = 0;
function startSegPlayback() {
  // เริ่มเล่นจากท่อนที่ครอบ currentTime อยู่ หรือท่อนถัดไป ถ้าไม่มีก็ท่อนแรก
  const t = video.currentTime;
  let idx = state.segments.findIndex(s => t >= s.start - 0.02 && t < s.end - 0.02);
  if (idx < 0) idx = state.segments.findIndex(s => s.start >= t - 0.02);
  if (idx < 0) idx = 0;
  playIdx = idx;
  const s = state.segments[idx];
  if (t < s.start - 0.02 || t >= s.end - 0.02) video.currentTime = s.start;
  video.playbackRate = s.speed;
}
function segPlaybackTick() {
  if (state.exporting || video.paused || video.seeking || !state.segments.length) return;
  const s = state.segments[playIdx];
  if (!s) { video.pause(); return; }
  if (Math.abs(video.playbackRate - s.speed) > 1e-3) video.playbackRate = s.speed;
  if (video.currentTime >= s.end - 0.03) {
    const next = state.segments[playIdx + 1];
    if (next) { playIdx++; video.currentTime = next.start; video.playbackRate = next.speed; }
    else video.pause();
  }
}

function updateTimelineUI() {
  timeline.querySelectorAll('.zoom-marker').forEach(el => el.remove());
  if (!video.duration) return;
  for (const ev of state.events) {
    const el = document.createElement('div');
    normalizeEventTiming(ev);
    el.className = 'zoom-marker' + (ev.id === state.selectedId ? ' selected' : '');
    const dur = eventDuration(ev);
    el.style.left = (ev.start / video.duration * 100) + '%';
    el.style.width = (dur / video.duration * 100) + '%';
    el.dataset.id = ev.id;
    el.innerHTML = `<span class="z-handle left" data-edge="left"></span><span class="zlabel">${ev.zoom.toFixed(1)}x</span><span class="z-handle right" data-edge="right"></span>`;
    timeline.appendChild(el);
  }
  $('zoomCount').textContent = state.events.length ? tr('zoomPoints', state.events.length) : '';
  updateMarkerEditUI();
  updatePlayheadUI();
}

function updateMarkerEditUI() {
  const ev = state.events.find(e => e.id === state.selectedId);
  const panel = $('markerEdit');
  if (!ev) { panel.classList.remove('visible'); return; }
  panel.classList.add('visible');
  $('mZoom').value = ev.zoom;
  $('mZoomVal').textContent = ev.zoom.toFixed(1) + 'x';
  $('mIn').value = ev.tIn;
  $('mInVal').textContent = ev.tIn.toFixed(2).replace(/0$/,'').replace(/\.0$/,'') + 's';
  $('mHold').value = ev.hold;
  $('mHoldVal').textContent = ev.hold.toFixed(1) + 's';
  $('mOut').value = ev.tOut;
  $('mOutVal').textContent = ev.tOut.toFixed(2).replace(/0$/,'').replace(/\.0$/,'') + 's';
}

$('mZoom').addEventListener('input', e => {
  const ev = state.events.find(x => x.id === state.selectedId);
  if (!ev) return;
  ev.zoom = parseFloat(e.target.value);
  $('mZoomVal').textContent = ev.zoom.toFixed(1) + 'x';
  updateTimelineUI(); requestRender();
});
$('mHold').addEventListener('input', e => {
  const ev = state.events.find(x => x.id === state.selectedId);
  if (!ev) return;
  ev.hold = parseFloat(e.target.value);
  $('mHoldVal').textContent = ev.hold.toFixed(1) + 's';
  updateTimelineUI(); requestRender();
});
function bindMarkerTimeSlider(id, key, valId) {
  $(id).addEventListener('input', e => {
    const ev = state.events.find(x => x.id === state.selectedId);
    if (!ev) return;
    ev[key] = parseFloat(e.target.value);
    normalizeEventTiming(ev);
    $(valId).textContent = ev[key].toFixed(2).replace(/0$/,'').replace(/\.0$/,'') + 's';
    updateTimelineUI(); requestRender();
  });
}
bindMarkerTimeSlider('mIn', 'tIn', 'mInVal');
bindMarkerTimeSlider('mOut', 'tOut', 'mOutVal');
$('mGrowL').onclick = () => {
  const ev = state.events.find(x => x.id === state.selectedId);
  if (!ev) return;
  shiftEventStart(ev, ev.start - 0.25);
  updateTimelineUI(); requestRender();
};
$('mGrowR').onclick = () => {
  const ev = state.events.find(x => x.id === state.selectedId);
  if (!ev) return;
  setEventEnd(ev, eventEnd(ev) + 0.25);
  updateTimelineUI(); requestRender();
};
$('mDelete').onclick = () => {
  commitHistory();
  state.events = state.events.filter(e => e.id !== state.selectedId);
  state.selectedId = null;
  updateTimelineUI(); requestRender();
};
$('markerClose').onclick = clearSelection;

// timeline interactions: click = seek, click marker = select, drag marker = move
let dragging = null;
timeline.addEventListener('pointerdown', e => {
  if (!state.loaded || !video.duration) return;
  const bounds = timeline.getBoundingClientRect();
  const marker = e.target.closest('.zoom-marker');
  if (marker) {
    const id = parseInt(marker.dataset.id);
    selectOnly('marker', id);
    const ev = state.events.find(x => x.id === id);
    const t = (e.clientX - bounds.left) / bounds.width * video.duration;
    const edge = e.target.closest('.z-handle')?.dataset.edge || null;
    dragging = { ev, edge, offsetT: t - ev.start, moved: false };
    commitHistory();
    timeline.setPointerCapture(e.pointerId);
    updateTimelineUI();
  } else {
    clearSelection();
    const frac = Math.min(1, Math.max(0, (e.clientX - bounds.left) / bounds.width));
    video.currentTime = frac * video.duration;
  }
});
timeline.addEventListener('pointermove', e => {
  if (!dragging) return;
  const bounds = timeline.getBoundingClientRect();
  const raw = (e.clientX - bounds.left) / bounds.width * video.duration;
  dragging.moved = true;
  if (dragging.edge === 'left') {
    shiftEventStart(dragging.ev, raw);
  } else if (dragging.edge === 'right') {
    setEventEnd(dragging.ev, raw);
  } else {
    const dur = eventDuration(dragging.ev);
    const t = raw - dragging.offsetT;
    dragging.ev.start = Math.min(Math.max(0, video.duration - dur), Math.max(0, t));
  }
  state.events.sort((a, b) => a.start - b.start);
  updateTimelineUI();
  requestRender();
});
timeline.addEventListener('pointerup', () => { dragging = null; });

// ---------- งานใหม่ ----------
$('newBtn').onclick = () => {
  if (state.loaded && !confirm(tr('newConfirm'))) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  Object.assign(state, {
    loaded: false, mode: 'video', imageEl: null,
    events: [], taps: [], selectedId: null,
    videoClips: [], selectedVideoId: null,
    voiceovers: [], selectedVoiceId: null,
    facecams: [], selectedFaceId: null,
    cursorPoints: [], annotations: [], annotationLaneCount: 1,
    segments: [], selectedSeg: null,
    videoLaneCount: 1,
    voiceLaneCount: 1,
    cameraLaneCount: 1,
    laneSettings: { video: [], voice: [], camera: [] },
    crop: { t: 0, r: 0, b: 0, l: 0 },
    timelineZoom: 1,
    baseMedia: null, projectPath: null, projectCreatedAt: null, dirty: false,
  });
  clearTimeout(autosaveTimer);
  if (desktop) desktop.project.clearRecovery().catch(() => {});
  if (desktop) desktop.project.resetCurrent().catch(() => {});
  $('projectSaveBtn').disabled = true;
  setProjectStatus('');
  syncCropUI();
  canvas.style.display = 'none';
  $('dropHint').style.display = '';
  $('playBtn').disabled = true;
  $('splitBtn').disabled = true;
  $('voiceBtn').disabled = true;
  $('quickVoice').disabled = true;
  $('exportBtn').disabled = true;
  $('videoExportPreset').disabled = true;
  $('snapBtn').disabled = true;
  $('exportBtn').textContent = tr('exportVideo');
  $('imgExportSec').style.display = 'none';
  document.querySelector('.timeline-area').style.display = '';
  $('editorShell').classList.remove('timeline-hidden');
  $('zoomCount').textContent = '';
  $('timeLabel').textContent = '0:00.0 / 0:00.0';
  $('previewTransport').hidden = true;
  updatePreviewTransport();
  playhead.style.left = '0';
  $('videoTrackGroup').innerHTML = '';
  $('voiceTrackGroup').innerHTML = '';
  $('cameraTrackGroup').innerHTML = '';
  $('ruler').innerHTML = '';
  updateTimelineScale();
  timeline.querySelectorAll('.zoom-marker').forEach(el => el.remove());
  $('markerEdit').classList.remove('visible');
  $('segEdit').classList.remove('visible');
  $('voiceEdit').classList.remove('visible');
  $('cameraEdit').classList.remove('visible');
  queueMicrotask(() => globalThis.refreshEditorShellIcons?.());
};

// ---------- Export PNG (ภาพนิ่ง / เฟรมปัจจุบัน) ----------
async function exportPNG(scale) {
  const ow = canvas.width, oh = canvas.height;
  canvas.width = ow * scale;
  canvas.height = oh * scale;
  drawFrame(true);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  canvas.width = ow; canvas.height = oh;
  requestRender();
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zoomcut-${state.mode === 'image' ? 'mockup' : 'frame'}@${scale}x.png`;
  a.click();
}

$('snapBtn').onclick = () => { if (state.loaded) exportPNG(state.exportScale); };

async function prepareVoiceBuffers(audioCtx) {
  const out = [];
  for (const v of state.voiceovers) {
    try {
      const arr = v.blob ? await v.blob.arrayBuffer() : await (await fetch(v.url)).arrayBuffer();
      const buffer = await audioCtx.decodeAudioData(arr.slice(0));
      out.push({ ...v, buffer });
    } catch (e) {}
  }
  return out;
}
function connectOverlayAudio(audioCtx, dest) {
  const connected = [];
  for (const clip of state.videoClips) {
    if (!clip.video) continue;
    try {
      if (!clip.audioSourceNode) clip.audioSourceNode = audioCtx.createMediaElementSource(clip.video);
      const gain = audioCtx.createGain();
      gain.gain.value = clip.muted || !laneEnabled('video', clip.lane || 0, 'audio') ? 0 : (clip.volume ?? 1);
      clip.audioSourceNode.connect(gain).connect(dest);
      clip.video.muted = false;
      connected.push({ clip, gain });
    } catch {}
  }
  return connected;
}
function getExportAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!exportAudioCtx || exportAudioCtx.state === 'closed') exportAudioCtx = new AC();
  return exportAudioCtx;
}
function getVideoAudioSource(audioCtx) {
  if (!videoAudioSourceNode) {
    videoAudioSourceNode = audioCtx.createMediaElementSource(video);
    videoAudioPreviewGain = audioCtx.createGain();
    videoAudioSourceNode.connect(videoAudioPreviewGain).connect(audioCtx.destination);
  }
  return videoAudioSourceNode;
}
function syncBaseAudioLane() {
  if (!videoAudioPreviewGain) return;
  const segment = segAt(video.currentTime);
  videoAudioPreviewGain.gain.value = segment && laneEnabled('video', segment.lane || 0, 'audio') ? 1 : 0;
}
function scheduleVoiceoversForSegment(audioCtx, dest, voiceBuffers, seg) {
  const now = audioCtx.currentTime + 0.03;
  const segOutStart = segmentOutputStart(seg);
  const segOutEnd = segOutStart + (seg.end - seg.start) / seg.speed;
  for (const v of voiceBuffers) {
    if (!laneEnabled('voice', v.lane || 0, 'audio')) continue;
    const vStart = voiceOutStart(v);
    const vEnd = vStart + voiceOutDuration(v);
    const overlapStart = Math.max(vStart, segOutStart);
    const overlapEnd = Math.min(vEnd, segOutEnd);
    if (overlapEnd <= overlapStart) continue;
    const source = audioCtx.createBufferSource();
    source.buffer = v.buffer;
    source.playbackRate.value = 1;
    const gain = audioCtx.createGain();
    gain.gain.value = v.muted ? 0 : (v.volume ?? 1);
    source.connect(gain).connect(dest);
    const when = now + (overlapStart - segOutStart);
    const offset = Math.max(0, overlapStart - vStart);
    const sourceDur = overlapEnd - overlapStart;
    try { source.start(when, offset, sourceDur); } catch {}
  }
}

function offlineAudioPlan() {
  const clips = [];
  for (const clip of state.videoClips) if (clip.sourcePath && laneEnabled('video', clip.lane || 0, 'audio')) {
    clips.push({ path: clip.sourcePath, offset: clipMediaOffset(clip), duration: clipOutDuration(clip), outStart: clipOutStart(clip), volume: clip.muted ? 0 : (clip.volume ?? 1) });
  }
  for (const clip of state.voiceovers) if (clip.sourcePath && laneEnabled('voice', clip.lane || 0, 'audio')) {
    clips.push({ path: clip.sourcePath, offset: clipMediaOffset(clip), duration: clipOutDuration(clip), outStart: clipOutStart(clip), volume: clip.muted ? 0 : (clip.volume ?? 1) });
  }
  return {
    duration: outputDuration(),
    base: state.baseMedia?.sourcePath ? {
      path: state.baseMedia.sourcePath,
      segments: state.segments.map(segment => ({
        start: segment.start, end: segment.end, speed: segment.speed,
        volume: laneEnabled('video', segment.lane || 0, 'audio') ? 1 : 0,
      })),
    } : null,
    clips,
  };
}

function seekElement(element, time) {
  if (!element || !Number.isFinite(time)) return Promise.resolve();
  const target = Math.max(0, Math.min(Math.max(0, (element.duration || time) - 0.001), time));
  if (element.readyState >= 2 && Math.abs((element.currentTime || 0) - target) < 0.002) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out seeking media for offline export')); }, 10000);
    const cleanup = () => { clearTimeout(timer); element.removeEventListener('seeked', done); element.removeEventListener('error', failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Could not decode media during offline export')); };
    element.addEventListener('seeked', done, { once: true });
    element.addEventListener('error', failed, { once: true });
    element.currentTime = target;
  });
}

async function seekOfflineFrame(outTime) {
  const safeOut = Math.min(Math.max(0, outputDuration() - 0.0001), outTime + 0.000001);
  await seekElement(video, outputToSourceTime(safeOut));
  const active = [...state.videoClips, ...state.facecams]
    .filter(clip => safeOut >= clipOutStart(clip) && safeOut < clipOutStart(clip) + clipOutDuration(clip));
  await Promise.all(active.map(clip => seekElement(clip.video, safeOut - clipOutStart(clip) + clipMediaOffset(clip))));
}

async function exportOfflineDeterministic(exportTarget, scale) {
  await persistRecordedAssets();
  const fps = 30;
  const duration = outputDuration();
  const frames = Math.max(1, Math.ceil(duration * fps));
  const estimatedBytes = Math.ceil(frames * canvas.width * canvas.height * 0.1);
  activeDesktopExportSession = await desktop.export.begin({
    targetId: exportTarget.id, ext: 'mjpeg', jobId: state.exportJobId, fps,
    estimatedBytes, expectedChunks: frames, width: canvas.width, height: canvas.height, audioPlan: offlineAudioPlan(),
  });
  for (let frame = 0; frame < frames && !state.exportCancelRequested; frame++) {
    const outTime = Math.min(duration, frame / fps);
    await seekOfflineFrame(outTime);
    drawFrame(true);
    const quality = canvas.width >= 3840 || canvas.height >= 2160 ? 0.88 : 0.92;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Could not encode offline export frame');
    await desktop.export.append(activeDesktopExportSession.id, await blob.arrayBuffer());
    if (frame % 3 === 0) {
      $('exportProgress').style.width = ((frame + 1) / frames * 100) + '%';
      $('exportSub').textContent = `${state.lang === 'th' ? 'กำลังวาดเฟรม' : 'Rendering frames'} ${frame + 1}/${frames}`;
    }
  }
  if (state.exportCancelRequested) return;
  $('exportSub').textContent = tr('exportRemuxing');
  const result = await desktop.export.finish(activeDesktopExportSession.id);
  activeDesktopExportSession = null;
  setProjectStatus(result.path);
}

// ---------- Export ----------
let exportAbortController = null;
let activeDesktopExportSession = null;
$('exportCancel').onclick = () => {
  if (!state.exporting) return;
  state.exportCancelRequested = true;
  if (exportAbortController) exportAbortController.abort();
  if (activeDesktopExportSession && desktop) desktop.export.cancel(activeDesktopExportSession.id).catch(() => {});
  if (state.exportJobId) api('/api/export/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: state.exportJobId }),
  }, 3000).catch(() => {});
};
$('exportBtn').onclick = async () => {
  if (!state.loaded || state.exporting) return;
  if (state.mode === 'image') { exportPNG(state.exportScale); return; }
  let exportTarget = null;
  if (desktop) {
    exportTarget = await desktop.export.choosePath('zoomcut-export.mp4');
    if (exportTarget.canceled) return;
  }
  state.exporting = true;
  state.exportCancelRequested = false;
  state.exportJobId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9-]/gi, '');
  video.pause();
  $('exportOverlay').classList.add('visible');
  $('exportProgress').style.width = '0%';
  const originalCanvas = { width: canvas.width, height: canvas.height };
  const scale = state.videoExportScale || 1;
  canvas.width = Math.round(canvas.width * scale);
  canvas.height = Math.round(canvas.height * scale);
  requestRender();
  let audioCtx = null;
  let voiceBuffers = [];
  let audioDest = null;
  let baseExportGain = null;
  let overlayAudio = [];
  let rec = null;
  try {
    if (desktop && exportTarget) {
      await exportOfflineDeterministic(exportTarget, scale);
      return;
    }
    const candidates = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const stream = canvas.captureStream(60);
    audioCtx = getExportAudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const src = getVideoAudioSource(audioCtx);
    audioDest = audioCtx.createMediaStreamDestination();
    baseExportGain = audioCtx.createGain();
    src.connect(baseExportGain).connect(audioDest);
    voiceBuffers = await prepareVoiceBuffers(audioCtx);
    overlayAudio = connectOverlayAudio(audioCtx, audioDest);
    audioDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(12_000_000 * scale * scale) });
    const chunks = desktop ? null : [];
    let chunkWrite = Promise.resolve();
    let chunkError = null;
    if (desktop && exportTarget) {
      const estimatedBytes = Math.ceil(outputDuration() * 12_000_000 * scale * scale / 8 * 2.2);
      activeDesktopExportSession = await desktop.export.begin({ targetId: exportTarget.id, ext, jobId: state.exportJobId, estimatedBytes });
    }
    rec.ondataavailable = e => {
      if (!e.data.size) return;
      if (!activeDesktopExportSession) { chunks.push(e.data); return; }
      chunkWrite = chunkWrite.then(async () => {
        const buffer = await e.data.arrayBuffer();
        await desktop.export.append(activeDesktopExportSession.id, buffer);
      }).catch(error => {
        chunkError = error;
        state.exportCancelRequested = true;
      });
    };
    const done = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = e => reject(e.error || new Error('MediaRecorder failed')); });
    const segs = state.segments;
    const totalOut = outputDuration();
    let doneOut = 0;
    const seekTo = t => new Promise(resolve => {
      video.currentTime = t;
      if (Math.abs(video.currentTime - t) < 0.002) return resolve();
      video.addEventListener('seeked', resolve, { once: true });
    });
    await seekTo(segs[0].start);
    rec.start(250);
    for (let i = 0; i < segs.length && !state.exportCancelRequested; i++) {
      const segment = segs[i];
      if (Math.abs(video.currentTime - segment.start) > 0.05) await seekTo(segment.start);
      video.playbackRate = segment.speed;
      baseExportGain.gain.value = laneEnabled('video', segment.lane || 0, 'audio') ? 1 : 0;
      if (voiceBuffers.length) scheduleVoiceoversForSegment(audioCtx, audioDest, voiceBuffers, segment);
      await video.play();
      const segBase = doneOut;
      await new Promise(resolve => {
        let finished = false;
        const finish = () => { if (finished) return; finished = true; clearInterval(interval); resolve(); };
        const check = () => {
          if (finished) return;
          if (state.exportCancelRequested || video.ended || video.currentTime >= segment.end - 0.02) return finish();
          doneOut = segBase + (video.currentTime - segment.start) / segment.speed;
          $('exportProgress').style.width = Math.min(100, doneOut / totalOut * 100) + '%';
          $('exportSub').textContent = tr('exportSegment', i + 1, segs.length, fmtTime(doneOut), fmtTime(totalOut), segment.speed);
          requestAnimationFrame(check);
        };
        const interval = setInterval(check, 200);
        requestAnimationFrame(check);
      });
      video.pause();
      doneOut = segBase + (segment.end - segment.start) / segment.speed;
    }
    rec.stop();
    await done;
    await chunkWrite;
    if (chunkError) throw chunkError;
    if (state.exportCancelRequested) return;
    $('exportSub').textContent = tr('exportRemuxing');
    if (desktop && exportTarget) {
      const result = await desktop.export.finish(activeDesktopExportSession.id);
      activeDesktopExportSession = null;
      setProjectStatus(result.path);
    } else {
      const blob = new Blob(chunks, { type: mime });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `zoomcut-export.${ext}`;
      link.click();
    }
  } catch (error) {
    if (!state.exportCancelRequested && error.name !== 'AbortError') showActionableError(error.message);
  } finally {
    video.pause();
    if (rec && rec.state !== 'inactive') try { rec.stop(); } catch {}
    if (activeDesktopExportSession && desktop) {
      await desktop.export.cancel(activeDesktopExportSession.id).catch(() => {});
      activeDesktopExportSession = null;
    }
    if (videoAudioSourceNode && baseExportGain) try { videoAudioSourceNode.disconnect(baseExportGain); baseExportGain.disconnect(); } catch {}
    for (const item of overlayAudio) {
      try { item.clip.audioSourceNode.disconnect(item.gain); item.gain.disconnect(); } catch {}
      item.clip.video.muted = true;
    }
    canvas.width = originalCanvas.width;
    canvas.height = originalCanvas.height;
    $('exportOverlay').classList.remove('visible');
    state.exporting = false;
    state.exportCancelRequested = false;
    state.exportJobId = null;
    exportAbortController = null;
    requestRender();
  }
};

// ---------- อัดหน้าจอ iPhone จากปุ่มในแอป (ผ่าน serve.py) ----------
const recBtn = $('recBtn');
let recState = { recording: false, poller: null, polling: false, lifecycle: 'idle', pending: null, target: null, countdownSec: 3 };

function setRecordingLifecycle(lifecycle) {
  recState.lifecycle = lifecycle;
  const hud = $('recordingHud');
  if (hud) hud.dataset.lifecycle = lifecycle;
}

function formatRecordingDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function recordingReviewUrl(base) {
  const token = API_TOKEN ? `?token=${encodeURIComponent(API_TOKEN)}` : '';
  return `/recordings/${encodeURIComponent(String(base || ''))}.mp4${token}`;
}

function hideRecordingReview() {
  $('recordingReview').hidden = true;
  $('recordingReviewVideo').pause();
  $('recordingReviewVideo').removeAttribute('src');
  recState.pending = null;
}

function showRecordingReview(data) {
  recState.pending = { base: data.base, duration: data.duration || 0, clicks: data.clicks || 0, target: recState.target };
  const review = $('recordingReview');
  const videoPreview = $('recordingReviewVideo');
  videoPreview.src = recordingReviewUrl(data.base);
  $('recordingReviewTitle').value = state.lang === 'th' ? 'วิดีโออัดหน้าจอ' : 'Screen recording';
  $('recordingReviewMeta').textContent = `${formatRecordingDuration(data.duration)} • ${data.clicks || 0} ${state.lang === 'th' ? 'คลิก' : 'clicks'}`;
  review.hidden = false;
}

function updateRecordingReviewLanguage() {
  const th = state.lang === 'th';
  $('recordingReview').querySelector('.recording-review-kicker').textContent = th ? 'พร้อมตรวจ' : 'Review ready';
  $('recordingReviewPlay').textContent = th ? '▶️ เล่น' : '▶️ Play';
  $('recordingReviewRerecord').textContent = th ? '↺ อัดใหม่' : '↺ Re-record';
  $('recordingReviewDiscard').textContent = th ? 'นำออกจากรายการ' : 'Discard from list';
  $('recordingReviewOpen').textContent = th ? 'เปิดใน editor' : 'Open in editor';
}

function setRecordingHud(mode, { elapsed = 0, clicks = 0, warning = '' } = {}) {
  const hud = $('recordingHud');
  if (!mode) {
    hud.hidden = true;
    hud.dataset.mode = '';
    const shellRecordLabel = $('shellStartRecord')?.querySelector('span');
    if (shellRecordLabel) shellRecordLabel.textContent = state.lang === 'th' ? 'เลือกสิ่งที่จะอัด' : 'Choose recording source';
    return;
  }
  const th = state.lang === 'th';
  hud.hidden = false;
  hud.dataset.mode = mode;
  hud.dataset.elapsed = String(elapsed);
  hud.dataset.clicks = String(clicks);
  const status = mode === 'running'
    ? warning
      ? (th ? 'กำลังอัด แต่ click tracking ยังไม่ตอบสนอง' : 'Recording, but click tracking is not responding')
      : (th ? 'กำลังอัดหน้าจอ' : 'Recording screen')
    : mode === 'processing'
      ? (th ? 'กำลังบันทึกไฟล์' : 'Finishing recording')
      : mode === 'stopping'
        ? (th ? 'กำลังหยุดอัด' : 'Stopping recording')
        : (th ? 'กำลังเริ่มอัด' : 'Starting recording');
  $('recordingHudStatus').textContent = status;
  hud.classList.toggle('warning', Boolean(warning));
  hud.title = warning || '';
  $('recordingHudTime').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
  $('recordingHudClicks').textContent = `${clicks} ${th ? 'คลิก' : 'clicks'}`;
  $('recordingStopBtn').disabled = mode !== 'running';
  $('recordingStopBtn').querySelector('span').textContent = th ? 'หยุดอัด' : 'Stop';
  const shellRecordLabel = $('shellStartRecord')?.querySelector('span');
  if (shellRecordLabel) shellRecordLabel.textContent = mode === 'running' ? (th ? 'หยุดอัด' : 'Stop recording') : status;
}
$('recordingStopBtn').onclick = () => {
  if (recState.recording) { setRecordingLifecycle('stopping'); recBtn.click(); }
};

$('themeBtn').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('zoomcut-theme', state.theme);
  applyTheme();
  requestRender();
};
$('langSel').onchange = e => {
  state.lang = e.target.value;
  localStorage.setItem('zoomcut-lang', state.lang);
  applyLanguage();
  refreshMicDevices();
};
applyTheme();
applyLanguage();

function applyStoredPanelSizes() {
  const sidebarW = parseFloat(localStorage.getItem('zoomcut-sidebar-width')) || 222;
  const timelineH = parseFloat(localStorage.getItem('zoomcut-timeline-height')) || 276;
  const shell = $('editorShell');
  shell.style.setProperty('--sidebar-width', clamp(sidebarW, 190, 340) + 'px');
  shell.style.setProperty('--timeline-height', clamp(timelineH, 210, window.innerHeight * 0.48) + 'px');
}
function initSplitters() {
  const shell = $('editorShell');
  const sidebar = document.querySelector('.sidebar');
  const timelineArea = document.querySelector('.timeline-area');
  const sideSplit = $('sidebarSplitter');
  const timeSplit = $('timelineSplitter');
  sideSplit.addEventListener('pointerdown', e => {
    e.preventDefault();
    document.body.classList.add('resizing');
    sideSplit.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    const move = ev => {
      const next = clamp(startW + ev.clientX - startX, 190, Math.min(340, window.innerWidth * 0.3));
      shell.style.setProperty('--sidebar-width', next + 'px');
      localStorage.setItem('zoomcut-sidebar-width', String(Math.round(next)));
      requestRender();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      sideSplit.removeEventListener('pointermove', move);
      sideSplit.removeEventListener('pointerup', up);
      sideSplit.removeEventListener('pointercancel', up);
    };
    sideSplit.addEventListener('pointermove', move);
    sideSplit.addEventListener('pointerup', up);
    sideSplit.addEventListener('pointercancel', up);
  });
  timeSplit.addEventListener('pointerdown', e => {
    e.preventDefault();
    document.body.classList.add('resizing');
    timeSplit.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = timelineArea.getBoundingClientRect().height;
    const wrapH = shell.getBoundingClientRect().height;
    const move = ev => {
      const next = clamp(startH + startY - ev.clientY, 210, Math.max(240, wrapH * 0.58));
      shell.style.setProperty('--timeline-height', next + 'px');
      localStorage.setItem('zoomcut-timeline-height', String(Math.round(next)));
      requestRender();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      timeSplit.removeEventListener('pointermove', move);
      timeSplit.removeEventListener('pointerup', up);
      timeSplit.removeEventListener('pointercancel', up);
    };
    timeSplit.addEventListener('pointermove', move);
    timeSplit.addEventListener('pointerup', up);
    timeSplit.addEventListener('pointercancel', up);
  });
}
applyStoredPanelSizes();
initSplitters();
window.addEventListener('resize', applyStoredPanelSizes);

async function api(path, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { ...(opts.headers || {}) };
  if (API_TOKEN) headers['X-ZoomCut-Token'] = API_TOKEN;
  const r = await fetch(path, { ...opts, headers, signal: opts.signal || ctrl.signal }).finally(() => clearTimeout(timer));
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

function showActionableError(message) {
  alert(String(message || 'เกิดข้อผิดพลาด')
    + tr('actionableSuffix'));
}

function diagItem(ok, name, detail) {
  return `<div class="diag-item"><div>${ok ? '✅' : '⚠️'}</div><div><div class="name">${name}</div><div class="detail">${String(detail || '').replace(/</g, '&lt;')}</div></div></div>`;
}
async function openDiagnostics() {
  const list = $('diagList');
  $('diagOverlay').classList.add('visible');
  list.innerHTML = diagItem(true, state.lang === 'th' ? 'กำลังตรวจระบบ' : 'Checking system', state.lang === 'th' ? 'กำลังโหลด diagnostics จากแอป...' : 'Loading diagnostics from the app...');
  const { ok, data } = await api('/api/diagnostics', {}, 10000);
  if (!ok) {
    list.innerHTML = diagItem(false, state.lang === 'th' ? 'Diagnostics ใช้ไม่ได้' : 'Diagnostics unavailable', state.lang === 'th' ? 'เปิดผ่านเว็บ static อยู่ หรือ server ในแอปยังไม่พร้อม' : 'You may be running the static web editor or the app server is not ready.');
    return;
  }
  const bins = data.bins || {};
  list.innerHTML = [
    diagItem(true, 'Runtime', `${data.platform}/${data.arch} • Node ${data.node}`),
    diagItem(bins.ffmpeg && bins.ffmpeg.ok, 'ffmpeg', bins.ffmpeg && `${bins.ffmpeg.path} — ${bins.ffmpeg.detail}`),
    diagItem(bins.ffprobe && bins.ffprobe.ok, 'ffprobe', bins.ffprobe && `${bins.ffprobe.path} — ${bins.ffprobe.detail}`),
    diagItem(bins.adb && bins.adb.ok, 'adb', bins.adb && `${bins.adb.path} — ${bins.adb.detail || (state.lang === 'th' ? 'พร้อมใช้ Android USB recording' : 'Ready for Android USB recording')}`),
    diagItem(bins.scrcpy && bins.scrcpy.ok, 'scrcpy', bins.scrcpy && `${bins.scrcpy.path} — ${bins.scrcpy.detail || (state.lang === 'th' ? 'พร้อมใช้ Android mirroring' : 'Ready for Android mirroring')}`),
    diagItem(bins.scrcpyServer && bins.scrcpyServer.ok, 'scrcpy-server', bins.scrcpyServer && `${bins.scrcpyServer.path} — ${bins.scrcpyServer.detail}`),
    diagItem(bins.screencapture && bins.screencapture.ok, 'Screen Recording backend', bins.screencapture && `${bins.screencapture.path} — ${bins.screencapture.detail || (state.lang === 'th' ? 'พร้อมเรียก screencapture' : 'Ready to call screencapture')}`),
    diagItem(data.uiohook && data.uiohook.ok, 'Click hook', data.uiohook && data.uiohook.detail),
    diagItem((data.sources && data.sources.displays > 0), 'Display/window list', state.lang === 'th'
      ? `${data.sources?.displays || 0} จอ • ${data.sources?.windows || 0} หน้าต่าง • Android ${data.sources?.android || 0} เครื่อง${data.sources?.windowsError ? ' — ' + data.sources.windowsError : ''}`
      : `${data.sources?.displays || 0} displays • ${data.sources?.windows || 0} windows • ${data.sources?.android || 0} Android devices${data.sources?.windowsError ? ' — ' + data.sources.windowsError : ''}`),
    diagItem(true, 'Debug log', data.debugLog || '/tmp/zoomcut-debug.log'),
  ].join('');
  $('diagTip').textContent = state.lang === 'th'
    ? 'macOS permission บางอย่างตรวจแบบ 100% ไม่ได้จากเว็บ renderer: ถ้าอัดไม่ได้ ให้เปิด Screen Recording, Microphone และ Input Monitoring/Accessibility ให้ ZoomCut แล้ว restart แอป'
    : 'Some macOS permissions cannot be verified perfectly from the renderer. If recording fails, enable Screen Recording, Microphone, and Input Monitoring/Accessibility for ZoomCut, then restart the app.';
}
$('diagBtn').onclick = openDiagnostics;
$('diagClose').onclick = () => $('diagOverlay').classList.remove('visible');
$('diagOverlay').addEventListener('click', e => { if (e.target === $('diagOverlay')) $('diagOverlay').classList.remove('visible'); });

// แสดงปุ่มเฉพาะเมื่อรันผ่าน serve.py (มี API)
(async () => {
  try {
    const { ok } = await api('/api/record/state', {}, 5000);
    if (ok) {
      recBtn.style.display = ''; $('diagBtn').style.display = '';
      const recovered = await api('/api/record/recovered', {}, 5000).catch(() => ({ ok: false, data: {} }));
      const items = recovered.data?.recordings || [];
      if (items.length) {
        const latest = items[items.length - 1];
        const open = confirm(state.lang === 'th'
          ? 'พบวิดีโอที่กู้คืนจากการอัดครั้งก่อน ต้องการเปิดใน editor หรือไม่?'
          : 'A recording from the previous session was recovered. Open it in the editor?');
        await api('/api/record/recovered', { method: 'POST' }, 5000).catch(() => {});
        if (open) loadFromServer(latest);
      }
    }
  } catch {}
})();

recBtn.onclick = async () => {
  if (recState.recording) {
    setRecordingLifecycle('stopping');
    recBtn.textContent = tr('recStopping');
    $('quickRecord').classList.add('recording');
    setRecordingHud('stopping', {
      elapsed: Number($('recordingHud').dataset.elapsed) || 0,
      clicks: Number($('recordingHud').dataset.clicks) || 0,
    });
    try {
      if (desktop?.system?.stopRecording) await desktop.system.stopRecording();
      else await api('/api/record/stop', { method: 'POST' });
    } catch {
      await api('/api/record/stop', { method: 'POST' }).catch(() => {});
    }
    pollRecState();
    return;
  }
  openSourcePicker();
};

desktop?.system?.onRecordingStopped?.(() => {
  if (recState.recording) pollRecState();
});

async function startSmartRecording() {
  if (recState.recording) {
    recBtn.click();
    return;
  }
  $('quickRecord').classList.add('recording');
  recBtn.textContent = tr('recStarting');
  let ok = false, data = {};
  try {
    ({ ok, data } = await api('/api/windows', {}, 8000));
  } catch {}
  $('quickRecord').classList.remove('recording');
  if (!ok) {
    openSourcePicker();
    return;
  }
  let lastTarget = null;
  try { lastTarget = JSON.parse(localStorage.getItem('zoomcut-last-record-target') || 'null'); } catch {}
  if (lastTarget?.androidSerial && (data.androidDevices || []).some(x => x.serial === lastTarget.androidSerial)) return startRecording(lastTarget);
  if (lastTarget?.windowId && (data.windows || []).some(x => x.id === lastTarget.windowId)) return startRecording(lastTarget);
  if (lastTarget?.screenIndex && (data.displays || []).some(x => x.index === lastTarget.screenIndex)) return startRecording(lastTarget);
  const iphone = (data.windows || []).find(w => /iphone/i.test(`${w.app || ''} ${w.title || ''}`));
  if (iphone) {
    startRecording({ windowId: iphone.id });
    return;
  }
  const mainDisplay = (data.displays || []).find(d => d.isMain) || (data.displays || [])[0];
  if (mainDisplay) {
    startRecording({ screenIndex: mainDisplay.index });
    return;
  }
  const android = (data.androidDevices || [])[0];
  if (android) return startRecording({ androidSerial: android.serial });
  openSourcePicker();
}

// ---------- หน้าเลือกแหล่งอัด (แบบแชร์จอ meeting) ----------
const APP_ICONS = {
  'google chrome': '🌐', 'safari': '🧭', 'firefox': '🦊', 'arc': '🌐',
  'microsoft edge': '🌐', 'brave browser': '🦁', 'iphone mirroring': '📱',
  'finder': '📁', 'terminal': '⬛', 'code': '💻', 'visual studio code': '💻',
  'notes': '📝', 'keynote': '📊', 'figma': '🎨', 'slack': '💬',
};
function appIcon(app) { return APP_ICONS[app.toLowerCase()] || '🪟'; }

async function openSourcePicker() {
  // Keep the modal stack unambiguous when starting another take from the
  // editor while a completed recording is still awaiting review.
  hideRecordingReview();
  const list = $('pickerList');
  list.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px">${state.lang === 'th' ? 'กำลังโหลดรายชื่อหน้าต่าง...' : 'Loading windows...'}</div>`;
  $('pickerOverlay').classList.add('visible');

  let ok = false, data = {};
  try {
    ({ ok, data } = await api('/api/windows', {}, 8000));
  } catch (e) {
    data = {};
  }
  list.innerHTML = '';
  recState.lifecycle = 'preflight';
  recState.target = null;
  $('pickerSelection').classList.remove('visible');

  const addItem = (icon, name, detail, target) => {
    const el = document.createElement('button');
    el.className = 'picker-item';
    el.innerHTML = `<span class="icon">${icon}</span><span class="info">
      <div class="name">${String(name).replace(/</g, '&lt;')}</div>
      <div class="detail">${String(detail).replace(/</g, '&lt;')}</div></span>`;
    el.onclick = () => selectRecordingTarget({ icon, name, detail, target });
    list.appendChild(el);
  };

  // ตัวเลือก iPhone อยู่บนสุดเสมอ (เปิด iPhone Mirroring ให้เองถ้ายังไม่เปิด)
  addItem('📱', 'iPhone', state.lang === 'th' ? 'อัดหน้าจอ iPhone ผ่าน iPhone Mirroring — เปิดแอปให้อัตโนมัติ' : 'Record iPhone via iPhone Mirroring. ZoomCut will open it if needed.', {});

  if (ok) {
    for (const d of data.androidDevices || []) {
      addItem('🤖', tr('androidRecord'), tr('androidRecordSub', d), { androidSerial: d.serial });
    }
    // ทั้งหน้าจอ (แต่ละจอ)
    for (const d of data.displays || []) {
      const label = state.lang === 'th'
        ? (data.displays.length > 1 ? `ทั้งหน้าจอ — ${d.name}` : 'ทั้งหน้าจอ') + (d.isMain ? ' (จอหลัก)' : '')
        : (data.displays.length > 1 ? `Entire screen — ${d.name}` : 'Entire screen') + (d.isMain ? ' (main)' : '');
      addItem('🖥', label, state.lang === 'th' ? `เดสก์ท็อปทั้งจอ • ${d.w}×${d.h}` : `Full desktop • ${d.w}×${d.h}`, { screenIndex: d.index });
    }
    // หน้าต่างเดี่ยว
    for (const w of data.windows || []) {
      addItem(appIcon(w.app), w.title || w.app, `${w.app} • ${w.w}×${w.h}`, { windowId: w.id });
    }
  }
}

function selectRecordingTarget({ icon, name, detail, target }) {
  recState.target = target;
  recState.lifecycle = 'source-selected';
  $('pickerTargetIcon').textContent = icon;
  $('pickerTargetName').textContent = name;
  $('pickerTargetDetail').textContent = detail;
  $('pickerSelection').classList.add('visible');
  $('pickerRecord').focus();
}
$('pickerCancel').onclick = () => { $('pickerOverlay').classList.remove('visible'); setRecordingLifecycle('idle'); };
$('pickerChangeSource').onclick = () => { recState.target = null; recState.lifecycle = 'preflight'; $('pickerSelection').classList.remove('visible'); };
$('pickerRecord').onclick = () => {
  if (!recState.target) return;
  recState.countdownSec = Number($('recordCountdown').value) || 0;
  startRecording(recState.target);
};
$('pickerOverlay').addEventListener('click', e => {
  if (e.target === $('pickerOverlay')) {
    $('pickerOverlay').classList.remove('visible');
    recState.target = null;
    setRecordingLifecycle('idle');
  }
});

$('recordingReviewPlay').onclick = () => {
  const preview = $('recordingReviewVideo');
  if (preview.paused) preview.play().catch(() => {});
  else preview.pause();
};
$('recordingReviewDiscard').onclick = () => {
  // Detach from the UI only. The finished media remains on disk for recovery.
  hideRecordingReview();
  setRecordingLifecycle('idle');
};
$('recordingReviewRerecord').onclick = () => {
  const target = recState.pending?.target || recState.target;
  hideRecordingReview();
  if (target) startRecording(target);
  else openSourcePicker();
};
$('recordingReviewOpen').onclick = () => {
  const pending = recState.pending;
  if (!pending?.base) return;
  const base = pending.base;
  hideRecordingReview();
  setRecordingLifecycle('idle');
  loadFromServer(base);
};

function recordingCountdown(seconds = 3) {
  if (!seconds) return Promise.resolve(true);
  setRecordingLifecycle('countdown');
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(5,7,12,.62);display:grid;place-items:center;z-index:300';
    overlay.innerHTML = `<div style="text-align:center"><div data-count style="font-size:72px;font-weight:800">${seconds}</div><button class="btn" data-cancel>${tr('cancel')}</button></div>`;
    document.body.appendChild(overlay);
    let remaining = seconds;
    const finish = value => { clearInterval(timer); overlay.remove(); resolve(value); };
    overlay.querySelector('[data-cancel]').onclick = () => finish(false);
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) finish(true);
      else overlay.querySelector('[data-count]').textContent = remaining;
    }, 1000);
  });
}

async function recordingPreflight(target) {
  setRecordingLifecycle('preflight');
  if (!desktop || target.androidSerial) return true;
  const permissions = await desktop.system.permissions().catch(() => null);
  if (permissions && ['denied', 'restricted'].includes(permissions.screen)) {
    alert(state.lang === 'th' ? 'ZoomCut ยังไม่มีสิทธิ์อัดหน้าจอ ระบบจะเปิดหน้าตั้งค่าให้' : 'ZoomCut does not have Screen Recording access. System Settings will open.');
    await desktop.system.openPrivacy('screen');
    return false;
  }
  return true;
}

async function startRecording(target) {
  $('pickerOverlay').classList.remove('visible');
  recState.target = target;
  if (!await recordingPreflight(target)) {
    setRecordingLifecycle('idle');
    return;
  }
  if (!await recordingCountdown(recState.countdownSec ?? 3)) {
    setRecordingLifecycle('idle');
    return;
  }
  recState.recording = true;
  setRecordingLifecycle('starting');
  recBtn.classList.add('recording');
  recBtn.textContent = tr('recStarting');
  $('quickRecord').classList.add('recording');
  setRecordingHud('starting');
  if (recState.poller) clearInterval(recState.poller);
  recState.poller = setInterval(pollRecState, 1000);
  try {
    const { ok, data } = await api('/api/record/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    }, 15000);
    if (!ok) throw new Error(data.error || (state.lang === 'th' ? 'เริ่มอัดไม่ได้' : 'Could not start recording'));
    localStorage.setItem('zoomcut-last-record-target', JSON.stringify(target));
    if (desktop) desktop.system.recordingIndicator(true).catch(() => {});
    pollRecState();
  } catch (e) {
    clearInterval(recState.poller);
    recState.poller = null;
    recState.recording = false;
    setRecordingLifecycle('error');
    recBtn.classList.remove('recording');
    $('quickRecord').classList.remove('recording');
    recBtn.textContent = tr('record');
    setRecordingHud(null);
    if (desktop) desktop.system.recordingIndicator(false).catch(() => {});
    await api('/api/record/stop', { method: 'POST' }, 5000).catch(() => {});
    showActionableError((state.lang === 'th'
      ? 'เริ่มอัดไม่สำเร็จหรือใช้เวลานานเกินไป:\n'
      : 'Recording did not start or took too long:\n') + (e.message || e));
  }
}

async function pollRecState() {
  if (recState.polling) return;
  recState.polling = true;
  try { await pollRecStateOnce(); }
  finally { recState.polling = false; }
}

async function pollRecStateOnce() {
  let ok, data;
  try { ({ ok, data } = await api('/api/record/state', {}, 5000)); }
  catch { return; }
  if (!ok) return;
  if (data.running) {
    setRecordingLifecycle('recording');
    const secs = Math.max(0, Math.floor(Date.now() / 1000 - data.started));
    const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
    recBtn.textContent = `${state.lang === 'th' ? '⏹ หยุดอัด' : '⏹ Stop'} ${mm}:${ss} • 👆${data.clicks}`;
    recBtn.title = 'คีย์ลัดหยุดอัดทั้งจอ: ⌃⌘S (Control-Command-S)';
    $('quickRecord').classList.add('recording');
    setRecordingHud('running', { elapsed: secs, clicks: data.clicks || 0, warning: data.trackingError || '' });
    if (data.trackingError) recBtn.title = data.trackingError;
    return;
  }
  // ยังไม่ถึงสถานะจบ (finished/error) → ต้องรอต่อ ห้ามหยุด poll
  // (บั๊กเดิม: running เป็น false ก่อน finished เป็น true → หยุด poll ก่อนวิดีโอพร้อม → วิดีโอไม่กลับเข้า editor)
  if (!data.finished && !data.error) {
    setRecordingLifecycle(data.processing ? 'processing' : 'starting');
    recBtn.classList.remove('recording');
    recBtn.textContent = data.processing ? tr('recProcessing') : tr('recStarting');
    setRecordingHud(data.processing ? 'processing' : 'starting', {
      elapsed: Number($('recordingHud').dataset.elapsed) || 0,
      clicks: data.clicks || Number($('recordingHud').dataset.clicks) || 0,
    });
    return; // poll ต่อไป
  }
  // จบจริง (finished หรือ error)
  clearInterval(recState.poller);
  recState.recording = false;
  recBtn.classList.remove('recording');
  $('quickRecord').classList.remove('recording');
  recBtn.textContent = tr('record');
  setRecordingHud(null);
  if (desktop) desktop.system.recordingIndicator(false).catch(() => {});
  if (data.error) {
    setRecordingLifecycle('error');
    showActionableError((state.lang === 'th' ? 'อัดไม่สำเร็จ:\n' : 'Recording failed:\n') + data.error);
    return;
  }
  if (data.finished && data.base) {
    setRecordingLifecycle('review-ready');
    showRecordingReview(data);
  }
}

async function loadFromServer(base) {
  // รองรับทั้ง "recordings/recording-xxx" (autoload) และ "recording-xxx" (จากสถานะอัด)
  const p = base.includes('/') ? base : 'recordings/' + base;
  try {
    if (desktop) {
      const cleanBase = p.split('/').pop();
      const media = await desktop.project.registerRecording(cleanBase);
      const jr = media.clicksUrl ? await fetch(media.clicksUrl) : { ok: false };
      const jfile = jr.ok ? new File([await jr.blob()], 'clicks.json') : null;
      loadVideoSource(media.url, { sourcePath: media.path, name: cleanBase + '.mp4', type: 'video/mp4' }, jfile);
      return;
    }
    const token = new URLSearchParams(location.search).get('token') || '';
    const auth = token ? `?token=${encodeURIComponent(token)}` : '';
    const vr = await fetch('/' + p + '.mp4' + auth);
    if (!vr.ok) { alert((state.lang === 'th' ? 'โหลดวิดีโอไม่สำเร็จ' : 'Could not load video') + ' (' + vr.status + ') — ' + p + '.mp4'); return; }
    const vfile = new File([await vr.blob()], p.split('/').pop() + '.mp4', { type: 'video/mp4' });
    const jr = await fetch('/' + p + '.clicks.json' + auth);
    const jfile = jr.ok ? new File([await jr.blob()], 'clicks.json') : null;
    loadFile(vfile, jfile);
  } catch (e) { alert((state.lang === 'th' ? 'โหลดวิดีโอผิดพลาด: ' : 'Video load error: ') + e.message); }
}

// เปิดจาก record.py โดยตรง: ?autoload=recordings/recording-xxx
const autoBase = new URLSearchParams(location.search).get('autoload');
if (autoBase && /^recordings\/[\w.-]+$/.test(autoBase)) loadFromServer(autoBase);
