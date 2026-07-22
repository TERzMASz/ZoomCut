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
  assert.equal(project.version, 1);
  assert.equal(project.baseMedia.url, undefined);
  assert.equal(project.state.videoClips[0].video, undefined);
  assert.equal(project.state.voiceovers[0].blob, undefined);
  assert.deepEqual(project.mediaPaths.map(x => x.kind), ['base', 'video', 'voice']);
  assert.equal(core.validateProject(project), project);
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
