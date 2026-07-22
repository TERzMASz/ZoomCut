'use strict';

function parseOrientation(text) {
  const match = String(text || '').match(/(?:SurfaceOrientation|mCurrentOrientation)\s*[:=]\s*([0-3])/i);
  return match ? Number(match[1]) : 0;
}

function rotateNormalized(x, y, orientation) {
  x = Math.max(0, Math.min(1, Number(x) || 0));
  y = Math.max(0, Math.min(1, Number(y) || 0));
  if (orientation === 1) return { x: y, y: 1 - x };
  if (orientation === 2) return { x: 1 - x, y: 1 - y };
  if (orientation === 3) return { x: 1 - y, y: x };
  return { x, y };
}

function createTouchParser({ xMax, yMax, orientation = () => 0, onTouch }) {
  let curX = null, curY = null, touching = false, began = false;
  return function parse(line) {
    const match = String(line).match(/:\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]{4})\s+([0-9a-fA-F]+)/);
    if (!match) return;
    const type = parseInt(match[1], 16), code = parseInt(match[2], 16);
    let value = parseInt(match[3], 16);
    if (value > 0x7fffffff) value -= 0x100000000;
    if (type === 3 && code === 0x35) curX = value;
    if (type === 3 && code === 0x36) curY = value;
    if (type === 1 && code === 0x14a) { if (value === 1 && !touching) began = true; touching = value === 1; }
    if (type === 3 && code === 0x39) { if (value >= 0 && !touching) began = true; touching = value >= 0; }
    if (type === 0 && code === 0 && began && touching && curX !== null && curY !== null) {
      began = false;
      onTouch(rotateNormalized(curX / Math.max(1, xMax), curY / Math.max(1, yMax), orientation()));
    }
  };
}

module.exports = { parseOrientation, rotateNormalized, createTouchParser };
