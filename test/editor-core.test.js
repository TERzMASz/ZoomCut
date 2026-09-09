'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/editor-core');

test('project serialization keeps editable data and removes runtime objects', () => {
  const state = {
    mode: 'video', aspect: '16:9', crop: { t: 0.1, r: 0, b: 0, l: 0 }, camDefaults: {},
    baseMedia: { sourcePath: '/tmp/base.mp4', name: 'base.mp4', url: 'blob:base', video: {} },
    segments: [{ id: 1, start: 0, end: 10, speed: 1, lane: 0 }],
    videoClips: [{ id: 2, sourcePath: '/tmp/overlay.mp4', url: 'blob:overlay', video: {}, outStart: 1, outDuration: 2 }],
    voiceovers: [{ id: 3, sourcePath: '/tmp/voice.webm', blob: {}, audio: {}, outStart: 2, outDuration: 1 }],
    facecams: [], events: [], taps: [], videoLaneCount: 2, voiceLaneCount: 1, cameraLaneCount: 1,
  };
  const project = core.createProject(state, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(project.version, core.PROJECT_VERSION);
  assert.equal(project.baseMedia.url, undefined);
  assert.equal(project.state.videoClips[0].video, undefined);
  assert.equal(project.state.voiceovers[0].blob, undefined);
  assert.deepEqual(project.mediaPaths.map(x => x.kind), ['base', 'video', 'voice']);
  assert.equal(core.validateProject(project), project);
});

test('v1 projects migrate to v2 with foundation defaults and retain legacy settings', () => {
  const project = {
    format: 'zoomcut-project', version: 1,
    baseMedia: { sourcePath: '/tmp/base.mp4' },
    settings: { bg: 3, bgType: 'preset', frame: 'iphone' },
    state: { segments: [{ start: 0, end: 1, speed: 1 }], events: [], taps: [] },
  };
  core.validateProject(project);
  assert.equal(project.version, 2);
  assert.equal(project.settings.background.value, 3);
  assert.equal(project.settings.frameStyle.type, 'iphone');
  assert.deepEqual(project.state.cursorPoints, []);
  assert.deepEqual(project.state.annotations, []);
  assert.equal(project.state.annotationLaneCount, 1);
});

test('new foundation fields are normalized and dangerous keys are scrubbed', () => {
  const project = JSON.parse(JSON.stringify({
    format: 'zoomcut-project', version: 2,
    baseMedia: { sourcePath: '/tmp/base.mp4' },
    settings: {
      cursorSettings: { enabled: 1, size: 99, smoothing: -1, constructor: { polluted: true } },
      shortcuts: { play: 'Space' },
      background: { type: 'preset', value: 2 }, frameStyle: 'browser',
    },
    state: {
      segments: [{ start: 0, end: 1, speed: 1 }], events: [], taps: [],
      cursorPoints: [{ t: -2, x: 2, y: -1, kind: 'move' }],
      annotations: [{ id: 'a1', type: 'text', start: 2, end: 1, x: 2, y: -1, text: 'Hello' }],
      annotationLaneCount: 100,
    },
  }));
  core.validateProject(project);
  assert.equal(project.settings.cursorSettings.size, 4);
  assert.equal(project.settings.cursorSettings.smoothing, 0);
  assert.equal(Object.hasOwn(project.settings.cursorSettings, 'constructor'), false);
  assert.deepEqual(project.state.cursorPoints[0], { t: 0, x: 1, y: 0, kind: 'move' });
  assert.equal(project.state.annotations[0].duration, 0.05);
  assert.equal(project.state.annotations[0].coordinateSpace, 'source');
  assert.equal(project.state.annotationLaneCount, 32);
});

test('foundation validation rejects unsafe shortcut and collection shapes', () => {
  const base = { format: 'zoomcut-project', version: 2, baseMedia: { sourcePath: '/tmp/base.mp4' }, state: { segments: [{ start: 0, end: 1 }] } };
  assert.throws(() => core.validateProject({ ...base, settings: { shortcuts: { play: { key: 'Space' } } } }), /invalid binding/);
  assert.throws(() => core.validateProject({ ...base, state: { segments: [{ start: 0, end: 1 }], annotations: 'nope' } }), /annotations must be an array/);
  assert.throws(() => core.validateProject({ ...base, settings: { cursorSettings: [] } }), /cursorSettings must be an object/);
  assert.throws(() => core.validateProject({ ...base, state: { segments: [{ start: 0, end: 1 }], annotations: [{}] } }), /invalid id/);
});

test('v2 structured settings retain advanced values while current legacy controls remain authoritative', () => {
  const project = core.createProject({
    mode: 'video', baseMedia: { sourcePath: '/tmp/base.mp4' }, segments: [{ start: 0, end: 1 }],
    bg: 2, bgType: 'preset', frame: 'none', padding: 0, radius: 3, shadow: 60,
    background: { type: 'gradient', value: 'aurora', colors: ['#112233', '#445566'], blur: 12 },
    frameStyle: { type: 'browser', padding: 35, radius: 8, shadow: 90 },
  });
  assert.deepEqual(project.settings.background, { type: 'preset', value: 2, colors: ['#112233', '#445566'], blur: 12 });
  assert.deepEqual(project.settings.frameStyle, { type: 'none', padding: 0, radius: 3, shadow: 60 });
  core.validateProject(project);
  assert.equal(project.settings.background.value, 2);
  assert.equal(project.settings.background.blur, 12);
  assert.equal(project.settings.frameStyle.padding, 0);
});

test('foundation enums normalize unknown values and cursor cap matches the project ceiling', () => {
  const base = { format: 'zoomcut-project', version: 2, baseMedia: { sourcePath: '/tmp/base.mp4' }, state: { segments: [{ start: 0, end: 1 }] } };
  const project = JSON.parse(JSON.stringify({ ...base, settings: {
    cursorSettings: { style: '<script>', clickEffect: 'unknown' },
    background: { type: 'unknown', value: { unsafe: true } }, frameStyle: { type: 'unknown' },
  } }));
  core.validateProject(project);
  assert.equal(project.settings.cursorSettings.style, core.DEFAULT_CURSOR_SETTINGS.style);
  assert.equal(project.settings.cursorSettings.clickEffect, core.DEFAULT_CURSOR_SETTINGS.clickEffect);
  assert.equal(project.settings.background.type, 'preset');
  assert.equal(project.settings.background.value, 0);
  assert.equal(project.settings.frameStyle.type, 'none');
  const tooMany = Array.from({ length: 50001 }, (_, index) => ({ t: index, x: 0, y: 0 }));
  assert.throws(() => core.validateProject({ ...base, state: { segments: [{ start: 0, end: 1 }], cursorPoints: tooMany } }), /too many timeline items/);
});

test('project validation rejects missing media and normalizes unsafe segment values', () => {
  assert.throws(() => core.validateProject({ format: 'zoomcut-project', version: 1, state: { segments: [] } }), /Base media/);
  const project = {
    format: 'zoomcut-project', version: 1, baseMedia: { sourcePath: '/tmp/base.mp4' },
    state: { segments: [{ start: -2, end: 0, speed: 0, lane: -1 }] },
  };
  core.validateProject(project);
  assert.equal(project.state.segments[0].start, 0);
  assert.equal(project.state.segments[0].end, 0.1);
  assert.equal(project.state.segments[0].speed, 0.05);
  assert.equal(project.state.segments[0].lane, 0);
});

test('timeline snapping chooses nearest candidate only inside threshold', () => {
  assert.equal(core.snapTime(4.92, [0, 5, 10], 0.1), 5);
  assert.equal(core.snapTime(4.7, [0, 5, 10], 0.1), 4.7);
});

test('project validation strips dangerous keys and rebuilds media authorization data', () => {
  const project = JSON.parse('{"format":"zoomcut-project","version":1,"baseMedia":{"sourcePath":"/tmp/base.mp4"},"settings":{"aspect":"16:9","constructor":{"polluted":true}},"state":{"segments":[{"start":0,"end":1,"speed":1}],"videoClips":[],"voiceovers":[],"facecams":[],"events":[],"taps":[]},"mediaPaths":[{"path":"/etc/passwd"}]}');
  core.validateProject(project);
  assert.equal(Object.hasOwn(project.settings, 'constructor'), false);
  assert.deepEqual(project.mediaPaths.map(item => item.path), ['/tmp/base.mp4']);
});

test('project validation rejects non-string clip media paths', () => {
  const project = {
    format: 'zoomcut-project', version: 1, baseMedia: { sourcePath: '/tmp/base.mp4' },
    state: { segments: [{ start: 0, end: 1 }], videoClips: [{ sourcePath: { path: '/etc/passwd' } }] },
  };
  assert.throws(() => core.validateProject(project), /invalid media path/);
});
