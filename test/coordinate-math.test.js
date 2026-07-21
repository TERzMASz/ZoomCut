const assert = require('assert');

function cropRect(crop) {
  return {
    x: crop.l,
    y: crop.t,
    w: Math.max(0.05, 1 - crop.l - crop.r),
    h: Math.max(0.05, 1 - crop.t - crop.b),
  };
}

function cropPx(media, crop) {
  const cr = cropRect(crop);
  return { x: cr.x * media.w, y: cr.y * media.h, w: cr.w * media.w, h: cr.h * media.h };
}

function sourceRect(media, crop, cam) {
  const cp = cropPx(media, crop);
  const sw = cp.w / cam.zoom;
  const sh = cp.h / cam.zoom;
  let sx = cam.cx * media.w - sw / 2;
  let sy = cam.cy * media.h - sh / 2;
  sx = Math.min(cp.x + cp.w - sw, Math.max(cp.x, sx));
  sy = Math.min(cp.y + cp.h - sh, Math.max(cp.y, sy));
  return { sx, sy, sw, sh };
}

function canvasPointToVideoNorm(media, crop, cam, content, px, py) {
  const sr = sourceRect(media, crop, cam);
  const relX = (px - content.x) / content.w;
  const relY = (py - content.y) / content.h;
  return {
    x: (sr.sx + relX * sr.sw) / media.w,
    y: (sr.sy + relY * sr.sh) / media.h,
  };
}

function nearly(actual, expected, eps = 1e-9) {
  assert(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

const media = { w: 1000, h: 2000 };
const content = { x: 100, y: 50, w: 400, h: 800 };

{
  const crop = { t: 0.1, r: 0.2, b: 0.3, l: 0.05 };
  const cr = cropRect(crop);
  nearly(cr.x, 0.05);
  nearly(cr.y, 0.1);
  nearly(cr.w, 0.75);
  nearly(cr.h, 0.6);
}

{
  const crop = { t: 0.1, r: 0.1, b: 0.1, l: 0.1 };
  const cam = { zoom: 1, cx: 0.5, cy: 0.5 };
  const sr = sourceRect(media, crop, cam);
  assert.deepStrictEqual(sr, { sx: 100, sy: 200, sw: 800, sh: 1600 });
}

{
  const crop = { t: 0.1, r: 0.1, b: 0.1, l: 0.1 };
  const cam = { zoom: 2, cx: 0.5, cy: 0.5 };
  const center = canvasPointToVideoNorm(media, crop, cam, content, 300, 450);
  nearly(center.x, 0.5);
  nearly(center.y, 0.5);
}

{
  const crop = { t: 0.2, r: 0.2, b: 0.2, l: 0.2 };
  const cam = { zoom: 3, cx: 0.02, cy: 0.98 };
  const sr = sourceRect(media, crop, cam);
  assert(sr.sx >= crop.l * media.w);
  assert(sr.sy >= crop.t * media.h);
  assert(sr.sx + sr.sw <= (1 - crop.r) * media.w + 1e-9);
  assert(sr.sy + sr.sh <= (1 - crop.b) * media.h + 1e-9);
}

{
  const crop = { t: 0, r: 0, b: 0, l: 0 };
  const cam = { zoom: 4, cx: 0.8, cy: 0.25 };
  const mapped = canvasPointToVideoNorm(media, crop, cam, content, 300, 450);
  nearly(mapped.x, 0.8);
  nearly(mapped.y, 0.25);
}

console.log('coordinate math ok');

function outputDuration(segments) {
  return segments.reduce((a, s) => a + (s.end - s.start) / s.speed, 0);
}
function segmentOutputStart(segments, target) {
  let out = 0;
  for (const s of segments) {
    if (s === target || s.id === target.id) return out;
    out += (s.end - s.start) / s.speed;
  }
  return out;
}
function sourceToOutputTime(segments, t) {
  let out = 0;
  for (const s of segments) {
    if (t >= s.start - 1e-3 && t <= s.end + 1e-3) return out + Math.max(0, t - s.start) / s.speed;
    out += (s.end - s.start) / s.speed;
  }
  return Math.max(0, Math.min(outputDuration(segments), out));
}
function outputToSourceTime(segments, outT) {
  let cursor = 0;
  for (const s of segments) {
    const len = (s.end - s.start) / s.speed;
    if (outT <= cursor + len + 1e-3) return Math.min(s.end, s.start + Math.max(0, outT - cursor) * s.speed);
    cursor += len;
  }
  return segments[segments.length - 1].end;
}

{
  const segments = [{ id: 1, start: 10, end: 14, speed: 0.25 }];
  nearly(outputDuration(segments), 16);
  nearly(sourceToOutputTime(segments, 11), 4);
  nearly(outputToSourceTime(segments, 4), 11);
  nearly(segmentOutputStart(segments, segments[0]), 0);
  const voice = { outStart: sourceToOutputTime(segments, 11), outDuration: 3 };
  nearly(voice.outDuration, 3);
}

console.log('output timeline math ok');
