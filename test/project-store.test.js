'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjectStore, MAX_PROJECT_BYTES, readProject } = require('../electron/project-store');

function documentFor(mediaPath) {
  return {
    format: 'zoomcut-project', version: 1, state: { segments: [{ start: 0, end: 1, speed: 1 }] },
    mediaPaths: [{ id: 'base', kind: 'base', name: 'base.mp4', path: mediaPath }],
  };
}

test('project store saves atomically, recovers autosave and reports missing media', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-project-test-'));
  const projectPath = path.join(dir, 'test.zoomcut');
  const mediaPath = path.join(dir, 'base.mp4');
  fs.writeFileSync(mediaPath, 'media');
  const dialog = {
    showSaveDialog: async () => ({ canceled: false, filePath: projectPath }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [projectPath] }),
  };
  const store = createProjectStore({ userData: path.join(dir, 'user'), dialog });
  const doc = documentFor(mediaPath);
  assert.equal((await store.save(doc)).path, projectPath);
  store.autosave(doc);
  assert.equal(store.recovery().missing.length, 0);
  fs.unlinkSync(mediaPath);
  assert.equal((await store.open()).missing.length, 1);
  assert.equal(store.recovery().missing.length, 1);
  store.clearRecovery();
  assert.equal(store.recovery(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recorded assets are content addressed and deduplicated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-assets-test-'));
  const dialog = {};
  const store = createProjectStore({ userData: dir, dialog });
  const first = store.persistAsset(Buffer.from('same'), 'webm');
  const second = store.persistAsset(Buffer.from('same'), 'webm');
  assert.equal(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'same');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project reader rejects oversized files before parsing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomcut-project-limit-test-'));
  const projectPath = path.join(dir, 'oversized.zoomcut');
  const handle = fs.openSync(projectPath, 'w');
  fs.ftruncateSync(handle, MAX_PROJECT_BYTES + 1);
  fs.closeSync(handle);
  assert.throws(() => readProject(projectPath), /too large/);
  fs.rmSync(dir, { recursive: true, force: true });
});
