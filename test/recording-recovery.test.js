'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { recoverInterruptedRecordings } = require('../electron/server');

test('interrupted mov recordings recover to mp4 and receive click metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-record-recovery-'));
  const input = path.join(dir, 'recording-20260814010101.mov');
  fs.writeFileSync(input, 'partial-video');
  const recovered = await recoverInterruptedRecordings(dir, async (source, output) => fs.copyFileSync(source, output));

  assert.deepEqual(recovered, ['recording-20260814010101']);
  assert.equal(fs.existsSync(input), false);
  assert.equal(fs.readFileSync(path.join(dir, 'recording-20260814010101.mp4'), 'utf8'), 'partial-video');
  const clicks = JSON.parse(fs.readFileSync(path.join(dir, 'recording-20260814010101.clicks.json'), 'utf8'));
  assert.deepEqual(clicks.clicks, []);
  assert.equal(clicks.recovered, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
