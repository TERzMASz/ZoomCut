const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'shared/editor-shell.js'), 'utf8');

test('editor shell keeps one instance of every DOM id', () => {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('editor shell assets and primary work areas are packaged by index', () => {
  assert.match(html, /shared\/editor-shell\.css/);
  assert.match(html, /shared\/lucide\.min\.js/);
  assert.match(html, /shared\/editor-app\.js/);
  assert.match(html, /shared\/editor-shell\.js/);
  assert.doesNotMatch(html, /<script>(?:.|\n)*?<\/script>/);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /script-src[^;]*unsafe-inline/);

  for (const id of [
    'editorShell',
    'editorRail',
    'sidebar',
    'stage',
    'contextInspector',
    'timeline',
    'sidebarSplitter',
    'timelineSplitter',
    'recordingHud',
    'recordingStopBtn',
    'previewTransport',
    'previewPlay',
  ]) {
    assert.match(html, new RegExp(`\\bid=["']${id}["']`), `missing #${id}`);
  }
});

test('literal shell element references resolve to existing DOM ids', () => {
  const htmlIds = new Set(
    [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]),
  );
  const references = [
    ...shell.matchAll(/getElementById\(["']([^"']+)["']\)/g),
  ].map((match) => match[1]);

  const missing = [...new Set(references.filter((id) => !htmlIds.has(id)))];
  assert.deepEqual(missing, []);
});
