#!/usr/bin/env python3
"""
ZoomCut Server — เสิร์ฟหน้าเว็บ + API ควบคุมการอัดหน้าจอ iPhone จากปุ่มในเบราว์เซอร์

รัน: python3 serve.py   (หรือดับเบิลคลิก "เปิด ZoomCut.command")
แล้วทุกอย่างทำจากปุ่มในหน้าเว็บได้เลย:
  🔴 อัด iPhone → เริ่มอัด   ⏹ หยุด → จบแล้ววิดีโอ+จุดซูมโหลดเข้า editor อัตโนมัติ
"""
import json
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import Quartz

PROJECT = Path(__file__).parent
PORT = 8123

rec = {"proc": None, "base": None, "started": None, "log": []}
rec_lock = threading.Lock()


def read_log(proc):
    for line in proc.stdout:
        line = line.rstrip()
        print(f"[record] {line}")
        rec["log"].append(line)
        del rec["log"][:-30]


SKIP_APPS = {"Window Server", "Dock", "Control Center", "Notification Center",
             "Spotlight", "Wallpaper", "Screenshot"}


def list_windows():
    """รายชื่อหน้าต่างที่อัดได้ — สำหรับหน้าเลือกแบบแชร์จอ meeting"""
    wins = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    out = []
    for w in wins or []:
        app = w.get("kCGWindowOwnerName") or ""
        title = w.get("kCGWindowName") or ""
        b = w.get("kCGWindowBounds") or {}
        if (w.get("kCGWindowLayer") != 0 or app in SKIP_APPS
                or b.get("Width", 0) < 300 or b.get("Height", 0) < 200):
            continue
        out.append({
            "id": w.get("kCGWindowNumber"),
            "app": app,
            "title": title,
            "w": int(b["Width"]), "h": int(b["Height"]),
        })
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PROJECT), **kw)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/windows":
            self.send_json({"windows": list_windows()})
            return
        if self.path == "/api/record/state":
            with rec_lock:
                proc = rec["proc"]
                running = proc is not None and proc.poll() is None
                clicks = 0
                if rec["base"]:
                    cj = PROJECT / (rec["base"] + ".clicks.json")
                    if cj.exists():
                        try:
                            clicks = len(json.loads(cj.read_text()).get("clicks", []))
                        except Exception:
                            pass
                finished = (
                    proc is not None and proc.poll() == 0
                    and rec["base"] is not None
                    and (PROJECT / (rec["base"] + ".mp4")).exists()
                )
                error = None
                if proc is not None and proc.poll() not in (None, 0):
                    error = "\n".join(rec["log"][-6:])
                self.send_json({
                    "running": running,
                    "base": rec["base"],
                    "started": rec["started"],
                    "clicks": clicks,
                    "finished": finished,
                    "error": error,
                    "log": rec["log"][-3:],
                })
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/record/start":
            with rec_lock:
                if rec["proc"] is not None and rec["proc"].poll() is None:
                    self.send_json({"error": "กำลังอัดอยู่แล้ว"}, 409)
                    return
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(length)) if length else {}
                except Exception:
                    body = {}
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                base = f"recordings/recording-{stamp}"
                cmd = [sys.executable, str(PROJECT / "record.py"), "--controlled", "--base", base]
                if body.get("windowId"):
                    cmd += ["--window-id", str(int(body["windowId"]))]
                proc = subprocess.Popen(
                    cmd, cwd=PROJECT,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                )
                rec.update(proc=proc, base=base, started=time.time(), log=[])
                threading.Thread(target=read_log, args=(proc,), daemon=True).start()
            self.send_json({"ok": True, "base": base})
            return
        if self.path == "/api/record/stop":
            with rec_lock:
                proc = rec["proc"]
                if proc is None or proc.poll() is not None:
                    self.send_json({"error": "ไม่ได้กำลังอัดอยู่"}, 409)
                    return
                # ไฟล์สั่งหยุดเป็นช่องทางหลัก (SIGINT ถูกบล็อกระหว่าง CFRunLoopRun)
                if rec["base"]:
                    (PROJECT / (rec["base"] + ".stop")).touch()
                proc.send_signal(signal.SIGINT)
            self.send_json({"ok": True})
            return
        self.send_json({"error": "not found"}, 404)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"🎬 ZoomCut พร้อมใช้งานที่ {url}")
    print("   กดปุ่ม '🔴 อัด iPhone' ในหน้าเว็บเพื่อเริ่มอัดได้เลย (Ctrl+C เพื่อปิด)")
    if "--no-open" not in sys.argv:
        subprocess.run(["open", url])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        with rec_lock:
            if rec["proc"] is not None and rec["proc"].poll() is None:
                rec["proc"].send_signal(signal.SIGINT)
                rec["proc"].wait()
        print("\n👋 ปิด ZoomCut แล้ว")


if __name__ == "__main__":
    main()
