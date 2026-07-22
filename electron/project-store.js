'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_VERSION = 1;
const PROJECT_EXT = '.zoomcut';
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;

function readProject(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) throw new Error('ZoomCut project is too large');
  return validateProject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function validateProject(document) {
  if (!document || typeof document !== 'object') throw new Error('Invalid ZoomCut project');
  if (document.format !== 'zoomcut-project') throw new Error('Not a ZoomCut project');
  if (document.version !== PROJECT_VERSION) throw new Error(`Unsupported ZoomCut project version: ${document.version}`);
  if (!document.state || typeof document.state !== 'object') throw new Error('Project state is missing');
  return document;
}

function missingMedia(document) {
  const paths = document.mediaPaths || [];
  return paths.filter((item) => item && item.path && !fs.existsSync(item.path));
}

function createProjectStore({ userData, dialog }) {
  const autosavePath = path.join(userData, 'recovery', 'autosave.zoomcut');
  const assetsDir = path.join(userData, 'project-assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  let currentProjectPath = null;

  async function save(document) {
    validateProject(document);
    let filePath = currentProjectPath;
    if (!filePath) {
      const result = await dialog.showSaveDialog({
        title: 'Save ZoomCut Project',
        defaultPath: `ZoomCut Project${PROJECT_EXT}`,
        filters: [{ name: 'ZoomCut Project', extensions: ['zoomcut'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      filePath = result.filePath.endsWith(PROJECT_EXT) ? result.filePath : result.filePath + PROJECT_EXT;
    }
    atomicWriteJson(filePath, { ...document, savedAt: new Date().toISOString() });
    currentProjectPath = filePath;
    return { canceled: false, path: filePath };
  }

  async function open() {
    const result = await dialog.showOpenDialog({
      title: 'Open ZoomCut Project',
      properties: ['openFile'],
      filters: [{ name: 'ZoomCut Project', extensions: ['zoomcut'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    const document = readProject(filePath);
    currentProjectPath = filePath;
    return { canceled: false, path: filePath, document, missing: missingMedia(document) };
  }

  function autosave(document) {
    validateProject(document);
    atomicWriteJson(autosavePath, { ...document, autosavedAt: new Date().toISOString() });
    return { ok: true };
  }

  function recovery() {
    if (!fs.existsSync(autosavePath)) return null;
    try {
      const document = readProject(autosavePath);
      return { document, missing: missingMedia(document), path: autosavePath };
    } catch {
      return null;
    }
  }

  function clearRecovery() {
    try { fs.unlinkSync(autosavePath); } catch {}
    return { ok: true };
  }

  function resetCurrent() { currentProjectPath = null; return { ok: true }; }

  function persistAsset(buffer, extension = 'bin') {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    const ext = String(extension).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const filePath = path.join(assetsDir, `${digest}.${ext}`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    return filePath;
  }

  return { save, open, autosave, recovery, clearRecovery, resetCurrent, persistAsset, autosavePath, assetsDir };
}

module.exports = { PROJECT_VERSION, MAX_PROJECT_BYTES, validateProject, missingMedia, atomicWriteJson, readProject, createProjectStore };
