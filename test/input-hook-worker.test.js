'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { runInputHookWorker, STOP_KEYCODE } = require('../electron/input-hook-worker');

test('input hook worker forwards clicks and stop shortcut over IPC', async () => {
  const hook = new EventEmitter();
  const transport = new EventEmitter();
  const messages = [];
  let started = false;
  let stopped = false;
  let exitCode = null;
  hook.start = () => { started = true; };
  hook.stop = () => { stopped = true; };
  transport.connected = true;
  transport.send = message => messages.push(message);

  runInputHookWorker({ hook, transport, exit: code => { exitCode = code; } });
  assert.equal(started, true);
  assert.deepEqual(messages.shift(), { type: 'ready' });

  hook.emit('mousedown', { x: 321, y: 654 });
  assert.equal(messages[0].type, 'mousedown');
  assert.equal(messages[0].x, 321);
  assert.equal(messages[0].y, 654);
  assert.equal(Number.isFinite(messages[0].wall), true);

  hook.emit('keydown', { keycode: STOP_KEYCODE, ctrlKey: true, metaKey: true });
  assert.deepEqual(messages.at(-1), { type: 'stop-request' });

  transport.emit('message', { type: 'stop' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(messages.at(-1), { type: 'stopped' });
});
