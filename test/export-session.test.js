'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createExportSessionManager, MAX_CHUNK_BYTES } = require('../electron/export-session');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-export-session-test-'));
  const targets = new Map([['target', path.join(root, 'result.mp4')]]);
  const canceled = [];
  const manager = createExportSessionManager({
    tempRoot: root,
    maxBytes: 64,
    consumeTarget: id => { const value = targets.get(id); targets.delete(id); return value; },
    runRemux: async (input, output) => fs.copyFileSync(input, output),
    cancelRemux: id => canceled.push(id),
  });
  return { root, manager, canceled };
}

test('export session streams chunks to disk and atomically publishes output', async () => {
  const { root, manager } = fixture();
  const session = manager.begin({ targetId: 'target', ext: 'webm', jobId: 'job-1' });
  await manager.append(session.id, Buffer.from('first'));
  await manager.append(session.id, Buffer.from('-second'));
  const result = await manager.finish(session.id);
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'first-second');
  assert.equal(manager.activeCount(), 0);
  assert.deepEqual(fs.readdirSync(root), ['result.mp4']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('export session enforces total and per-chunk limits and cleans canceled sessions', async () => {
  const { root, manager, canceled } = fixture();
  const session = manager.begin({ targetId: 'target', ext: 'mp4', jobId: 'job-2' });
  await assert.rejects(manager.append(session.id, 'not-binary'), /Invalid export chunk/);
  await manager.append(session.id, Buffer.alloc(48));
  await assert.rejects(manager.append(session.id, Buffer.alloc(17)), /size limit/);
  await assert.rejects(manager.append(session.id, Buffer.alloc(MAX_CHUNK_BYTES + 1)), /size limit/);
  await manager.cancel(session.id);
  assert.deepEqual(canceled, ['job-2']);
  assert.equal(manager.activeCount(), 0);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
