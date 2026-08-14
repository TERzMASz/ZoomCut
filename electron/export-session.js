'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

function normalizeExt(value) {
  const ext = String(value || 'webm').toLowerCase();
  if (!['webm', 'mp4', 'mjpeg'].includes(ext)) throw new Error('Unsupported export container');
  return ext;
}

function freeBytes(target) {
  const stat = fs.statfsSync(target);
  return Number(stat.bavail) * Number(stat.bsize);
}

function cleanupStaleExports(recoveryDir, tempRoot = os.tmpdir()) {
  if (!recoveryDir || !fs.existsSync(recoveryDir)) return 0;
  let cleaned = 0;
  for (const name of fs.readdirSync(recoveryDir).filter(x => /^export-[a-f0-9]+\.json$/.test(x))) {
    const journalPath = path.join(recoveryDir, name);
    try {
      const item = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (item.inputPath && path.resolve(item.inputPath).startsWith(path.resolve(tempRoot) + path.sep)) fs.rmSync(item.inputPath, { force: true });
      if (item.tempDir && path.resolve(item.tempDir).startsWith(path.resolve(tempRoot) + path.sep)) fs.rmSync(item.tempDir, { recursive: true, force: true });
      if (item.outputPart && /\.zoomcut-[a-f0-9]+\.part\.mp4$/.test(item.outputPart)) fs.rmSync(item.outputPart, { force: true });
      cleaned++;
    } catch {}
    fs.rmSync(journalPath, { force: true });
  }
  return cleaned;
}

function createExportSessionManager({ consumeTarget, runRemux, cancelRemux, maxBytes = DEFAULT_MAX_BYTES, tempRoot = os.tmpdir(), recoveryDir, getFreeBytes = freeBytes, reserveBytes = 1024 * 1024 * 1024, diskCheckIntervalBytes = 64 * 1024 * 1024 }) {
  const sessions = new Map();
  if (recoveryDir) fs.mkdirSync(recoveryDir, { recursive: true });
  cleanupStaleExports(recoveryDir, tempRoot);

  function getSession(id) {
    const session = sessions.get(String(id || ''));
    if (!session) throw new Error('Export session not found');
    return session;
  }

  function cleanup(session) {
    try { fs.unlinkSync(session.inputPath); } catch {}
    try { fs.unlinkSync(session.outputPart); } catch {}
    try { fs.rmdirSync(session.tempDir); } catch {}
    if (session.journalPath) try { fs.unlinkSync(session.journalPath); } catch {}
  }

  function begin({ targetId, ext, jobId, estimatedBytes = 0, expectedChunks = 0, fps = 30, width = 0, height = 0, audioPlan = null }) {
    const targetPath = consumeTarget(String(targetId || ''));
    if (!targetPath) throw new Error('Invalid export target');
    const id = crypto.randomBytes(18).toString('hex');
    const safeExt = normalizeExt(ext);
    const safeJobId = String(jobId || id).replace(/[^a-z0-9-]/gi, '') || id;
    const estimate = Math.max(0, Number(estimatedBytes) || 0);
    const required = estimate * 1.3 + reserveBytes;
    if (estimate && (getFreeBytes(tempRoot) < required || getFreeBytes(path.dirname(targetPath)) < required)) {
      throw new Error('Not enough disk space for export');
    }
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'zoomcut-export-stream-'));
    const inputPath = path.join(tempDir, `input.${safeExt}`);
    const outputPart = `${targetPath}.zoomcut-${id}.part.mp4`;
    const stream = fs.createWriteStream(inputPath, { flags: 'wx', mode: 0o600 });
    const journalPath = recoveryDir ? path.join(recoveryDir, `export-${id}.json`) : null;
    const session = {
      id, targetPath, inputPath, outputPart, tempDir, stream, jobId: safeJobId,
      bytes: 0, chunks: 0, nextDiskCheck: diskCheckIntervalBytes, state: 'writing', canceled: false, streamError: null, journalPath,
      ext: safeExt, fps: Math.max(1, Math.min(60, Number(fps) || 30)),
      width: Math.max(0, Number(width) || 0), height: Math.max(0, Number(height) || 0),
      estimatedBytes: estimate, expectedChunks: Math.max(0, Math.floor(Number(expectedChunks) || 0)), audioPlan,
    };
    if (journalPath) fs.writeFileSync(journalPath, JSON.stringify({ inputPath, outputPart, tempDir, createdAt: Date.now() }), { mode: 0o600 });
    stream.on('error', error => { session.streamError = error; });
    sessions.set(id, session);
    return { id };
  }

  async function append(id, value) {
    const session = getSession(id);
    if (session.state !== 'writing' || session.canceled) throw new Error('Export session is not writable');
    if (session.streamError) throw session.streamError;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error('Invalid export chunk');
    const chunk = Buffer.from(value);
    if (!chunk.length) return { bytes: session.bytes };
    if (chunk.length > MAX_CHUNK_BYTES) throw new Error('Export chunk exceeds size limit');
    if (session.bytes + chunk.length > maxBytes) throw new Error('Export exceeds size limit');
    session.bytes += chunk.length;
    session.chunks += 1;
    if (session.bytes >= session.nextDiskCheck) {
      const observedEstimate = session.expectedChunks && session.chunks
        ? session.bytes / session.chunks * session.expectedChunks
        : session.estimatedBytes;
      const projected = Math.max(session.bytes, session.estimatedBytes, observedEstimate || 0);
      const required = Math.max(0, projected - session.bytes) + projected * 0.35 + reserveBytes;
      if (getFreeBytes(tempRoot) < required || getFreeBytes(path.dirname(session.targetPath)) < required) {
        throw new Error('Not enough disk space to continue export');
      }
      session.nextDiskCheck = session.bytes + diskCheckIntervalBytes;
    }
    await new Promise((resolve, reject) => session.stream.write(chunk, error => error ? reject(error) : resolve()));
    return { bytes: session.bytes };
  }

  async function finish(id) {
    const session = getSession(id);
    if (session.state !== 'writing' || session.canceled) throw new Error('Export session cannot be finished');
    session.state = 'closing';
    try {
      await new Promise((resolve, reject) => session.stream.end(error => error ? reject(error) : resolve()));
      if (session.streamError) throw session.streamError;
      if (!session.bytes) throw new Error('Export produced no media data');
      session.state = 'remuxing';
      await runRemux(session.inputPath, session.outputPart, session.jobId, session);
      if (session.canceled) throw new Error('export canceled');
      fs.renameSync(session.outputPart, session.targetPath);
      session.state = 'finished';
      return { ok: true, path: session.targetPath, bytes: session.bytes };
    } finally {
      sessions.delete(session.id);
      cleanup(session);
    }
  }

  async function cancel(id) {
    const session = sessions.get(String(id || ''));
    if (!session) return { ok: true };
    session.canceled = true;
    session.state = 'canceled';
    if (!session.stream.destroyed) session.stream.destroy();
    cancelRemux(session.jobId);
    sessions.delete(session.id);
    cleanup(session);
    return { ok: true };
  }

  async function cancelAll() {
    await Promise.all([...sessions.keys()].map(cancel));
  }

  return { begin, append, finish, cancel, cancelAll, activeCount: () => sessions.size };
}

module.exports = { DEFAULT_MAX_BYTES, MAX_CHUNK_BYTES, normalizeExt, freeBytes, cleanupStaleExports, createExportSessionManager };
