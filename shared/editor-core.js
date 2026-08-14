(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoomCutCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROJECT_VERSION = 1;
  const MAX_PROJECT_ARRAY = 50000;
  const MAX_PROJECT_STRING = 16384;
  const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const SETTINGS_FIELDS = [
    'aspect', 'posV', 'bg', 'bgType', 'padding', 'radius', 'shadow', 'frame', 'frameColor',
    'urlText', 'statusBar', 'showTaps', 'defZoom', 'defHold', 'zoomStyle', 'exportScale',
    'timelineZoom', 'videoExportScale', 'camDefaults', 'crop', 'laneSettings',
  ];

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function plainClip(clip) {
    const out = {};
    for (const [key, value] of Object.entries(clip || {})) {
      if (['blob', 'url', 'video', 'audio', 'stream', 'file', 'audioSourceNode', 'gainNode'].includes(key)) continue;
      if (typeof value === 'function' || value === undefined) continue;
      try { out[key] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value; } catch {}
    }
    return out;
  }

  function createProject(state, metadata = {}) {
    const settings = {};
    for (const key of SETTINGS_FIELDS) {
      if (state[key] !== undefined) settings[key] = JSON.parse(JSON.stringify(state[key]));
    }
    const document = {
      format: 'zoomcut-project',
      version: PROJECT_VERSION,
      createdAt: metadata.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseMedia: state.baseMedia ? plainClip(state.baseMedia) : null,
      settings,
      state: {
        mode: state.mode,
        segments: (state.segments || []).map(plainClip),
        videoClips: (state.videoClips || []).map(plainClip),
        events: (state.events || []).map(plainClip),
        taps: (state.taps || []).map(plainClip),
        voiceovers: (state.voiceovers || []).map(plainClip),
        facecams: (state.facecams || []).map(plainClip),
        videoLaneCount: Math.max(1, finite(state.videoLaneCount, 1)),
        voiceLaneCount: Math.max(1, finite(state.voiceLaneCount, 1)),
        cameraLaneCount: Math.max(1, finite(state.cameraLaneCount, 1)),
      },
    };
    document.mediaPaths = collectMediaPaths(document);
    return document;
  }

  function collectMediaPaths(document) {
    const media = [];
    const add = (item, kind) => {
      if (item && typeof item.sourcePath === 'string' && item.sourcePath) {
        media.push({ id: item.id || kind, kind, name: typeof item.name === 'string' ? item.name : '', path: item.sourcePath });
      }
    };
    add(document.baseMedia, 'base');
    for (const clip of document.state?.videoClips || []) add(clip, 'video');
    for (const clip of document.state?.voiceovers || []) add(clip, 'voice');
    for (const clip of document.state?.facecams || []) add(clip, 'camera');
    return media;
  }

  function scrubProjectValue(value, depth = 0) {
    if (depth > 8) throw new Error('Project data is too deeply nested');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Project contains a non-finite number');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_PROJECT_STRING) throw new Error('Project text value is too large');
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_PROJECT_ARRAY) throw new Error('Project contains too many timeline items');
      return value.map(item => scrubProjectValue(item, depth + 1));
    }
    if (!value || typeof value !== 'object') throw new Error('Project contains an unsupported value');
    const entries = Object.entries(value);
    if (entries.length > 256) throw new Error('Project object contains too many fields');
    const out = {};
    for (const [key, item] of entries) {
      if (BLOCKED_KEYS.has(key)) continue;
      out[key] = scrubProjectValue(item, depth + 1);
    }
    return out;
  }

  function requireArray(value, name, max) {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
    if (value.length > max) throw new Error(`${name} contains too many items`);
    return value;
  }

  function validateProject(document) {
    if (!document || document.format !== 'zoomcut-project') throw new Error('Not a ZoomCut project');
    if (document.version !== PROJECT_VERSION) throw new Error(`Unsupported project version ${document.version}`);
    const clean = scrubProjectValue(document);
    for (const key of Object.keys(document)) delete document[key];
    Object.assign(document, clean);
    if (!document.baseMedia?.sourcePath) throw new Error('Base media is missing');
    if (typeof document.baseMedia.sourcePath !== 'string' || document.baseMedia.sourcePath.length > 4096) throw new Error('Base media path is invalid');
    if (!document.state || typeof document.state !== 'object') throw new Error('Project state is missing');
    requireArray(document.state.segments, 'Timeline', 10000);
    if (!document.state.segments.length) throw new Error('Timeline is missing');
    for (const key of ['videoClips', 'voiceovers', 'facecams']) {
      if (document.state[key] === undefined) document.state[key] = [];
      requireArray(document.state[key], key, 1024);
      for (const clip of document.state[key]) {
        if (!clip || typeof clip !== 'object') throw new Error(`${key} contains an invalid clip`);
        if (clip.sourcePath !== undefined && (typeof clip.sourcePath !== 'string' || clip.sourcePath.length > 4096)) {
          throw new Error(`${key} contains an invalid media path`);
        }
      }
    }
    for (const key of ['events', 'taps']) {
      if (document.state[key] === undefined) document.state[key] = [];
      requireArray(document.state[key], key, MAX_PROJECT_ARRAY);
    }
    const settings = {};
    for (const key of SETTINGS_FIELDS) if (document.settings?.[key] !== undefined) settings[key] = document.settings[key];
    document.settings = settings;
    for (const segment of document.state.segments) {
      if (!segment || typeof segment !== 'object') throw new Error('Timeline segment is invalid');
      segment.start = Math.max(0, finite(segment.start));
      segment.end = Math.max(segment.start + 0.1, finite(segment.end, segment.start + 0.1));
      segment.speed = Math.max(0.05, finite(segment.speed, 1));
      segment.lane = Math.max(0, Math.floor(finite(segment.lane)));
    }
    document.mediaPaths = collectMediaPaths(document);
    return document;
  }

  function snapTime(value, candidates, threshold) {
    let best = finite(value);
    let distance = Math.max(0, finite(threshold));
    for (const candidate of candidates || []) {
      const delta = Math.abs(finite(candidate) - value);
      if (delta <= distance) { best = finite(candidate); distance = delta; }
    }
    return best;
  }

  return { PROJECT_VERSION, SETTINGS_FIELDS, plainClip, createProject, collectMediaPaths, validateProject, snapTime };
});
