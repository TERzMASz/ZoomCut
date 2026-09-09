(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoomCutCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Version 2 adds the editor foundation fields without changing the legacy
  // timeline shape.  v1 documents are migrated in-memory before validation,
  // then every newly saved document is emitted as v2.
  const PROJECT_VERSION = 2;
  const LEGACY_PROJECT_VERSION = 1;
  const MAX_PROJECT_ARRAY = 50000;
  const MAX_PROJECT_STRING = 16384;
  const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const SETTINGS_FIELDS = [
    'aspect', 'posV', 'bg', 'bgType', 'padding', 'radius', 'shadow', 'frame', 'frameColor',
    'urlText', 'statusBar', 'showTaps', 'defZoom', 'defHold', 'zoomStyle', 'exportScale',
    'timelineZoom', 'videoExportScale', 'camDefaults', 'crop', 'laneSettings',
    'cursorSettings', 'shortcuts', 'background', 'frameStyle',
  ];
  // Keep this aligned with scrubProjectValue's generic array ceiling so the
  // field-specific error and the documented recording cap cannot disagree.
  const MAX_CURSOR_POINTS = MAX_PROJECT_ARRAY;
  const MAX_ANNOTATIONS = 10000;
  const MAX_SHORTCUTS = 64;
  const CURSOR_STYLES = new Set(['soft', 'outline', 'classic', 'shadow', 'solid', 'dot', 'pointer']);
  const CLICK_EFFECTS = new Set(['none', 'ripple', 'ring', 'pulse', 'target']);
  const BACKGROUND_TYPES = new Set(['preset', 'custom', 'image', 'transparent', 'color', 'gradient']);
  const FRAME_TYPES = new Set(['none', 'iphone', 'browser']);
  const ANNOTATION_TYPES = new Set(['text', 'arrow', 'rectangle', 'highlight', 'blur']);
  const DEFAULT_CURSOR_SETTINGS = Object.freeze({
    enabled: true,
    style: 'soft',
    size: 1,
    smoothing: 0.65,
    clickEffect: 'ripple',
    clickBounce: 1,
    bounceDurationMs: 350,
    sway: 0,
  });
  // Cursor timelines are replaced as a unit by capture/import/project restore.
  // Cache their sanitized ordering so preview and offline export do not rebuild
  // and sort as many as 50,000 samples on every rendered frame. WeakMap keeps
  // the cache tied to the timeline lifetime rather than retaining projects.
  const cursorSampleCache = new WeakMap();

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

  function defaultCursorSettings(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      enabled: input.enabled === undefined ? DEFAULT_CURSOR_SETTINGS.enabled : Boolean(input.enabled),
      style: CURSOR_STYLES.has(input.style) ? input.style : DEFAULT_CURSOR_SETTINGS.style,
      size: clampNumber(input.size, 0.25, 4, DEFAULT_CURSOR_SETTINGS.size),
      smoothing: clampNumber(input.smoothing, 0, 1, DEFAULT_CURSOR_SETTINGS.smoothing),
      clickEffect: CLICK_EFFECTS.has(input.clickEffect) ? input.clickEffect : DEFAULT_CURSOR_SETTINGS.clickEffect,
      clickBounce: clampNumber(input.clickBounce, 0, 4, DEFAULT_CURSOR_SETTINGS.clickBounce),
      bounceDurationMs: clampNumber(input.bounceDurationMs, 80, 2000, DEFAULT_CURSOR_SETTINGS.bounceDurationMs),
      sway: clampNumber(input.sway, 0, 2, DEFAULT_CURSOR_SETTINGS.sway),
    };
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function defaultBackground(value, legacy = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const type = BACKGROUND_TYPES.has(input.type) ? input.type
      : (BACKGROUND_TYPES.has(legacy.bgType) ? legacy.bgType : 'preset');
    const rawValue = input.value === undefined ? (legacy.bg === undefined ? 0 : legacy.bg) : input.value;
    const safeValue = typeof rawValue === 'string' || typeof rawValue === 'number' || rawValue === null ? rawValue : 0;
    const colors = Array.isArray(input.colors)
      ? input.colors.slice(0, 4).filter(color => typeof color === 'string' && color.length <= 64)
      : [];
    const out = { type, value: safeValue, colors, blur: clampNumber(input.blur, 0, 100, 0) };
    if (typeof input.color === 'string' && input.color.length <= 64) out.color = input.color;
    return out;
  }

  function defaultFrameStyle(value, legacy = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value)
      ? value : (typeof value === 'string' ? { type: value } : {});
    return {
      type: FRAME_TYPES.has(input.type) ? input.type : (FRAME_TYPES.has(legacy.frame) ? legacy.frame : 'none'),
      padding: clampNumber(input.padding, 0, 100, clampNumber(legacy.padding, 0, 100, 0)),
      radius: clampNumber(input.radius, 0, 50, clampNumber(legacy.radius, 0, 50, 3)),
      shadow: clampNumber(input.shadow, 0, 100, clampNumber(legacy.shadow, 0, 100, 60)),
    };
  }

  function migrateProject(document) {
    if (!document || document.version !== LEGACY_PROJECT_VERSION) return document;
    const settings = { ...(document.settings || {}) };
    const state = { ...(document.state || {}) };
    // Keep old settings as the source of truth while exposing the names used
    // by the new inspector.  This is intentionally additive for old runtimes.
    if (settings.cursorSettings === undefined) settings.cursorSettings = defaultCursorSettings();
    if (settings.shortcuts === undefined) settings.shortcuts = {};
    settings.background = defaultBackground(settings.background, settings);
    settings.frameStyle = defaultFrameStyle(settings.frameStyle, settings);
    if (state.cursorPoints === undefined) state.cursorPoints = [];
    if (state.annotations === undefined) state.annotations = [];
    if (state.annotationLaneCount === undefined) state.annotationLaneCount = 1;
    return { ...document, version: PROJECT_VERSION, settings, state };
  }

  function createProject(state, metadata = {}) {
    const settings = {};
    for (const key of SETTINGS_FIELDS) {
      if (state[key] !== undefined) settings[key] = JSON.parse(JSON.stringify(state[key]));
    }
    if (settings.cursorSettings === undefined) settings.cursorSettings = defaultCursorSettings();
    if (settings.shortcuts === undefined) settings.shortcuts = {};
    // During the M1 transition the live renderer still edits legacy fields.
    // Merge those active values into the v2 structures while retaining v2-only
    // properties such as blur/colors; later inspectors must update both views.
    settings.background = defaultBackground({
      ...(settings.background && typeof settings.background === 'object' ? settings.background : {}),
      ...(state.bgType === undefined ? {} : { type: state.bgType }),
      ...(state.bg === undefined ? {} : { value: state.bg }),
    }, state);
    settings.frameStyle = defaultFrameStyle({
      ...(settings.frameStyle && typeof settings.frameStyle === 'object' ? settings.frameStyle : {}),
      ...(state.frame === undefined ? {} : { type: state.frame }),
      ...(state.padding === undefined ? {} : { padding: state.padding }),
      ...(state.radius === undefined ? {} : { radius: state.radius }),
      ...(state.shadow === undefined ? {} : { shadow: state.shadow }),
    }, state);
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
        cursorPoints: (state.cursorPoints || []).map(plainClip),
        annotations: (state.annotations || []).map(plainClip),
        annotationLaneCount: Math.max(1, finite(state.annotationLaneCount, 1)),
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

  function validateCursorSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cursorSettings must be an object');
    return defaultCursorSettings(value);
  }

  function validateShortcuts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shortcuts must be an object');
    const normalized = {};
    const entries = Object.entries(value);
    if (entries.length > MAX_SHORTCUTS) throw new Error('shortcuts contains too many bindings');
    for (const [action, binding] of entries) {
      if (!/^[a-z][a-zA-Z0-9._-]{0,63}$/.test(action) || typeof binding !== 'string' || binding.length > 128) {
        throw new Error('shortcuts contains an invalid binding');
      }
      normalized[action] = binding;
    }
    return normalized;
  }

  function validateCursorPoints(value) {
    requireArray(value, 'cursorPoints', MAX_CURSOR_POINTS);
    cursorSampleCache.delete(value);
    for (const point of value) {
      if (!point || typeof point !== 'object' || Array.isArray(point)) throw new Error('cursorPoints contains an invalid point');
      point.t = Math.max(0, finite(point.t));
      point.x = clampNumber(point.x, 0, 1, 0);
      point.y = clampNumber(point.y, 0, 1, 0);
      if (point.id !== undefined && (typeof point.id !== 'string' && typeof point.id !== 'number')) {
        throw new Error('cursorPoints contains an invalid id');
      }
      if (point.kind !== undefined && (typeof point.kind !== 'string' || point.kind.length > 32)) {
        throw new Error('cursorPoints contains an invalid kind');
      }
    }
    return value;
  }

  function validateAnnotations(value) {
    requireArray(value, 'annotations', MAX_ANNOTATIONS);
    for (const annotation of value) {
      if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
        throw new Error('annotations contains an invalid annotation');
      }
      if (typeof annotation.id !== 'string' && typeof annotation.id !== 'number') {
        throw new Error('annotations contains an invalid id');
      }
      if (!ANNOTATION_TYPES.has(annotation.type)) {
        throw new Error('annotations contains an invalid type');
      }
      annotation.start = Math.max(0, finite(annotation.start));
      annotation.duration = Math.max(0.05, finite(annotation.duration,
        annotation.end === undefined ? 3 : finite(annotation.end) - annotation.start));
      delete annotation.end;
      annotation.lane = Math.max(0, Math.min(31, Math.floor(finite(annotation.lane, 0))));
      annotation.coordinateSpace = 'source';
      for (const key of ['x', 'y', 'x2', 'y2']) {
        if (annotation[key] !== undefined) annotation[key] = clampNumber(annotation[key], 0, 1, 0);
      }
      for (const key of ['width', 'height']) {
        if (annotation[key] !== undefined) annotation[key] = clampNumber(annotation[key], 0, 1, 0);
      }
      for (const key of ['text', 'color', 'fontFamily']) {
        if (annotation[key] !== undefined && (typeof annotation[key] !== 'string' || annotation[key].length > MAX_PROJECT_STRING)) {
          throw new Error(`annotations contains an invalid ${key}`);
        }
      }
    }
    return value;
  }

  function validateProject(document) {
    if (!document || document.format !== 'zoomcut-project') throw new Error('Not a ZoomCut project');
    if (document.version !== PROJECT_VERSION && document.version !== LEGACY_PROJECT_VERSION) {
      throw new Error(`Unsupported project version ${document.version}`);
    }
    const clean = migrateProject(scrubProjectValue(document));
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
    if (document.state.cursorPoints === undefined) document.state.cursorPoints = [];
    if (document.state.annotations === undefined) document.state.annotations = [];
    document.state.annotationLaneCount = Math.max(1, Math.min(32, Math.floor(finite(document.state.annotationLaneCount, 1))));
    validateCursorPoints(document.state.cursorPoints);
    validateAnnotations(document.state.annotations);
    const settings = {};
    for (const key of SETTINGS_FIELDS) if (document.settings?.[key] !== undefined) settings[key] = document.settings[key];
    document.settings = settings;
    if (document.settings.cursorSettings === undefined) document.settings.cursorSettings = defaultCursorSettings();
    if (document.settings.shortcuts === undefined) document.settings.shortcuts = {};
    document.settings.background = defaultBackground(document.settings.background, document.settings);
    document.settings.frameStyle = defaultFrameStyle(document.settings.frameStyle, document.settings);
    document.settings.cursorSettings = validateCursorSettings(document.settings.cursorSettings);
    document.settings.shortcuts = validateShortcuts(document.settings.shortcuts || {});
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

  // Resolve a normalized cursor sample at a source time without mutating the
  // recording.  Recorders can pause while the OS is busy, so a large sample
  // gap is treated as a held cursor followed by a short fade instead of an
  // implausibly fast diagonal jump.  The binary search keeps preview/export
  // deterministic and bounded for long recordings.
  function cursorAt(points, sourceTime, smoothing = 0.65) {
    if (!Array.isArray(points)) return null;
    let samples = cursorSampleCache.get(points);
    if (!samples) {
      samples = points
        .map((point, index) => ({
          t: finite(point?.t, NaN),
          x: clampNumber(point?.x, 0, 1, NaN),
          y: clampNumber(point?.y, 0, 1, NaN),
          index,
        }))
        .filter(point => Number.isFinite(point.t) && Number.isFinite(point.x) && Number.isFinite(point.y))
        .sort((a, b) => a.t - b.t || a.index - b.index);
      cursorSampleCache.set(points, samples);
    }
    if (!samples.length) return null;
    const time = finite(sourceTime, samples[0].t);
    const smooth = clampNumber(smoothing, 0, 1, 0.65);
    const holdWindow = 0.5;
    const fadeWindow = 0.42 + smooth * 0.18;
    const point = (sample, opacity = 1) => ({
      x: clampNumber(sample.x, 0, 1, 0),
      y: clampNumber(sample.y, 0, 1, 0),
      opacity: clampNumber(opacity, 0, 1, 0),
    });
    if (time <= samples[0].t) return point(samples[0]);
    if (time >= samples[samples.length - 1].t) {
      const last = samples[samples.length - 1];
      const gap = time - last.t;
      return point(last, gap <= holdWindow ? 1 : 1 - Math.min(1, (gap - holdWindow) / fadeWindow));
    }
    let lo = 0, hi = samples.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= time) lo = mid;
      else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    const span = Math.max(0, b.t - a.t);
    if (!span) return point(b);
    const gap = time - a.t;
    if (span > 1.2) {
      return point(a, gap <= holdWindow ? 1 : 1 - Math.min(1, (gap - holdWindow) / fadeWindow));
    }
    const raw = clampNumber(gap / span, 0, 1, 0);
    const eased = raw * raw * (3 - 2 * raw);
    const mix = raw + (eased - raw) * smooth;
    return {
      x: clampNumber(a.x + (b.x - a.x) * mix, 0, 1, 0),
      y: clampNumber(a.y + (b.y - a.y) * mix, 0, 1, 0),
      opacity: 1,
    };
  }

  return {
    PROJECT_VERSION, LEGACY_PROJECT_VERSION, SETTINGS_FIELDS, DEFAULT_CURSOR_SETTINGS,
    plainClip, createProject, collectMediaPaths, migrateProject, validateProject, snapTime, cursorAt,
  };
});
