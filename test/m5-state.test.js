const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const shortcuts = require('../shared/shortcut-registry');
const revision = require('../shared/project-revision');

test('shortcut registry persists app bindings, rejects collisions and native reserved keys', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  const registry = shortcuts.createShortcutRegistry({ storage });
  assert.equal(registry.get('playPause'), 'Space');
  assert.equal(registry.set('playPause', 'P'), 'P');
  assert.equal(shortcuts.createShortcutRegistry({ storage }).get('playPause'), 'P');
  assert.throws(() => registry.set('split', 'P'), /conflict/);
  assert.throws(() => registry.set('split', 'Command+S'), /reserved/);
  assert.throws(() => registry.set('split', shortcuts.bindingForEvent({ key: 's', metaKey: true, ctrlKey: true })), /reserved/);
  assert.throws(() => registry.set('split', shortcuts.bindingForEvent({ key: 's', ctrlKey: true, shiftKey: true })), /reserved/);
  assert.throws(() => registry.set('split', shortcuts.bindingForEvent({ key: 'w', metaKey: true })), /reserved/);
  registry.reset('playPause');
  assert.equal(registry.get('playPause'), 'Space');
});

test('shortcut registry removes persisted collisions against effective defaults', () => {
  const data = new Map([['zoomcut-shortcuts-v1', JSON.stringify({ playPause: 'B' })]]);
  const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  const registry = shortcuts.createShortcutRegistry({ storage });
  assert.equal(registry.get('playPause'), 'Space');
  assert.equal(registry.get('split'), 'B');

  data.set('zoomcut-shortcuts-v1', JSON.stringify({ playPause: 'B', split: 'X' }));
  const nonConflictingEffective = shortcuts.createShortcutRegistry({ storage });
  assert.equal(nonConflictingEffective.get('playPause'), 'B');
  assert.equal(nonConflictingEffective.get('split'), 'X');
});

test('shortcut matching ignores typing targets and normalizes modifier aliases', () => {
  assert.equal(shortcuts.bindingForEvent({ key: 'z', ctrlKey: true }), 'Mod+Z');
  assert.equal(shortcuts.matchesBinding('Mod+Z', { key: 'z', metaKey: true }), true);
  assert.equal(shortcuts.isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(shortcuts.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(shortcuts.isTypingTarget({ tagName: 'BUTTON' }), false);
});

test('autosave checkpoints do not clear explicit unsaved state', () => {
  let state = revision.createRevisionState();
  state = revision.markModified(state);
  assert.deepEqual([state.revision, state.savedRevision, state.saveState], [1, 0, 'modified']);
  state = revision.finishAutosave(state, 1);
  assert.deepEqual([state.autosavedRevision, state.savedRevision, state.saveState], [1, 0, 'autosaved']);
  state = revision.finishExplicitSave(state, 1);
  assert.deepEqual([state.savedRevision, state.saveState], [1, 'clean']);
});

test('revision save errors and recovery remain actionable', () => {
  let state = revision.createRevisionState({ revision: 4, savedRevision: 2, autosavedRevision: 4, saveState: 'modified' });
  state = revision.failSave(state);
  assert.equal(state.saveState, 'error');
  state = revision.finishAutosave(state, 4);
  assert.equal(state.saveState, 'autosaved');
  state = revision.resetRevision(state);
  assert.deepEqual(state, { revision: 0, savedRevision: 0, autosavedRevision: 0, saveState: 'clean' });
});

test('out-of-order save completions never move checkpoints backwards', () => {
  let state = revision.createRevisionState({ revision: 6, savedRevision: 0, autosavedRevision: 4, saveState: 'modified' });
  state = revision.finishAutosave(state, 3);
  assert.equal(state.autosavedRevision, 4);
  state = revision.finishExplicitSave(state, 6);
  state = revision.finishExplicitSave(state, 5);
  assert.deepEqual([state.savedRevision, state.autosavedRevision, state.saveState], [6, 6, 'clean']);
});

test('selection-only pointer downs defer dirty revisions until movement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'editor-app.js'), 'utf8');
  assert.match(source, /voiceDrag = \{[^\n]+historyCommitted: false/);
  assert.match(source, /camDrag = \{[^\n]+historyCommitted: false/);
  assert.match(source, /annotationDrag = \{ a, edge,[^\n]+historyCommitted: false/);
  assert.match(source, /dragging = \{ ev, edge,[^\n]+historyCommitted: false/);
  assert.doesNotMatch(source, /dragging = \{ ev, edge,[^\n]+\};\n\s*commitHistory\(\)/);
});

test('forced exit explicitly closes local resources first', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(source, /server\.closeAllConnections\?\.\(\)/);
  assert.match(source, /await new Promise\(resolve => server\.close/);
  assert.match(source, /globalShortcut\.unregisterAll\(\)/);
  assert.match(source, /await cleanupBeforeWindowClose\(\)[\s\S]+app\.exit\(0\)/);
});
