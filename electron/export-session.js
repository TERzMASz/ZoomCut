'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

function normalizeExt(value) {
  const ext = String(value || 'webm').toLowerCase();
  if (!['webm', 'mp4'].includes(ext)) throw new Error('Unsupported export container');
  return ext;
}

function createExportSessionManager({ consumeTarget, runRemux, cancelRemux, maxBytes = DEFAULT_MAX_BYTES, tempRoot = os.tmpdir() }) {
  const sessions = new Map();

  function getSession(id) {
    const session = sessions.get(String(id || ''));
    if (!session) throw new Error('Export session not found');
    return session;
  }

  function cleanup(session) {
    try { fs.unlinkSync(session.inputPath); } catch {}
    try { fs.unlinkSync(session.outputPart); } catch {}
    try { fs.rmdirSync(session.tempDir); } catch {}
  }

  function begin({ targetId, ext, jobId }) {
    const targetPath = consumeTarget(String(targetId || ''));
    if (!targetPath) throw new Error('Invalid export target');
    const id = crypto.randomBytes(18).toString('hex');
    const safeExt = normalizeExt(ext);
    const safeJobId = String(jobId || id).replace(/[^a-z0-9-]/gi, '') || id;
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'zoomcut-export-stream-'));
    const inputPath = path.join(tempDir, `input.${safeExt}`);
    const outputPart = `${targetPath}.zoomcut-${id}.part.mp4`;
    const stream = fs.createWriteStream(inputPath, { flags: 'wx', mode: 0o600 });
    const session = {
      id, targetPath, inputPath, outputPart, tempDir, stream, jobId: safeJobId,
      bytes: 0, state: 'writing', canceled: false, streamError: null,
    };
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
      await runRemux(session.inputPath, session.outputPart, session.jobId);
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

module.exports = { DEFAULT_MAX_BYTES, MAX_CHUNK_BYTES, normalizeExt, createExportSessionManager };
