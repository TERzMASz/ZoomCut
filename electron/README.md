# ZoomCut — Desktop (Electron) Beta

แอปเดสก์ท็อปที่รวม **อัดหน้าจอ + ซูมอัตโนมัติตามคลิก + ตัดต่อ** ไว้ในที่เดียว
ตัวแก้ไข (renderer) ใช้ `index.html` ไฟล์เดียวกับเว็บ ส่วนการอัดทำใน main process (`electron/`)

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|------|---------|
| `electron/main.js` | Electron main — เปิด server ในตัว + หน้าต่างแอป |
| `electron/server.js` | HTTP server + ตรรกะอัดจอ (พอร์ตจาก `serve.py`/`record.py`) + JXA แจกแจงหน้าต่าง/จอ (ฝัง inline ส่งให้ osascript เพื่อให้อ่านได้ในแอปที่แพ็ก asar) |
| `index.html` | ตัวแก้ไข (ใช้ร่วมกับเว็บ Vercel) |

อัดได้ 3 แบบ: **ทั้งหน้าจอ** (`screencapture -D`), **หน้าต่างเดี่ยว** (`screencapture -l`, ติดตามหน้าต่าง), **iPhone** (ผ่าน iPhone Mirroring)

การอัด: `screencapture -v -l <windowId>` (ติดตามหน้าต่าง) + `uiohook-napi` จับคลิกทั้งจอ →
sync เวลาให้ตรงเฟรมจริงจากความยาววิดีโอ แล้วส่งเข้า editor อัตโนมัติ

## รันโหมด dev

```bash
npm install          # ครั้งแรก (postinstall rebuild uiohook สำหรับ Electron)
npm start            # เปิดแอป
```

## Build เป็น DMG (beta, self-signed)

`bash electron/build-signed.sh` รัน QA, stage runtime tools, build, hardened-runtime signing และสร้าง DMG.

Public build ใช้ `ZOOMCUT_SIGN_IDENTITY="Developer ID Application: ..." ZOOMCUT_NOTARIZE=1` พร้อม `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

### เปิดครั้งแรกบน Mac (แอป beta ยังไม่ notarize)
macOS จะเตือน "unidentified developer" — วิธีเปิด:
1. **คลิกขวาที่ ZoomCut.app → Open → Open** หรือ
2. System Settings → Privacy & Security → กด **Open Anyway**
3. ถ้าขึ้น "damaged": `xattr -cr /Applications/ZoomCut.app`

### สิทธิ์ที่ต้องให้ (ครั้งแรก macOS จะถามเอง)
- **Screen Recording** — สำหรับอัดจอ
- **Input Monitoring / Accessibility** — สำหรับจับตำแหน่งคลิก (auto-zoom)

> หมายเหตุ: ระหว่างพัฒนา ถ้า build ใหม่บ่อยๆ macOS อาจขอสิทธิ์ใหม่ (เพราะลายเซ็น ad-hoc เปลี่ยนต่อ build)
> — เป็นเรื่องปกติของ beta ที่ยังไม่ได้ notarize

## แจก beta
อัป `dist/*.dmg` ขึ้น **GitHub Releases** แล้วแนบวิธีเปิดครั้งแรกด้านบน

## ทำ production ทีหลัง (ไม่ต้องรื้อ)
สมัคร Apple Developer ($99/ปี) → ตั้ง `CSC_LINK`/`CSC_KEY_PASSWORD` + `mac.notarize` → ได้แอปเปิดได้เนียนไม่มีเตือน
