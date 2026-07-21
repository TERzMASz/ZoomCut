#!/usr/bin/env python3
"""
ZoomCut Recorder — อัด "ตัวหน้าต่าง" จริงๆ (ไม่ใช่พื้นที่หน้าจอ) พร้อมจับตำแหน่งคลิกแบบ realtime

ใช้ screencapture -v -l <windowId> ของ macOS ซึ่งตามติดหน้าต่างเสมอ:
ย้ายหน้าต่าง ปรับขนาด หรือมีหน้าต่างอื่นมาบัง ก็ยังอัดเนื้อหาหน้าต่างนั้นถูกต้อง
ตำแหน่งคลิกก็คำนวณจาก bounds จริงของหน้าต่าง ณ เวลาที่คลิก

โหมด:
  python3 record.py                     → อัดหน้าต่าง iPhone Mirroring (เปิดแอปให้ถ้ายังไม่เปิด)
  python3 record.py --window-id N      → อัดหน้าต่างใดๆ (serve.py ส่ง id มาจากหน้าเลือก)

สิทธิ์ที่ต้องอนุญาต (ให้แอปที่ใช้เปิด ZoomCut เช่น Terminal หรือ Claude):
  - Screen Recording  (อัดจอ)
  - Input Monitoring  (จับตำแหน่งคลิก)
"""
import argparse
import json
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import Quartz

OUT_DIR = Path(__file__).parent / "recordings"


def _window_list(on_screen_only=True):
    opts = Quartz.kCGWindowListExcludeDesktopElements
    if on_screen_only:
        opts |= Quartz.kCGWindowListOptionOnScreenOnly
    else:
        opts |= Quartz.kCGWindowListOptionAll
    return Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []


def _bounds(w):
    b = w.get("kCGWindowBounds")
    return {"x": b["X"], "y": b["Y"], "w": b["Width"], "h": b["Height"]} if b else None


def find_window_by_id(wid, on_screen_only=True):
    """หา bounds ปัจจุบันของหน้าต่าง (ใช้ตอนคลิกเพื่อได้ตำแหน่งล่าสุด)"""
    for w in _window_list(on_screen_only):
        if w.get("kCGWindowNumber") == wid:
            return _bounds(w)
    return None


def window_owner_pid(wid):
    """PID ของแอปเจ้าของหน้าต่าง (ดูจากรายการทุกหน้าต่าง)"""
    for w in _window_list(on_screen_only=False):
        if w.get("kCGWindowNumber") == wid:
            return w.get("kCGWindowOwnerPID")
    return None


def app_has_windows(pid):
    """แอป (ตาม PID) ยังมีหน้าต่างอยู่ไหม — สัญญาณว่าแอปยังไม่ถูกปิด (นับข้าม Space/ถูกบังด้วย)"""
    if pid is None:
        return True
    for w in _window_list(on_screen_only=False):
        if w.get("kCGWindowOwnerPID") == pid:
            b = _bounds(w)
            if b and b["w"] > 100 and b["h"] > 100:
                return True
    return False


def find_mirror_window():
    """หา iPhone Mirroring คืนค่า (window_id, bounds)"""
    for w in _window_list():
        owner = (w.get("kCGWindowOwnerName") or "").lower()
        if "iphone" in owner:
            b = _bounds(w)
            if b and b["w"] > 200 and b["h"] > 300:
                return w.get("kCGWindowNumber"), b
    return None


def video_codec(path):
    p = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return p.stdout.strip()


def video_duration(path):
    p = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(p.stdout.strip())
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--controlled", action="store_true",
                    help="ถูกเรียกจาก serve.py: ไม่เปิดเบราว์เซอร์/เซิร์ฟเวอร์เอง")
    ap.add_argument("--base", help="path ผลลัพธ์ (ไม่มีนามสกุล) เช่น recordings/recording-x")
    ap.add_argument("--window-id", type=int, help="อัดหน้าต่างใดๆ ตาม window ID")
    args = ap.parse_args()

    # --- หาหน้าต่างเป้าหมาย ---
    if args.window_id:
        wid = args.window_id
        win = find_window_by_id(wid)
        if not win:
            sys.exit(f"❌ ไม่พบหน้าต่าง ID {wid} — หน้าต่างอาจถูกปิดไปแล้ว")
        target_name = f"หน้าต่าง ID {wid}"
    else:
        found = find_mirror_window()
        if not found:
            print("📱 ยังไม่พบหน้าต่าง iPhone Mirroring — กำลังเปิดแอปให้...")
            subprocess.run(["open", "-a", "iPhone Mirroring"])
            for _ in range(30):
                time.sleep(1)
                found = find_mirror_window()
                if found:
                    break
            if not found:
                sys.exit("❌ ไม่พบหน้าต่าง iPhone Mirroring — เปิดแอปแล้วเชื่อมต่อ iPhone ก่อน แล้วรันใหม่")
        wid, win = found
        target_name = "iPhone Mirroring"

    owner_pid = window_owner_pid(wid)  # ใช้เช็คว่าแอปยังรันอยู่ (เสถียรกว่าเช็ค window id)

    print(f"✅ พบ{target_name} ที่ ({win['x']:.0f},{win['y']:.0f}) ขนาด {win['w']:.0f}x{win['h']:.0f}")
    print("   🪟 อัดแบบติดตามหน้าต่าง — ย้ายหน้าต่างระหว่างอัดได้เลย", flush=True)

    OUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    if args.base:
        base = Path(__file__).parent / args.base
        base.parent.mkdir(exist_ok=True)
    else:
        base = OUT_DIR / f"recording-{stamp}"
    out_mov = base.with_suffix(".mov")
    out_mp4 = base.with_suffix(".mp4")
    out_json = base.parent / (base.name + ".clicks.json")
    stop_file = base.parent / (base.name + ".stop")
    stop_file.unlink(missing_ok=True)
    out_mov.unlink(missing_ok=True)

    # --- อัดตัวหน้าต่างด้วย screencapture (ติดตามหน้าต่างเอง) ---
    # หมายเหตุสำคัญ: screencapture -v เขียนไฟล์ทั้งก้อน "ตอนหยุด" ไม่ใช่ระหว่างอัด
    # จึงห้ามใช้ขนาดไฟล์เป็นตัวบอกว่าเริ่มอัดแล้ว (บั๊กเดิม) — ใช้ "ยังรันอยู่" แทน
    cap_err = base.parent / (base.name + ".caplog")
    cap_err_f = open(cap_err, "w")
    cap = subprocess.Popen(
        ["screencapture", "-v", "-C", "-l", str(wid), str(out_mov)],
        stdout=subprocess.DEVNULL, stderr=cap_err_f,
    )

    # --- จุดเริ่มเวลา: ถือว่าเริ่มอัดเมื่อ screencapture ยังรันต่อเนื่องได้สักครู่ ---
    # (ถ้าไม่มีสิทธิ์/มีปัญหา screencapture จะออกทันที → ตรวจจับได้จาก cap.poll())
    start_time = [None]
    launched_at = time.time()
    START_CONFIRM = 0.8  # วินาทีที่ต้องรันต่อเนื่องก่อนถือว่าเริ่มจริง

    def watch_start():
        while start_time[0] is None and cap.poll() is None:
            if time.time() - launched_at >= START_CONFIRM:
                start_time[0] = time.time()
                print("🔴 เริ่มอัดแล้ว! ใช้งานหน้าต่างได้เลย — ทุกคลิกจะกลายเป็นจุดซูม (หยุด: ⌃⌘S)", flush=True)
                return
            time.sleep(0.1)

    threading.Thread(target=watch_start, daemon=True).start()

    # --- event tap จับคลิกซ้าย: เทียบกับ bounds จริง ณ เวลาคลิก ---
    clicks = []
    last_bounds = [win]

    # คีย์ลัด global หยุดอัด: ⌃⌘S (Control-Command-S)
    KEY_S = 1  # kVK_ANSI_S
    NEED_FLAGS = Quartz.kCGEventFlagMaskControl | Quartz.kCGEventFlagMaskCommand
    hotkey_stopped = [False]

    def on_event(proxy, etype, event, refcon):
        # คีย์ลัดหยุดอัด (ทำงานทั้งจอ ไม่ต้องกลับมาที่ ZoomCut)
        if etype == Quartz.kCGEventKeyDown and start_time[0] is not None:
            keycode = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode)
            flags = Quartz.CGEventGetFlags(event)
            if keycode == KEY_S and (flags & NEED_FLAGS) == NEED_FLAGS:
                hotkey_stopped[0] = True
                print("\n⌨️  กดคีย์ลัด ⌃⌘S — หยุดอัด", flush=True)
                Quartz.CFRunLoopStop(runloop)
            return event
        if etype == Quartz.kCGEventLeftMouseDown and start_time[0] is not None:
            loc = Quartz.CGEventGetLocation(event)
            # หา bounds ล่าสุด: on-screen ก่อน แล้ว fallback รายการทุกหน้าต่าง แล้วค่อยใช้ค่าเดิม
            w = find_window_by_id(wid) or find_window_by_id(wid, on_screen_only=False) or last_bounds[0]
            last_bounds[0] = w
            if w["x"] <= loc.x <= w["x"] + w["w"] and w["y"] <= loc.y <= w["y"] + w["h"]:
                now = time.time()
                t = now - start_time[0]
                nx = (loc.x - w["x"]) / w["w"]
                ny = (loc.y - w["y"]) / w["h"]
                # เก็บเวลา wall-clock ไว้ด้วย เพื่อ sync ให้ตรงเฟรมจริงตอนจบ
                clicks.append({"wall": now, "t": round(t, 3), "x": round(nx, 4), "y": round(ny, 4)})
                out_json.write_text(json.dumps(
                    {"version": 1, "recording": True,
                     "clicks": [{"t": c["t"], "x": c["x"], "y": c["y"]} for c in clicks]}))
                print(f"  👆 คลิกที่ {t:6.2f}s  ({nx:.2f}, {ny:.2f})  รวม {len(clicks)} ครั้ง", flush=True)
        return event

    tap = Quartz.CGEventTapCreate(
        Quartz.kCGSessionEventTap,
        Quartz.kCGHeadInsertEventTap,
        Quartz.kCGEventTapOptionListenOnly,
        Quartz.CGEventMaskBit(Quartz.kCGEventLeftMouseDown) | Quartz.CGEventMaskBit(Quartz.kCGEventKeyDown),
        on_event, None,
    )
    if not tap:
        cap.send_signal(signal.SIGINT)
        sys.exit(
            "❌ สร้าง event tap ไม่ได้ — ต้องอนุญาต Input Monitoring ก่อน:\n"
            "   System Settings → Privacy & Security → Input Monitoring\n"
            "   → เปิดให้แอปที่ใช้เปิด ZoomCut (Terminal หรือ Claude) แล้วเริ่มอัดใหม่"
        )

    src = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    runloop = Quartz.CFRunLoopGetCurrent()
    Quartz.CFRunLoopAddSource(runloop, src, Quartz.kCFRunLoopCommonModes)
    Quartz.CGEventTapEnable(tap, True)

    def stop_sig(sig, frame):
        Quartz.CFRunLoopStop(runloop)

    signal.signal(signal.SIGINT, stop_sig)

    # CFRunLoopRun บล็อก signal handler ของ Python — timer นี้แตะกลับมาที่ Python
    # เป็นระยะเพื่อให้ SIGINT ทำงาน + เช็คไฟล์สั่งหยุดจาก serve.py + เช็คว่าเริ่มอัดได้จริง
    def timer_cb(timer, info):
        if stop_file.exists():
            Quartz.CFRunLoopStop(runloop)
            return
        if start_time[0] is None:
            # error เฉพาะเมื่อ screencapture "ออกเอง" ก่อนเริ่ม (สิทธิ์/ปัญหาจริง)
            # ไม่ใช้เงื่อนไข timeout อย่างเดียวแล้ว เพราะไฟล์ไม่โผล่ระหว่างอัดเป็นเรื่องปกติ
            if cap.poll() is not None:
                cap_err_f.flush()
                reason = ""
                try:
                    reason = cap_err.read_text().strip()
                except Exception:
                    pass
                print(
                    "❌ เริ่มอัดไม่สำเร็จ — screencapture ออกทันที "
                    "(มักเกิดจากยังไม่ได้ให้สิทธิ์ Screen Recording)\n"
                    "   System Settings → Privacy & Security → Screen & System Audio Recording\n"
                    "   → เปิดให้แอปที่ใช้เปิด ZoomCut (Terminal หรือ Claude) แล้วเริ่มอัดใหม่"
                    + (f"\n   รายละเอียด: {reason}" if reason else ""),
                    flush=True,
                )
                stop_file.unlink(missing_ok=True)
                cap_err_f.close()
                cap_err.unlink(missing_ok=True)
                sys.exit(2)

    timer = Quartz.CFRunLoopTimerCreate(
        None, Quartz.CFAbsoluteTimeGetCurrent() + 0.3, 0.3, 0, 0, timer_cb, None
    )
    Quartz.CFRunLoopAddTimer(runloop, timer, Quartz.kCFRunLoopCommonModes)

    # หยุดอัตโนมัติเฉพาะเมื่อ "แอปถูกปิดจริงๆ" หรือตัวอัดจบเอง
    # หมายเหตุ: ไม่เช็คแค่ window id หายจากจอ เพราะหน้าต่างที่ถูกบัง/อยู่คนละ Space
    # จะหลุดจากรายการ on-screen ทำให้หยุดอัดผิดพลาด (บั๊กเดิม) — ใช้ app_has_windows
    # ที่ดูจากรายการทุกหน้าต่าง (นับข้าม Space/ถูกบัง) และให้ทนหลายวินาที
    def watch_window():
        misses = 0
        while True:
            time.sleep(1)
            if start_time[0] is None:
                continue
            # สัญญาณหลัก: ตัวอัดหน้าจอจบเอง (หน้าต่างถูกปิดจริงๆ screencapture จะจบ)
            if cap.poll() is not None:
                Quartz.CFRunLoopStop(runloop)
                return
            # สัญญาณสำรอง: แอปเจ้าของหน้าต่างไม่เหลือหน้าต่างเลย (แอปถูกปิด) ต่อเนื่อง 8 วินาที
            if not app_has_windows(owner_pid):
                misses += 1
                if misses >= 8:
                    print(f"\n📴 {target_name} ถูกปิด — หยุดอัดอัตโนมัติ", flush=True)
                    Quartz.CFRunLoopStop(runloop)
                    return
            else:
                misses = 0

    threading.Thread(target=watch_window, daemon=True).start()

    print("⏳ กำลังรอเฟรมแรก...")
    print(f"   (หยุดอัด: กดคีย์ลัด ⌃⌘S, ปุ่ม ⏹ ใน ZoomCut, ปิด{target_name}, หรือ Ctrl+C ที่นี่)", flush=True)
    Quartz.CFRunLoopRun()

    # --- หยุดอัด + ปิดไฟล์ ---
    stop_file.unlink(missing_ok=True)
    stop_wall = time.time()  # เวลาที่สั่งหยุด ≈ เฟรมสุดท้ายของวิดีโอ
    print("\n⏹  กำลังปิดไฟล์วิดีโอ...", flush=True)
    if cap.poll() is None:
        cap.send_signal(signal.SIGINT)
        try:
            cap.wait(timeout=15)
        except subprocess.TimeoutExpired:
            cap.terminate()
    cap_err_f.close()
    cap_err.unlink(missing_ok=True)

    if not out_mov.exists() or out_mov.stat().st_size == 0:
        out_mov.unlink(missing_ok=True)
        sys.exit("❌ ไม่มีวิดีโอถูกบันทึก — ตรวจสิทธิ์ Screen Recording แล้วลองใหม่")

    # --- sync เวลาคลิกให้ตรงเฟรมจริง ---
    # วิดีโอครอบช่วง [stop_wall - dur, stop_wall] → เฟรม 0 = stop_wall - dur
    dur = video_duration(out_mov)
    if dur:
        frame0_wall = stop_wall - dur
        synced = []
        for c in clicks:
            tt = c["wall"] - frame0_wall
            if -0.25 <= tt <= dur + 0.25:
                synced.append({"t": round(max(0.0, tt), 3), "x": c["x"], "y": c["y"]})
        clicks = synced
    else:
        clicks = [{"t": c["t"], "x": c["x"], "y": c["y"]} for c in clicks]

    # --- แปลงเป็น mp4 ให้เบราว์เซอร์เล่นได้ชัวร์ ---
    codec = video_codec(out_mov)
    if codec == "h264":
        cvt = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(out_mov), "-c", "copy", "-movflags", "+faststart", str(out_mp4)]
    else:  # เช่น HEVC → transcode ให้เล่นได้ทุกเบราว์เซอร์
        cvt = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
               "-i", str(out_mov), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_mp4)]
    r = subprocess.run(cvt)
    if r.returncode == 0:
        out_mov.unlink(missing_ok=True)
    else:
        sys.exit("❌ แปลงไฟล์วิดีโอไม่สำเร็จ — ไฟล์ดิบอยู่ที่ " + str(out_mov))

    out_json.write_text(json.dumps({"version": 1, "clicks": clicks}, indent=2))
    print(f"""
✅ เสร็จแล้ว!
   🎬 วิดีโอ : {out_mp4}
   👆 คลิก  : {out_json}  ({len(clicks)} จุด)""", flush=True)

    if args.controlled:
        return  # serve.py จะโหลดไฟล์เข้า ZoomCut ให้เอง

    # โหมดรันเอง: เปิด ZoomCut พร้อมโหลดไฟล์อัตโนมัติ
    import socket
    signal.signal(signal.SIGINT, signal.default_int_handler)
    project = Path(__file__).parent
    port = 8123
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        in_use = s.connect_ex(("127.0.0.1", port)) == 0
    server = None
    if not in_use:
        server = subprocess.Popen(
            [sys.executable, str(project / "serve.py"), "--no-open"],
            cwd=project, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(0.8)
    url = f"http://localhost:{port}/?autoload=recordings/{base.name}"
    subprocess.run(["open", url])
    print(f"\n🌐 เปิด ZoomCut ให้แล้ว: {url}\nปิดหน้าต่างนี้ได้เมื่อเสร็จ (Ctrl+C เพื่อจบ)")
    if server:
        try:
            server.wait()
        except KeyboardInterrupt:
            server.terminate()


if __name__ == "__main__":
    main()
