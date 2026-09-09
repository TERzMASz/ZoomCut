'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const editorCore = require('../shared/editor-core');

const PROJECT_VERSION = editorCore.PROJECT_VERSION;
const PROJECT_EXT = '.zoomcut';
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_DIRECT_ASSET_BYTES = MAX_ASSET_CHUNK_BYTES;
const MAX_ASSET_BYTES = 20 * 1024 * 1024 * 1024;

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
  return editorCore.validateProject(document);
}

function projectMediaPaths(document) {
  return editorCore.collectMediaPaths(document).map(item => item.path).filter(item => typeof item === 'string' && item);
}

function missingMedia(document) {
  const paths = document.mediaPaths || [];
  return paths.filter((item) => item && item.path && !fs.existsSync(item.path));
}

function createProjectStore({ userData, dialog }) {
  const autosavePath = path.join(userData, 'recovery', 'autosave.zoomcut');
  const assetsDir = path.join(userData, 'project-assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const name of fs.readdirSync(assetsDir).filter(name => /^\.recording-[a-f0-9]+\.part$/.test(name))) {
    try { fs.unlinkSync(path.join(assetsDir, name)); } catch {}
  }
  let currentProjectPath = null;
  const assetWrites = new Map();

  async function save(document) {
    document = validateProject(document);
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
    document = validateProject(document);
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
    if (buffer.length > MAX_DIRECT_ASSET_BYTES) throw new Error('Recorded media asset exceeds direct-write size limit');
    const ext = String(extension).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const filePath = path.join(assetsDir, `${digest}.${ext}`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    return filePath;
  }

  function beginAsset(extension = 'webm') {
    const ext = String(extension).replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!['webm', 'm4a', 'mp4', 'mov', 'wav', 'ogg'].includes(ext)) throw new Error('Unsupported recorded media type');
    const id = crypto.randomBytes(18).toString('hex');
    const tempPath = path.join(assetsDir, `.recording-${id}.part`);
    const stream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    const session = { id, ext, tempPath, stream, bytes: 0, nextDiskCheck: 64 * 1024 * 1024, hash: crypto.createHash('sha256'), error: null };
    stream.on('error', error => { session.error = error; });
    assetWrites.set(id, session);
    return { id };
  }

  async function appendAsset(id, value) {
    const session = assetWrites.get(String(id || ''));
    if (!session) throw new Error('Recorded media session not found');
    if (session.error) throw session.error;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error('Invalid recorded media chunk');
    const chunk = Buffer.from(value);
    if (chunk.length > MAX_ASSET_CHUNK_BYTES) throw new Error('Recorded media chunk exceeds size limit');
    if (session.bytes + chunk.length > MAX_ASSET_BYTES) throw new Error('Recorded media exceeds size limit');
    if (!chunk.length) return { bytes: session.bytes };
    session.bytes += chunk.length;
    if (session.bytes >= session.nextDiskCheck) {
      const disk = fs.statfsSync(assetsDir);
      const available = Number(disk.bavail) * Number(disk.bsize);
      if (available < 512 * 1024 * 1024) throw new Error('Not enough disk space to continue recording voice or camera');
      session.nextDiskCheck = session.bytes + 64 * 1024 * 1024;
    }
    session.hash.update(chunk);
    await new Promise((resolve, reject) => session.stream.write(chunk, error => error ? reject(error) : resolve()));
    return { bytes: session.bytes };
  }

  async function finishAsset(id) {
    const session = assetWrites.get(String(id || ''));
    if (!session) throw new Error('Recorded media session not found');
    assetWrites.delete(session.id);
    try {
      await new Promise((resolve, reject) => session.stream.end(error => error ? reject(error) : resolve()));
      if (session.error) throw session.error;
      if (!session.bytes) throw new Error('Recorded media is empty');
      const filePath = path.join(assetsDir, `${session.hash.digest('hex')}.${session.ext}`);
      if (fs.existsSync(filePath)) fs.unlinkSync(session.tempPath);
      else fs.renameSync(session.tempPath, filePath);
      return filePath;
    } catch (error) {
      try { fs.unlinkSync(session.tempPath); } catch {}
      throw error;
    }
  }

  function cancelAsset(id) {
    const session = assetWrites.get(String(id || ''));
    if (!session) return { ok: true };
    assetWrites.delete(session.id);
    session.stream.destroy();
    try { fs.unlinkSync(session.tempPath); } catch {}
    return { ok: true };
  }

  function cancelAllAssets() {
    for (const id of [...assetWrites.keys()]) cancelAsset(id);
  }

  return { save, open, autosave, recovery, clearRecovery, resetCurrent, persistAsset, beginAsset, appendAsset, finishAsset, cancelAsset, cancelAllAssets, autosavePath, assetsDir };
}

module.exports = { PROJECT_VERSION, MAX_PROJECT_BYTES, MAX_ASSET_CHUNK_BYTES, MAX_DIRECT_ASSET_BYTES, MAX_ASSET_BYTES, validateProject, projectMediaPaths, missingMedia, atomicWriteJson, readProject, createProjectStore };
