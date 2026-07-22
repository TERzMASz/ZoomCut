'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOrientation, rotateNormalized, createTouchParser } = require('../electron/android-tracking');

test('Android orientation parsing and coordinate rotation are deterministic', () => {
  assert.equal(parseOrientation('SurfaceOrientation: 3'), 3);
  assert.deepEqual(rotateNormalized(0.2, 0.7, 1), { x: 0.7, y: 0.8 });
  assert.deepEqual(rotateNormalized(0.2, 0.7, 3), { x: 0.30000000000000004, y: 0.2 });
});

test('Android touch parser emits one normalized touch on SYN_REPORT', () => {
  const touches = [];
  const parse = createTouchParser({ xMax: 1000, yMax: 2000, orientation: () => 1, onTouch: point => touches.push(point) });
  parse('/dev/input/event2: 0003 0035 000001f4');
  parse('/dev/input/event2: 0003 0036 000001f4');
  parse('/dev/input/event2: 0003 0039 00000001');
  parse('/dev/input/event2: 0000 0000 00000000');
  assert.deepEqual(touches, [{ x: 0.25, y: 0.5 }]);
});
