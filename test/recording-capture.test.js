const assert = require('node:assert/strict');
const test = require('node:test');

const { buildScreencaptureArgs, normalizePointerPoint, appendCursorPoint, downsampleCursor, recordingMetadata, normalizeRecordingMetadata } = require('../electron/server');

test('window recording excludes the shadow so captured pixels match click bounds', () => {
  assert.deepEqual(
    buildScreencaptureArgs({ windowId: 9943 }, '/tmp/capture.mov'),
    ['-v', '-C', '-o', '-l', '9943', '/tmp/capture.mov'],
  );
});

test('display recording keeps the complete display frame', () => {
  assert.deepEqual(
    buildScreencaptureArgs({ screenIndex: 2 }, '/tmp/capture.mov'),
    ['-v', '-C', '-D', '2', '/tmp/capture.mov'],
  );
});

test('cursor samples normalize to live bounds, coalesce jitter, and stay below the 50k cap', () => {
  const bounds = { x: 100, y: 50, w: 1000, h: 500 };
  assert.deepEqual(normalizePointerPoint(600, 300, bounds), { x: 0.5, y: 0.5 });
  assert.equal(normalizePointerPoint(99, 300, bounds), null);
  const points = [];
  appendCursorPoint(points, { t: 1, x: 0.5, y: 0.5 });
  appendCursorPoint(points, { t: 1.04, x: 0.5001, y: 0.5001 });
  assert.equal(points.length, 1);
  assert.equal(points[0].t, 1.04);
  for (let i = 0; i < 50010; i++) appendCursorPoint(points, { t: 2 + i, x: (i % 100) / 100, y: (i % 80) / 80 });
  assert.ok(points.length <= 50000);
  assert.deepEqual(points.at(-1), { t: 50011, x: 0.09, y: 0.1125 });
  assert.equal(downsampleCursor(points, 100).length, 100);
});

test('cursor cap compacts in batches rather than rewriting the full buffer for every append', () => {
  const points = [];
  for (let i = 0; i < 12; i++) appendCursorPoint(points, { t: i, x: i / 12, y: i / 12 }, 10);
  assert.equal(points.length, 7);
  assert.deepEqual(points.at(-1), { t: 11, x: 11 / 12, y: 11 / 12 });
});

test('recording metadata always has a cursor array and supports v1-compatible empty recovery', () => {
  assert.deepEqual(recordingMetadata({ clicks: [{ t: 1, x: 0.2, y: 0.4 }] }), {
    version: 2, clicks: [{ t: 1, x: 0.2, y: 0.4 }], cursor: [],
  });
  assert.equal(recordingMetadata({ recovered: true }).cursor.length, 0);
  assert.deepEqual(normalizeRecordingMetadata({ version: 1, clicks: [{ t: 0.5 }] }).cursor, []);
  assert.deepEqual(normalizeRecordingMetadata({ version: 2, clicks: [], cursor: [{ t: 0.5, x: 0.2, y: 0.3 }] }).cursor, [{ t: 0.5, x: 0.2, y: 0.3 }]);
});
