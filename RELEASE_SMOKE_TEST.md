# ZoomCut Release Smoke Test

ใช้ checklist นี้ก่อนส่ง DMG ให้ tester ทุกครั้ง

## 1. Diagnostics

- เปิดแอป แล้วกด `ตรวจระบบ`
- ต้องเห็น `ffmpeg`, `ffprobe`, `Screen Recording backend`, `Click hook` เป็นพร้อมใช้งาน
- ถ้าเพิ่งเพิ่มสิทธิ์ macOS ให้ปิดแอปแล้วเปิดใหม่

## 1.1 Layout Resize

- ลากเส้นแบ่งแนวตั้งระหว่าง sidebar กับ preview ไปซ้าย/ขวาได้
- ลากเส้นแบ่งแนวนอนระหว่าง preview กับ timeline ขึ้น/ลงได้
- ปิด/เปิดแอปใหม่แล้วขนาด panel ต้องจำค่าล่าสุด

## 2. Recording

- หน้าเริ่มต้นใน timeline ต้องมี 3 ปุ่มชัดเจน: `อัดหน้าจอ`, `เพิ่มสื่อ`, `พากย์เสียง`
- ก่อนมีวิดีโอ ปุ่ม `พากย์เสียง` ใน quick actions ต้อง disabled
- กด `อัดหน้าจอ`
- เลือกทั้งจอหรือหน้าต่างสั้น ๆ
- อัดประมาณ 10 วินาที และคลิกอย่างน้อย 3 จุดที่ห่างกัน
- หยุดด้วยปุ่มในแอป และทดสอบคีย์ลัด `Control-Command-S` อีกหนึ่งรอบ
- หลังจบต้องโหลดวิดีโอกลับเข้า editor พร้อมจำนวนจุดซูม

## 3. Coordinate / Zoom

- เปิด `Debug` แล้วเล่นผ่านจุดคลิก
- เส้น crosshair ของ camera ต้องตรงกับตำแหน่งที่ซูมเข้า
- ลอง crop ซ้าย/ขวา/บน/ล่าง แล้วคลิกเพิ่มบน preview
- จุดซูมใหม่ต้องยังตรงกับตำแหน่งที่คลิก ไม่ผูกผิดกับ crop

## 4. Zoom Range

- เลือก zoom style: `Subtle`, `Focus`, `Fast`, `Cinematic`, `Tap only`
- import/click ใหม่ต้องได้ zoom duration/easing ตาม preset
- `Tap only` ต้องไม่สร้าง zoom marker แต่ tap ripple ยังแสดงได้
- เลือก zoom marker บน timeline
- ลากทั้ง marker เพื่อเลื่อนเวลา
- ลากขอบซ้าย/ขวาเพื่อขยาย/ย่อช่วงซูม
- ปรับ `เข้า`, `ค้างไว้`, `ออก`, และ `ระดับ`
- เล่น preview แล้วต้องเห็น zoom-in, hold, zoom-out ต่อเนื่องไม่กระตุก

## 5. Timeline Trim

- กด `+ Video lane`, `+ Voice lane`, `+ Camera lane` แล้วต้องเห็น lane ใหม่แยกตามชนิด media
- เปิด/ลากวิดีโอไฟล์แรกเพื่อเป็น base แล้วเพิ่มวิดีโอไฟล์ที่สอง ต้องเห็นเป็น overlay clip สีเหลืองใน video lane
- เล่น preview ช่วง overlay clip แล้ววิดีโอที่สองต้องวาดทับบนพื้นที่ content
- ลาก overlay video clip ซ้าย/ขวาและข้าม video lane ได้
- ลากขอบซ้าย/ขวาของ overlay video clip เพื่อ trim ได้
- กด split กลาง overlay video clip แล้วต้องแตกเป็น 2 clip
- Export MP4 แล้ว overlay video ต้องติดไฟล์ตาม preview
- ลากขอบซ้าย/ขวาของ video segment เพื่อ trim หัว/ท้าย
- กด `แบ่งท่อน` กลาง segment แล้ว trim แต่ละท่อนแยกกัน
- เลือก segment แล้วเปลี่ยน `Lane` ใน panel ด้านล่าง ต้องย้าย segment ไป lane ที่เลือก
- ลบท่อนหนึ่งออก แล้ว preview ต้องข้ามช่องว่างที่ถูกตัด
- ปรับ speed รายท่อนแล้ว playhead ต้องข้ามถูกจังหวะ
- กด `×` ใน panel หรือกด `Esc` แล้ว panel ที่เลือกต้องปิด
- กดปุ่มลบใน panel ต้องมี confirm ก่อนลบ เพื่อกันกดพลาด

## 6. Keyboard Shortcuts

- กด `?` แล้วต้องเห็นรายการ shortcuts
- `Space` เล่น/หยุด
- `B`, `C`, หรือ `Command-B` แบ่งท่อนที่ playhead
- `I`/`O` และ `Q`/`W` trim หัว/ท้ายของท่อนที่เลือก
- `Delete` ลบ zoom marker, voice clip, หรือ segment ที่เลือก
- `Command-Z` undo และ `Command-Shift-Z` redo
- `Command + +` / `Command + -` zoom timeline, `Shift-Z` fit timeline
- ลูกศรซ้าย/ขวา seek, `Shift` + ลูกศร seek ทีละ 1 วิ
- `R` เริ่ม/หยุด voice over

## 7. Voice Over

- เลือก microphone source จาก dropdown ข้างปุ่ม `Voice over`
- กด `Voice over` ที่ playhead ปัจจุบัน
- ระหว่างพูด level meter ต้องขยับ
- อัดเสียง 3-5 วินาที แล้วกดหยุด
- ต้องเห็น clip เสียงใน voice track พร้อม waveform bars
- คลิก clip เสียงแล้ว playhead ต้องกระโดดไปจุดเริ่ม
- ลาก voice clip ไปซ้าย/ขวาได้ และลากขอบซ้าย/ขวาเพื่อ trim ได้
- ลาก voice clip ข้าม voice lane หรือเลือก `Lane` ใน panel แล้ว clip ต้องย้าย lane ได้
- กด split ขณะ playhead อยู่กลาง voice clip แล้วต้องแตกเป็น 2 clip
- เล่น preview แล้วต้องได้ยินเสียงบรรยายตรงช่วง clip
- ทดสอบกับ segment speed `0.25x`: พากย์ตาม playback ที่ช้าลง แล้วเสียงใน preview/export ต้องเป็นเสียงเวลาจริง ไม่ยืดหรือช้าลงซ้ำ
- ลบ clip เสียงได้
- Export MP4 แล้วเสียงบรรยายต้องติดไฟล์

## 8. Camera Overlay

- เลือก camera source จาก dropdown
- เปิดปุ่ม `Camera` แล้วกด `Voice over`
- อัดพร้อมบรรยาย 3-5 วินาที แล้วกดหยุด
- ต้องเห็น camera clip ใน camera lane
- preview ต้องเห็นวงกลมกล้องมุมขวาล่าง
- ลาก/trim/split camera clip ได้
- ลาก camera clip ข้าม camera lane หรือเลือก `Lane` ใน panel แล้ว clip ต้องย้าย lane ได้
- ปรับ fade in/out แล้ว preview/export ต้องค่อย ๆ เข้า/ออก
- ปรับ position, shape, size, margin แล้ว preview/export ต้องเปลี่ยนตาม
- Export MP4 แล้ว camera overlay ต้องติดไฟล์

## 9. Theme / Language

- สลับ light/dark แล้ว editor ต้องอ่านง่ายทั้งสองโหมด
- สลับ TH/EN แล้ว header, sidebar, timeline panels, overlays, picker, diagnostics และ export state ต้องเปลี่ยนภาษาโดยไม่ต้อง reload

## 10. Export

- Export MP4
- ไฟล์ต้องเล่นได้จนจบใน QuickTime
- เช็กว่าช่วงที่ตัดออกไม่โผล่กลับมา
- เช็กว่า zoom/tap ripple ตรงกับ preview
