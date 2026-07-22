const assert = require('node:assert/strict');
const test = require('node:test');

const { buildScreencaptureArgs } = require('../electron/server');

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
