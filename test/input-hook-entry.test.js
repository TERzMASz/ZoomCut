'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('packaged click tracking uses the signed app entry without weakening Electron fuses', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = fs.readFileSync(path.join(root, 'electron', 'entry.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'electron', 'server.js'), 'utf8');
  const afterPack = fs.readFileSync(path.join(root, 'electron', 'after-pack.js'), 'utf8');

  assert.equal(pkg.main, 'electron/entry.js');
  assert.match(entry, /--zoomcut-input-hook-worker/);
  assert.match(entry, /runInputHookWorker/);
  assert.match(server, /--zoomcut-input-hook-worker/);
  assert.doesNotMatch(server, /ELECTRON_RUN_AS_NODE/);
  assert.match(afterPack, /\[FuseV1Options\.RunAsNode\]: false/);
});
