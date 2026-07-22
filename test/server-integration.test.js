'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../electron/server');

test('local API requires token and registered media supports byte ranges', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-server-test-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>ZoomCut</title>');
  const mediaPath = path.join(dir, 'sample.mp4');
  fs.writeFileSync(mediaPath, Buffer.from('0123456789'));
  const recordingsDir = path.join(dir, 'recordings');
  fs.mkdirSync(recordingsDir);
  fs.writeFileSync(path.join(recordingsDir, 'capture.mp4'), Buffer.from('recording'));
  const info = await startServer({ webRoot: dir, recordingsDir, port: 0 });
  const origin = `http://127.0.0.1:${info.port}`;
  try {
    const denied = await fetch(origin + '/api/record/state');
    assert.equal(denied.status, 401);
    const allowed = await fetch(origin + '/api/record/state', { headers: { 'X-ZoomCut-Token': info.apiToken } });
    assert.equal(allowed.status, 200);
    const registered = info.registerMediaPath(mediaPath);
    const partial = await fetch(origin + registered.url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), '2345');
    const traversal = await fetch(origin + '/%2e%2e/package.json');
    assert.notEqual(traversal.status, 200);
    const recordingDenied = await fetch(origin + '/recordings/capture.mp4');
    assert.equal(recordingDenied.status, 401);
    const recordingAllowed = await fetch(origin + `/recordings/capture.mp4?token=${info.apiToken}`);
    assert.equal(recordingAllowed.status, 200);
  } finally {
    await new Promise(resolve => info.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
