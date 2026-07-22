'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createApiToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function safeStaticPath(root, requestPath) {
  const decoded = decodeURIComponent(requestPath || '');
  const candidate = path.resolve(root, '.' + path.sep + decoded.replace(/^[/\\]+/, ''));
  return isPathInside(root, candidate) ? candidate : null;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        const error = new Error('invalid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function streamRequestToFile(req, target, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      output.once('close', () => fs.unlink(target, () => reject(error)));
      output.destroy();
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('export exceeds size limit');
        error.statusCode = 413;
        fail(error);
        req.destroy();
      }
    });
    req.on('aborted', () => fail(new Error('request aborted')));
    req.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
    req.pipe(output);
  });
}

function normalizeRecordingOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid recording options');
  const allowed = new Set(['screenIndex', 'windowId', 'androidSerial']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown recording option: ${key}`);
  const selected = [...allowed].filter(key => value[key] !== undefined && value[key] !== null && value[key] !== '');
  if (selected.length > 1) throw new Error('choose exactly one recording source');
  if (value.screenIndex !== undefined) {
    const screenIndex = Number(value.screenIndex);
    if (!Number.isSafeInteger(screenIndex) || screenIndex < 1 || screenIndex > 32) throw new Error('invalid screen index');
    return { screenIndex };
  }
  if (value.windowId !== undefined) {
    const windowId = Number(value.windowId);
    if (!Number.isSafeInteger(windowId) || windowId < 1) throw new Error('invalid window id');
    return { windowId };
  }
  if (value.androidSerial !== undefined) {
    const androidSerial = String(value.androidSerial);
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(androidSerial)) throw new Error('invalid Android serial');
    return { androidSerial };
  }
  return {};
}

module.exports = { createApiToken, isPathInside, safeStaticPath, readJsonBody, streamRequestToFile, normalizeRecordingOptions };
