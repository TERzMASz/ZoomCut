# ZoomCut — Handoff / Onboarding (สำหรับ AI agent & dev ที่มาช่วยต่อ)

เอกสารนี้อธิบายทั้งโปรเจกต์ให้คน/agent ที่เพิ่งเข้ามาเข้าใจสถาปัตยกรรม จุดที่ต้องระวัง และวิธีทำงานต่อได้เร็ว
อ่านให้จบก่อนแก้โค้ด โดยเฉพาะหัวข้อ **ระบบพิกัด (Coordinate systems)** และ **บทเรียน/กับดัก**

---

## 1. ZoomCut คืออะไร

เครื่องมือ **อัดหน้าจอ + ซูมอัตโนมัติตามจุดที่คลิก/แตะ + ตัดต่อ** (คล้าย Screen Studio / ScreenArc)
จุดขายหลัก: อัดแล้ว **ซูมเข้าไปที่จุดที่ผู้ใช้คลิกจริงโดยอัตโนมัติ** — ทำได้เพราะจับ event คลิกระดับ OS

มี 2 รูปแบบการใช้งานจากโค้ดชุดเดียวกัน:
| รูปแบบ | อัดจอ? | ที่อยู่ |
|--------|--------|--------|
| **เว็บ (Vercel)** | ❌ (ลากไฟล์เข้ามาแก้อย่างเดียว) | `index.html` เป็น static site |
| **แอปเดสก์ท็อป (Electron .dmg)** | ✅ อัด + ซูมอัตโนมัติ + ตัดต่อครบ | `electron/` + `index.html` |

`index.html` ไฟล์เดียวเป็น renderer ของทั้งสองแบบ — **ห้ามแยกโค้ด editor เป็นสองชุด**

---

## 2. โครงไฟล์

```
index.html            ← ตัวแก้ไข/ตัดต่อทั้งหมด (vanilla JS + <canvas>, ไม่มี build step)
shared/editor-core.js ← project schema + pure timeline/project helpers (ใช้ได้ทั้ง browser/Node tests)
electron/
  main.js             ← Electron main: เปิด server ในตัว + สร้างหน้าต่าง โหลด http://127.0.0.1:<port>
  server.js           ← HTTP server + ตรรกะอัดจอ (พอร์ตจาก record.py/serve.py มาเป็น Node)
  preload.js          ← bridge แบบจำกัดสำหรับ project/media/export/system permission
  project-store.js    ← save/open/autosave/recovery + content-addressed assets
  security.js         ← path containment, request limits, stream upload, option validation
  build-signed.sh     ← build + เซ็นด้วย self-signed cert (identity คงที่) + ทำ DMG
  README.md           ← วิธี build/แจก
record.py, serve.py   ← เวอร์ชัน Python เดิม (ยังใช้รันบน Mac ได้ แต่ Electron คือทางหลักแล้ว)
package.json          ← electron + electron-builder + uiohook-napi (optional)
.vercelignore         ← กันไฟล์ desktop/ส่วนตัวไม่ให้ deploy ขึ้นเว็บ
dist/                 ← ผลลัพธ์ build (gitignored)
```

> **สำคัญ:** เว็บ (Vercel) deploy เฉพาะ `index.html` — `.vercelignore` กัน `electron/`, `*.py`, `recordings/`, `node_modules/` ไว้แล้ว

---

## 3. วิธีรัน / build / ทดสอบ

```bash
# เว็บ editor อย่างเดียว (ทดสอบ UI เร็วๆ)
python3 -m http.server 8123        # แล้วเปิด http://localhost:8123

# server + API อัดจอ แบบไม่ต้องเปิด Electron (ทดสอบ endpoint ได้)
node electron/server.js            # เปิด http://localhost:8123 มี /api/* ครบ

# Electron dev
npm install                        # ครั้งแรก (postinstall rebuild uiohook)
npm start

# build DMG (เซ็น identity คงที่)
bash electron/build-signed.sh      # ได้ dist/ZoomCut-<ver>-arm64.dmg
```

**การทดสอบที่ใช้จริงในโปรเจกต์นี้:**
- ตรรกะฝั่ง JS (segment math, crop, camera) — เปิดใน browser preview แล้วรันผ่าน devtools/JS
- endpoint ฝั่ง server — `node electron/server.js` แล้ว `fetch` ทดสอบตรงๆ
- ⚠️ **การอัดจริงต้องมีสิทธิ์ Screen Recording + Input Monitoring** ให้แอป — agent ที่ไม่มีสิทธิ์ทดสอบ end-to-end ไม่ได้ ต้องให้ผู้ใช้ยืนยัน

---

## 4. สถาปัตยกรรม renderer (`index.html`)

renderer หลักเป็น vanilla JS และวาดลง `<canvas id="canvas">`; pure data rules แยกไว้ใน `shared/editor-core.js`

### 4.1 State กลาง
มี object `state` เดียวเก็บทุกอย่าง (mode, aspect, crop, segments, events, frame, bg, ฯลฯ)
`state.mode` = `'video'` | `'image'` (โหมดภาพนิ่งสำหรับทำ mockup/App Store shot)

### 4.2 Pipeline การวาด
```
setCanvasForAspect()  → กำหนดขนาด canvas (16:9 / 9:16 / 4:5 / 1:1 / fit)
layout()              → คำนวณกรอบ: outer (รวม bezel อุปกรณ์) + content (พื้นที่วิดีโอ)
drawFrame(forExport)  → วาด: พื้นหลัง → เงา → กรอบอุปกรณ์ → วิดีโอ(ครอบตาม camera+crop)
                          → status bar → browser chrome → tap ripples
cameraAt(t)           → คืนกล้อง {zoom, cx, cy} ณ เวลา t (interpolate ระหว่าง zoom events)
sourceRect(cam)       → แปลงกล้อง → พิกัดพิกเซลต้นฉบับที่จะ drawImage (คำนวณ crop + clamp)
```
`loop()` เรียก `drawFrame()` ทุก rAF ตอนเล่น/ตอน export; ตอน pause ใช้ `requestRender()`

### 4.3 ⚠️ ระบบพิกัด (Coordinate systems) — อ่านให้เข้าใจก่อนแตะ camera/crop/click
- **event.x/y, tap.x/y** เก็บเป็น **normalized ของวิดีโอเต็ม [0..1]** เสมอ (ไม่ผูกกับ crop)
- **crop** = `state.crop {t,r,b,l}` เศษส่วนที่ตัดออกแต่ละด้าน → `cropRect()`/`cropPx()`
- **กล้อง**: `idCam()` = พัก (zoom 1) อยู่กึ่งกลาง crop. zoom 1 = เห็นเต็มพื้นที่ crop พอดี
- **sourceRect(cam)** เป็นที่เดียวที่รวม crop + zoom + clamp → ใช้ทั้งตอน drawImage, ตอนแปลงคลิกบน canvas กลับเป็นพิกัด, และตอนวาด tap ripple → **ถ้าจะแก้ให้แก้ที่นี่ที่เดียว**
- คลิกจาก record (`clicks.json`) เป็น normalized ของ**หน้าต่าง/จอที่อัด** = normalized วิดีโอเต็ม → ตรงกันพอดี

### 4.4 Segments (ตัดหลายท่อน + speed แยกท่อน)
`state.segments = [{id, start, end, speed}]` — ช่องว่างระหว่างท่อน = ถูกตัดออก
- เล่น preview: `segPlaybackTick()` (เรียกจาก `loop()` และ `timeupdate`) ข้ามช่วงที่ตัด + ใช้ speed ต่อท่อน โดย track ด้วย `playIdx` (index ชัดเจน กันความกำกวมที่ขอบท่อน)
- Export: driver วน segment ทีละท่อน seek+play+อัด
- `outputDuration()` = ผลรวม `(end-start)/speed`

### 4.5 Export
`MediaRecorder(canvas.captureStream(60))` → stream request ลง temporary file → **POST `/api/remux`** ให้ ffmpeg
แปลงเป็น MP4 frame rate คงที่ (แก้อาการ "เล่นได้แค่ช่วงแรกแล้วค้าง")
บนเว็บ (ไม่มี `/api/remux`) จะ fallback ดาวน์โหลด blob เดิม

### 4.7 Project persistence
ไฟล์ `.zoomcut` เก็บ schema version, settings, lanes, trims, zooms และ media paths. Autosave เขียนแบบ atomic ไปที่ `userData/recovery`; voice/camera ที่อัดในแอปเก็บแบบ content-addressed ใน `userData/project-assets`. เปิดโปรเจกต์แล้วหา media ไม่เจอจะขอ relink.

### 4.6 สะพานเชื่อม recording (renderer ↔ server)
renderer เรียก `api('/api/...')` = `fetch` ธรรมดา. ปุ่ม "🔴 อัดหน้าจอ" แสดงเฉพาะเมื่อ `/api/record/state` ตอบ (คือรันในแอป/ผ่าน server) — บนเว็บ Vercel จะซ่อนอัตโนมัติ

---

## 5. Electron main + server (`electron/`)

`main.js` เปิด HTTP server ในตัว (`server.js`) แล้ว `loadURL('http://127.0.0.1:<port>')`
→ renderer เดิมใช้ `fetch('/api/...')` ได้เลย ไม่ต้องแก้

### server.js — endpoints
| Endpoint | หน้าที่ |
|----------|--------|
| `GET /api/windows` | รายชื่อหน้าต่าง + จอ (สำหรับหน้าเลือกแหล่งอัด) |
| `GET /api/record/state` | สถานะอัด (running, clicks, finished, error) |
| `POST /api/record/start` | เริ่มอัด — body `{screenIndex}` = ทั้งจอ / `{windowId}` = หน้าต่าง / `{}` = iPhone |
| `POST /api/record/stop` | หยุดอัด |
| `POST /api/remux?ext=webm&target=...&job=...` | stream export → ffmpeg → MP4 CFR |
| `POST /api/export/cancel` | หยุด FFmpeg export ตาม job id |
| `GET /recordings/*` | เสิร์ฟไฟล์ที่อัด (อยู่ที่ `userData/recordings`) |

### ระบบอัด (พอร์ตจาก record.py)
- **อัด**: `screencapture -v -C` โดย `-D <n>` = ทั้งจอ, `-l <windowId>` = หน้าต่าง (ติดตามหน้าต่าง)
- **จับคลิก**: `uiohook-napi` (global mouse/keyboard hook) → map พิกัดกับ bounds ของจอ/หน้าต่าง → normalized
- **คีย์ลัดหยุด ⌃⌘S**: จับใน uiohook keydown
- **แจกแจงหน้าต่าง/จอ**: JXA (`osascript -l JavaScript -e <script>`) เรียก CGWindowList / NSScreen — **ฝัง script เป็นสตริง inline** (ดูกับดัก #1)
- **Time-sync**: `screencapture` เขียนไฟล์ตอน "หยุด" ไม่ใช่ระหว่างอัด (ดูกับดัก #2) → คลิกเก็บเป็น wall-clock time แล้วตอนจบคำนวณ `frame0 = stopWall - duration` เพื่อ map เวลาคลิกให้ตรงเฟรมจริง
- **แปลง**: `.mov` → `.mp4` (copy ถ้า h264, ไม่งั้น transcode) แล้วเขียน `.clicks.json`

---

## 6. การเซ็น & สิทธิ์ (สำคัญมากสำหรับ beta)

- เซ็นด้วย **self-signed cert ชื่อ "ZoomCut Beta Self-Signed"** (อยู่ใน login keychain) → identity **คงที่**
- ทำไมต้องคงที่: TCC (สิทธิ์ Screen Recording/Input Monitoring) ผูกกับ *designated requirement* ของลายเซ็น
  - ad-hoc (`--sign -`) → DR อ้าง cdhash → **เปลี่ยนทุก build** → สิทธิ์หลุดทุกครั้งที่อัปเดต ❌
  - self-signed cert → DR อ้าง `certificate leaf` → **คงที่** → ให้สิทธิ์ครั้งเดียวใช้ได้ตลอด ✅
- `electron-builder` ตั้ง `mac.identity: null` (ข้ามการเซ็น) แล้ว **เซ็นเองหลัง build** ด้วย cert นี้ใน `build-signed.sh`
- ยังไม่ notarize (beta) → ผู้ใช้เปิดครั้งแรกต้อง **คลิกขวา → Open**
- reset สิทธิ์เวลาเทสต์: `tccutil reset ScreenCapture com.zoomcut.app` (+ `ListenEvent`, `Accessibility`)

---

## 7. บทเรียน / กับดัก (bug ที่เคยเจอ — อย่าพลาดซ้ำ)

1. **asar อ่านไฟล์ภายนอกไม่ได้** — โปรเซสภายนอก (osascript/ffmpeg) อ่านไฟล์ใน `.app/.../app.asar` ไม่ได้ → **ฝัง JXA เป็นสตริงส่ง `-e`** แทนการอ้างไฟล์
2. **screencapture -v เขียนไฟล์ตอนหยุด** — ไฟล์ไม่โผล่ระหว่างอัด → ห้ามใช้ "ไฟล์มีขนาด>0" เป็นสัญญาณเริ่มอัด (ใช้ "รันต่อเนื่อง 0.8s" แทน) และต้อง time-sync คลิกตอนจบ
3. **แอป GUI มี PATH จำกัด** — เปิดจาก Finder ไม่มี `/opt/homebrew/bin` → ใช้ absolute path + `CHILD_ENV` (augment PATH) กับ child process ทุกตัว
4. **Electron ไม่รองรับ `prompt()`** — ใช้ `zcPrompt()` (modal เอง) แทน. `alert()`/`confirm()` ใช้ได้
5. **MediaRecorder ได้ VFR** — เล่นได้ช่วงแรกแล้วค้าง → remux ผ่าน ffmpeg เป็น CFR (`-r 30 -vsync cfr`)
6. **path โหลดไฟล์กลับ** — `loadFromServer` ต้องเติม prefix `recordings/` (ไฟล์เสิร์ฟที่ `/recordings/`)
7. **Electron ไม่ปิดจริงตอนปิดหน้าต่าง** — `window-all-closed → app.quit()` เพื่อให้เปิดใหม่อ่านสิทธิ์ล่าสุด
8. **tab ที่ถูกพักเบื้องหลัง rAF หยุด** — export/segment ใช้ setInterval เป็น backup ของ rAF; และ tab hidden ทำ automated test เพี้ยน (เวลา/เฟรม) — เทสต์ playback/export ต้องระวังจุดนี้

---

## 8. งานที่ทำบ่อย → แก้ที่ไหน

| อยากทำ | ไฟล์ / จุด |
|--------|-----------|
| เพิ่ม/แก้ตัวเลือกในหน้าเลือกแหล่งอัด | `index.html` `openSourcePicker()` + `server.js` `startRecording()` |
| แก้ตรรกะซูม/กล้อง | `index.html` `cameraAt()` / `sourceRect()` (แก้ที่ sourceRect ที่เดียว) |
| เพิ่มเฟรมอุปกรณ์ใหม่ (iPad/Mac) | `index.html` `layout()` (ค่า bezel/topBar) + `drawFrame()` |
| แก้คุณภาพ/รูปแบบไฟล์ export | `server.js` `/api/remux` (ffmpeg args) |
| เพิ่ม field ใน preset | `index.html` `PRESET_FIELDS` + `applySettings()` |
| เพิ่ม backend อัดของ Windows | `server.js` `startRecording()` (ต้องใช้ ffmpeg gdigrab/dshow แทน screencapture) |

---

## 9. TODO / ทิศทางต่อ
- [ ] Windows EXE (backend อัดด้วย ffmpeg แทน screencapture ซึ่งเป็น macOS-only)
- [ ] Notarize (ต้องมี Apple Developer $99/ปี) → เปิดได้เนียนไม่มีเตือน
- [ ] ไอคอนแอป (ตอนนี้ใช้ default Electron)
- [ ] deterministic/offline frame renderer (ปัจจุบัน canvas export ยัง realtime)
- [ ] Android real-device matrix + bundled adb/scrcpy ที่ผ่าน license review
- [ ] Debug log อยู่ที่ `/tmp/zoomcut-debug.log` (จาก `dbg()` ใน server.js)

---

## 10. ธรรมเนียม
- UI เป็น **ภาษาไทย** — คงโทนเดิม
- renderer **ไม่มี build step** — แก้ `index.html` แล้วรีเฟรชได้เลย
- คอมเมนต์อธิบาย "ทำไม" (เหตุผล/กับดัก) ไม่ใช่ "ทำอะไร"
- ทดสอบทุกครั้งก่อนสรุปว่าเสร็จ — โดยเฉพาะ pipeline ที่มีหลายชั้น
