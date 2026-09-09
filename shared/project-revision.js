(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoomCutRevision = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SAVE_STATES = new Set(['clean', 'modified', 'autosaving', 'autosaved', 'error']);

  function createRevisionState(value = {}) {
    const revision = Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
    const savedRevision = Number.isSafeInteger(value.savedRevision) && value.savedRevision >= 0 ? value.savedRevision : 0;
    const autosavedRevision = Number.isSafeInteger(value.autosavedRevision) && value.autosavedRevision >= 0 ? value.autosavedRevision : 0;
    const saveState = SAVE_STATES.has(value.saveState) ? value.saveState : (revision === savedRevision ? 'clean' : 'modified');
    return { revision, savedRevision, autosavedRevision, saveState };
  }

  function isModified(value) {
    const state = createRevisionState(value);
    return state.revision !== state.savedRevision;
  }

  function markModified(value) {
    const state = createRevisionState(value);
    state.revision += 1;
    state.saveState = 'modified';
    return state;
  }

  function beginAutosave(value) {
    const state = createRevisionState(value);
    state.saveState = 'autosaving';
    return state;
  }

  function finishAutosave(value, revision = value?.revision) {
    const state = createRevisionState(value);
    if (Number.isSafeInteger(revision) && revision >= 0) state.autosavedRevision = Math.max(state.autosavedRevision, revision);
    // Autosave is recovery only: it never advances savedRevision and therefore
    // must not make the explicit .zoomcut close prompt disappear.
    state.saveState = state.revision === state.savedRevision ? 'clean'
      : state.revision === state.autosavedRevision ? 'autosaved' : 'modified';
    return state;
  }

  function failSave(value) {
    const state = createRevisionState(value);
    state.saveState = 'error';
    return state;
  }

  function finishExplicitSave(value, revision = value?.revision) {
    const state = createRevisionState(value);
    const target = Number.isSafeInteger(revision) && revision >= 0 ? revision : state.revision;
    state.savedRevision = Math.max(state.savedRevision, target);
    state.autosavedRevision = Math.max(state.autosavedRevision, target);
    state.saveState = state.revision === state.savedRevision ? 'clean' : 'modified';
    return state;
  }

  function resetRevision(value = {}) {
    const state = createRevisionState(value);
    state.revision = 0;
    state.savedRevision = 0;
    state.autosavedRevision = 0;
    state.saveState = 'clean';
    return state;
  }

  return { SAVE_STATES, createRevisionState, isModified, markModified, beginAutosave, finishAutosave, finishExplicitSave, failSave, resetRevision };
});
