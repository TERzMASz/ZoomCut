(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoomCutShortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The native recording stop binding is intentionally outside this registry.
  // It must keep working when the renderer is busy and must not be replaceable
  // by a project preference or a hostile loaded document.
  const RESERVED_BINDINGS = new Set([
    'Control+Command+S', 'Control+Shift+S', 'Command+S', 'Control+S',
    // KeyboardEvent matching intentionally aliases either primary platform
    // modifier to Mod, including the native recording-stop chord. Reserve the
    // effective forms too so capture cannot bypass the native bindings.
    'Mod+S', 'Mod+Shift+S', 'Alt+F4', 'Command+W', 'Control+W', 'Mod+W',
  ]);
  const KEY_NAMES = {
    ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Escaped: 'Escape',
    Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown',
  };
  const DEFAULT_ACTIONS = [
    ['playPause', 'Space', 'Play / pause', 'เล่น / หยุด'],
    ['split', 'B', 'Split at playhead', 'แบ่งท่อนที่ playhead'],
    ['splitAlt', 'C', 'Split at playhead (alternate)', 'แบ่งท่อนที่ playhead (สำรอง)'],
    ['trimStart', 'I', 'Set in point', 'ตั้งหัวท่อน'],
    ['trimStartAlt', 'Q', 'Trim left to playhead', 'ตัดซ้ายถึง playhead'],
    ['trimEnd', 'O', 'Set out point', 'ตั้งท้ายท่อน'],
    ['trimEndAlt', 'W', 'Trim right to playhead', 'ตัดขวาถึง playhead'],
    ['delete', 'Delete', 'Delete selected item', 'ลบ item ที่เลือก'],
    ['undo', 'Mod+Z', 'Undo', 'ย้อนกลับ'],
    ['duplicate', 'Mod+D', 'Duplicate selected clip', 'ทำสำเนาคลิปที่เลือก'],
    ['redo', 'Shift+Mod+Z', 'Redo', 'ทำซ้ำ'],
    ['seekBack', 'ArrowLeft', 'Seek back 0.1s', 'เลื่อนย้อน 0.1 วิ'],
    ['seekForward', 'ArrowRight', 'Seek forward 0.1s', 'เลื่อนไปข้างหน้า 0.1 วิ'],
    ['seekBackLarge', 'Shift+ArrowLeft', 'Seek back 1s', 'เลื่อนย้อน 1 วิ'],
    ['seekForwardLarge', 'Shift+ArrowRight', 'Seek forward 1s', 'เลื่อนไปข้างหน้า 1 วิ'],
    ['start', 'Home', 'Go to start', 'ไปต้นวิดีโอ'],
    ['end', 'End', 'Go to end', 'ไปท้ายวิดีโอ'],
    ['back', 'J', 'Back', 'ถอย'],
    ['stop', 'K', 'Stop', 'หยุด'],
    ['play', 'L', 'Play', 'เล่น'],
    ['selectPrev', 'ArrowUp', 'Select previous segment', 'เลือกท่อนก่อนหน้า'],
    ['selectPrevAlt', '[', 'Select previous segment (alternate)', 'เลือกท่อนก่อนหน้า (สำรอง)'],
    ['selectNext', 'ArrowDown', 'Select next segment', 'เลือกท่อนถัดไป'],
    ['selectNextAlt', ']', 'Select next segment (alternate)', 'เลือกท่อนถัดไป (สำรอง)'],
    ['selectCurrent', 'A', 'Select current segment', 'เลือกท่อนปัจจุบัน'],
    ['clearSelection', 'V', 'Clear selection', 'ล้าง selection'],
    ['timelineZoomIn', 'Mod+=', 'Zoom timeline in', 'ขยาย timeline'],
    ['timelineZoomOut', 'Mod+-', 'Zoom timeline out', 'ย่อ timeline'],
    ['timelineFit', 'Shift+Z', 'Fit timeline', 'พอดี timeline'],
    ['voiceOver', 'R', 'Start / stop voice over', 'เริ่ม / หยุด voice over'],
    ['shortcutHelp', '?', 'Show keyboard shortcuts', 'เปิดหน้าคีย์ลัด'],
  ].map(([actionId, defaultBinding, label, labelTh]) => ({
    actionId, defaultBinding, label: { en: label, th: labelTh }, THENabled: true,
    context: 'editor', run: null,
  }));

  function normalizeKey(key) {
    const raw = KEY_NAMES[String(key)] || String(key);
    if (/^Key[A-Z]$/.test(raw)) return raw.slice(3);
    if (/^Digit[0-9]$/.test(raw)) return raw.slice(5);
    if (raw.length === 1) return raw.toUpperCase();
    return raw;
  }

  function normalizeBinding(binding) {
    if (typeof binding !== 'string') return null;
    const parts = binding.split('+').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    let mod = false, control = false, command = false, alt = false, shift = false;
    let key = null;
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'mod' || lower === 'commandorcontrol' || lower === 'cmdorctrl') mod = true;
      else if (lower === 'control' || lower === 'ctrl') control = true;
      else if (lower === 'command' || lower === 'cmd' || lower === 'meta') command = true;
      else if (lower === 'alt' || lower === 'option') alt = true;
      else if (lower === 'shift') shift = true;
      else if (key === null) key = normalizeKey(part);
      else return null;
    }
    if (!key) return null;
    if (mod) { control = false; command = false; }
    return [command ? 'Command' : control ? 'Control' : mod ? 'Mod' : '', alt ? 'Alt' : '', shift ? 'Shift' : '', key]
      .filter(Boolean).join('+');
  }

  function bindingForEvent(event) {
    if (!event) return null;
    const key = normalizeKey(event.key || event.code || '');
    if (!key) return null;
    const modifiers = [];
    if (event.metaKey || event.ctrlKey) modifiers.push('Mod');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey && key !== '?') modifiers.push('Shift');
    return normalizeBinding([...modifiers, key].join('+'));
  }

  function matchesBinding(binding, event) {
    return normalizeBinding(binding) === bindingForEvent(event);
  }

  function isTypingTarget(element) {
    return Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
      || element.tagName === 'SELECT' || element.isContentEditable));
  }

  function isReserved(binding) {
    const normalized = normalizeBinding(binding);
    return normalized ? RESERVED_BINDINGS.has(normalized) : false;
  }

  function definitionsWithDefaults(definitions = DEFAULT_ACTIONS) {
    return definitions.map(item => ({ ...item, label: { ...(item.label || {}) } }));
  }

  function createShortcutRegistry({ storage, storageKey = 'zoomcut-shortcuts-v1', definitions = DEFAULT_ACTIONS } = {}) {
    const defs = definitionsWithDefaults(definitions);
    const byId = new Map(defs.map(item => [item.actionId, item]));
    let custom = {};
    const read = () => {
      try {
        const parsed = JSON.parse(storage?.getItem?.(storageKey) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
      } catch { return {}; }
    };
    const persist = () => { try { storage?.setItem?.(storageKey, JSON.stringify(custom)); } catch {} };
    const validCustom = value => {
      const result = {};
      for (const [actionId, binding] of Object.entries(value || {})) {
        if (!byId.has(actionId)) continue;
        const normalized = normalizeBinding(binding);
        if (!normalized || isReserved(normalized)) continue;
        result[actionId] = normalized;
      }
      // localStorage is untrusted and can outlive changes to the defaults.
      // Resolve collisions against the complete effective registry, not only
      // against other custom entries. Prefer an unchanged default owner; when
      // custom entries collide with each other, keep the first definition.
      let changed = true;
      while (changed) {
        changed = false;
        const groups = new Map();
        for (const definition of defs) {
          const binding = result[definition.actionId] || normalizeBinding(definition.defaultBinding);
          if (!groups.has(binding)) groups.set(binding, []);
          groups.get(binding).push(definition.actionId);
        }
        for (const ids of groups.values()) {
          if (ids.length < 2) continue;
          const defaultOwners = ids.filter(actionId => !Object.hasOwn(result, actionId));
          const removals = defaultOwners.length ? ids.filter(actionId => Object.hasOwn(result, actionId)) : ids.slice(1);
          for (const actionId of removals) { delete result[actionId]; changed = true; }
        }
      }
      return result;
    };
    custom = validCustom(read());
    const binding = actionId => custom[actionId] || byId.get(actionId)?.defaultBinding || null;
    const all = () => defs.map(item => ({ ...item, binding: binding(item.actionId) }));
    const conflicts = (actionId, nextBinding) => {
      const normalized = normalizeBinding(nextBinding);
      if (!normalized) return { ok: false, reason: 'invalid' };
      if (isReserved(normalized)) return { ok: false, reason: 'reserved' };
      const existing = all().find(item => item.actionId !== actionId && normalizeBinding(item.binding) === normalized);
      return existing ? { ok: false, reason: 'conflict', actionId: existing.actionId } : { ok: true, binding: normalized };
    };
    return {
      definitions: defs,
      list: all,
      get: binding,
      find: event => all().filter(item => item.THEnabled !== false && matchesBinding(item.binding, event)),
      set(actionId, nextBinding) {
        if (!byId.has(actionId)) throw new Error('Unknown shortcut action');
        const result = conflicts(actionId, nextBinding);
        if (!result.ok) { const error = new Error(`Shortcut binding ${result.reason}`); error.code = `SHORTCUT_${result.reason.toUpperCase()}`; throw error; }
        custom[actionId] = result.binding;
        persist();
        return result.binding;
      },
      reset(actionId) { if (actionId) delete custom[actionId]; else custom = {}; persist(); return all(); },
      conflicts,
      isReserved,
      matches: matchesBinding,
      isTypingTarget,
    };
  }

  return { DEFAULT_ACTIONS, RESERVED_BINDINGS, normalizeBinding, bindingForEvent, matchesBinding, isTypingTarget, isReserved, createShortcutRegistry };
});
