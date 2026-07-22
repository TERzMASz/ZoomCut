'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { isPathInside, safeStaticPath, readJsonBody, streamRequestToFile, normalizeRecordingOptions } = require('../electron/security');

test('path checks reject traversal and prefix collisions', () => {
  const root = path.join(os.tmpdir(), 'zoomcut-root');
  assert.equal(isPathInside(root, path.join(root, 'index.html')), true);
  assert.equal(isPathInside(root, root + '-evil/file'), false);
  assert.equal(safeStaticPath(root, '../secret'), null);
  assert.equal(safeStaticPath(root, '%2e%2e/secret'), null);
});

test('JSON body parser accepts valid input and enforces byte limit', async () => {
  const valid = Readable.from([Buffer.from('{"ok":true}')]);
  assert.deepEqual(await readJsonBody(valid, 64), { ok: true });
  const oversized = Readable.from([Buffer.alloc(65, 0x20)]);
  await assert.rejects(readJsonBody(oversized, 64), /too large/);
});

test('request streaming writes without buffering and deletes partial oversized files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-security-test-'));
  const output = path.join(dir, 'upload.bin');
  await streamRequestToFile(Readable.from([Buffer.from('abc'), Buffer.from('def')]), output, 10);
  assert.equal(fs.readFileSync(output, 'utf8'), 'abcdef');
  const rejected = path.join(dir, 'large.bin');
  await assert.rejects(streamRequestToFile(Readable.from([Buffer.alloc(11)]), rejected, 10), /size limit/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(rejected), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recording options reject mixed, unknown and shell-like inputs', () => {
  assert.deepEqual(normalizeRecordingOptions({ screenIndex: 2 }), { screenIndex: 2 });
  assert.deepEqual(normalizeRecordingOptions({}), {});
  assert.throws(() => normalizeRecordingOptions({ screenIndex: 1, windowId: 2 }), /exactly one/);
  assert.throws(() => normalizeRecordingOptions({ androidSerial: 'abc; rm' }), /serial/);
  assert.throws(() => normalizeRecordingOptions({ command: 'whoami' }), /unknown/);
});
