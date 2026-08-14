'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('public release profile keeps library validation and requires notarization', () => {
  const hardened = read('electron/entitlements.mac.plist');
  const beta = read('electron/entitlements.beta.plist');
  const build = read('electron/build-signed.sh');
  const privacy = read('resources/PrivacyInfo.xcprivacy');

  assert.doesNotMatch(hardened, /disable-library-validation/);
  assert.match(beta, /disable-library-validation/);
  assert.match(build, /ZOOMCUT_PUBLIC_RELEASE/);
  assert.match(build, /ZOOMCUT_NOTARIZE/);
  assert.match(build, /notarytool submit/);
  assert.match(privacy, /NSPrivacyTracking/);
  assert.match(privacy, /NSPrivacyCollectedDataTypes/);
});
