'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { runInputHookWorker, STOP_KEYCODE, MOVE_INTERVAL_MS } = require('../electron/input-hook-worker');

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
  assert.deepEqual(messages[0], { type: 'activity' });
  assert.equal(messages[1].type, 'mousedown');
  assert.equal(messages[1].x, 321);
  assert.equal(messages[1].y, 654);
  assert.equal(Number.isFinite(messages[1].wall), true);

  hook.emit('keydown', { keycode: STOP_KEYCODE, ctrlKey: true, metaKey: true });
  assert.deepEqual(messages.at(-1), { type: 'stop-request' });

  transport.emit('message', { type: 'stop' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(messages.at(-1), { type: 'stopped' });
});

test('input hook worker throttles pointer movement to 30Hz while keeping clicks immediate', () => {
  const hook = new EventEmitter();
  const transport = new EventEmitter();
  const messages = [];
  let wall = 1000;
  hook.start = () => {};
  hook.stop = () => {};
  transport.connected = true;
  transport.send = message => messages.push(message);
  runInputHookWorker({ hook, transport, now: () => wall, exit: () => {} });
  messages.length = 0;
  hook.emit('mousemove', { x: 10, y: 20 });
  wall += MOVE_INTERVAL_MS / 2;
  hook.emit('mousemove', { x: 11, y: 21 });
  wall += MOVE_INTERVAL_MS;
  hook.emit('mousemove', { x: 12, y: 22 });
  const moves = messages.filter(message => message.type === 'mousemove');
  assert.equal(moves.length, 2);
  hook.emit('mousedown', { x: 12, y: 22 });
  assert.equal(messages.at(-1).type, 'mousedown');
});
