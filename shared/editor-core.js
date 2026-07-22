(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoomCutCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROJECT_VERSION = 1;
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
      if (item && item.sourcePath) media.push({ id: item.id || kind, kind, name: item.name || '', path: item.sourcePath });
    };
    add(document.baseMedia, 'base');
    for (const clip of document.state?.videoClips || []) add(clip, 'video');
    for (const clip of document.state?.voiceovers || []) add(clip, 'voice');
    for (const clip of document.state?.facecams || []) add(clip, 'camera');
    return media;
  }

  function validateProject(document) {
    if (!document || document.format !== 'zoomcut-project') throw new Error('Not a ZoomCut project');
    if (document.version !== PROJECT_VERSION) throw new Error(`Unsupported project version ${document.version}`);
    if (!document.baseMedia?.sourcePath) throw new Error('Base media is missing');
    if (!Array.isArray(document.state?.segments) || !document.state.segments.length) throw new Error('Timeline is missing');
    for (const segment of document.state.segments) {
      segment.start = Math.max(0, finite(segment.start));
      segment.end = Math.max(segment.start + 0.1, finite(segment.end, segment.start + 0.1));
      segment.speed = Math.max(0.05, finite(segment.speed, 1));
      segment.lane = Math.max(0, Math.floor(finite(segment.lane)));
    }
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
